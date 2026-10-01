package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// PF4-6: the non-hashed build files carry a content ETag through the real
// router and a matching If-None-Match gets an empty 304 (gzip on or off);
// a changed file gets a new tag; hashed assets, SPA routes and the API do
// not get one.
func TestStaticETagRevalidation(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		fp := filepath.Join(dir, "build", filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(fp), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fp, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "<html><head><title>shell</title></head></html>")
	write("manifest.json", `{"name":"music"}`)
	write("android/android-launchericon-192-192.png", "png-bytes")
	write("_app/immutable/chunks/x.1234.js", "export const x=1")
	t.Chdir(dir)
	t.Setenv("MEILI_URL", "")
	e := newServer()
	do := func(p, inm string, gzip bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		if inm != "" {
			req.Header.Set("If-None-Match", inm)
		}
		if gzip {
			req.Header.Set("Accept-Encoding", "gzip")
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}
	for _, p := range []string{"/", "/manifest.json", "/android/android-launchericon-192-192.png"} {
		first := do(p, "", false)
		tag := first.Header().Get("ETag")
		if first.Code != http.StatusOK || !strings.HasPrefix(tag, `W/"`) || first.Body.Len() == 0 {
			t.Fatalf("%s: code %d etag %q", p, first.Code, tag)
		}
		for _, gz := range []bool{false, true} {
			rec := do(p, tag, gz)
			if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 || rec.Header().Get("Content-Encoding") != "" {
				t.Fatalf("%s gzip=%v: revalidation code %d body %d enc %q", p, gz, rec.Code, rec.Body.Len(), rec.Header().Get("Content-Encoding"))
			}
		}
		if rec := do(p, `W/"other"`, false); rec.Code != http.StatusOK || rec.Body.Len() == 0 {
			t.Fatalf("%s: stale tag code %d", p, rec.Code)
		}
	}
	// "/" keeps its no-cache policy on the 304
	if rec := do("/", do("/", "", false).Header().Get("ETag"), false); rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("/ 304 cache-control %q", rec.Header().Get("Cache-Control"))
	}
	// a new build of the file: new tag, the old one no longer matches
	old := do("/manifest.json", "", false).Header().Get("ETag")
	write("manifest.json", `{"name":"music v2"}`)
	if rec := do("/manifest.json", old, false); rec.Code != http.StatusOK || rec.Header().Get("ETag") == old || !strings.Contains(rec.Body.String(), "v2") {
		t.Fatalf("changed manifest: code %d etag %q", rec.Code, rec.Header().Get("ETag"))
	}
	for _, p := range []string{"/_app/immutable/chunks/x.1234.js", "/home", "/api/v1/nope"} {
		if tag := do(p, "", false).Header().Get("ETag"); tag != "" {
			t.Fatalf("%s got an ETag %q", p, tag)
		}
	}
}

func TestEtagMatches(t *testing.T) {
	tag := `W/"abc"`
	for _, h := range []string{`W/"abc"`, `"abc"`, `"x", W/"abc"`, `*`} {
		if !etagMatches(h, tag) {
			t.Fatalf("%q should match", h)
		}
	}
	for _, h := range []string{"", `"abd"`, `W/"ab"`} {
		if etagMatches(h, tag) {
			t.Fatalf("%q should not match", h)
		}
	}
}
