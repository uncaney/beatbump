package api

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// clockedCache is a response cache on a fake clock (advance moves it).
func clockedCache(t *testing.T) (*responseCache, func(time.Duration)) {
	t.Helper()
	t.Setenv("YTM_API_CACHE", "")
	rc := newResponseCache(10)
	var mu sync.Mutex
	now := time.Unix(1000, 0)
	rc.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	return rc, func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
}

// countingHandler answers {"n":<call count>}.
func countingHandler(calls *int32) echo.HandlerFunc {
	return func(c echo.Context) error {
		n := atomic.AddInt32(calls, 1)
		return c.JSON(http.StatusOK, map[string]int32{"n": n})
	}
}

func cacheStatus(t *testing.T, h echo.HandlerFunc, target string) (string, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	if err := h(echo.New().NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	return rec.Header().Get("X-Ytm-Cache"), rec.Body.String()
}

// PF5-2: the home.json policy keeps serving STALE across a whole idle day
// (the audit v5 case was a MISS of 539 ms after 51 idle minutes with the
// 30 min grace); only past TTL + 24 h does the entry fall back to a MISS.
func TestHomeCacheGraceCoversAnIdleDay(t *testing.T) {
	if HomeCacheTTL != 2*time.Minute || HomeCacheGrace != 24*time.Hour {
		t.Fatalf("home policy = %s / %s, want 2m / 24h", HomeCacheTTL, HomeCacheGrace)
	}
	rc, advance := clockedCache(t)
	var calls int32
	h := cacheResponseSWRWith(rc, HomeCacheTTL, HomeCacheGrace, countingHandler(&calls))
	const target = "/api/v1/home.json"

	if st, body := cacheStatus(t, h, target); st != "MISS" || body != `{"n":1}`+"\n" {
		t.Fatalf("first: %s %q", st, body)
	}
	// 51 idle minutes (audit v5): the old body at once, one refresh behind.
	advance(51 * time.Minute)
	if st, body := cacheStatus(t, h, target); st != "STALE" || body != `{"n":1}`+"\n" {
		t.Fatalf("after 51 min: %s %q, want STALE with the old body", st, body)
	}
	rc.bg.Wait()
	if st, body := cacheStatus(t, h, target); st != "HIT" || body != `{"n":2}`+"\n" {
		t.Fatalf("after refresh: %s %q", st, body)
	}
	// 23 h later: still inside the grace, still STALE (never a MISS).
	advance(23 * time.Hour)
	if st, _ := cacheStatus(t, h, target); st != "STALE" {
		t.Fatalf("after 23 h: %s, want STALE", st)
	}
	rc.bg.Wait()
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("handler calls = %d, want 3 (first MISS + 2 refreshes)", got)
	}
	// Past TTL + grace: evicted, synchronous MISS.
	advance(HomeCacheTTL + HomeCacheGrace + time.Second)
	if st, _ := cacheStatus(t, h, target); st != "MISS" {
		t.Fatalf("past the grace: %s, want MISS", st)
	}
}

// PF5-2: WarmHome primes the entry at boot: the first real request is a HIT
// and the handler ran exactly once, in the background. With the cache
// disabled nothing runs.
func TestWarmCachedPrimesTheEntry(t *testing.T) {
	rc, _ := clockedCache(t)
	var calls int32
	h := cacheResponseSWRWith(rc, HomeCacheTTL, HomeCacheGrace, countingHandler(&calls))
	const target = "/api/v1/home.json"

	warmCached(rc, target, h)
	rc.bg.Wait()
	if got := atomic.LoadInt32(&calls); got != 1 || rc.len() != 1 {
		t.Fatalf("after warm: calls=%d entries=%d, want 1 / 1", got, rc.len())
	}
	if st, body := cacheStatus(t, h, target); st != "HIT" || body != `{"n":1}`+"\n" {
		t.Fatalf("first real request: %s %q, want HIT with the warmed body", st, body)
	}
	// A failing warm (non-200) stores nothing and panics nowhere.
	rc2, _ := clockedCache(t)
	warmCached(rc2, target, cacheResponseSWRWith(rc2, HomeCacheTTL, HomeCacheGrace, func(c echo.Context) error {
		return c.String(http.StatusBadGateway, "youtube down")
	}))
	rc2.bg.Wait()
	if rc2.len() != 0 {
		t.Fatalf("failed warm stored %d entries, want 0", rc2.len())
	}
	// Cache disabled: no call at all.
	t.Setenv("YTM_API_CACHE", "0")
	warmCached(rc, target, h)
	rc.bg.Wait()
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("warm with cache disabled ran the handler (calls=%d)", got)
	}
}
