package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// seedRediscover writes a synthetic history around the three windows
// (older than 60 d / 30-60 d / last 30 d) for profile p-test:
//
//	A: 3 plays 90 d ago, nothing since            -> qualifies (3 old plays)
//	B: 4 plays 100 d ago, nothing since           -> qualifies (4, ranked first)
//	C: 3 plays 90 d ago + 1 play 10 d ago         -> excluded (played recently)
//	D: 2 plays 90 d ago                           -> excluded (< 3 old plays)
//	E: 3 plays 45 d ago                           -> excluded (not older than 60 d)
//	F: 3 plays 90 d ago, 1 play 40 d ago          -> qualifies (40 d is outside the quiet window)
//	G: 3 plays 90 d ago, empty stored item        -> no row (nothing to render)
//	H: 3 plays 90 d ago, OTHER profile            -> excluded
func seedRediscover(t *testing.T, now time.Time) {
	t.Helper()
	item := func(ref string) string {
		raw, _ := json.Marshal(map[string]interface{}{"videoId": ref, "title": "Song " + ref, "thumbnails": []interface{}{map[string]interface{}{"url": "/cover?lid=" + ref}},
			"artistInfo": map[string]interface{}{"artist": []interface{}{map[string]interface{}{"text": "Artist " + ref}}}})
		return string(raw)
	}
	var evs []db.PlayEvent
	add := func(pid, ref string, daysAgo, n int, data string) {
		for i := 0; i < n; i++ {
			evs = append(evs, db.PlayEvent{ProfileID: pid, Ref: ref, Title: "Song " + ref, Source: "local", Data: data,
				PlayedAt: now.Add(-time.Duration(daysAgo)*24*time.Hour - time.Duration(i)*time.Hour)})
		}
	}
	add("p-test", "A", 90, 3, item("A"))
	add("p-test", "B", 100, 4, item("B"))
	add("p-test", "C", 90, 3, item("C"))
	add("p-test", "C", 10, 1, item("C"))
	add("p-test", "D", 90, 2, item("D"))
	add("p-test", "E", 45, 3, item("E"))
	add("p-test", "F", 90, 3, item("F"))
	add("p-test", "F", 40, 1, item("F"))
	add("p-test", "G", 90, 3, "")
	add("p-other", "H", 90, 3, item("H"))
	if err := db.DB.Create(&evs).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func TestMeRediscoverWindows(t *testing.T) {
	useTestDB(t)
	now := time.Now()
	seedRediscover(t, now)

	rows := rediscoverRows("p-test", now, 50)
	got := map[string]int{}
	for _, r := range rows {
		got[r.Ref] = r.Old
	}
	for _, want := range []string{"A", "B", "F", "G"} {
		if _, ok := got[want]; !ok {
			t.Errorf("%s should qualify, rows=%v", want, got)
		}
	}
	for _, no := range []string{"C", "D", "E", "H"} {
		if _, ok := got[no]; ok {
			t.Errorf("%s must not qualify, rows=%v", no, got)
		}
	}
	if len(rows) == 0 || rows[0].Ref != "B" || rows[0].Old != 4 {
		t.Fatalf("most old plays first, got %+v", rows)
	}

	resp := getJSON(t, MeRediscoverHandler, "/api/v1/me/stats/rediscover?limit=12")
	items, _ := resp["items"].([]interface{})
	if len(items) != 3 {
		t.Fatalf("expected A, B, F as renderable items (G has no stored item), got %d: %v", len(items), items)
	}
	first := items[0].(map[string]interface{})
	if first["videoId"] != "B" || first["title"] != "Song B" {
		t.Fatalf("first item should be B, got %v", first)
	}
	counts, _ := resp["counts"].([]interface{})
	if len(counts) != 3 || counts[0].(map[string]interface{})["plays"] != 4.0 {
		t.Fatalf("counts = %v", counts)
	}

	limited := getJSON(t, MeRediscoverHandler, "/api/v1/me/stats/rediscover?limit=1")
	if l, _ := limited["items"].([]interface{}); len(l) != 1 {
		t.Fatalf("limit=1: %d items", len(l))
	}

	// a profile without history: nothing (the row stays hidden)
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/rediscover", "", nil)
	c.Request().Header.Del("Cookie")
	c.Request().AddCookie(&http.Cookie{Name: "bbp", Value: "p-nobody"})
	if err := MeRediscoverHandler(c); err != nil {
		t.Fatal(err)
	}
	var fresh map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &fresh); err != nil {
		t.Fatal(err)
	}
	if f, _ := fresh["items"].([]interface{}); len(f) != 0 {
		t.Fatalf("fresh profile: expected no items, got %v", f)
	}
}
