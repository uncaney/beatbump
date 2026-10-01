package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

func TestMeRecentExposesPlayedAt(t *testing.T) {
	useTestDB(t)
	t0 := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	for i, ev := range []struct {
		ref string
		at  time.Time
	}{{"aaaaaaaaaaa", t0}, {"bbbbbbbbbbb", t0.Add(time.Hour)}, {"aaaaaaaaaaa", t0.Add(48 * time.Hour)}} {
		db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: ev.ref, Title: "T", Data: `{"videoId":"` + ev.ref + `","title":"T"}`, PlayedAt: ev.at})
		_ = i
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/recent?limit=10", "", nil)
	if err := MeRecentHandler(c); err != nil {
		t.Fatal(err)
	}
	var body struct {
		Items    []map[string]interface{} `json:"items"`
		PlayedAt []int64                  `json:"playedAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 2 || len(body.PlayedAt) != 2 {
		t.Fatalf("body %s", rec.Body.String())
	}
	if body.Items[0]["videoId"] != "aaaaaaaaaaa" || body.PlayedAt[0] != t0.Add(48*time.Hour).UnixMilli() || body.PlayedAt[1] != t0.Add(time.Hour).UnixMilli() {
		t.Fatalf("body %s", rec.Body.String())
	}
}

// I18: events=1 lists every play (a ref played on two days appears twice),
// most recent first, bounded by limit.
func TestMeRecentEventsListsEveryPlay(t *testing.T) {
	useTestDB(t)
	t0 := time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)
	for _, ev := range []struct {
		ref string
		at  time.Time
	}{{"aaaaaaaaaaa", t0}, {"bbbbbbbbbbb", t0.Add(time.Hour)}, {"aaaaaaaaaaa", t0.Add(48 * time.Hour)}} {
		db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: ev.ref, Title: "T", Data: `{"videoId":"` + ev.ref + `","title":"T"}`, PlayedAt: ev.at})
	}
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "ccccccccccc", Title: "T", Data: "", PlayedAt: t0.Add(2 * time.Hour)})
	get := func(q string) (items []map[string]interface{}, at []int64) {
		c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/recent?"+q, "", nil)
		if err := MeRecentHandler(c); err != nil {
			t.Fatal(err)
		}
		var body struct {
			Items    []map[string]interface{} `json:"items"`
			PlayedAt []int64                  `json:"playedAt"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Items, body.PlayedAt
	}
	items, at := get("limit=200&events=1")
	if len(items) != 3 || len(at) != 3 {
		t.Fatalf("got %d items / %d times, want 3", len(items), len(at))
	}
	if items[0]["videoId"] != "aaaaaaaaaaa" || items[2]["videoId"] != "aaaaaaaaaaa" || at[2] != t0.UnixMilli() || at[0] != t0.Add(48*time.Hour).UnixMilli() {
		t.Fatalf("order: %v %v", items, at)
	}
	items, _ = get("limit=2&events=1")
	if len(items) != 2 {
		t.Fatalf("limit not applied: %d", len(items))
	}
	items, _ = get("limit=200")
	if len(items) != 2 {
		t.Fatalf("default mode should stay one row per ref: %d", len(items))
	}
}
