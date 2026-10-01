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
	body := strings.TrimSuffix(songBody, "}") + fmt.Sprintf(`,"playedAt":%d,"clientSentAt":%d}`, at, time.Now().UnixMilli())
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
	if _, ok := data["clientSentAt"]; ok {
		t.Fatalf("clientSentAt leaked into the stored item: %s", ev.Data)
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

// I10: the outbox replays the same (ref, playedAt) from two tabs or after a
// lost response: one row.
func TestRecordPlayIdempotentOnPlayedAt(t *testing.T) {
	useTestDB(t)
	at := time.Now().Add(-20 * time.Minute).UnixMilli()
	sent := time.Now().UnixMilli()
	body := strings.TrimSuffix(songBody, "}") + fmt.Sprintf(`,"playedAt":%d,"clientSentAt":%d}`, at, sent)
	for i := 0; i < 2; i++ {
		c, rec := ctxFor(http.MethodPost, "/api/v1/me/history", body, map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"})
		if err := MeRecordPlayHandler(c); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("post %d: %v status %d", i, err, rec.Code)
		}
	}
	var n int64
	db.DB.Model(&db.PlayEvent{}).Count(&n)
	if n != 1 {
		t.Fatalf("got %d rows, want 1", n)
	}
	// A real later play of the same track (playedAt 5 min after) is a new row.
	later := strings.TrimSuffix(songBody, "}") + fmt.Sprintf(`,"playedAt":%d,"clientSentAt":%d}`, at+5*60*1000, sent)
	c, _ := ctxFor(http.MethodPost, "/api/v1/me/history", later, map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"})
	if err := MeRecordPlayHandler(c); err != nil {
		t.Fatal(err)
	}
	db.DB.Model(&db.PlayEvent{}).Count(&n)
	if n != 2 {
		t.Fatalf("got %d rows after a later play, want 2", n)
	}
}

// I11: direct POSTs trust the client clock only within 5 min of the server;
// outbox replays are moved onto the server clock when the client is skewed.
func TestStampPlayedAtClockSkew(t *testing.T) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	ms := func(d time.Duration) float64 { return float64(now.Add(d).UnixMilli()) }
	cases := []struct {
		name   string
		played interface{}
		sent   interface{}
		want   time.Time
	}{
		{"direct, no playedAt", nil, nil, now},
		{"direct, 30 s off", ms(-30 * time.Second), nil, now.Add(-30 * time.Second)},
		{"direct, phone 3 h behind", ms(-3 * time.Hour), nil, now},
		{"direct, phone 10 min ahead", ms(10 * time.Minute), nil, now},
		{"replay 2 h old, clock ok", ms(-2 * time.Hour), ms(-time.Second), now.Add(-2 * time.Hour)},
		{"replay 2 h old, clock 1 min behind (kept)", ms(-2*time.Hour - time.Minute), ms(-time.Minute), now.Add(-2*time.Hour - time.Minute)},
		// the phone is 3 h behind: its "1 day ago" play was really 1 day ago on the server clock
		{"replay, clock 3 h behind", ms(-27 * time.Hour), ms(-3 * time.Hour), now.Add(-24 * time.Hour)},
		{"replay, clock 3 h ahead", ms(-21 * time.Hour), ms(3 * time.Hour), now.Add(-24 * time.Hour)},
		{"replay 8 days old", ms(-8 * 24 * time.Hour), ms(0), now},
		{"replay in the future", ms(time.Hour), ms(0), now},
		{"replay, garbage sentAt = direct rule", ms(-2 * time.Hour), "x", now},
	}
	for _, c := range cases {
		if got := stampPlayedAt(c.played, c.sent, now); !got.Equal(c.want) {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestRecordPlayDirectSkewedClockUsesServerTime(t *testing.T) {
	useTestDB(t)
	at := time.Now().Add(-3 * time.Hour).UnixMilli()
	body := strings.TrimSuffix(songBody, "}") + fmt.Sprintf(`,"playedAt":%d}`, at)
	c, _ := ctxFor(http.MethodPost, "/api/v1/me/history", body, map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"})
	if err := MeRecordPlayHandler(c); err != nil {
		t.Fatal(err)
	}
	var ev db.PlayEvent
	if err := db.DB.First(&ev).Error; err != nil {
		t.Fatalf("no event: %v", err)
	}
	if time.Since(ev.PlayedAt) > time.Minute {
		t.Fatalf("skewed direct playedAt kept: %v", ev.PlayedAt)
	}
}
