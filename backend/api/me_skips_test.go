package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

func useSkipDB(t *testing.T) {
	t.Helper()
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.SkipEvent{}); err != nil {
		t.Fatalf("migrate skips: %v", err)
	}
}

func postSkip(t *testing.T, body string, hdr map[string]string) (int, map[string]interface{}) {
	t.Helper()
	c, rec := ctxFor(http.MethodPost, "/api/v1/me/skips", body, hdr)
	if err := MeRecordSkipHandler(c); err != nil {
		t.Fatalf("skip: %v", err)
	}
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func countSkips(t *testing.T) int64 {
	t.Helper()
	var n int64
	db.DB.Model(&db.SkipEvent{}).Count(&n)
	return n
}

func TestRecordSkipStoresEvent(t *testing.T) {
	useSkipDB(t)
	code, _ := postSkip(t, `{"lid":"0123456789a","position":7.5,"duration":240,"source":"mediasession"}`, nil)
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	var ev db.SkipEvent
	if err := db.DB.First(&ev).Error; err != nil {
		t.Fatal(err)
	}
	if ev.ProfileID != "p-test" || ev.Ref != "0123456789a" || ev.Origin != "local" || ev.Source != "mediasession" || ev.Position != 7.5 || ev.Duration != 240 {
		t.Fatalf("stored %+v", ev)
	}
	// a skip is not a play
	if n := countEvents(t); n != 0 {
		t.Fatalf("skip created %d play events", n)
	}
	// videoId works too, unknown source falls back to "player"
	if code, _ := postSkip(t, `{"videoId":"dQw4w9WgXcQ","position":3,"duration":0,"source":"evil"}`, nil); code != http.StatusOK {
		t.Fatalf("videoId skip status %d", code)
	}
	var yt db.SkipEvent
	db.DB.Where("ref = ?", "dQw4w9WgXcQ").First(&yt)
	if yt.Origin != "youtube" || yt.Source != "player" {
		t.Fatalf("youtube skip %+v", yt)
	}
}

func TestRecordSkipRejectsLateAndEmpty(t *testing.T) {
	useSkipDB(t)
	// 100 s into a 240 s track: past 20 s and past 30 % -> not a skip
	if code, out := postSkip(t, `{"lid":"0123456789a","position":100,"duration":240}`, nil); code != http.StatusBadRequest || out["error"] != "not_a_skip" {
		t.Fatalf("late press: %d %v", code, out)
	}
	// 60 s into a 600 s track: past 20 s but under 30 % -> skip
	if code, _ := postSkip(t, `{"lid":"0123456789a","position":60,"duration":600}`, nil); code != http.StatusOK {
		t.Fatalf("early fraction: %d", code)
	}
	// 25 s, unknown duration: not a skip
	if code, _ := postSkip(t, `{"lid":"0123456789a","position":25}`, nil); code != http.StatusBadRequest {
		t.Fatalf("unknown duration past 20 s: %d", code)
	}
	if code, _ := postSkip(t, `{"position":1}`, nil); code != http.StatusBadRequest {
		t.Fatalf("no ref: %d", code)
	}
	if n := countSkips(t); n != 1 {
		t.Fatalf("skips stored = %d, want 1", n)
	}
}

func TestRecordSkipHarnessIgnored(t *testing.T) {
	useSkipDB(t)
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "")
	code, out := postSkip(t, `{"lid":"0123456789a","position":2}`, map[string]string{"X-Ytm-Harness": "1"})
	if code != http.StatusOK || out["ignored"] != true || countSkips(t) != 0 {
		t.Fatalf("harness skip: %d %v n=%d", code, out, countSkips(t))
	}
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "1")
	postSkip(t, `{"lid":"0123456789a","position":2}`, map[string]string{"X-Ytm-Harness": "1"})
	if countSkips(t) != 1 {
		t.Fatalf("YTM_STATS_INCLUDE_HARNESS=1 should keep the harness skip")
	}
}

func TestRecordSkipOutboxReplayDatedAndIdempotent(t *testing.T) {
	useSkipDB(t)
	at := time.Now().Add(-2 * time.Hour).UnixMilli()
	sent := time.Now().UnixMilli()
	body := fmt.Sprintf(`{"lid":"0123456789a","position":4,"duration":200,"at":%d,"clientSentAt":%d}`, at, sent)
	postSkip(t, body, nil)
	code, out := postSkip(t, body, nil)
	if code != http.StatusOK || out["duplicate"] != true {
		t.Fatalf("replay: %d %v", code, out)
	}
	var ev db.SkipEvent
	db.DB.First(&ev)
	if d := ev.SkippedAt.UnixMilli() - at; d < -1000 || d > 1000 {
		t.Fatalf("skippedAt %v, want the client time", ev.SkippedAt)
	}
	if countSkips(t) != 1 {
		t.Fatalf("replay stored twice")
	}
}

