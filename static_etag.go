package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"beatbump-server/backend/api"

	"github.com/labstack/echo/v4"
)

// staticETag gives the build's NON-hashed files ("/" = index.html,
// manifest.json, the icons, version.json, ...) a content ETag and answers
// a matching If-None-Match with 304 (PF4-6, audit perf v4). Their
// Last-Modified is the build time (adapter-static copies them), so it
// changes on every deploy even when the bytes do not: the service worker
// revalidating its carried-over copies could not get a 304 from it. The
// hash is computed once per (path, mtime, size). Hashed assets
// (/_app/immutable/, cached forever), the API, the audio proxy and the SPA
// routes pass through untouched; the SPA routes (HTML5 fallback) carry
// index.html's tag (c59g, see wantsShell). The ETag is weak: the gzip middleware may re-encode the body.
func staticETag(buildDir string) echo.MiddlewareFunc {
	type entry struct {
		mod  time.Time
		size int64
		tag  string
	}
	var mu sync.Mutex
	memo := map[string]entry{}
	tagFor := func(fp string, st os.FileInfo) string {
		mu.Lock()
		e, ok := memo[fp]
		mu.Unlock()
		if ok && e.mod.Equal(st.ModTime()) && e.size == st.Size() {
			return e.tag
		}
		f, err := os.Open(fp)
		if err != nil {
			return ""
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return ""
		}
		tag := `W/"` + hex.EncodeToString(h.Sum(nil))[:20] + `"`
		mu.Lock()
		memo[fp] = entry{mod: st.ModTime(), size: st.Size(), tag: tag}
		mu.Unlock()
		return tag
	}
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			r := c.Request()
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				return next(c)
			}
			p := path.Clean("/" + r.URL.Path)
			if strings.HasPrefix(p, "/_app/immutable/") || strings.HasPrefix(p, "/api/") || api.IsAudioProxyPath(p) {
				return next(c)
			}
			rel := p
			if p == "/" {
				rel = "/index.html"
			}
			fp := filepath.Join(buildDir, filepath.FromSlash(rel))
			st, err := os.Stat(fp)
			if err != nil || st.IsDir() {
				// c59g (DS1 rollback, chains 78/80): a SPA route (/home, /search/x,
				// /library/...) has no file; the static handler's HTML5 fallback
				// serves index.html with only the build time as Last-Modified. After
				// a ROLLBACK the old build's index.html is not newer than the
				// If-Modified-Since the browser learned from the new build, so the
				// old server answered 304 and the browser kept the NEW shell, whose
				// lazy chunks then 404 on the old server. The shell answers get
				// index.html's content ETag here: once an If-None-Match is sent,
				// If-Modified-Since is ignored (RFC 9110 13.1.3, net/http), and a
				// different build always serves a fresh shell, in both directions.
				if !wantsShell(p) {
					return next(c)
				}
				fp = filepath.Join(buildDir, "index.html")
				if st, err = os.Stat(fp); err != nil || st.IsDir() {
					return next(c)
				}
			}
			tag := tagFor(fp, st)
			if tag == "" {
				return next(c)
			}
			c.Response().Header().Set("ETag", tag)
			if etagMatches(r.Header.Get("If-None-Match"), tag) {
				return c.NoContent(http.StatusNotModified)
			}
			return next(c)
		}
	}
}

// etagMatches is the weak comparison of RFC 9110 13.1.2 (If-None-Match):
// "*" or any listed tag equal to ours once the W/ prefixes are dropped.
func etagMatches(header, tag string) bool {
	if header == "" {
		return false
	}
	want := strings.TrimPrefix(tag, "W/")
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimSpace(t)
		if t == "*" || strings.TrimPrefix(t, "W/") == want {
			return true
		}
	}
	return false
}

// wantsShell: a request the HTML5 fallback answers with index.html, i.e. a
// known SPA route or any extension-less path (an unknown one gets the 404
// shell from spaNotFound: same bytes, same tag).
func wantsShell(p string) bool {
	return IsKnownSPAPath(p) || path.Ext(p) == ""
}
