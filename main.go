package main

import (
	"beatbump-server/backend/api"
	"beatbump-server/backend/api/downloader"
	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func main() {
	db.InitDB()
	downloader.StartWorker()

	e := echo.New()

	e.Use(middleware.CORS())
	e.Use(middleware.Logger())
	e.Use(middleware.StaticWithConfig(middleware.StaticConfig{
		Root:       "./build",
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

	e.GET("/api/v1/search.json", api.SearchEndpointHandler)
	e.GET("/api/v1/player.json", api.PlayerEndpointHandler)
	e.GET("/api/v1/playlist.json", api.PlaylistEndpointHandler)
	e.GET("/api/v1/next.json", api.NextEndpointHandler)
	e.GET("/api/v1/related.json", api.RelatedEndpointHandler)
	e.GET("/api/v1/main.json", api.AlbumEndpointHandler)
	e.GET("/api/v1/get_queue.json", api.GetQueueHandler)
	e.GET("/api/v1/get_search_suggestions.json", api.GetSearchSuggstionsHandler)

	e.GET("/api/v1/home.json", api.HomeEndpointHandler)
	e.GET("/api/v1/explore/:category", api.ExploreEndpointHandler)
	e.GET("/api/v1/explore", api.ExploreEndpointHandler)
	e.GET("/api/v1/trending", api.TrendingEndpointHandler)
	e.GET("/api/v1/trending/:browseId", api.TrendingEndpointHandler)

	e.GET("/api/v1/artist/:artistId", api.ArtistEndpointHandler)

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
