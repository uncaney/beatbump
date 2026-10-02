package api

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// swapCoverMisses installs a fresh, clocked memo for one test.
func swapCoverMisses(t *testing.T, max int) (*missMemo, func(time.Duration)) {
	t.Helper()
	m := newMissMemo(max, coverMissTTL)
	var mu sync.Mutex
	now := time.Unix(1000, 0)
	m.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	old := coverMisses
	coverMisses = m
	t.Cleanup(func() { coverMisses = old })
	return m, func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
}

// PF5-7: the second /cover request for a lid without art is answered by the
// proxy (404, one-hour Cache-Control, X-Ytm-Cache: HIT) without a bridge
// call, for an hour; a 200 after a retag forgets the memo; /localf 404s are
// never memoised.
func TestAudioProxy_CoverMissMemo(t *testing.T) {
	_, advance := swapCoverMisses(t, 16)
	var mu sync.Mutex
	hits := map[string]int{}
	art := map[string]bool{} // lid -> has art
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		key := r.URL.Path + "?" + r.URL.RawQuery
		hits[key]++
		if r.URL.Path == "/cover" && art[r.URL.Query().Get("lid")] {
			w.Header().Set("Content-Type", "image/jpeg")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("jpg"))
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("nope"))
	}))
	defer up.Close()
	t.Setenv("COMPANION_URL", up.URL)
	e := newAudioTestApp(t)
	do := func(method, target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
		return rec
	}
	upstream := func(key string) int { mu.Lock(); defer mu.Unlock(); return hits[key] }

	const lid = "noart000001"
	rec := do(http.MethodGet, "/cover?lid="+lid)
	if rec.Code != http.StatusNotFound || rec.Header().Get("X-Ytm-Cache") != "MISS" || rec.Header().Get("Cache-Control") != coverMissCacheControl {
		t.Fatalf("first 404: status %d cache %q cc %q", rec.Code, rec.Header().Get("X-Ytm-Cache"), rec.Header().Get("Cache-Control"))
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodGet} {
		rec = do(method, "/cover?lid="+lid)
		if rec.Code != http.StatusNotFound || rec.Header().Get("X-Ytm-Cache") != "HIT" || rec.Header().Get("Cache-Control") != coverMissCacheControl {
			t.Fatalf("%s memoised 404: status %d cache %q cc %q", method, rec.Code, rec.Header().Get("X-Ytm-Cache"), rec.Header().Get("Cache-Control"))
		}
	}
	if n := upstream("/cover?lid=" + lid); n != 1 {
		t.Fatalf("bridge asked %d times for the memoised lid, want 1", n)
	}
	// Another lid is its own question.
	if rec = do(http.MethodGet, "/cover?lid=noart000002"); rec.Header().Get("X-Ytm-Cache") != "MISS" {
		t.Fatalf("other lid: cache %q, want MISS", rec.Header().Get("X-Ytm-Cache"))
	}
	// Past the hour the bridge is asked again; the file has art now: 200,
	// memo forgotten, and the lid keeps reaching the bridge.
	advance(coverMissTTL + time.Second)
	mu.Lock()
	art[lid] = true
	mu.Unlock()
	if rec = do(http.MethodGet, "/cover?lid="+lid); rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != coverCacheControl || rec.Header().Get("X-Ytm-Cache") != "" {
		t.Fatalf("after retag: status %d cc %q cache %q", rec.Code, rec.Header().Get("Cache-Control"), rec.Header().Get("X-Ytm-Cache"))
	}
	if coverMisses.has(lid) {
		t.Fatalf("a 200 did not forget the memo")
	}
	// InvalidateCoverMiss makes the next request ask the bridge.
	const lid3 = "noart000003"
	do(http.MethodGet, "/cover?lid="+lid3)
	InvalidateCoverMiss(lid3)
	if rec = do(http.MethodGet, "/cover?lid="+lid3); rec.Header().Get("X-Ytm-Cache") != "MISS" || upstream("/cover?lid="+lid3) != 2 {
		t.Fatalf("after InvalidateCoverMiss: cache %q, bridge asked %d times, want MISS / 2", rec.Header().Get("X-Ytm-Cache"), upstream("/cover?lid="+lid3))
	}
	// /localf 404s pass through every time (a file can appear).
	do(http.MethodGet, "/localf?p=missing")
	rec = do(http.MethodGet, "/localf?p=missing")
	if rec.Code != http.StatusNotFound || rec.Header().Get("X-Ytm-Cache") != "" || upstream("/localf?p=missing") != 2 {
		t.Fatalf("localf 404: status %d cache %q bridge asked %d, want 404 / none / 2", rec.Code, rec.Header().Get("X-Ytm-Cache"), upstream("/localf?p=missing"))
	}
}

// The memo is LRU-bounded and drops expired keys on read.
func TestMissMemoBoundedAndExpiring(t *testing.T) {
	m := newMissMemo(3, time.Hour)
	now := time.Unix(1000, 0)
	m.now = func() time.Time { return now }
	for _, k := range []string{"a", "b", "c"} {
		m.add(k)
	}
	m.add("a") // refreshed: a is now the most recent
	m.add("d") // evicts the oldest, b
	if m.len() != 3 || m.has("b") || !m.has("a") || !m.has("c") || !m.has("d") {
		t.Fatalf("after 4 adds with max 3: len %d, b=%v a=%v c=%v d=%v", m.len(), m.has("b"), m.has("a"), m.has("c"), m.has("d"))
	}
	now = now.Add(time.Hour + time.Second)
	if m.has("a") || m.len() != 2 {
		t.Fatalf("expired key still memoised (len %d)", m.len())
	}
	m.forget("c")
	m.forget("zzz")
	if m.has("c") || m.len() != 1 {
		t.Fatalf("forget: c=%v len %d", m.has("c"), m.len())
	}
}
