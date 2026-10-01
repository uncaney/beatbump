package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestIsKnownSPAPath(t *testing.T) {
	for p, want := range map[string]bool{
		"/": true, "/home": true, "/search/daft%20punk": true, "/artist/UC123": true,
		"/library/downloads-offline": true, "/listen": true, "/about": true, "/nope": false,
		"/this/does/not/exist": false, "/api/v1/x": false, "/favicon.ico": false,
		"/share-target": true, "/share-target/": true, "/share-targets": false,
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
		{"/share-target?text=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ", http.StatusOK, "static"},
		{"/robots.txt", http.StatusOK, "static"},
		{"/_app/immutable/x.js", http.StatusOK, "static"},
		{"/localf", http.StatusOK, "static"},
		{"/aud/abc", http.StatusOK, "static"},
		{"/vp", http.StatusOK, "static"},
		{"/cover", http.StatusOK, "static"},
		{"/api/v1/zzz", http.StatusOK, "static"},
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

// routesDir is the SvelteKit routes tree; spaRoots must mirror its first segments.
const routesDir = "app/src/routes"

var (
	paramDirRe  = regexp.MustCompile(`^\[(\w+)=(\w+)\]$`)
	matcherEqRe = regexp.MustCompile(`params\s*===\s*["']([^"']+)["']`)
	routeFileRe = regexp.MustCompile(`^\+(page|server|layout)(@[^.]*)?\.(svelte|ts|js)$`)
)

// hasRoute reports whether dir (recursively) holds a +page/+server file, i.e.
// whether it serves at least one URL. `_private` dirs never do.
func hasRoute(dir string) bool {
	found := false
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || found {
			return err
		}
		if d.IsDir() && p != dir && strings.HasPrefix(d.Name(), "_") {
			return filepath.SkipDir
		}
		n := d.Name()
		if !d.IsDir() && routeFileRe.MatchString(n) && !strings.HasPrefix(n, "+layout") {
			found = true
		}
		return nil
	})
	return found
}

// matcherValues reads app/src/params/<name>.ts and returns the literal values it accepts.
func matcherValues(t *testing.T, name string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("app/src/params", name+".ts"))
	if err != nil {
		t.Fatalf("matcher %q: %v", name, err)
	}
	var out []string
	for _, m := range matcherEqRe.FindAllStringSubmatch(string(b), -1) {
		out = append(out, m[1])
	}
	if len(out) == 0 {
		t.Fatalf("matcher %q: no literal value found; extend this test for the new matcher shape", name)
	}
	return out
}

// deriveRoots walks dir, expanding (group) dirs and [x=matcher] dirs, and adds the
// first URL segments served by SvelteKit to roots.
func deriveRoots(t *testing.T, dir string, roots map[string]bool) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() {
			if routeFileRe.MatchString(name) && strings.HasPrefix(name, "+page") {
				roots[""] = true
			}
			continue
		}
		sub := filepath.Join(dir, name)
		switch {
		case strings.HasPrefix(name, "_"):
			continue
		case strings.HasPrefix(name, "(") && strings.HasSuffix(name, ")"):
			deriveRoots(t, sub, roots)
		case paramDirRe.MatchString(name):
			if !hasRoute(sub) {
				continue
			}
			for _, v := range matcherValues(t, paramDirRe.FindStringSubmatch(name)[2]) {
				roots[v] = true
			}
		case strings.HasPrefix(name, "["):
			t.Fatalf("route dir %s has an unconstrained first segment: spaRoots cannot list it", sub)
		default:
			if hasRoute(sub) {
				roots[name] = true
			}
		}
	}
}

// TestSpaRootsMatchSvelteKitRoutes fails when a SvelteKit route root is missing
// from spaRoots (the page would answer 404) or spaRoots lists a dead root (audit v4 H11).
func TestSpaRootsMatchSvelteKitRoutes(t *testing.T) {
	derived := map[string]bool{}
	deriveRoots(t, routesDir, derived)
	if len(derived) < 5 {
		t.Fatalf("derived only %v from %s: walker broken?", derived, routesDir)
	}
	var missing, extra []string
	for r := range derived {
		if !spaRoots[r] {
			missing = append(missing, r)
		}
	}
	for r := range spaRoots {
		if !derived[r] {
			extra = append(extra, r)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 {
		t.Errorf("spaRoots misses SvelteKit route roots %q (they would answer 404)", missing)
	}
	if len(extra) > 0 {
		t.Errorf("spaRoots lists %q but no SvelteKit route serves them", extra)
	}
}

// TestDeriveRootsDetectsDrift checks the walker itself on a synthetic tree.
func TestDeriveRootsDetectsDrift(t *testing.T) {
	dir := t.TempDir()
	for _, p := range []string{"(app)/newroot/+page.svelte", "(app)/api/_lib/x.ts", "(app)/(inner)/deep/sub/+page.ts"} {
		f := filepath.Join(dir, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(f), 0o755)
		os.WriteFile(f, []byte(""), 0o644)
	}
	got := map[string]bool{}
	deriveRoots(t, dir, got)
	if !got["newroot"] || !got["deep"] || got["api"] || len(got) != 2 {
		t.Fatalf("deriveRoots = %v, want newroot+deep only", got)
	}
}
