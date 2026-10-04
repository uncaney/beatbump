package api

// Decision 8: daily acquisition cap per profile (acquire_cap.go).

import (
	"beatbump-server/backend/_youtube"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// useAcquireClock pins the cap's clock and clears the auto-cache debounce
// (global keys "al:" / "la:" / "v:" would leak between tests).
func useAcquireClock(t *testing.T, at time.Time) *time.Time {
	t.Helper()
	now := at
	prev := acquireNow
	acquireNow = func() time.Time { return now }
	t.Cleanup(func() { acquireNow = prev })
	autoCacheDebounce.Range(func(k, _ interface{}) bool { autoCacheDebounce.Delete(k); return true })
	t.Cleanup(func() {
		autoCacheDebounce.Range(func(k, _ interface{}) bool { autoCacheDebounce.Delete(k); return true })
	})
	return &now
}

func TestAcquireCapReachedThenQuota(t *testing.T) {
	useTestDB(t)
	useAcquireClock(t, time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC))
	t.Setenv("YTM_ACQUIRE_DAILY_CAP", "")

	assert.Equal(t, 20, acquireDailyCap(), "default cap is 20")
	for i := 0; i < 20; i++ {
		assert.True(t, acquireTryCharge("p-test", "autocache", "", "Artist", fmt.Sprintf("vid%08d", i)), "charge %d fits", i+1)
	}
	assert.Equal(t, 0, acquireAllowance("p-test"))
	assert.False(t, acquireTryCharge("p-test", "autocache", "", "Artist", "vid-over-cap"), "the 21st acquisition is refused")
	assert.Equal(t, 20, acquireUsedToday("p-test"), "a refused charge writes nothing")
	assert.Equal(t, 20, acquisitionsToday())

	// Another profile (an anonymous cookie id) has its own allowance.
	assert.Equal(t, 20, acquireAllowance("anon-cookie-2"))
	assert.True(t, acquireTryCharge("anon-cookie-2", "autocache", "", "Artist", "vid-other"))
	assert.Equal(t, 21, acquisitionsToday(), "stats/library counts every profile")

	// POST me/acquire past the cap: 429 quota, French reason, nothing resolved.
	c, rec := ctxFor(http.MethodPost, "/api/v1/me/acquire", `{"artistId":"UCtestartist000000000000"}`, nil)
	require.NoError(t, MeAcquireHandler(c))
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	var body map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "quota", body["error"])
	assert.Equal(t, "Limite de 20 acquisitions par jour atteinte, reessaie demain", body["reason"])
	assert.EqualValues(t, 20, body["cap"])

	// stats/library exposes the day's count (Meili unreachable here: counts 0).
	t.Setenv("MEILI_URL", "http://127.0.0.1:9")
	sc, srec := ctxFor(http.MethodGet, "/api/v1/stats/library", "", nil)
	require.NoError(t, LibraryStatsHandler(sc))
	var stats map[string]interface{}
	require.NoError(t, json.Unmarshal(srec.Body.Bytes(), &stats))
	assert.EqualValues(t, 21, stats["acquisitionsToday"])
}

func TestAcquireCapResetsAtMidnightUTC(t *testing.T) {
	useTestDB(t)
	now := useAcquireClock(t, time.Date(2026, 10, 3, 23, 30, 0, 0, time.UTC))
	t.Setenv("YTM_ACQUIRE_DAILY_CAP", "")

	for i := 0; i < 20; i++ {
		require.True(t, acquireTryCharge("p-test", "autocache", "", "Artist", fmt.Sprintf("vid%08d", i)))
	}
	assert.Equal(t, 0, acquireAllowance("p-test"), "cap reached at 23:30 UTC")

	*now = time.Date(2026, 10, 3, 23, 59, 59, 0, time.UTC)
	assert.Equal(t, 0, acquireAllowance("p-test"), "still the same UTC day")

	*now = time.Date(2026, 10, 4, 0, 0, 1, 0, time.UTC)
	assert.Equal(t, 20, acquireAllowance("p-test"), "a new UTC day restores the full allowance")
	assert.Equal(t, 0, acquisitionsToday(), "the day's global count resets too")
	assert.True(t, acquireTryCharge("p-test", "autocache", "", "Artist", "vid-next-day"))

	// A Paris evening (UTC+2) at 01:30 local is still the previous UTC day.
	paris := time.FixedZone("Europe/Paris", 2*3600)
	*now = time.Date(2026, 10, 5, 1, 30, 0, 0, paris)
	assert.Equal(t, 19, acquireAllowance("p-test"), "the day boundary is UTC, not local")
}

