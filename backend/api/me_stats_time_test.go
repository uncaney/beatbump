package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
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
	s := computeStreaks(evs, mins, now, fixedTZ(0))
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
	if s := computeStreaks(evs, nil, now, fixedTZ(0)); s.Current != 2 || s.Longest != 2 {
		t.Fatalf("yesterday keeps the streak alive: current=%d longest=%d", s.Current, s.Longest)
	}
	// two days ago only: the streak is broken.
	evs = []statEvent{ev("A", now.AddDate(0, 0, -3)), ev("A", now.AddDate(0, 0, -2))}
	if s := computeStreaks(evs, nil, now, fixedTZ(0)); s.Current != 0 || s.Longest != 2 {
		t.Fatalf("broken streak: current=%d longest=%d", s.Current, s.Longest)
	}
	if s := computeStreaks(nil, nil, now, fixedTZ(0)); s.Current != 0 || s.Longest != 0 || s.LastDay != "" || len(s.Days) != streakWindowDays {
		t.Fatalf("empty: %+v", s)
	}
	// unknown ref length: the 3.5 min estimate
	s := computeStreaks([]statEvent{ev("Z", now)}, map[string]float64{}, now, fixedTZ(0))
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
	if s := computeStreaks(evs, nil, now, fixedTZ(0)); s.Current != 2 || s.LastDay != "2026-10-02" {
		t.Fatalf("utc: %+v", s.Current)
	}
	if s := computeStreaks(evs, nil, now, fixedTZ(120)); s.Current != 2 || s.LastDay != "2026-10-03" || s.Days[len(s.Days)-1].Date != "2026-10-03" {
		t.Fatalf("utc+2: current=%d lastDay=%s", s.Current, s.LastDay)
	}
	// Two plays 90 min apart around UTC midnight: two days in UTC, ONE day
	// in UTC+2 (both after local midnight... 01:15 and 02:45).
	c := time.Date(2026, 10, 1, 23, 15, 0, 0, time.UTC)
	d := time.Date(2026, 10, 2, 0, 45, 0, 0, time.UTC)
	if s := computeStreaks([]statEvent{ev("A", c), ev("A", d)}, nil, d, fixedTZ(0)); s.Longest != 2 {
		t.Fatalf("utc split: longest=%d", s.Longest)
	}
	if s := computeStreaks([]statEvent{ev("A", c), ev("A", d)}, nil, d, fixedTZ(120)); s.Longest != 1 || s.Current != 1 {
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
	c := computeClock([]statEvent{ev("A", sat1), ev("A", sat2), ev("B", mon)}, mins, fixedTZ(0))
	if c.Minutes[5][20] != 4 || c.Minutes[5][21] != 4 || c.Minutes[0][8] != 2 {
		t.Fatalf("matrix: sat20=%v sat21=%v mon8=%v", c.Minutes[5][20], c.Minutes[5][21], c.Minutes[0][8])
	}
	if c.TopDay != 5 || c.Total != 10 {
		t.Fatalf("topDay=%d total=%v", c.TopDay, c.Total)
	}
	// UTC+4: Saturday 21:30 UTC is Sunday 01:30 local.
	c = computeClock([]statEvent{ev("A", sat2)}, mins, fixedTZ(240))
	if c.Minutes[6][1] != 4 || c.TopDay != 6 || c.TopHour != 1 {
		t.Fatalf("tz shift: sun1=%v topDay=%d topHour=%d", c.Minutes[6][1], c.TopDay, c.TopHour)
	}
	if e := computeClock(nil, nil, fixedTZ(0)); e.TopDay != -1 || e.TopHour != -1 || e.Total != 0 {
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

// L12-11: an IANA zone places each play with the offset in force AT the
// play, across the 2026-10-25 change (03:00 CEST -> 02:00 CET, 01:00 UTC).
func TestStatsZoneAcrossDST(t *testing.T) {
	paris := parseStatsTZ("Europe/Paris")
	if paris == nil {
		t.Fatal("Europe/Paris not loaded (time/tzdata)")
	}
	evs := []statEvent{
		ev("A", time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)),
		ev("A", time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)),
		// 00:30 CEST on Sunday 25: the only play of that local day
		ev("A", time.Date(2026, 10, 24, 22, 30, 0, 0, time.UTC)),
		// 00:30 CET on Monday 26 (after the change)
		ev("A", time.Date(2026, 10, 25, 23, 30, 0, 0, time.UTC)),
	}
	now := time.Date(2026, 10, 26, 13, 0, 0, 0, time.UTC)
	s := computeStreaks(evs, nil, now, paris)
	if s.Current != 4 || s.Longest != 4 || s.LastDay != "2026-10-26" || s.TZ != 60 || s.Zone != "Europe/Paris" {
		t.Fatalf("zone streak: %+v", s)
	}
	// The fixed winter offset (what tz=60 sends after the change) loses the
	// Sunday: 22:30 UTC becomes 23:30 on Saturday.
	if f := computeStreaks(evs, nil, now, fixedTZ(60)); f.Current != 1 || f.Zone != "" {
		t.Fatalf("fixed offset should break the run: %+v", f)
	}
	c := computeClock(evs, map[string]float64{"A": 3}, paris)
	if c.Minutes[6][0] != 3 || c.Minutes[0][0] != 3 || c.Minutes[5][23] != 0 {
		t.Fatalf("clock: sun0=%v mon0=%v sat23=%v", c.Minutes[6][0], c.Minutes[0][0], c.Minutes[5][23])
	}
	// Year: a play at 22:30 UTC on 31 March 2026 (00:30 CEST, 1 April) is an
	// April play; New Year's Eve 23:30 UTC 2025 is a 2026 play in Paris.
	yevs := []statEvent{
		ev("A", time.Date(2026, 3, 31, 22, 30, 0, 0, time.UTC)),
		ev("A", time.Date(2025, 12, 31, 23, 30, 0, 0, time.UTC)),
	}
	rows := []playRow{{Ref: "A", Cnt: 2, Data: `{"videoId":"A","title":"T","length":{"text":"3:00"}}`}}
	y := computeYear(yevs, rows, 2026, paris)
	if y.Months[3] == 0 || y.Months[2] != 0 || y.Months[0] == 0 || y.Plays != 2 {
		t.Fatalf("year months %v plays %d", y.Months, y.Plays)
	}
}

