package api

// 41A (B6-22) "Série" and the weekday x hour grid on Ton mois, per profile
// (bbp cookie), from play_events only (skip_events are not plays):
//
//	GET /api/v1/me/stats/streaks?tz=120 -> {current, longest, lastDay, tz, days: [{date, minutes}] x 90}
//	GET /api/v1/me/stats/clock?tz=120&days=90 -> {days, tz, minutes: [7][24], topDay, topHour}
//
// A day counts when it holds at least one play event. A play event is only
// written after 30 s of listening (Player.svelte historyThreshold, half the
// track under 60 s), so ">= 1 play of >= 30 s" is ">= 1 row". Harness plays
// are never written (harnessRequest) unless YTM_STATS_INCLUDE_HARNESS=1.
//
// Days and hours are in the VIEWER's local time. L12-11 (audit logic v12):
// ?tz= is preferably an IANA zone name (tz=Europe/Paris, the browser's
// Intl.DateTimeFormat().resolvedOptions().timeZone): each event is then placed
// with the zone's offset AT THAT EVENT, so a DST change inside the window
// (2026-10-25 in Europe) moves no play to the wrong day. The older form, the
// client offset in minutes east of UTC (tz=120, JS
// -new Date().getTimezoneOffset()), is still accepted as a fixed offset; a
// zone name the server does not know falls back to ?tzo=<minutes>, then UTC.
// Answers carry `tz` (the zone's offset now, minutes) and `zone` (its name).
// Streaks, clock and year answers are memoised per (profile, zone, params)
// for statsTimeMemoTTL; a new play or a login merge drops the profile's
// entries.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // IANA zones even without /usr/share/zoneinfo in the image

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

// streakWindowDays is the length of the streaks.days calendar.
const streakWindowDays = 90

// statEvent is one play: what, where from, when (no item JSON: that comes
// once per ref from windowRows).
type statEvent struct {
	Ref      string
	Source   string
	PlayedAt time.Time
}

// profileEvents returns the profile's plays since `since` (zero = all time),
// oldest first.
func profileEvents(pid string, since time.Time) []statEvent {
	var evs []statEvent
	q := db.DB.Model(&db.PlayEvent{}).Select("ref, source, played_at").Where("profile_id = ?", pid)
	if !since.IsZero() {
		q = q.Where("played_at >= ?", since)
	}
	q.Order("played_at asc").Scan(&evs)
	return evs
}

// refMinutes maps each ref of `rows` to the minutes one play of it lasts
// (item.length, else the 3.5 min estimate used by summary).
func refMinutes(rows []playRow) map[string]float64 {
	out := make(map[string]float64, len(rows))
	for _, r := range rows {
		if sec := itemLengthSec(r.Data); sec > 0 {
			out[r.Ref] = float64(sec) / 60
		} else {
			out[r.Ref] = estimatedTrackMinutes
		}
	}
	return out
}

// playMinutes is the length of one play of ref (estimate when unknown).
func playMinutes(m map[string]float64, ref string) float64 {
	if v, ok := m[ref]; ok {
		return v
	}
	return estimatedTrackMinutes
}

// fixedTZ is the fixed-offset zone of `min` minutes east of UTC (the
// legacy ?tz=<minutes> form).
func fixedTZ(min int) *time.Location {
	return time.FixedZone("viewer", min*60)
}

// parseStatsTZ reads one tz value: minutes east of UTC (clamped to +-14 h,
// else 0) or an IANA zone name; nil when it is neither.
func parseStatsTZ(raw string) *time.Location {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if n, err := strconv.Atoi(raw); err == nil {
		if n < -14*60 || n > 14*60 {
			n = 0
		}
		return fixedTZ(n)
	}
	if len(raw) > 64 || raw == "Local" {
		return nil
	}
	for _, r := range raw {
		ok := r == '/' || r == '_' || r == '-' || r == '+' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !ok {
			return nil
		}
	}
	loc, err := time.LoadLocation(raw)
	if err != nil {
		return nil
	}
	return loc
}

// statsZone is the viewer's zone: ?tz= (name or minutes), else ?tzo=
// (minutes), else UTC.
func statsZone(c echo.Context) *time.Location {
	if loc := parseStatsTZ(c.QueryParam("tz")); loc != nil {
		return loc
	}
	if raw := strings.TrimSpace(c.QueryParam("tzo")); raw != "" {
		if _, err := strconv.Atoi(raw); err == nil {
			return parseStatsTZ(raw)
		}
	}
	return time.UTC
}

// tzOffsetMin is the offset of loc at t, minutes east of UTC.
func tzOffsetMin(loc *time.Location, t time.Time) int {
	_, off := t.In(loc).Zone()
	return off / 60
}

// zoneName is loc's IANA name, "" for a fixed offset.
func zoneName(loc *time.Location) string {
	if n := loc.String(); n != "viewer" {
		return n
	}
	return ""
}

// ---- per-profile memo of the time views (L12-11) ----

