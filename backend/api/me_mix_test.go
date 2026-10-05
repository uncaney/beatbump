package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// mixMeiliStub answers the tracks/albums searches me/mix issues with
// deterministic hits (seed lookup, per-artist pool, random windows) and
// records how many requests were in flight at once.
type mixMeiliStub struct {
	calls, inflight, maxInflight int32
	delay                        time.Duration
	// copies: lid -> the pool lid it duplicates (same artist, same title,
	// another album); such a lid is served next to the original (L12-18).
	copies map[string]string
}

// track is the stub's hit for lid: "T <lid>" by "Art-<lid>" for a seed,
// "P <lid>" by the seed's artist for a pool lid "<seed>-pN"; a lid in
// copies carries the title and artist of the lid it duplicates.
func (s *mixMeiliStub) track(lid string) map[string]interface{} {
	src := lid
	if of, ok := s.copies[lid]; ok {
		src = of
	}
	if i := strings.Index(src, "-p"); i >= 0 {
		artist := "Art-" + src[:i]
		return map[string]interface{}{"lid": lid, "title": "P " + src, "artist": artist, "albumArtist": artist}
	}
	return map[string]interface{}{"lid": lid, "title": "T " + src, "artist": "Art-" + src, "albumArtist": "Art-" + src}
}

func extractQuoted(filter, prefix string) string {
	rest := strings.TrimPrefix(filter, prefix)
	if i := strings.IndexByte(rest, '"'); i >= 0 {
		return rest[:i]
	}
	return rest
}

