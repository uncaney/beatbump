package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AP3: the Open Graph middleware runs before the SPA shell handlers of the
// real router: robots get a card, humans (browsers, curl) the unchanged shell.
func TestOGPreviewInRouter(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "build"), 0o755); err != nil {
		t.Fatal(err)
	}
	shell := "<html><head><title>shell</title></head></html>"
	if err := os.WriteFile(filepath.Join(dir, "build", "index.html"), []byte(shell), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	t.Setenv("MEILI_URL", "")
	e := newServer()
	get := func(path, ua string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if ua != "" {
			req.Header.Set("User-Agent", ua)
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}
	// Unknown ids (no network: not a YouTube id, no Meili): plain fallback card, 200.
	for _, p := range []string{"/listen?id=nope", "/release?id=lb-000000000000"} {
		rec := get(p, "WhatsApp/2.23.20.0")
		body := rec.Body.String()
		if rec.Code != http.StatusOK || !strings.Contains(body, `<meta property="og:title" content="music.ekaii.fr">`) ||
			!strings.Contains(body, `twitter:card`) || strings.Contains(body, "shell") {
			t.Errorf("robot %s: code %d body %s", p, rec.Code, body)
		}
	}
	for _, ua := range []string{"", "curl/8.5.0", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"} {
		for _, p := range []string{"/listen?id=nope", "/release?id=lb-000000000000"} {
			rec := get(p, ua)
			if rec.Code != http.StatusOK || rec.Body.String() != shell {
				t.Errorf("human %q %s: code %d body %q", ua, p, rec.Code, rec.Body.String())
			}
		}
	}
	// Unknown SPA roots keep the 404 shell, even for robots (spa_notfound.go).
	if rec := get("/nope", "WhatsApp/2"); rec.Code != http.StatusNotFound || rec.Body.String() != shell {
		t.Errorf("robot /nope: code %d body %q", rec.Code, rec.Body.String())
	}
}