const (
	statsTimeMemoTTL = 5 * time.Minute
	statsTimeMemoMax = 512
)

type statsTimeEntry struct {
	pid string
	at  time.Time
	val interface{}
}

var (
	statsTimeMu   sync.Mutex
	statsTimeMemo = map[string]statsTimeEntry{}
	// statsTimeOrder lists the memoised keys, least recently used first
	// (L13-10: eviction is LRU, never a full reset).
	statsTimeOrder []string
	// statsTimeNow is swapped by tests.
	statsTimeNow = time.Now
)

// statsTimeTouch moves key to the recent end (statsTimeMu held).
func statsTimeTouch(key string) {
	for i, k := range statsTimeOrder {
		if k == key {
			statsTimeOrder = append(statsTimeOrder[:i], statsTimeOrder[i+1:]...)
			break
		}
	}
	statsTimeOrder = append(statsTimeOrder, key)
}

// statsTimeDrop forgets key (statsTimeMu held).
func statsTimeDrop(key string) {
	delete(statsTimeMemo, key)
	for i, k := range statsTimeOrder {
		if k == key {
			statsTimeOrder = append(statsTimeOrder[:i], statsTimeOrder[i+1:]...)
			return
		}
	}
}

// statsTimeCached answers key from the memo, else computes and stores it.
// memo=false (L13-10: a request without the bbp cookie gets a fresh random
// profile id from profileID, so its answer is never asked again) computes
// without reading or storing the memo, so cookieless visitors neither fill
// the map nor evict the named profiles' entries. When the map is full the
// expired entries go first, then the least recently used one.
func statsTimeCached(pid, key string, memo bool, compute func() interface{}) interface{} {
	if !memo {
		return compute()
	}
	now := statsTimeNow()
	statsTimeMu.Lock()
	if e, ok := statsTimeMemo[key]; ok {
		if now.Sub(e.at) < statsTimeMemoTTL {
			statsTimeTouch(key)
			statsTimeMu.Unlock()
			return e.val
		}
		statsTimeDrop(key)
	}
	statsTimeMu.Unlock()
	val := compute()
	statsTimeMu.Lock()
	defer statsTimeMu.Unlock()
	if _, ok := statsTimeMemo[key]; !ok && len(statsTimeMemo) >= statsTimeMemoMax {
		for _, k := range append([]string(nil), statsTimeOrder...) {
			if now.Sub(statsTimeMemo[k].at) >= statsTimeMemoTTL {
				statsTimeDrop(k)
			}
		}
		for len(statsTimeMemo) >= statsTimeMemoMax && len(statsTimeOrder) > 0 {
			statsTimeDrop(statsTimeOrder[0])
		}
	}
	statsTimeMemo[key] = statsTimeEntry{pid: pid, at: now, val: val}
	statsTimeTouch(key)
	return val
}

// statsTimeMemoLen is the number of memoised keys (tests).
func statsTimeMemoLen() int {
	statsTimeMu.Lock()
	defer statsTimeMu.Unlock()
	return len(statsTimeMemo)
}

// resetStatsTimeMemo empties the memo (tests).
func resetStatsTimeMemo() {
	statsTimeMu.Lock()
	statsTimeMemo = map[string]statsTimeEntry{}
	statsTimeOrder = nil
	statsTimeMu.Unlock()
}

// invalidateStatsTimeMemo drops the memoised time views of a profile.
func invalidateStatsTimeMemo(pid string) {
	statsTimeMu.Lock()
	defer statsTimeMu.Unlock()
	for k, e := range statsTimeMemo {
		if e.pid == pid {
			statsTimeDrop(k)
		}
	}
}

// statsTimeKey builds a memo key; the profile id goes first.
func statsTimeKey(kind, pid string, loc *time.Location, extra string) string {
	return kind + "\x00" + pid + "\x00" + loc.String() + "\x00" + strconv.Itoa(tzOffsetMin(loc, statsTimeNow())) + "\x00" + extra
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

// streakDay is one cell of the 90-day calendar.
type streakDay struct {
	Date    string  `json:"date"` // YYYY-MM-DD, viewer local
	Minutes float64 `json:"minutes"`
}

// streaksResp is the payload of me/stats/streaks.
type streaksResp struct {
	Current int         `json:"current"`
	Longest int         `json:"longest"`
	LastDay string      `json:"lastDay"`        // "" when the profile never played
	TZ      int         `json:"tz"`             // offset now, minutes east of UTC
	Zone    string      `json:"zone,omitempty"` // IANA name when ?tz= gave one
	Days    []streakDay `json:"days"`           // streakWindowDays entries, oldest first, ending today
}

const dayLayout = "2006-01-02"

// localDay truncates t to its calendar day in loc (midnight, in loc).
func localDay(t time.Time, loc *time.Location) time.Time {
	y, m, d := t.In(loc).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, loc)
}

