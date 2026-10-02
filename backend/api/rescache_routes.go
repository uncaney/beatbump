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
//
// PF5-6: search.json (TTL 60 s) and next.json (TTL 2 min) were a MISS on
// every harness step and on every human "search, play, come back" longer
// than a minute (31/31 and 27/27 answers above 400 ms in the audit v5
// journal). Both answers depend on the query only (q, videoId, playlistId,
// continuation, params...: all of it is in the cache key, responseCacheKey,
// so a continuation page never collides with the first page) and a YouTube
// result list for a query is stable over minutes: 10 min TTL, then an hour
// served STALE while one background refresh replaces the entry.
//
// PF5-5: local/mixes rebuilds its cards at every MISS (up to 12 album pages
// plus the genre counts, 160-200 ms) and had no grace, so the first
// /library/mixes after 5 idle minutes paid it all. 5 min TTL, a day of
// grace, primed at boot (WarmLocalMixes).
const (
	HomeCacheTTL     = 2 * time.Minute
	HomeCacheGrace   = 24 * time.Hour
	SearchCacheTTL   = 10 * time.Minute
	SearchCacheGrace = time.Hour
	NextCacheTTL     = 10 * time.Minute
	NextCacheGrace   = time.Hour
	MixesCacheTTL    = 5 * time.Minute
	MixesCacheGrace  = 24 * time.Hour
)

// HomeCached is the registered handler for GET /api/v1/home.json.
func HomeCached() echo.HandlerFunc { return homeCachedWith(apiResponseCache) }

func homeCachedWith(rc *responseCache) echo.HandlerFunc {
	return cacheResponseSWRWith(rc, HomeCacheTTL, HomeCacheGrace, HomeEndpointHandler)
}

// SearchCached is the registered handler for GET /api/v1/search.json.
func SearchCached() echo.HandlerFunc {
	return searchCachedWith(apiResponseCache, SearchEndpointHandler)
}

func searchCachedWith(rc *responseCache, next echo.HandlerFunc) echo.HandlerFunc {
	return cacheResponseSWRWith(rc, SearchCacheTTL, SearchCacheGrace, next)
}

// NextCached is the registered handler for GET /api/v1/next.json.
func NextCached() echo.HandlerFunc {
	return nextCachedWith(apiResponseCache, NextEndpointHandler)
}

func nextCachedWith(rc *responseCache, next echo.HandlerFunc) echo.HandlerFunc {
	return cacheResponseSWRWith(rc, NextCacheTTL, NextCacheGrace, next)
}

// LocalMixesCached is the registered handler for GET /api/v1/local/mixes.
func LocalMixesCached() echo.HandlerFunc {
	return mixesCachedWith(apiResponseCache, LocalMixesHandler)
}

func mixesCachedWith(rc *responseCache, next echo.HandlerFunc) echo.HandlerFunc {
	return cacheResponseSWRWith(rc, MixesCacheTTL, MixesCacheGrace, next)
}

// WarmHome primes the home.json entry in the background at start-up.
func WarmHome() { warmCached(apiResponseCache, "/api/v1/home.json", HomeCached()) }

// WarmLocalMixes primes the local/mixes entry in the background at start-up.
func WarmLocalMixes() { warmCached(apiResponseCache, "/api/v1/local/mixes", LocalMixesCached()) }

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
