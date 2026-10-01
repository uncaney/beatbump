package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestIsKnownSPAPath(t *testing.T) {
	for p, want := range map[string]bool{
		"/": true, "/home": true, "/search/daft%20punk": true, "/artist/UC123": true,
		"/library/downloads-offline": true, "/listen": true, "/nope": false,
		"/this/does/not/exist": false, "/api/v1/x": false, "/favicon.ico": false,
	} {
		if got := IsKnownSPAPath(p); got != want {
			t.Errorf("IsKnownSPAPath(%q) = %v, want %v", p, got, want)
		}
	}
}

func TestSpaNotFoundServesShellWith404(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>shell</html>"), 0o644)
	os.WriteFile(filepath.Join(dir, "robots.txt"), []byte("ok"), 0o644)
	e := echo.New()
	e.Use(spaNotFound(dir))
	e.GET("/*", func(c echo.Context) error { return c.String(http.StatusOK, "static") })

	cases := []struct {
		path string
		code int
		body string
	}{
		{"/nope", http.StatusNotFound, "<html>shell</html>"},
		{"/this/does/not/exist", http.StatusNotFound, "<html>shell</html>"},
		{"/home", http.StatusOK, "static"},
		{"/artist/UCxxx", http.StatusOK, "static"},
		{"/robots.txt", http.StatusOK, "static"},
		{"/_app/immutable/x.js", http.StatusOK, "static"},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != tc.code || rec.Body.String() != tc.body {
			t.Errorf("%s: got %d %q, want %d %q", tc.path, rec.Code, rec.Body.String(), tc.code, tc.body)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/nope", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	// Only GET is registered: a 405 from the router proves the middleware let POST through.
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /nope should fall through to the router, got %d", rec.Code)
	}
}
