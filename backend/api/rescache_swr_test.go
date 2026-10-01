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

// PF3-2: an expired entry inside the grace window is served at once as STALE
// while exactly one background refresh (singleflight) replaces it.
func TestResponseCacheStaleWhileRevalidate(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "")
	rc := newResponseCache(10)
	var mu sync.Mutex
	now := time.Unix(1000, 0)
	rc.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }

	var calls int32
	release := make(chan struct{})
	blocking := int32(0)
	h := cacheResponseSWRWith(rc, 2*time.Minute, 30*time.Minute, func(c echo.Context) error {
		n := atomic.AddInt32(&calls, 1)
		if atomic.LoadInt32(&blocking) == 1 {
			<-release
		}
		if c.Request().Context().Err() != nil {
			t.Errorf("refresh ran with a cancelled context")
		}
		return c.JSON(http.StatusOK, map[string]int32{"n": n})
	})
	e := echo.New()
	do := func() (string, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/home.json", nil)
		rec := httptest.NewRecorder()
		if err := h(e.NewContext(req, rec)); err != nil {
			t.Fatal(err)
		}
		return rec.Header().Get("X-Ytm-Cache"), rec.Body.String()
	}

	if st, body := do(); st != "MISS" || body != `{"n":1}`+"\n" {
		t.Fatalf("first: %s %q", st, body)
	}
	if st, _ := do(); st != "HIT" {
		t.Fatalf("second: %s", st)
	}

	// Past the TTL, inside the grace: STALE with the old body, immediately,
	// and concurrent STALE hits share one refresh.
	advance(3 * time.Minute)
	atomic.StoreInt32(&blocking, 1)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, body := do()
			if st != "STALE" || body != `{"n":1}`+"\n" {
				t.Errorf("stale: %s %q", st, body)
			}
		}()
	}
	wg.Wait() // all answered while the refresh is still blocked
	close(release)
	rc.bg.Wait()
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("handler calls after stale burst = %d, want 2 (one refresh)", got)
	}
	atomic.StoreInt32(&blocking, 0)
	if st, body := do(); st != "HIT" || body != `{"n":2}`+"\n" {
		t.Fatalf("after refresh: %s %q", st, body)
	}

	// Past TTL + grace: evicted, plain MISS (synchronous).
	advance(2*time.Minute + 31*time.Minute)
	if st, body := do(); st != "MISS" || body != `{"n":3}`+"\n" {
		t.Fatalf("after grace: %s %q", st, body)
	}
}

// A failing refresh keeps the stale entry (no MISS storm while upstream is down).
func TestResponseCacheStaleKeptWhenRefreshFails(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "")
	rc := newResponseCache(10)
	now := time.Unix(1000, 0)
	rc.now = func() time.Time { return now }
	fail := false
	h := cacheResponseSWRWith(rc, time.Minute, 10*time.Minute, func(c echo.Context) error {
		if fail {
			return c.String(http.StatusInternalServerError, "upstream down")
		}
		return c.String(http.StatusOK, "ok")
	})
	e := echo.New()
	do := func() string {
		rec := httptest.NewRecorder()
		_ = h(e.NewContext(httptest.NewRequest(http.MethodGet, "/x", nil), rec))
		return rec.Header().Get("X-Ytm-Cache")
	}
	do()
	fail = true
	now = now.Add(2 * time.Minute)
	if st := do(); st != "STALE" {
		t.Fatalf("want STALE, got %s", st)
	}
	rc.bg.Wait()
	if st := do(); st != "STALE" {
		t.Fatalf("want STALE after failed refresh, got %s", st)
	}
	rc.bg.Wait()
	// Plain CacheResponse (grace 0) still answers MISS once expired.
	rc2 := newResponseCache(10)
	rc2.now = func() time.Time { return now }
	h2 := cacheResponseWith(rc2, time.Minute, func(c echo.Context) error { return c.String(http.StatusOK, "ok") })
	rec := httptest.NewRecorder()
	_ = h2(e.NewContext(httptest.NewRequest(http.MethodGet, "/y", nil), rec))
	now = now.Add(2 * time.Minute)
	rec = httptest.NewRecorder()
	_ = h2(e.NewContext(httptest.NewRequest(http.MethodGet, "/y", nil), rec))
	if st := rec.Header().Get("X-Ytm-Cache"); st != "MISS" {
		t.Fatalf("no-grace cache: want MISS, got %s", st)
	}
}
