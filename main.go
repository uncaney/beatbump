package main

import (
	"beatbump-server/backend/api"
	"beatbump-server/backend/api/downloader"
	"beatbump-server/backend/db"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// version is the server build reported by /api/v1/stats/library (ST2). Set
// with `-ldflags "-X main.version=<tag>"`, else YTM_VERSION, else "dev".
var version = "dev"

func main() {
	// c43c B7-14: `beat-server -healthcheck` is the container healthcheck
	// (FROM scratch image: no wget / curl). Decided before any side effect:
	// no DB, no worker, no listener (healthcheck.go).
	if isHealthcheckArg(os.Args) {
		runHealthcheck()
	}
	db.InitDB()
	downloader.StartWorker()
	// c41b B6-19: first duplicate-albums scan in the background, so mixes
	// know the suggested copies (refreshed every 10 min on demand).
	api.WarmDuplicates()
	// c48b B8-20: first artist-aliases scan in the background (the artist
	// page chips, the songs union and the folded Artists list read the memo).
	api.WarmArtistAliases()
	// PF5-2: prime home.json so the first visitor after a deploy gets a HIT.
	api.WarmHome()
	// PF5-5: prime local/mixes (160-200 ms of album and genre counts per MISS).
	api.WarmLocalMixes()

	e := newServer()
	e.Logger.Fatal(e.Start(":8080"))
}

// apiNotFound answers unknown /api/* paths with a JSON 404. Without it the SPA
// static handler (HTML5 fallback) served the 200 HTML shell for them and the
// service worker cached that shell as a valid API response (F15).
func apiNotFound(c echo.Context) error {
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.JSON(http.StatusNotFound, map[string]string{"error": "not_found"})
}

// cacheControlMiddleware is the browser cache policy: hashed immutable assets
// are cached forever, the shell / service worker / manifest are always
// revalidated, API responses are never stored by the browser. K10: any other
// answer that turns out to be HTML (the SPA fallback for /home, /search/...,
// the 404 shell) is revalidated too; the Content-Type is only known when the
// static handler writes the headers, hence the Before hook.
func cacheControlMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		p := c.Request().URL.Path
		res := c.Response()
		h := res.Header()
		switch {
		case strings.HasPrefix(p, "/_app/immutable/"):
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		case p == "/" || p == "/index.html" || p == "/service-worker.js" || p == "/manifest.json":
			h.Set("Cache-Control", "no-cache")
		case strings.HasPrefix(p, "/api/"):
			h.Set("Cache-Control", "no-store")
		default:
			res.Before(func() {
				if h.Get("Cache-Control") == "" && strings.HasPrefix(h.Get(echo.HeaderContentType), echo.MIMETextHTML) {
					h.Set("Cache-Control", "no-cache")
				}
			})
		}
		return next(c)
	}
}

