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