func TestParseStatsTZ(t *testing.T) {
	cases := map[string]string{
		"Europe/Paris":     "Europe/Paris",
		"America/New_York": "America/New_York",
		"120":              "viewer",
		"-300":             "viewer",
		"9999":             "viewer", // out of range: 0
		"Local":            "",
		"../../etc/passwd": "",
		"Nowhere/Atlantis": "",
		"":                 "",
	}
	for in, want := range cases {
		got := ""
		if loc := parseStatsTZ(in); loc != nil {
			got = loc.String()
		}
		if got != want {
			t.Errorf("parseStatsTZ(%q) = %q, want %q", in, got, want)
		}
	}
	if loc := parseStatsTZ("9999"); tzOffsetMin(loc, time.Now()) != 0 {
		t.Error("out-of-range offset should be 0")
	}
}

func TestMeStreaksHandler_ZoneNameAndMemo(t *testing.T) {
	useTestDB(t)
	seedPlays(t)
	out := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tz=Europe%2FParis&tzo=120")
	if out["zone"] != "Europe/Paris" {
		t.Fatalf("zone: %v", out["zone"])
	}
	// an unknown name falls back to tzo
	if fb := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tz=Nowhere%2FAtlantis&tzo=120"); fb["tz"] != 120.0 || fb["zone"] != nil {
		t.Fatalf("fallback: tz=%v zone=%v", fb["tz"], fb["zone"])
	}
	before := out["longest"]
	// A play written behind the handler's back is not seen (memo) ...
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "Z", Title: "Z", Data: `{"videoId":"Z"}`, PlayedAt: time.Now().AddDate(0, 0, -2)})
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "Z", Title: "Z", Data: `{"videoId":"Z"}`, PlayedAt: time.Now().AddDate(0, 0, -3)})
	if again := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tz=Europe%2FParis&tzo=120"); again["longest"] != before {
		t.Fatalf("memo not used: %v -> %v", before, again["longest"])
	}
	// ... until the profile's memo is dropped (new play) or 5 min pass.
	statsTimeNow = func() time.Time { return time.Now().Add(statsTimeMemoTTL + time.Second) }
	t.Cleanup(func() { statsTimeNow = time.Now })
	if later := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tz=Europe%2FParis&tzo=120"); later["longest"] == before {
		t.Fatalf("memo outlived its TTL: %v", later["longest"])
	}
	statsTimeNow = time.Now
	invalidateStatsTimeMemo("p-test")
	statsTimeMu.Lock()
	n := len(statsTimeMemo)
	statsTimeMu.Unlock()
	if n != 0 {
		t.Fatalf("invalidate left %d entries", n)
	}
}

