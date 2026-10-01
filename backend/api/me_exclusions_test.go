package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

func addSkips(t *testing.T, pid, ref string, ago ...time.Duration) {
	t.Helper()
	for _, a := range ago {
		if err := db.DB.Create(&db.SkipEvent{ProfileID: pid, Ref: ref, Position: 3, Duration: 200, SkippedAt: time.Now().Add(-a)}).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func mixIDs(b mixBody) map[string]bool {
	out := map[string]bool{}
	for _, it := range b.Items {
		out[it.VideoId] = true
	}
	return out
}

// B6-10 item 2: a ref skipped twice in 30 days leaves "Pour toi"; one skip,
// or skips older than 30 days, do not; another profile's skips never count.
func TestMixExcludesTwiceSkipped(t *testing.T) {
	newMixTestEnv(t, 0)
	if err := db.DB.AutoMigrate(&db.SkipEvent{}); err != nil {
		t.Fatal(err)
	}
	seed := "0123456789a"
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: seed, Source: "local", PlayedAt: time.Now().Add(-48 * time.Hour)})
	_, before := getMix(t, "p-test")
	ids := mixIDs(before)
	for _, want := range []string{seed, seed + "-p1", seed + "-p2", seed + "-p3"} {
		if !ids[want] {
			t.Fatalf("baseline mix lacks %s: %v", want, ids)
		}
	}
	addSkips(t, "p-test", seed+"-p2", time.Hour, 3*24*time.Hour)
	addSkips(t, "p-test", seed+"-p3", time.Hour)                        // once only
	addSkips(t, "p-test", seed+"-p1", 40*24*time.Hour, 41*24*time.Hour) // too old
	addSkips(t, "other", seed+"-p1", time.Hour, 2*time.Hour)            // another profile
	invalidateMixCache("p-test")
	_, after := getMix(t, "p-test")
	ids = mixIDs(after)
	if ids[seed+"-p2"] {
		t.Fatalf("twice-skipped ref still in me/mix")
	}
	if !ids[seed+"-p1"] || !ids[seed+"-p3"] || !ids[seed] {
		t.Fatalf("refs wrongly excluded: %v", ids)
	}
}

// A twice-skipped top track is not a seed any more (nor an item).
func TestMixSkippedSeedDropped(t *testing.T) {
	newMixTestEnv(t, 0)
	if err := db.DB.AutoMigrate(&db.SkipEvent{}); err != nil {
		t.Fatal(err)
	}
	a, b := "aaaaaaaaaaa", "bbbbbbbbbbb"
	for i := 0; i < 3; i++ {
		db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: a, Source: "local", PlayedAt: time.Now().Add(-time.Duration(48+i) * time.Hour)})
	}
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: b, Source: "local", PlayedAt: time.Now().Add(-50 * time.Hour)})
	addSkips(t, "p-test", a, time.Hour, 2*time.Hour)
	_, m := getMix(t, "p-test")
	for id := range mixIDs(m) {
		if strings.HasPrefix(id, a) {
			t.Fatalf("skipped seed %s still drives the mix (%s)", a, id)
		}
	}
	if m.Seeds != 1 {
		t.Fatalf("seeds = %d, want 1", m.Seeds)
	}
}

// A skip drops the cached mix of its profile (like a play).
func TestSkipInvalidatesMixCache(t *testing.T) {
	newMixTestEnv(t, 0)
	if err := db.DB.AutoMigrate(&db.SkipEvent{}); err != nil {
		t.Fatal(err)
	}
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "0123456789a", Source: "local", PlayedAt: time.Now().Add(-48 * time.Hour)})
	getMix(t, "p-test")
	if _, ok := mixCacheGet("p-test"); !ok {
		t.Fatalf("mix not cached")
	}
	postSkip(t, `{"lid":"0123456789a-p2","position":3,"duration":200}`, nil)
	if _, ok := mixCacheGet("p-test"); ok {
		t.Fatalf("skip did not drop the cached mix")
	}
}

func relatedIDs(t *testing.T, target, cookie string) map[string]bool {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "bbp", Value: cookie})
	}
	rec := httptest.NewRecorder()
	if err := LocalRelatedHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: %d %s", target, rec.Code, rec.Body.String())
	}
	var body struct {
		Items []map[string]interface{} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	out := map[string]bool{}
	for _, it := range body.Items {
		out[mstr(it, "videoId")] = true
	}
	return out
}

func relatedFixture(t *testing.T) {
	t.Helper()
	stub := newShelfStub(t)
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
		{"lid": "a1b2c3d4e5f", "title": "Around the World", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Homework", "genre": "House", "track": 2.0, "durationSec": 212.0},
		{"lid": "0123456789a", "title": "Lady", "artist": "Modjo", "albumArtist": "Modjo", "album": "Modjo", "genre": "House", "track": 3.0, "durationSec": 300.0},
		{"lid": "bbbbbbbbbbb", "title": "Music Sounds Better", "artist": "Stardust", "albumArtist": "Stardust", "album": "Stardust", "genre": "House", "track": 1.0, "durationSec": 300.0},
	}
}

