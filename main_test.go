package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

// F15: unknown /api/* paths used to get the 200 HTML shell from the SPA static
// handler; they must now be a JSON 404, and the wildcard must not shadow the
// real API routes.
func TestAPIUnknownPathIs404JSON(t *testing.T) {
	e := newServer()
	for _, path := range []string{"/api/v1/nope.json", "/api/zzz", "/api/v1/me/unknown"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404 (body %q)", path, rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Fatalf("%s: content-type %q, want application/json", path, ct)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] != "not_found" {
			t.Fatalf("%s: body %q, want {\"error\":\"not_found\"}", path, rec.Body.String())
		}
	}
}

func TestAPIWildcardDoesNotShadowRoutes(t *testing.T) {
	e := newServer()
	for _, tc := range []struct{ method, path, want string }{
		{http.MethodGet, "/api/v1/player.json", "/api/v1/player.json"},
		{http.MethodGet, "/api/v1/playlist.json", "/api/v1/playlist.json"},
		{http.MethodGet, "/api/v1/me/whoami", "/api/v1/me/whoami"},
		{http.MethodPost, "/api/v1/me/login", "/api/v1/me/login"},
		{http.MethodGet, "/api/v1/artist/UC123", "/api/v1/artist/:artistId"},
		{http.MethodDelete, "/api/v1/downloads/t1/tracks/v1", "/api/v1/downloads/:taskId/tracks/:videoId"},
		{http.MethodGet, "/api/v1/me/stats/export.csv", "/api/v1/me/stats/export.csv"},
		{http.MethodGet, "/api/v1/stats/library", "/api/v1/stats/library"},
		{http.MethodPost, "/api/v1/client-log", "/api/v1/client-log"},
		{http.MethodGet, "/api/v1/client-log", "/api/v1/client-log"},
		{http.MethodGet, "/api/v1/nope.json", "/api/*"},
	} {
		c := e.NewContext(httptest.NewRequest(tc.method, tc.path, nil), httptest.NewRecorder())
		e.Router().Find(tc.method, tc.path, c)
		if c.Path() != tc.want {
			t.Fatalf("%s %s resolved to route %q, want %q", tc.method, tc.path, c.Path(), tc.want)
		}
	}
}

// K5/K6: next.json, related.json and the search suggestions go through the
// TTL response cache (X-Ytm-Cache header); player.json never does (signed
// stream URLs). YTM_API_CACHE=0 keeps the wrapper in BYPASS so the test does
// not populate the process-wide cache, and the requests are built so every
// handler fails fast on validation without touching YouTube.
func TestCachedRoutesCarryXYtmCache(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "0")
	e := newServer()
	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}
	for _, target := range []string{
		"/api/v1/next.json",
		"/api/v1/related.json?browseId=",
		"/api/v1/get_search_suggestions.json",
	} {
		if got := get(target).Header().Get("X-Ytm-Cache"); got != "BYPASS" {
			t.Fatalf("%s: X-Ytm-Cache %q, want BYPASS (route not wrapped by CacheResponse)", target, got)
		}
	}
	if got := get("/api/v1/player.json").Header().Get("X-Ytm-Cache"); got != "" {
		t.Fatalf("player.json must stay uncached, got X-Ytm-Cache %q", got)
	}
}

// K10: every HTML answer (SPA fallback for /home, /search/x, the 404 shell) is
// revalidated, not only "/"; non-HTML files, immutable assets and the API keep
// their own policy.
func TestHTMLAnswersAreNoCache(t *testing.T) {
	e := echo.New()
	e.Use(cacheControlMiddleware)
	e.GET("/_app/immutable/a.js", func(c echo.Context) error { return c.Blob(http.StatusOK, "application/javascript", []byte("1")) })
	e.GET("/api/v1/x", func(c echo.Context) error { return c.JSON(http.StatusOK, map[string]int{"a": 1}) })
	e.GET("/favicon.png", func(c echo.Context) error { return c.Blob(http.StatusOK, "image/png", []byte("p")) })
	e.GET("/*", func(c echo.Context) error {
		if c.Request().URL.Path == "/nope" {
			c.Response().Header().Set("Cache-Control", "no-cache")
			return c.HTMLBlob(http.StatusNotFound, []byte("<html>404</html>"))
		}
		return c.HTML(http.StatusOK, "<html>shell</html>")
	})
	for target, want := range map[string]string{
		"/":                    "no-cache",
		"/home":                "no-cache",
		"/search/abba":         "no-cache",
		"/nope":                "no-cache",
		"/favicon.png":         "",
		"/_app/immutable/a.js": "public, max-age=31536000, immutable",
		"/api/v1/x":            "no-store",
	} {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if got := rec.Header().Get("Cache-Control"); got != want {
			t.Fatalf("%s: Cache-Control %q, want %q", target, got, want)
		}
	}
}