// L13-10: a request without the bbp cookie gets a fresh random profile id,
// so its time views are computed but never memoised: 600 such requests
// leave the memo empty, a named profile's entry is kept.
func TestStatsTimeMemoSkipsCookieless(t *testing.T) {
	useTestDB(t)
	seedPlays(t)
	if out := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tzo=120"); out["longest"] == nil {
		t.Fatalf("named answer: %v", out)
	}
	if n := statsTimeMemoLen(); n != 1 {
		t.Fatalf("named profile memo: %d entries, want 1", n)
	}
	for i := 0; i < 600; i++ {
		for _, h := range []echo.HandlerFunc{MeStreaksHandler, MeClockHandler, MeYearHandler} {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/me/stats/x?tzo=120", nil)
			rec := httptest.NewRecorder()
			if err := h(echo.New().NewContext(req, rec)); err != nil || rec.Code != http.StatusOK {
				t.Fatalf("cookieless %d: %v %d", i, err, rec.Code)
			}
		}
	}
	if n := statsTimeMemoLen(); n != 1 {
		t.Fatalf("cookieless visitors changed the memo: %d entries, want 1", n)
	}
	// The named entry is still served from the memo.
	before := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tzo=120")["longest"]
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "Z", Title: "Z", Data: `{"videoId":"Z"}`, PlayedAt: time.Now().AddDate(0, 0, -2)})
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "Z", Title: "Z", Data: `{"videoId":"Z"}`, PlayedAt: time.Now().AddDate(0, 0, -3)})
	if again := getJSON(t, MeStreaksHandler, "/api/v1/me/stats/streaks?tzo=120")["longest"]; again != before {
		t.Fatalf("named memo evicted by cookieless traffic: %v -> %v", before, again)
	}
}

// L13-10: a full memo evicts its expired entries, then the least recently
// used one; the hot entries survive (no full reset).
func TestStatsTimeMemoLRU(t *testing.T) {
	resetStatsTimeMemo()
	t.Cleanup(resetStatsTimeMemo)
	base := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	statsTimeNow = func() time.Time { return base }
	t.Cleanup(func() { statsTimeNow = time.Now })
	computed := 0
	get := func(i int) interface{} {
		return statsTimeCached("p"+strconv.Itoa(i), "k"+strconv.Itoa(i), true, func() interface{} { computed++; return i })
	}
	for i := 0; i < statsTimeMemoMax; i++ {
		get(i)
	}
	if computed != statsTimeMemoMax || statsTimeMemoLen() != statsTimeMemoMax {
		t.Fatalf("fill: computed %d len %d", computed, statsTimeMemoLen())
	}
	get(0)                // k0 becomes the most recently used
	get(statsTimeMemoMax) // full: k1 (least recently used) goes, nothing else
	if statsTimeMemoLen() != statsTimeMemoMax {
		t.Fatalf("len after overflow: %d", statsTimeMemoLen())
	}
	computed = 0
	get(0)
	get(2)
	if computed != 0 {
		t.Fatalf("hot entries were reset: %d recomputed", computed)
	}
	get(1)
	if computed != 1 {
		t.Fatalf("the least recently used entry should have been evicted")
	}
	// Expired entries go first when the map is full.
	statsTimeNow = func() time.Time { return base.Add(statsTimeMemoTTL + time.Second) }
	computed = 0
	get(statsTimeMemoMax + 1)
	if computed != 1 || statsTimeMemoLen() != 1 {
		t.Fatalf("expired sweep: computed %d len %d (want 1, 1)", computed, statsTimeMemoLen())
	}
}
