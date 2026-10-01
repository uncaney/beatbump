package main

import (
	"beatbump-server/backend/api"
	"beatbump-server/backend/api/downloader"
	"beatbump-server/backend/db"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func main() {
	db.InitDB()
	downloader.StartWorker()

	e := echo.New()

	e.Use(middleware.CORS())
	e.Use(middleware.Logger())
	// Compression: the shell, hashed bundles and JSON APIs were served uncompressed (444 KB
	// vendor chunk, 690 KB search.json). Audio proxy streams are skipped (already compressed
	// media; Range/206 must pass through untouched).
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{
		Level:   5,
		Skipper: func(c echo.Context) bool { return api.IsAudioProxyPath(c.Request().URL.Path) },
	}))
	// Cache policy: hashed immutable assets are cached forever, the shell / service worker /
	// manifest are always revalidated, API responses are never stored by the browser.
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			p := c.Request().URL.Path
			h := c.Response().Header()
			switch {
			case strings.HasPrefix(p, "/_app/immutable/"):
				h.Set("Cache-Control", "public, max-age=31536000, immutable")
			case p == "/" || p == "/index.html" || p == "/service-worker.js" || p == "/manifest.json":
				h.Set("Cache-Control", "no-cache")
			case strings.HasPrefix(p, "/api/"):
				h.Set("Cache-Control", "no-store")
			}
			return next(c)
		}
	})
	e.Use(middleware.StaticWithConfig(middleware.StaticConfig{
		Root: "./build",
		// Audio reverse-proxy paths must bypass the SPA static handler: with IgnoreBase
		// the exact routes /localf, /vp, /cover collapse to the build root and get index.html.
		Skipper:    func(c echo.Context) bool { return api.IsAudioProxyPath(c.Request().URL.Path) },
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
	e.GET("/api/v1/next.json", api.NextEndpointHandler)
	e.GET("/api/v1/related.json", api.RelatedEndpointHandler)
	e.GET("/api/v1/main.json", api.CacheResponse(5*time.Minute, api.AlbumEndpointHandler))
	e.GET("/api/v1/get_queue.json", api.GetQueueHandler)
	e.GET("/api/v1/get_search_suggestions.json", api.GetSearchSuggstionsHandler)

	e.GET("/api/v1/home.json", api.CacheResponse(2*time.Minute, api.HomeEndpointHandler))
	e.GET("/api/v1/explore/:category", api.CacheResponse(5*time.Minute, api.ExploreEndpointHandler))
	e.GET("/api/v1/explore", api.CacheResponse(5*time.Minute, api.ExploreEndpointHandler))
	e.GET("/api/v1/trending", api.CacheResponse(5*time.Minute, api.TrendingEndpointHandler))
	e.GET("/api/v1/trending/:browseId", api.CacheResponse(5*time.Minute, api.TrendingEndpointHandler))

	e.GET("/api/v1/artist/:artistId", api.CacheResponse(5*time.Minute, api.ArtistEndpointHandler))

	// Lyrics via lrclib.net (universal; local or YouTube tracks)
	e.GET("/api/v1/lyrics", api.LyricsHandler)

	// Local collection browse (whole self-hosted library, paginated + sorted)
	e.GET("/api/v1/local/artists", api.LocalArtistsHandler)
	e.GET("/api/v1/local/albums", api.LocalAlbumsHandler)
	e.GET("/api/v1/local/songs", api.LocalSongsHandler)
	e.GET("/api/v1/local/genres", api.LocalGenresHandler)

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
	me.POST("/acquire", api.MeAcquireHandler)
	me.GET("/acquire", api.MeAcquireStatusHandler)
	me.GET("/mix", api.MeMixHandler)

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

	e.Logger.Fatal(e.Start(":8080"))
}
