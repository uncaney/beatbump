package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"beatbump-server/backend/api"

	"github.com/labstack/echo/v4"
)

// spaRoots lists the first path segment of every SvelteKit route (app/src/routes).
// Anything else that is not a file of the build gets the shell with a real 404
// status: the SPA still renders its error page, but crawlers, uptime probes and
// the browser history no longer see a 200 for a dead URL (audit UX v3).
var spaRoots = map[string]bool{
	"": true, "home": true, "search": true, "library": true, "settings": true,
	"artist": true, "channel": true, "listen": true, "watch": true,
	"explore": true, "trending": true, "playlist": true, "release": true,
	"lyrics": true, "session": true, "favorites": true, "downloads": true,
	"share-target": true, // HL5: manifest share_target action (Android "Partager vers")
	"about":        true, // ST2: A propos / Etat
}

// IsKnownSPAPath reports whether p starts with a known SvelteKit route root.
func IsKnownSPAPath(p string) bool {
	p = strings.TrimPrefix(path.Clean("/"+p), "/")
	first := p
	if i := strings.IndexByte(p, '/'); i >= 0 {
		first = p[:i]
	}
	return spaRoots[first]
}

// spaNotFound serves the app shell with status 404 for unknown non-file paths.
// Existing build files and known route roots fall through to the static handler.
func spaNotFound(buildDir string) echo.MiddlewareFunc {
	var once sync.Once
	var shell []byte
	load := func() []byte {
		once.Do(func() {
			b, err := os.ReadFile(filepath.Join(buildDir, "index.html"))
			if err == nil {
				shell = b
			}
		})
		return shell
	}
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			p := c.Request().URL.Path
			if c.Request().Method != http.MethodGet && c.Request().Method != http.MethodHead {
				return next(c)
			}
			// Audio reverse-proxy routes and the API are real routes, not SPA pages.
			if api.IsAudioProxyPath(p) || strings.HasPrefix(p, "/api/") {
				return next(c)
			}
			if IsKnownSPAPath(p) {
				return next(c)
			}
			clean := path.Clean("/" + p)
			// PF3-9: build assets (every /_app/ request) never fall back to
			// the shell. L10-4: a missing one used to reach the HTML5 fallback
			// of the static handler and answer 200 text/html with the
			// one-year immutable policy (a chunk frozen as HTML in the browser
			// cache and the SW shell); it is now a plain 404 never stored.
			if strings.HasPrefix(clean, "/_app/") {
				if st, err := os.Stat(filepath.Join(buildDir, filepath.FromSlash(clean))); err == nil && !st.IsDir() {
					return next(c)
				}
				c.Response().Header().Set("Cache-Control", "no-store")
				return c.NoContent(http.StatusNotFound)
			}
			if st, err := os.Stat(filepath.Join(buildDir, filepath.FromSlash(clean))); err == nil && !st.IsDir() {
				return next(c)
			}
			b := load()
			if b == nil {
				return next(c)
			}
			c.Response().Header().Set("Cache-Control", "no-cache")
			return c.HTMLBlob(http.StatusNotFound, b)
		}
	}
}
