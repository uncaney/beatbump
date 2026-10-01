package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/labstack/echo/v4"

	"beatbump-server/backend/_youtube"
)

// Audit L10-1: a handler panic during the background stale-while-revalidate
// refresh must be contained (the stale entry keeps being served) and must
// never unwind the process.
func TestSWRRefreshPanicIsContained(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "")
	rc := newResponseCache(10)
	now := time.Unix(1000, 0)
	rc.now = func() time.Time { return now }
	calls := 0
	h := cacheResponseSWRWith(rc, time.Second, time.Minute, func(c echo.Context) error {
		calls++
		if calls > 1 {
			panic("youtube answered without tabs")
		}
		return c.String(http.StatusOK, "fresh")
	})
	e := echo.New()
	do := func() (string, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/home.json", nil)
		rec := httptest.NewRecorder()
		if err := h(e.NewContext(req, rec)); err != nil {
			t.Fatal(err)
		}
		return rec.Body.String(), rec.Header().Get("X-Ytm-Cache")
	}
	do()                           // MISS, stored
	now = now.Add(2 * time.Second) // past the TTL, inside the grace window
	body, xc := do()               // STALE + background refresh that panics
	if xc != "STALE" || body != "fresh" {
		t.Fatalf("expected STALE fresh, got %s %q", xc, body)
	}
	rc.bg.Wait() // the goroutine must return normally despite the panic
	body, _ = do()
	if body != "fresh" {
		t.Fatalf("stale entry lost after a panicking refresh: %q", body)
	}
}

// Audit L10-1: YouTube can answer 200 with no tab at all; ParseHome must not index Tabs[0].
func TestParseHomeWithoutTabsDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("ParseHome panicked: %v", r)
		}
	}()
	out := ParseHome(_youtube.HomeResponse{})
	if out == nil {
		t.Fatal("nil response")
	}
}