func (s *mixMeiliStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	atomic.AddInt32(&s.calls, 1)
	n := atomic.AddInt32(&s.inflight, 1)
	for {
		m := atomic.LoadInt32(&s.maxInflight)
		if n <= m || atomic.CompareAndSwapInt32(&s.maxInflight, m, n) {
			break
		}
	}
	defer atomic.AddInt32(&s.inflight, -1)
	time.Sleep(s.delay)
	var body map[string]interface{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	hits := []map[string]interface{}{}
	if strings.HasSuffix(r.URL.Path, "/indexes/tracks/search") {
		filter, _ := body["filter"].(string)
		limit := int(body["limit"].(float64))
		switch {
		case strings.HasPrefix(filter, `lid = "`):
			hits = append(hits, s.track(extractQuoted(filter, `lid = "`)))
		case strings.HasPrefix(filter, `lid IN [`):
			for lid := range stubLidIn(filter) {
				hits = append(hits, s.track(lid))
			}
		case strings.HasPrefix(filter, `albumArtist = "`):
			artist := extractQuoted(filter, `albumArtist = "`)
			for i := 1; i <= 3; i++ {
				lid := strings.TrimPrefix(artist, "Art-") + fmt.Sprintf("-p%d", i)
				hits = append(hits, s.track(lid))
				for c, of := range s.copies {
					if of == lid {
						hits = append(hits, s.track(c))
					}
				}
			}
		default: // random window (offset + sort); the count query (limit 0) has no offset
			offF, _ := body["offset"].(float64)
			off := int(offF)
			for i := 0; i < limit; i++ {
				lid := fmt.Sprintf("r-%d-%d", off, i)
				hits = append(hits, map[string]interface{}{"lid": lid, "title": "R " + lid, "artist": "Rnd"})
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	// A large library (estimatedTotalHits): the random windows of the cold
	// start draw their offsets under it (libraryTrackTotal).
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": 54000})
}

func newMixTestEnv(t *testing.T, delay time.Duration) *mixMeiliStub {
	t.Helper()
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.Favorite{}); err != nil {
		t.Fatalf("migrate favorites: %v", err)
	}
	stub := &mixMeiliStub{delay: delay}
	srv := httptest.NewServer(stub)
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	t.Setenv("YTM_API_CACHE", "")
	resetTrackTotalMemo()
	t.Cleanup(resetTrackTotalMemo)
	mixCacheMu.Lock()
	mixCache = map[string]mixCacheEntry{}
	mixCacheMu.Unlock()
	prevNow := mixCacheNow
	t.Cleanup(func() {
		mixCacheNow = prevNow
		mixCacheMu.Lock()
		mixCache = map[string]mixCacheEntry{}
		mixCacheMu.Unlock()
	})
	return stub
}

type mixBody struct {
	Items []struct {
		VideoId string `json:"videoId"`
	} `json:"items"`
	Seeds int `json:"seeds"`
}

func getMix(t *testing.T, cookie string) (*httptest.ResponseRecorder, mixBody) {
	t.Helper()
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/mix", "", nil)
	if cookie != "" {
		c.Request().Header.Set("Cookie", "bbp="+cookie)
	}
	if err := MeMixHandler(c); err != nil {
		t.Fatalf("mix: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("mix status %d: %s", rec.Code, rec.Body.String())
	}
	var b mixBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("mix body: %v", err)
	}
	return rec, b
}

// K4: the seeds are expanded concurrently but merged in seed order (most
// played first, then its pool), exactly like the former sequential loop.
func TestMixSeedsConcurrentOrderPreserved(t *testing.T) {
	stub := newMixTestEnv(t, 15*time.Millisecond)
	// c40b: played 4 h ago (a seed played in the last 3 h is no longer an item).
	played := time.Now().Add(-4 * time.Hour)
	for i := 0; i < 3; i++ {
		db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "aaaaaaaaaa1", Source: "local", PlayedAt: played})
	}
	for i := 0; i < 2; i++ {
		db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "bbbbbbbbbb2", Source: "local", PlayedAt: played})
	}
	rec, b := getMix(t, "")
	if rec.Header().Get("X-Ytm-Mix-Cache") != "MISS" {
		t.Fatalf("first call: X-Ytm-Mix-Cache %q, want MISS", rec.Header().Get("X-Ytm-Mix-Cache"))
	}
	if b.Seeds != 2 {
		t.Fatalf("seeds %d, want 2", b.Seeds)
	}
	ids := make([]string, 0, len(b.Items))
	for _, it := range b.Items {
		ids = append(ids, it.VideoId)
	}
	// seed 1, its 3 artist hits, 5 random pads; seed 2, its 3 artist hits, ...
	want := []string{"aaaaaaaaaa1", "aaaaaaaaaa1-p1", "aaaaaaaaaa1-p2", "aaaaaaaaaa1-p3"}
	if len(ids) < 13 || strings.Join(ids[:4], ",") != strings.Join(want, ",") {
		t.Fatalf("order: %v", ids)
	}
	if ids[9] != "bbbbbbbbbb2" || ids[10] != "bbbbbbbbbb2-p1" || ids[11] != "bbbbbbbbbb2-p2" || ids[12] != "bbbbbbbbbb2-p3" {
		t.Fatalf("second seed block: %v", ids[9:13])
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatalf("duplicate %s in %v", id, ids)
		}
		seen[id] = true
	}
	if atomic.LoadInt32(&stub.maxInflight) < 2 {
		t.Fatalf("seeds were expanded sequentially (max in flight %d)", stub.maxInflight)
	}
}

// K4: the cold-start sample fetches its windows concurrently.
func TestMixColdStartWindowsConcurrent(t *testing.T) {
	stub := newMixTestEnv(t, 15*time.Millisecond)
	_, b := getMix(t, "")
	if b.Seeds != 0 || len(b.Items) < 36 || len(b.Items) > 40 {
		t.Fatalf("cold start: seeds %d, %d items", b.Seeds, len(b.Items))
	}
	seen := map[string]bool{}
	for _, it := range b.Items {
		if seen[it.VideoId] {
			t.Fatalf("duplicate %s", it.VideoId)
		}
		seen[it.VideoId] = true
	}
	if atomic.LoadInt32(&stub.maxInflight) < 2 {
		t.Fatalf("windows were fetched sequentially (max in flight %d)", stub.maxInflight)
	}
}

