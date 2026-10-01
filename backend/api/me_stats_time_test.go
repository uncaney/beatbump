package api

import (
	"encoding/json"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// ev builds a synthetic play event at t.
func ev(ref string, t time.Time) statEvent { return statEvent{Ref: ref, Source: "local", PlayedAt: t} }

func TestComputeStreaks_GapsAndRecord(t *testing.T) {
	now := time.Date(2026, 10, 2, 15, 0, 0, 0, time.UTC)
	day := func(back int) time.Time { return now.AddDate(0, 0, -back).Add(-time.Hour) }
	var evs []statEvent
	// record run of 4 days (back 20..17), a gap, then 3 days ending today.
	for _, b := range []int{20, 19, 18, 17, 10, 2, 1, 0} {
		evs = append(evs, ev("A", day(b)))
	}
	evs = append(evs, ev("A", day(0)), ev("B", day(0))) // several plays on one day count once
	mins := map[string]float64{"A": 4, "B": 2}
	s := computeStreaks(evs, mins, now, 0)
	if s.Current != 3 || s.Longest != 4 {
		t.Fatalf("current=%d longest=%d, want 3 / 4", s.Current, s.Longest)
	}
	if s.LastDay != "2026-10-02" {
		t.Fatalf("lastDay=%q", s.LastDay)
	}
	if len(s.Days) != streakWindowDays || s.Days[len(s.Days)-1].Date != "2026-10-02" || s.Days[0].Date != "2026-07-05" {
		t.Fatalf("days window: %d first=%s last=%s", len(s.Days), s.Days[0].Date, s.Days[len(s.Days)-1].Date)
	}
	if got := s.Days[len(s.Days)-1].Minutes; got != 10 { // A x2 + B
		t.Fatalf("today minutes=%v, want 10", got)
	}
	if s.Days[len(s.Days)-4].Minutes != 0 { // day back 3: no play
		t.Fatalf("gap day should be 0: %+v", s.Days[len(s.Days)-4])
	}
}

func TestComputeStreaks_TodayWithoutPlay(t *testing.T) {
	now := time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)
	evs := []statEvent{ev("A", now.AddDate(0, 0, -2)), ev("A", now.AddDate(0, 0, -1))}
	if s := computeStreaks(evs, nil, now, 0); s.Current != 2 || s.Longest != 2 {
		t.Fatalf("yesterday keeps the streak alive: current=%d longest=%d", s.Current, s.Longest)
	}
	// two days ago only: the streak is broken.
	evs = []statEvent{ev("A", now.AddDate(0, 0, -3)), ev("A", now.AddDate(0, 0, -2))}
	if s := computeStreaks(evs, nil, now, 0); s.Current != 0 || s.Longest != 2 {
		t.Fatalf("broken streak: current=%d longest=%d", s.Current, s.Longest)
	}
	if s := computeStreaks(nil, nil, now, 0); s.Current != 0 || s.Longest != 0 || s.LastDay != "" || len(s.Days) != streakWindowDays {
		t.Fatalf("empty: %+v", s)
	}
	// unknown ref length: the 3.5 min estimate
	s := computeStreaks([]statEvent{ev("Z", now)}, map[string]float64{}, now, 0)
	if s.Days[len(s.Days)-1].Minutes != 3.5 {
		t.Fatalf("estimate: %v", s.Days[len(s.Days)-1].Minutes)
	}
}

func TestComputeStreaks_TimezoneEdge(t *testing.T) {
	// 22:30 UTC on 1 Oct and 22:30 UTC on 2 Oct; now = 23:00 UTC on 2 Oct.
	// UTC: two consecutive days, today played -> 2.
	// UTC+2 (Paris summer): 00:30 on 2 Oct and 00:30 on 3 Oct; now is
	// 01:00 on 3 Oct -> still 2 consecutive days, and lastDay = 3 Oct.
	// UTC-5: 17:30 on 1 Oct, 17:30 on 2 Oct.
	a := time.Date(2026, 10, 1, 22, 30, 0, 0, time.UTC)
	b := time.Date(2026, 10, 2, 22, 30, 0, 0, time.UTC)
	now := time.Date(2026, 10, 2, 23, 0, 0, 0, time.UTC)
	evs := []statEvent{ev("A", a), ev("A", b)}
	if s := computeStreaks(evs, nil, now, 0); s.Current != 2 || s.LastDay != "2026-10-02" {
		t.Fatalf("utc: %+v", s.Current)
	}
	if s := computeStreaks(evs, nil, now, 120); s.Current != 2 || s.LastDay != "2026-10-03" || s.Days[len(s.Days)-1].Date != "2026-10-03" {
		t.Fatalf("utc+2: current=%d lastDay=%s", s.Current, s.LastDay)
	}
	// Two plays 90 min apart around UTC midnight: two days in UTC, ONE day
	// in UTC+2 (both after local midnight... 01:15 and 02:45).
	c := time.Date(2026, 10, 1, 23, 15, 0, 0, time.UTC)
	d := time.Date(2026, 10, 2, 0, 45, 0, 0, time.UTC)
	if s := computeStreaks([]statEvent{ev("A", c), ev("A", d)}, nil, d, 0); s.Longest != 2 {
		t.Fatalf("utc split: longest=%d", s.Longest)
	}
	if s := computeStreaks([]statEvent{ev("A", c), ev("A", d)}, nil, d, 120); s.Longest != 1 || s.Current != 1 {
		t.Fatalf("utc+2 same day: longest=%d current=%d", s.Longest, s.Current)
	}
}