func TestMeSkipsAggregates(t *testing.T) {
	useSkipDB(t)
	now := time.Now()
	add := func(pid, ref string, ago time.Duration) {
		db.DB.Create(&db.SkipEvent{ProfileID: pid, Ref: ref, Position: 3, SkippedAt: now.Add(-ago)})
	}
	add("p-test", "aaaaaaaaaaa", time.Hour)
	add("p-test", "aaaaaaaaaaa", 2*time.Hour)
	add("p-test", "aaaaaaaaaaa", 40*24*time.Hour) // outside days=30
	add("p-test", "bbbbbbbbbbb", time.Minute)
	add("other", "aaaaaaaaaaa", time.Minute) // another profile
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/skips?days=30", "", nil)
	if err := MeSkipsHandler(c); err != nil {
		t.Fatal(err)
	}
	var body struct {
		Rows []struct {
			Ref   string `json:"ref"`
			Count int    `json:"count"`
			Last  int64  `json:"last"`
		} `json:"rows"`
		Total int `json:"total"`
		Days  int `json:"days"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Days != 30 || body.Total != 3 || len(body.Rows) != 2 {
		t.Fatalf("body %+v", body)
	}
	if body.Rows[0].Ref != "aaaaaaaaaaa" || body.Rows[0].Count != 2 || body.Rows[1].Ref != "bbbbbbbbbbb" || body.Rows[1].Count != 1 {
		t.Fatalf("rows %+v", body.Rows)
	}
	if body.Rows[0].Last != now.Add(-time.Hour).UnixMilli() {
		t.Fatalf("last %d", body.Rows[0].Last)
	}
	c, rec = ctxFor(http.MethodGet, "/api/v1/me/skips?days=all", "", nil)
	_ = MeSkipsHandler(c)
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Total != 4 || body.Rows[0].Count != 3 {
		t.Fatalf("days=all %+v", body)
	}
}

func TestIsSkipPosition(t *testing.T) {
	cases := []struct {
		pos, dur float64
		want     bool
	}{
		{0, 0, true}, {19.9, 0, true}, {20, 0, false}, {20, 100, true}, {29, 100, true},
		{30, 100, false}, {25, 50, false}, {59, 200, true}, {60, 200, false}, {-1, 100, false},
	}
	for _, k := range cases {
		if got := isSkipPosition(k.pos, k.dur); got != k.want {
			t.Errorf("isSkipPosition(%v,%v)=%v want %v", k.pos, k.dur, got, k.want)
		}
	}
}

// L12-6: the write path purges rows older than 90 days, at most once an hour.
func TestSkipRetentionPurge(t *testing.T) {
	useSkipDB(t)
	skipLastPurge.Store(0)
	t.Cleanup(func() { skipLastPurge.Store(0) })
	now := time.Now()
	db.DB.Create(&db.SkipEvent{ProfileID: "p-test", Ref: "old-1", SkippedAt: now.Add(-91 * 24 * time.Hour)})
	db.DB.Create(&db.SkipEvent{ProfileID: "p-other", Ref: "old-2", SkippedAt: now.Add(-200 * 24 * time.Hour)})
	db.DB.Create(&db.SkipEvent{ProfileID: "p-test", Ref: "recent", SkippedAt: now.Add(-89 * 24 * time.Hour)})
	if code, _ := postSkip(t, `{"lid":"0123456789a","position":3,"duration":200,"source":"player"}`, nil); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if n := countSkips(t); n != 2 {
		t.Fatalf("after purge: %d rows, want 2 (recent + new)", n)
	}
	// within the hour: no second purge
	db.DB.Create(&db.SkipEvent{ProfileID: "p-test", Ref: "old-3", SkippedAt: now.Add(-100 * 24 * time.Hour)})
	if code, _ := postSkip(t, `{"lid":"0123456789b","position":3,"duration":200,"source":"player"}`, nil); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if n := countSkips(t); n != 4 {
		t.Fatalf("purged again within the hour: %d rows", n)
	}
	// an hour later the next write purges again
	if got := purgeOldSkips(now.Add(skipPurgeEvery + time.Minute)); got != 1 {
		t.Fatalf("hourly purge deleted %d, want 1", got)
	}
	// the composite index exists
	if !db.DB.Migrator().HasIndex(&db.SkipEvent{}, "idx_se_profile_ref_at") {
		t.Fatal("missing idx_se_profile_ref_at")
	}
}
