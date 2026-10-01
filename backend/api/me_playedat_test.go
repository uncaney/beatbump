package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

func TestClientPlayedAtBounds(t *testing.T) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	ms := func(d time.Duration) float64 { return float64(now.Add(d).UnixMilli()) }
	cases := []struct {
		name string
		in   interface{}
		want time.Time
	}{
		{"missing", nil, now},
		{"2h ago", ms(-2 * time.Hour), now.Add(-2 * time.Hour)},
		{"6d23h ago", ms(-(7*24 - 1) * time.Hour), now.Add(-(7*24 - 1) * time.Hour)},
		{"8 days ago", ms(-8 * 24 * time.Hour), now},
		{"future", ms(time.Minute), now},
		{"numeric string", fmt.Sprint(now.Add(-time.Hour).UnixMilli()), now.Add(-time.Hour)},
		{"rfc3339", now.Add(-3 * time.Hour).Format(time.RFC3339), now.Add(-3 * time.Hour)},
		{"garbage", "yesterday", now},
		{"bool", true, now},
	}
	for _, c := range cases {
		if got := clientPlayedAt(c.in, now); !got.Equal(c.want) {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestRecordPlayKeepsClientPlayedAt(t *testing.T) {
	useTestDB(t)
	at := time.Now().Add(-90 * time.Minute).UnixMilli()
	body := strings.TrimSuffix(songBody, "}") + fmt.Sprintf(`,"playedAt":%d}`, at)
	c, rec := ctxFor(http.MethodPost, "/api/v1/me/history", body, map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"})
	if err := MeRecordPlayHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("handler: %v status %d", err, rec.Code)
	}
	var ev db.PlayEvent
	if err := db.DB.First(&ev).Error; err != nil {
		t.Fatalf("no event: %v", err)
	}
	if ev.PlayedAt.UnixMilli() != at {
		t.Fatalf("playedAt %v, want %v", ev.PlayedAt.UnixMilli(), at)
	}
	var data map[string]interface{}
	_ = json.Unmarshal([]byte(ev.Data), &data)
	if _, ok := data["playedAt"]; ok {
		t.Fatalf("playedAt leaked into the stored item: %s", ev.Data)
	}
}

func TestRecordPlayIgnoresFuturePlayedAt(t *testing.T) {
	useTestDB(t)
	at := time.Now().Add(48 * time.Hour).UnixMilli()
	body := strings.TrimSuffix(songBody, "}") + fmt.Sprintf(`,"playedAt":%d}`, at)
	c, _ := ctxFor(http.MethodPost, "/api/v1/me/history", body, map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"})
	before := time.Now()
	if err := MeRecordPlayHandler(c); err != nil {
		t.Fatal(err)
	}
	var ev db.PlayEvent
	if err := db.DB.First(&ev).Error; err != nil {
		t.Fatalf("no event: %v", err)
	}
	if ev.PlayedAt.Before(before.Add(-time.Second)) || ev.PlayedAt.After(time.Now().Add(time.Second)) {
		t.Fatalf("future playedAt kept: %v", ev.PlayedAt)
	}
}
