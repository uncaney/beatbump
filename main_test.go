package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		{http.MethodGet, "/api/v1/nope.json", "/api/*"},
	} {
		c := e.NewContext(httptest.NewRequest(tc.method, tc.path, nil), httptest.NewRecorder())
		e.Router().Find(tc.method, tc.path, c)
		if c.Path() != tc.want {
			t.Fatalf("%s %s resolved to route %q, want %q", tc.method, tc.path, c.Path(), tc.want)
		}
	}
}