func TestAcquireCapZeroDisables(t *testing.T) {
	useTestDB(t)
	useAcquireClock(t, time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC))
	t.Setenv("YTM_ACQUIRE_DAILY_CAP", "0")

	assert.Equal(t, 0, acquireDailyCap())
	for i := 0; i < 45; i++ {
		require.True(t, acquireTryCharge("p-test", "autocache", "", "Artist", fmt.Sprintf("vid%08d", i)), "no cap: charge %d", i+1)
	}
	assert.Equal(t, 45, acquireUsedToday("p-test"), "charges are still recorded for the stats")
	assert.Greater(t, acquireAllowance("p-test"), 1000000)

	t.Setenv("YTM_ACQUIRE_DAILY_CAP", "3")
	assert.Equal(t, 3, acquireDailyCap(), "a custom cap is read")
	assert.Equal(t, 0, acquireAllowance("p-test"))

	t.Setenv("YTM_ACQUIRE_DAILY_CAP", "abc")
	assert.Equal(t, 20, acquireDailyCap(), "an unreadable cap falls back to 20")
	t.Setenv("YTM_ACQUIRE_DAILY_CAP", "-4")
	assert.Equal(t, 20, acquireDailyCap(), "a negative cap falls back to 20")
}

func TestAcquireProfileKey(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/player.json?videoId=x", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	assert.Equal(t, "anon", acquireProfileKey(c), "no cookie: pooled anonymous key")
	assert.Empty(t, rec.Header().Get("Set-Cookie"), "a play never mints a profile cookie")

	req = httptest.NewRequest(http.MethodGet, "/api/v1/player.json?videoId=x", nil)
	req.AddCookie(&http.Cookie{Name: "bbp", Value: "anon-cookie-7"})
	c = e.NewContext(req, httptest.NewRecorder())
	assert.Equal(t, "anon-cookie-7", acquireProfileKey(c), "an anonymous profile is its cookie id")
}

// TestAutoCacheRunChargesOncePerAlbumAndStopsAtCap drives the play-side
// acquisition synchronously against a fake yubal: one charge per newly
// requested album (a replay within autoCacheTTL costs nothing), nothing is
// enqueued once the profile's cap is reached, and harness plays never reach
// it (TestPlayerHarnessDoesNotAutoCache).
func TestAutoCacheRunChargesOncePerAlbumAndStopsAtCap(t *testing.T) {
	useTestDB(t)
	useAcquireClock(t, time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC))
	t.Setenv("YTM_ACQUIRE_DAILY_CAP", "2")
	t.Setenv("BEATBUMP_AUTOCACHE", "true")

	var jobs int32
	var posted []string
	yubal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/resolve/album"):
			vid := r.URL.Query().Get("videoId")
			_ = json.NewEncoder(w).Encode(map[string]string{"albumUrl": "https://music.youtube.com/playlist?list=OLAK5uy_" + vid})
		case r.Method == http.MethodPost && r.URL.Path == "/api/jobs":
			var b map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&b)
			posted = append(posted, fmt.Sprint(b["url"]))
			atomic.AddInt32(&jobs, 1)
			w.WriteHeader(http.StatusAccepted)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(yubal.Close)
	t.Setenv("YUBAL_URL", yubal.URL)

	prevOwns := ownsTrackFn
	ownsTrackFn = func(string, string, string) bool { return false }
	t.Cleanup(func() { ownsTrackFn = prevOwns })

	play := func(vid string) {
		var pr _youtube.PlayerResponse
		pr.VideoDetails.Title = "Track " + vid
		pr.VideoDetails.Author = "Artist"
		autoCacheRun("p-test", vid, "", pr)
	}

	play("QaAaaaaaaa1")
	assert.Equal(t, int32(1), atomic.LoadInt32(&jobs), "first album enqueued")
	assert.Equal(t, 1, acquireUsedToday("p-test"))

	play("QaAaaaaaaa1")
	assert.Equal(t, int32(1), atomic.LoadInt32(&jobs), "replaying the same album enqueues nothing")
	assert.Equal(t, 1, acquireUsedToday("p-test"), "and is not charged")

	play("QbBbbbbbbb2")
	assert.Equal(t, int32(2), atomic.LoadInt32(&jobs), "second album enqueued")
	assert.Equal(t, 0, acquireAllowance("p-test"), "cap of 2 reached")

	play("QcCccccccc3")
	assert.Equal(t, int32(2), atomic.LoadInt32(&jobs), "past the cap nothing more is enqueued")
	assert.Equal(t, 2, acquireUsedToday("p-test"))
	assert.Equal(t, []string{
		"https://music.youtube.com/playlist?list=OLAK5uy_QaAaaaaaaa1",
		"https://music.youtube.com/playlist?list=OLAK5uy_QbBbbbbbbb2",
	}, posted)

	// Another profile is not affected by p-test's exhausted allowance.
	var pr _youtube.PlayerResponse
	pr.VideoDetails.Author = "Artist"
	autoCacheRun("anon", "QdDddddddd4", "", pr)
	assert.Equal(t, int32(3), atomic.LoadInt32(&jobs))
	assert.Equal(t, 1, acquireUsedToday("anon"))
}