func TestMeStreaksHandler_ProfileScoped(t *testing.T) {
	useTestDB(t)
	seedPlays(t) // p-test: today-ish (A, B, C), yesterday (A), 40 days ago (D); p-other: E now
	out := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tz=0")
	days, _ := out["days"].([]interface{})
	if len(days) != streakWindowDays {
		t.Fatalf("days len %d", len(days))
	}
	if out["longest"].(float64) < 1 || out["current"].(float64) < 1 {
		t.Fatalf("streaks: %v", out)
	}
	total := 0.0
	for _, d := range days {
		total += d.(map[string]interface{})["minutes"].(float64)
	}
	// p-test: A x3 (4 min) + B x2 (3.5 est.) + C (2) + D (3, 40 days ago) = 24.
	// The p-other play (3 min) must not leak in.
	if total < 23.9 || total > 24.1 {
		raw, _ := json.Marshal(out)
		t.Fatalf("total minutes %.1f, want 24: %s", total, raw)
	}
	var n int64
	db.DB.Model(&db.PlayEvent{}).Count(&n)
	if n != 8 {
		t.Fatalf("seed changed: %d", n)
	}
}

func TestComputeClock(t *testing.T) {
	// Saturday 3 Oct 2026, 20:10 UTC and 21:30 UTC; Monday 5 Oct 08:00 UTC.
	sat1 := time.Date(2026, 10, 3, 20, 10, 0, 0, time.UTC)
	sat2 := time.Date(2026, 10, 3, 21, 30, 0, 0, time.UTC)
	mon := time.Date(2026, 10, 5, 8, 0, 0, 0, time.UTC)
	mins := map[string]float64{"A": 4, "B": 2}
	c := computeClock([]statEvent{ev("A", sat1), ev("A", sat2), ev("B", mon)}, mins, 0)
	if c.Minutes[5][20] != 4 || c.Minutes[5][21] != 4 || c.Minutes[0][8] != 2 {
		t.Fatalf("matrix: sat20=%v sat21=%v mon8=%v", c.Minutes[5][20], c.Minutes[5][21], c.Minutes[0][8])
	}
	if c.TopDay != 5 || c.Total != 10 {
		t.Fatalf("topDay=%d total=%v", c.TopDay, c.Total)
	}
	// UTC+4: Saturday 21:30 UTC is Sunday 01:30 local.
	c = computeClock([]statEvent{ev("A", sat2)}, mins, 240)
	if c.Minutes[6][1] != 4 || c.TopDay != 6 || c.TopHour != 1 {
		t.Fatalf("tz shift: sun1=%v topDay=%d topHour=%d", c.Minutes[6][1], c.TopDay, c.TopHour)
	}
	if e := computeClock(nil, nil, 0); e.TopDay != -1 || e.TopHour != -1 || e.Total != 0 {
		t.Fatalf("empty: %+v", e)
	}
}

func TestMeClockHandler(t *testing.T) {
	useTestDB(t)
	seedPlays(t)
	out := getJSON(t, MeClockHandler, "/api/v1/me/stats/clock?tz=0&days=30")
	m, _ := out["minutes"].([]interface{})
	if len(m) != 7 || len(m[0].([]interface{})) != 24 {
		t.Fatalf("shape: %v", out["minutes"])
	}
	// 30 days: A x3 (12) + B x2 (7) + C (2) = 21; D (40 days ago) and p-other out.
	if tot := out["total"].(float64); tot != 21 {
		t.Fatalf("total %v, want 21", tot)
	}
	if out["days"].(float64) != 30 {
		t.Fatalf("days %v", out["days"])
	}
}
