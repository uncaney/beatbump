package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

func TestResponseCacheHitMissTTL(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "")
	rc := newResponseCache(10)
	now := time.Unix(1000, 0)
	rc.now = func() time.Time { return now }
	calls := 0
	h := cacheResponseWith(rc, 60*time.Second, func(c echo.Context) error {
		calls++
		return c.JSON(http.StatusOK, map[string]int{"n": calls})
	})
	e := echo.New()
	do := func(target string) (*httptest.ResponseRecorder, string) {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()
		if err := h(e.NewContext(req, rec)); err != nil {
			t.Fatal(err)
		}
		return rec, rec.Header().Get("X-Ytm-Cache")
	}
	rec, st := do("/api/v1/home.json?b=2&a=1")
	if st != "MISS" || calls != 1 || rec.Body.String() != `{"n":1}`+"\n" {
		t.Fatalf("first call: status=%s calls=%d body=%q", st, calls, rec.Body.String())
	}
	// Same params in another order: HIT, handler not called again, same body.
	rec, st = do("/api/v1/home.json?a=1&b=2")
	if st != "HIT" || calls != 1 || rec.Body.String() != `{"n":1}`+"\n" {
		t.Fatalf("second call: status=%s calls=%d body=%q", st, calls, rec.Body.String())
	}
	if ct := rec.Header().Get(echo.HeaderContentType); ct == "" {
		t.Fatalf("HIT lost the content type")
	}
	// Different query: MISS.
	if _, st = do("/api/v1/home.json?a=1&b=3"); st != "MISS" || calls != 2 {
		t.Fatalf("different query: status=%s calls=%d", st, calls)
	}
	// After the TTL: MISS again.
	now = now.Add(61 * time.Second)
	if _, st = do("/api/v1/home.json?a=1&b=2"); st != "MISS" || calls != 3 {
		t.Fatalf("expired: status=%s calls=%d", st, calls)
	}
}

func TestResponseCacheSkipsNon200AndDisabled(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "")
	rc := newResponseCache(10)
	calls := 0
	h := cacheResponseWith(rc, time.Minute, func(c echo.Context) error {
		calls++
		return c.String(http.StatusBadGateway, "upstream down")
	})
	e := echo.New()
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/artist/x", nil)
		rec := httptest.NewRecorder()
		_ = h(e.NewContext(req, rec))
		if rec.Header().Get("X-Ytm-Cache") != "MISS" {
			t.Fatalf("non-200 must never be served from cache (call %d)", i)
		}
	}
	if calls != 2 || rc.len() != 0 {
		t.Fatalf("non-200 stored: calls=%d len=%d", calls, rc.len())
	}

	t.Setenv("YTM_API_CACHE", "0")
	ok := cacheResponseWith(rc, time.Minute, func(c echo.Context) error { return c.String(http.StatusOK, "ok") })
	req := httptest.NewRequest(http.MethodGet, "/api/v1/home.json", nil)
	rec := httptest.NewRecorder()
	_ = ok(e.NewContext(req, rec))
	if rec.Header().Get("X-Ytm-Cache") != "BYPASS" || rc.len() != 0 {
		t.Fatalf("YTM_API_CACHE=0 must bypass: %s len=%d", rec.Header().Get("X-Ytm-Cache"), rc.len())
	}
}

func TestResponseCacheCapEvictsLRU(t *testing.T) {
	rc := newResponseCache(3)
	for i := 0; i < 3; i++ {
		rc.set("k"+strconv.Itoa(i), []byte("v"), "text/plain", time.Minute)
	}
	rc.get("k0") // k0 becomes most recently used; k1 is now the oldest
	rc.set("k3", []byte("v"), "text/plain", time.Minute)
	if rc.len() != 3 {
		t.Fatalf("cap not enforced: %d", rc.len())
	}
	if _, ok := rc.get("k1"); ok {
		t.Fatalf("k1 should have been evicted (LRU)")
	}
	if _, ok := rc.get("k0"); !ok {
		t.Fatalf("k0 (recently used) should be kept")
	}
	// Oversized bodies are not stored.
	rc.set("big", make([]byte, resCacheMaxBody+1), "text/plain", time.Minute)
	if _, ok := rc.get("big"); ok {
		t.Fatalf("oversized body must not be cached")
	}
}

// L8-1: a per-profile variant must bypass the shared cache in both directions
// (never stored, never served) while the shared variant still caches.
func TestCacheResponseUnlessSkipsPerProfile(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "")
	e := echo.New()
	calls := 0
	h := cacheResponseUnlessWith(newResponseCache(10), time.Minute, perProfileRelated, func(c echo.Context) error {
		calls++
		return c.String(http.StatusOK, "profile="+c.Request().Header.Get("X-Test-Profile")+" seed="+c.QueryParam("seed"))
	})
	do := func(url, profile string) (string, string) {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("X-Test-Profile", profile)
		rec := httptest.NewRecorder()
		if err := h(e.NewContext(req, rec)); err != nil {
			t.Fatal(err)
		}
		return rec.Body.String(), rec.Header().Get("X-Ytm-Cache")
	}
	b1, c1 := do("/api/v1/local/related?seed=favorites", "A")
	b2, c2 := do("/api/v1/local/related?seed=favorites", "B")
	if c1 != "BYPASS" || c2 != "BYPASS" {
		t.Fatalf("favorites seed must bypass: %s %s", c1, c2)
	}
	if b1 == b2 {
		t.Fatalf("profile B got profile A's favorites radio: %q", b2)
	}
	_, c3 := do("/api/v1/local/related?seed=album:x", "A")
	_, c4 := do("/api/v1/local/related?seed=album:x", "B")
	if c3 != "MISS" || c4 != "HIT" {
		t.Fatalf("album seed should still be shared-cached: %s %s", c3, c4)
	}
	if calls != 3 {
		t.Fatalf("handler calls = %d, want 3", calls)
	}
}
