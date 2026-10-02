package api

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
)

// Route cache policies (TTL + stale-while-revalidate grace) in one place,
// so main.go and the tests read the same numbers.
//
// PF5-2: home.json used to be CacheResponseSWR(2 min, 30 min). A personal
// instance sleeps hours between two visits, so the first home of the day
// always paid the InnerTube MISS (539 ms after 51 min idle, audit v5) and
// the STALE path never served a real user. The grace is now a day: inside
// it the entry is served STALE whatever its age while one background
// refresh (swrRefreshTimeout) replaces it, and the entry is primed at boot
// (WarmHome) so the first visitor after a deploy gets a HIT.
const (
	HomeCacheTTL   = 2 * time.Minute
	HomeCacheGrace = 24 * time.Hour
)

// HomeCached is the registered handler for GET /api/v1/home.json.
func HomeCached() echo.HandlerFunc { return homeCachedWith(apiResponseCache) }

func homeCachedWith(rc *responseCache) echo.HandlerFunc {
	return cacheResponseSWRWith(rc, HomeCacheTTL, HomeCacheGrace, HomeEndpointHandler)
}

// WarmHome primes the home.json entry in the background at start-up.
func WarmHome() { warmCached(apiResponseCache, "/api/v1/home.json", HomeCached()) }

// warmCached runs the cached handler h once for GET target, detached from
// any client, so its answer lands in rc (a MISS nobody waits for). A
// failure only means the first real request pays the MISS as before; the
// cache being disabled (YTM_API_CACHE=0) skips the call. Tests wait on
// rc.bg.
func warmCached(rc *responseCache, target string, h echo.HandlerFunc) {
	if !responseCacheEnabled() {
		return
	}
	rc.bg.Add(1)
	go func() {
		defer rc.bg.Done()
		// L12-13: a panic in a bare goroutine kills the whole server.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[rescache] warm of %s panicked: %v", target, r)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), swrRefreshTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return
		}
		bw := &bufferWriter{header: http.Header{}}
		c := echo.New().NewContext(req, bw)
		if err := h(c); err != nil || bw.status != http.StatusOK {
			log.Printf("[rescache] warm of %s: status %d, err %v", target, bw.status, err)
		}
	}()
}