// K4: 60 s cache per profile id, HIT/MISS header, dropped by a new play and
// by favourite changes, never shared between profiles.
func TestMixCachePerProfile(t *testing.T) {
	stub := newMixTestEnv(t, 0)
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "aaaaaaaaaa1", Source: "local", PlayedAt: time.Now()})

	rec1, _ := getMix(t, "")
	calls := atomic.LoadInt32(&stub.calls)
	rec2, _ := getMix(t, "")
	if rec1.Header().Get("X-Ytm-Mix-Cache") != "MISS" || rec2.Header().Get("X-Ytm-Mix-Cache") != "HIT" {
		t.Fatalf("headers %q then %q, want MISS then HIT", rec1.Header().Get("X-Ytm-Mix-Cache"), rec2.Header().Get("X-Ytm-Mix-Cache"))
	}
	if rec2.Body.String() != rec1.Body.String() {
		t.Fatalf("HIT body differs from the MISS body")
	}
	if atomic.LoadInt32(&stub.calls) != calls {
		t.Fatalf("HIT still queried Meili")
	}
	if ct := rec2.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("HIT content-type %q", ct)
	}

	// another profile: its own entry
	if rec, _ := getMix(t, "p-other"); rec.Header().Get("X-Ytm-Mix-Cache") != "MISS" {
		t.Fatalf("other profile got %q, want MISS", rec.Header().Get("X-Ytm-Mix-Cache"))
	}

	// a new play invalidates
	c, rec := ctxFor(http.MethodPost, "/api/v1/me/history", `{"videoId":"bbbbbbbbbb2","title":"B"}`, nil)
	if err := MeRecordPlayHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("record play: %v %d", err, rec.Code)
	}
	if rec, _ := getMix(t, ""); rec.Header().Get("X-Ytm-Mix-Cache") != "MISS" {
		t.Fatalf("after play: %q, want MISS", rec.Header().Get("X-Ytm-Mix-Cache"))
	}
	if rec, _ := getMix(t, ""); rec.Header().Get("X-Ytm-Mix-Cache") != "HIT" {
		t.Fatalf("re-cached: %q, want HIT", rec.Header().Get("X-Ytm-Mix-Cache"))
	}

	// favourite added / removed invalidates
	c, rec = ctxFor(http.MethodPost, "/api/v1/me/favorites", `{"videoId":"aaaaaaaaaa1","title":"A"}`, nil)
	if err := MeAddFavoriteHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("add favorite: %v %d", err, rec.Code)
	}
	if rec, _ := getMix(t, ""); rec.Header().Get("X-Ytm-Mix-Cache") != "MISS" {
		t.Fatalf("after favorite: %q, want MISS", rec.Header().Get("X-Ytm-Mix-Cache"))
	}
	getMix(t, "")
	c, rec = ctxFor(http.MethodDelete, "/api/v1/me/favorites?ref=aaaaaaaaaa1", "", nil)
	if err := MeDeleteFavoriteHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("delete favorite: %v %d", err, rec.Code)
	}
	if rec, _ := getMix(t, ""); rec.Header().Get("X-Ytm-Mix-Cache") != "MISS" {
		t.Fatalf("after unfavorite: %q, want MISS", rec.Header().Get("X-Ytm-Mix-Cache"))
	}

	// TTL: expired after 60 s
	getMix(t, "")
	base := time.Now()
	mixCacheNow = func() time.Time { return base.Add(mixCacheTTL + time.Second) }
	if rec, _ := getMix(t, ""); rec.Header().Get("X-Ytm-Mix-Cache") != "MISS" {
		t.Fatalf("after TTL: %q, want MISS", rec.Header().Get("X-Ytm-Mix-Cache"))
	}

	// YTM_API_CACHE=0 bypasses
	t.Setenv("YTM_API_CACHE", "0")
	if rec, _ := getMix(t, ""); rec.Header().Get("X-Ytm-Mix-Cache") != "BYPASS" {
		t.Fatalf("disabled: %q, want BYPASS", rec.Header().Get("X-Ytm-Mix-Cache"))
	}
}