// computeStreaks folds play events into the streak payload. `now` decides
// what "today" is. The current streak stays alive through a today without
// play as long as yesterday had one (the day is not over); it is 0 once a
// whole day passed without listening. Longest is over the whole history.
func computeStreaks(evs []statEvent, mins map[string]float64, now time.Time, loc *time.Location) streaksResp {
	played := map[string]bool{}
	perDay := map[string]float64{}
	var ordered []time.Time // distinct local days, ascending (evs are sorted)
	for _, e := range evs {
		d := localDay(e.PlayedAt, loc)
		k := d.Format(dayLayout)
		if !played[k] {
			played[k] = true
			ordered = append(ordered, d)
		}
		perDay[k] += playMinutes(mins, e.Ref)
	}
	// evs come oldest first, but be robust to an unsorted input.
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Before(ordered[j]) })
	out := streaksResp{TZ: tzOffsetMin(loc, now), Zone: zoneName(loc), Days: make([]streakDay, 0, streakWindowDays)}
	run := 0
	var prev time.Time
	for i, d := range ordered {
		if i > 0 && prev.AddDate(0, 0, 1).Equal(d) {
			run++
		} else {
			run = 1
		}
		if run > out.Longest {
			out.Longest = run
		}
		prev = d
	}
	if len(ordered) > 0 {
		out.LastDay = ordered[len(ordered)-1].Format(dayLayout)
	}
	today := localDay(now, loc)
	start := today
	if !played[start.Format(dayLayout)] {
		start = today.AddDate(0, 0, -1)
	}
	for d := start; played[d.Format(dayLayout)]; d = d.AddDate(0, 0, -1) {
		out.Current++
	}
	for i := streakWindowDays - 1; i >= 0; i-- {
		k := today.AddDate(0, 0, -i).Format(dayLayout)
		out.Days = append(out.Days, streakDay{Date: k, Minutes: round1(perDay[k])})
	}
	return out
}

// MeStreaksHandler: GET /api/v1/me/stats/streaks?tz=<zone|minutes>.
func MeStreaksHandler(c echo.Context) error {
	pid := profileID(c)
	loc := statsZone(c)
	out := statsTimeCached(pid, statsTimeKey("streaks", pid, loc, ""), hasProfileCookie(c), func() interface{} {
		evs := profileEvents(pid, time.Time{}) // all time: the record needs the whole history
		mins := refMinutes(windowRows(pid, streakWindowDays+1))
		return computeStreaks(evs, mins, time.Now(), loc)
	})
	return c.JSON(http.StatusOK, out)
}

// clockResp is the payload of me/stats/clock: minutes listened per weekday
// (0 = Monday ... 6 = Sunday, the French week) and local hour.
type clockResp struct {
	Days    int            `json:"days"`
	TZ      int            `json:"tz"`
	Zone    string         `json:"zone,omitempty"`
	Minutes [7][24]float64 `json:"minutes"`
	Total   float64        `json:"total"`
	TopDay  int            `json:"topDay"`  // -1 without plays
	TopHour int            `json:"topHour"` // -1 without plays
}

// computeClock folds plays into the weekday x hour matrix (viewer local).
func computeClock(evs []statEvent, mins map[string]float64, loc *time.Location) clockResp {
	out := clockResp{TZ: tzOffsetMin(loc, time.Now()), Zone: zoneName(loc), TopDay: -1, TopHour: -1}
	var perDay [7]float64
	var perHour [24]float64
	for _, e := range evs {
		t := e.PlayedAt.In(loc)
		wd := (int(t.Weekday()) + 6) % 7 // Monday = 0
		m := playMinutes(mins, e.Ref)
		out.Minutes[wd][t.Hour()] += m
		perDay[wd] += m
		perHour[t.Hour()] += m
		out.Total += m
	}
	for d := range out.Minutes {
		for h := range out.Minutes[d] {
			out.Minutes[d][h] = round1(out.Minutes[d][h])
		}
	}
	out.Total = round1(out.Total)
	best := 0.0
	for d, v := range perDay {
		if v > best {
			best, out.TopDay = v, d
		}
	}
	best = 0
	for h, v := range perHour {
		if v > best {
			best, out.TopHour = v, h
		}
	}
	return out
}

// MeClockHandler: GET /api/v1/me/stats/clock?tz=<zone|minutes>&days=90
// (days clamped to 1..365, default 90).
func MeClockHandler(c echo.Context) error {
	pid := profileID(c)
	loc := statsZone(c)
	days := 90
	if n, err := strconv.Atoi(strings.TrimSpace(c.QueryParam("days"))); err == nil && n > 0 {
		days = n
		if days > 365 {
			days = 365
		}
	}
	out := statsTimeCached(pid, statsTimeKey("clock", pid, loc, strconv.Itoa(days)), hasProfileCookie(c), func() interface{} {
		evs := profileEvents(pid, time.Now().Add(-time.Duration(days)*24*time.Hour))
		r := computeClock(evs, refMinutes(windowRows(pid, days)), loc)
		r.Days = days
		return r
	})
	return c.JSON(http.StatusOK, out)
}
