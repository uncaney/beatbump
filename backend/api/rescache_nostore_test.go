package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// An answer marked with NoStoreHeader is served but never cached: the next
// request reaches the handler again (fresh install: no mix card while the
// library is indexed). An unmarked answer is cached as before.
func TestResponseCacheHonoursNoStore(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "1")
	rc := newResponseCache(16)
	calls := 0
	empty := true
	h := cacheResponseSWRWith(rc, time.Minute, time.Hour, func(c echo.Context) error {
		calls++
		if empty {
			c.Response().Header().Set(NoStoreHeader, "1")
			return c.JSON(http.StatusOK, map[string]int{"cards": 0})
		}
		return c.JSON(http.StatusOK, map[string]int{"cards": 3})
	})
	e := echo.New()
	get := func() string {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/local/mixes", nil)
		rec := httptest.NewRecorder()
		if err := h(e.NewContext(req, rec)); err != nil {
			t.Fatal(err)
		}
		return rec.Header().Get("X-Ytm-Cache")
	}
	if got := get(); got != "MISS" {
		t.Fatalf("first: %s", got)
	}
	if got := get(); got != "MISS" || calls != 2 {
		t.Fatalf("no-store answer was cached: %s after %d calls", got, calls)
	}
	empty = false
	if got := get(); got != "MISS" {
		t.Fatalf("third: %s", got)
	}
	if got := get(); got != "HIT" || calls != 3 {
		t.Fatalf("normal answer not cached: %s after %d calls", got, calls)
	}
}
