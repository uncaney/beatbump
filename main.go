package main

import (
	"beatbump-server/backend/api"
	"beatbump-server/backend/api/downloader"
	"beatbump-server/backend/db"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// version is the server build reported by /api/v1/stats/library (ST2). Set
// with `-ldflags "-X main.version=<tag>"`, else YTM_VERSION, else "dev".
var version = "dev"

func main() {
	db.InitDB()
	downloader.StartWorker()

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
	// private docker network, i.e. Traefik coolify-proxy); a client reaching
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
	e.Use(middleware.Logger())
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

	// Same-origin audio: /localf, /vp, /cover -> COMPANION_URL (ytm-cache),
	// /aud/* -> IVVP_URL (iv-vp). Streaming reverse proxies, GET + HEAD.
	api.RegisterAudioProxyRoutes(e)

	// Read-mostly, user-independent JSON: short TTL response cache (backend/api/rescache.go).
	e.GET("/api/v1/search.json", api.CacheResponse(60*time.Second, api.SearchEndpointHandler))
	e.GET("/api/v1/player.json", api.PlayerEndpointHandler)
	e.GET("/api/v1/playlist.json", api.PlaylistEndpointHandler)
	// K6: next.json (p50 1.0 s) and related.json (p50 0.4 s) depend on the
	// videoId/playlistId/continuation query only; player.json stays uncached
	// (signed stream URLs).
	e.GET("/api/v1/next.json", api.CacheResponse(2*time.Minute, api.NextEndpointHandler))
	e.GET("/api/v1/related.json", api.CacheResponse(5*time.Minute, api.RelatedEndpointHandler))
	e.GET("/api/v1/main.json", api.CacheResponse(5*time.Minute, api.AlbumEndpointHandler))
	e.GET("/api/v1/get_queue.json", api.GetQueueHandler)
	// K5: one YouTube round trip (~200 ms) per keystroke; the answer only depends on q.
	e.GET("/api/v1/get_search_suggestions.json", api.CacheResponse(10*time.Minute, api.GetSearchSuggstionsHandler))

	e.GET("/api/v1/home.json", api.CacheResponseSWR(2*time.Minute, 30*time.Minute, api.HomeEndpointHandler))
	e.GET("/api/v1/explore/:category", api.CacheResponse(5*time.Minute, api.ExploreEndpointHandler))
	e.GET("/api/v1/explore", api.CacheResponse(5*time.Minute, api.ExploreEndpointHandler))
	e.GET("/api/v1/trending", api.CacheResponse(5*time.Minute, api.TrendingEndpointHandler))
	e.GET("/api/v1/trending/:browseId", api.CacheResponse(5*time.Minute, api.TrendingEndpointHandler))

	e.GET("/api/v1/artist/:artistId", api.CacheResponse(5*time.Minute, api.ArtistEndpointHandler))

	// Lyrics via lrclib.net (universal; local or YouTube tracks)
	e.GET("/api/v1/lyrics", api.CacheResponse(24*time.Hour, api.LyricsHandler))

	// Local collection browse (whole self-hosted library, paginated + sorted)
	e.GET("/api/v1/local/artists", api.LocalArtistsHandler)
	e.GET("/api/v1/local/albums", api.LocalAlbumsHandler)
	// c31b D5: strict local twin of a YouTube album ("Tu l as deja" banner).
	e.GET("/api/v1/local/albums/match", api.CacheResponse(2*time.Minute, api.LocalAlbumMatchHandler))
	e.GET("/api/v1/local/songs", api.LocalSongsHandler)
	// seed=favorites is per profile: served uncached (audit L8-1), the rest shared-cached 5 min.
	e.GET("/api/v1/local/related", api.LocalRelatedCached(5*time.Minute))
	e.GET("/api/v1/local/genres", api.LocalGenresHandler)
	// c29b D1: decade / genre mixes (user-independent, cached like local/related).
	e.GET("/api/v1/local/mix", api.LocalMixHandler)
	e.GET("/api/v1/local/mixes", api.CacheResponse(5*time.Minute, api.LocalMixesHandler))

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
	me.GET("/stats/recent", api.MeRecentHandler)
	me.GET("/stats/top", api.MeTopHandler)
	me.GET("/stats/summary", api.MeStatsSummaryHandler)
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