// local/related: exclude= always applies; personal=1 + bbp cookie adds the
// profile's twice-skipped refs; without personal=1 the answer is shared.
func TestLocalRelatedExclusions(t *testing.T) {
	useSkipDB(t)
	relatedFixture(t)
	base := "/api/v1/local/related?lid=e182ccc85ad"
	all := relatedIDs(t, base, "")
	if !all["a1b2c3d4e5f"] || !all["0123456789a"] || !all["bbbbbbbbbbb"] {
		t.Fatalf("baseline related: %v", all)
	}
	if got := relatedIDs(t, base+"&exclude=a1b2c3d4e5f,bbbbbbbbbbb", ""); got["a1b2c3d4e5f"] || got["bbbbbbbbbbb"] || !got["0123456789a"] {
		t.Fatalf("exclude= not applied: %v", got)
	}
	addSkips(t, "p-skip", "0123456789a", time.Hour, 2*time.Hour)
	if got := relatedIDs(t, base+"&personal=1", "p-skip"); got["0123456789a"] || !got["a1b2c3d4e5f"] {
		t.Fatalf("personal=1 did not drop the twice-skipped ref: %v", got)
	}
	if got := relatedIDs(t, base, "p-skip"); !got["0123456789a"] {
		t.Fatalf("without personal=1 the shared answer must not depend on the profile: %v", got)
	}
	if got := relatedIDs(t, base+"&personal=1", "p-other"); !got["0123456789a"] {
		t.Fatalf("another profile's skips leaked: %v", got)
	}
}

// local/related?seed= (targeted radio) honours the exclusions too.
func TestLocalRelatedSeedExclusions(t *testing.T) {
	useSkipDB(t)
	relatedFixture(t)
	got := relatedIDs(t, "/api/v1/local/related?seed=artist:"+artistID("Daft Punk")+"&exclude=a1b2c3d4e5f,0123456789a", "")
	if got["a1b2c3d4e5f"] || got["0123456789a"] || !got["e182ccc85ad"] {
		t.Fatalf("seed radio exclusions: %v", got)
	}
}

// personal=1 bypasses the shared response cache (the answer depends on the
// profile); exclude= is part of the cache key.
func TestPersonalRelatedBypassesSharedCache(t *testing.T) {
	t.Setenv("YTM_API_CACHE", "")
	e := echo.New()
	calls := 0
	h := cacheResponseUnlessWith(newResponseCache(10), time.Minute, perProfileRelated, func(c echo.Context) error {
		calls++
		ck, _ := c.Cookie("bbp")
		return c.String(http.StatusOK, fmt.Sprintf("p=%s ex=%s", ck.Value, c.QueryParam("exclude")))
	})
	do := func(url, pid string) (string, string) {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.AddCookie(&http.Cookie{Name: "bbp", Value: pid})
		rec := httptest.NewRecorder()
		if err := h(e.NewContext(req, rec)); err != nil {
			t.Fatal(err)
		}
		return rec.Body.String(), rec.Header().Get("X-Ytm-Cache")
	}
	b1, c1 := do("/api/v1/local/related?lid=e182ccc85ad&personal=1", "A")
	b2, c2 := do("/api/v1/local/related?lid=e182ccc85ad&personal=1", "B")
	if c1 != "BYPASS" || c2 != "BYPASS" || b1 == b2 {
		t.Fatalf("personal=1 must bypass: %s %s %q %q", c1, c2, b1, b2)
	}
	_, c3 := do("/api/v1/local/related?lid=e182ccc85ad&exclude=x", "A")
	b4, c4 := do("/api/v1/local/related?lid=e182ccc85ad&exclude=y", "A")
	if c3 != "MISS" || c4 != "MISS" || !strings.Contains(b4, "ex=y") {
		t.Fatalf("exclude= must key the cache: %s %s %q", c3, c4, b4)
	}
}

// local/mix (the context continuation): exclude= and personal=1 are left
// out and the mix stays full when the library allows it.
func TestLocalMixExclusions(t *testing.T) {
	useSkipDB(t)
	stub := newMixStub(t)
	var ex []string
	for i := 0; i < 10; i++ {
		ex = append(ex, mstr(stub.tracks[i], "lid"))
	}
	skipped := mstr(stub.tracks[10], "lid")
	addSkips(t, "p-test", skipped, time.Hour, 2*time.Hour) // ctxFor's cookie is p-test
	resp := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=1990&personal=1&exclude="+strings.Join(ex, ","))
	items, _ := resp["items"].([]interface{})
	if len(items) < 35 {
		t.Fatalf("mix shrank to %d items", len(items))
	}
	bad := map[string]bool{skipped: true}
	for _, l := range ex {
		bad[l] = true
	}
	for _, it := range items {
		if v := mstr(it.(map[string]interface{}), "videoId"); bad[v] {
			t.Fatalf("excluded ref %s in the mix", v)
		}
	}
}

func TestRequestExclusionsBounded(t *testing.T) {
	var refs []string
	for i := 0; i < maxExcludeParam+50; i++ {
		refs = append(refs, fmt.Sprintf("%011x", i))
	}
	c, _ := ctxFor(http.MethodGet, "/api/v1/local/related?lid=x&exclude="+strings.Join(refs, ",")+",,%20", "", nil)
	if n := len(requestExclusions(c)); n != maxExcludeParam {
		t.Fatalf("exclusions = %d, want %d", n, maxExcludeParam)
	}
}