// newServer builds the Echo router with every middleware and route (no
// listeners, no DB side effects) so tests can exercise the routing table.
func newServer() *echo.Echo {
	e := echo.New()
	api.SetVersion(version)
	// L9-4: c.RealIP() (the client-log rate limit key) only believes
	// X-Forwarded-For when the direct peer is a proxy of ours (loopback or a
	// private docker network, i.e. the reverse proxy, e.g. Traefik); a client reaching
	// the backend directly is keyed on its own address whatever it sends.
	// X-Real-IP is ignored.
	e.IPExtractor = echo.ExtractIPFromXFFHeader(
		echo.TrustLoopback(true),
		echo.TrustLinkLocal(false),
		echo.TrustPrivateNet(true),
	)

	// Audit L10-1: a panic in any handler must cost one 500, never the process.
	e.Use(middleware.Recover())
	e.Use(middleware.CORS())
	// PF5-8: the default access line plus the cache verdicts (logger.go, accessLogConfig).
	e.Use(middleware.LoggerWithConfig(accessLogConfig(nil)))
	// Compression: the shell, hashed bundles and JSON APIs were served uncompressed (444 KB
	// vendor chunk, 690 KB search.json). Audio proxy streams are skipped (already compressed
	// media; Range/206 must pass through untouched).
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{
		Level:   5,
		Skipper: func(c echo.Context) bool { return api.IsAudioProxyPath(c.Request().URL.Path) },
	}))
	e.Use(cacheControlMiddleware)
	// AP3: link-preview robots (WhatsApp, Telegram, ...) fetching /listen?id=,
	// /release?id= or /playlist/<id> get an Open Graph card; humans fall through
	// to the unchanged SPA shell (backend/api/og_preview.go).
	e.Use(api.OGPreview())
	// Unknown SPA routes get the shell with a real 404 status (spa_notfound.go).
	e.Use(spaNotFound("./build"))
	// PF4-6: content ETag + 304 for the non-hashed build files (static_etag.go).
	e.Use(staticETag("./build"))
	e.Use(middleware.StaticWithConfig(middleware.StaticConfig{
		Root: "./build",
		// Audio reverse-proxy paths must bypass the SPA static handler: with IgnoreBase
		// the exact routes /localf, /vp, /cover collapse to the build root and get index.html.
		// /api/ too: an unknown API path must reach the /api/* JSON 404, not the shell.
		Skipper: func(c echo.Context) bool {
			p := c.Request().URL.Path
			return api.IsAudioProxyPath(p) || strings.HasPrefix(p, "/api/")
		},
		Browse:     true,
		IgnoreBase: true,
		HTML5:      true,
	}))

	// Same-origin audio: /localf, /vp, /cover -> COMPANION_URL (the bridge),
	// /aud/* -> IVVP_URL (iv-vp). Streaming reverse proxies, GET + HEAD.
	api.RegisterAudioProxyRoutes(e)

	// Read-mostly, user-independent JSON: short TTL response cache (backend/api/rescache.go).
	// PF5-6: 10 min TTL + 1 h stale-while-revalidate grace (was 60 s: a MISS on every search).
	e.GET("/api/v1/search.json", api.SearchCached())
	e.GET("/api/v1/player.json", api.PlayerEndpointHandler)
	e.GET("/api/v1/playlist.json", api.PlaylistEndpointHandler)
	// K6: next.json (p50 1.0 s) and related.json (p50 0.4 s) depend on the
	// videoId/playlistId/continuation query only; player.json stays uncached
	// (signed stream URLs).
	e.GET("/api/v1/next.json", api.NextCached()) // PF5-6: 10 min + 1 h grace (was 2 min)
	e.GET("/api/v1/related.json", api.CacheResponse(5*time.Minute, api.RelatedEndpointHandler))
	e.GET("/api/v1/main.json", api.CacheResponse(5*time.Minute, api.AlbumEndpointHandler))
	e.GET("/api/v1/get_queue.json", api.GetQueueHandler)
	// K5: one YouTube round trip (~200 ms) per keystroke; the answer only depends on q.
	e.GET("/api/v1/get_search_suggestions.json", api.CacheResponse(10*time.Minute, api.GetSearchSuggstionsHandler))

	// PF5-2: 2 min TTL + 24 h stale-while-revalidate grace, primed at boot (api.WarmHome).
	e.GET("/api/v1/home.json", api.HomeCached())
	e.GET("/api/v1/explore/:category", api.CacheResponse(5*time.Minute, api.ExploreEndpointHandler))
	e.GET("/api/v1/explore", api.CacheResponse(5*time.Minute, api.ExploreEndpointHandler))
	e.GET("/api/v1/trending", api.CacheResponse(5*time.Minute, api.TrendingEndpointHandler))
	e.GET("/api/v1/trending/:browseId", api.CacheResponse(5*time.Minute, api.TrendingEndpointHandler))

	e.GET("/api/v1/artist/:artistId", api.CacheResponse(5*time.Minute, api.ArtistEndpointHandler))

	// Lyrics via lrclib.net (universal; local or YouTube tracks)
	e.GET("/api/v1/lyrics", api.CacheResponse(24*time.Hour, api.LyricsHandler))

	// Local collection browse (whole self-hosted library, paginated + sorted)
	e.GET("/api/v1/local/artists", api.LocalArtistsHandler)
	// c48b B8-20: artists whose names normalise to the same one ("feat." credits), display only.
	e.GET("/api/v1/local/artists/aliases", api.LocalArtistAliasesHandler)
	e.GET("/api/v1/local/albums", api.LocalAlbumsHandler)
	// c31b D5: strict local twin of a YouTube album ("Tu l as deja" banner).
	e.GET("/api/v1/local/albums/match", api.CacheResponse(2*time.Minute, api.LocalAlbumMatchHandler))
	e.GET("/api/v1/local/songs", api.LocalSongsHandler)
	// seed=favorites is per profile: served uncached (audit L8-1), the rest shared-cached 5 min.
	e.GET("/api/v1/local/related", api.LocalRelatedCached(5*time.Minute))
	e.GET("/api/v1/local/genres", api.LocalGenresHandler)
	// c29b D1: decade / genre mixes (user-independent, cached like local/related).
	e.GET("/api/v1/local/mix", api.LocalMixHandler)
	// PF5-5: 5 min TTL + 24 h grace, primed at boot (api.WarmLocalMixes).
	e.GET("/api/v1/local/mixes", api.LocalMixesCached())
	// c39b B6-1: album of the day (same for every profile, memoised per UTC date).
	e.GET("/api/v1/local/album-of-day", api.LocalAlbumOfDayHandler)
	e.GET("/api/v1/local/album-of-the-day", api.LocalAlbumOfDayHandler)
	// c44a B7-1: artist of the day (never played by a named profile, memoised per UTC date + profile).
	e.GET("/api/v1/local/artist-of-the-day", api.LocalArtistOfDayHandler)
	// c41b B6-19: possible duplicate albums (read-only report, memoised 10 min).
	e.GET("/api/v1/local/duplicates", api.LocalDuplicatesHandler)
	// B8-22: /about "Bibliothèque" card counters (read-only, memoised 10 min).
	e.GET("/api/v1/local/lint", api.LocalLintHandler)

	// Per-profile server state: favorites, follows, playlists (named or anonymous cookie)
	me := e.Group("/api/v1/me")
	me.POST("/login", api.MeLoginHandler)
	me.POST("/logout", api.MeLogoutHandler)
	me.GET("/whoami", api.MeWhoamiHandler)
	me.GET("/favorites", api.MeFavoritesHandler)
	me.POST("/favorites", api.MeAddFavoriteHandler)
	me.DELETE("/favorites", api.MeDeleteFavoriteHandler)
	me.GET("/follows", api.MeFollowsHandler)
	me.POST("/follows", api.MeAddFollowHandler)
	me.DELETE("/follows", api.MeDeleteFollowHandler)
	me.GET("/playlists", api.MePlaylistsHandler)
	me.POST("/playlists", api.MeCreatePlaylistHandler)
	me.GET("/playlists/:id", api.MePlaylistHandler)
	me.POST("/playlists/:id/items", api.MeAddPlaylistItemHandler)
	me.DELETE("/playlists/:id", api.MeDeletePlaylistHandler)
	me.DELETE("/playlists/:id/items", api.MeDeletePlaylistItemHandler)
	me.POST("/history", api.MeRecordPlayHandler)
	// c40b B6-10: early "next" presses (not plays); GET = counts per ref over ?days=30.
	me.POST("/skips", api.MeRecordSkipHandler)
	me.GET("/skips", api.MeSkipsHandler)
	me.GET("/stats/recent", api.MeRecentHandler)
	me.GET("/stats/top", api.MeTopHandler)
	me.GET("/stats/summary", api.MeStatsSummaryHandler)
	// 41A (B6-22): day streak + 90-day calendar (viewer-local days via ?tz=).
	me.GET("/stats/streaks", api.MeStreaksHandler)
	// 41A (B6-22): 7 x 24 minutes (Monday first, viewer-local hours), last 90 days.
	me.GET("/stats/clock", api.MeClockHandler)
	// 41A (B6-22): minutes per release decade (local tracks) and "Ton année".
	me.GET("/stats/decades", api.MeDecadesHandler)
	me.GET("/stats/year", api.MeYearHandler)
	// BI3: RFC 4180 export of the profile history (last 10 000 plays).
	me.GET("/stats/export.csv", api.MeStatsExportCSVHandler)
	me.GET("/never-played", api.MeNeverPlayedHandler)
	me.GET("/stats/rediscover", api.MeRediscoverHandler) // c29b D3
	me.GET("/new-in-library", api.MeNewInLibraryHandler) // c29b EQ3
	me.POST("/acquire", api.MeAcquireHandler)
	me.GET("/acquire", api.MeAcquireStatusHandler)
	me.GET("/mix", api.MeMixHandler)
	me.PUT("/nowplaying", api.MeNowPlayingPutHandler)
	me.GET("/nowplaying", api.MeNowPlayingGetHandler)

	// ST2 "A propos / Etat": library size + build version (no profile data).
	e.GET("/api/v1/stats/library", api.LibraryStatsHandler)
	// ST3: client error reports, in-memory ring of 500 (no profile data).
	// L8-2: POST rate limited per IP (429), GET operator only (Bearer
	// YTM_ADMIN_TOKEN: 401, or 404 while the variable is unset).
	e.POST("/api/v1/client-log", api.ClientLogPostHandler)
	e.GET("/api/v1/client-log", api.ClientLogGetHandler)

	// Download & Settings
	e.GET("/api/v1/download/playlist", api.DownloadPlaylistHandler)
	e.GET("/api/v1/download/song", api.DownloadSongMixHandler)
	e.GET("/api/v1/downloads", api.GetDownloadsHandler)
	e.GET("/api/v1/downloads/:taskId/tracks", api.GetTaskTracksHandler)
	e.POST("/api/v1/downloads/:taskId/pause", api.PauseTaskHandler)
	e.POST("/api/v1/downloads/:taskId/resume", api.ResumeTaskHandler)
	e.POST("/api/v1/downloads/:taskId/retry", api.RetryTaskHandler)
	e.DELETE("/api/v1/downloads/:taskId", api.DeleteTaskHandler)
	e.DELETE("/api/v1/downloads/:taskId/tracks/:videoId", api.DeleteTrackHandler)
	e.GET("/api/v1/stream/:taskId/:videoId", api.StreamTrackHandler)
	e.GET("/api/v1/settings", api.GetSettingsHandler)
	e.POST("/api/v1/settings", api.UpdateSettingsHandler)

	// Catch-all for unknown API paths (Echo matches the static routes above first).
	e.Any("/api/*", apiNotFound)

	return e
}
