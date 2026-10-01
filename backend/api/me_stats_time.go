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
// Days and hours are in the VIEWER's local time: ?tz= is the client offset in
// minutes east of UTC (JS -new Date().getTimezoneOffset(), the same parameter
// as me/stats/summary), applied as one fixed offset to every event; without
// it the server answers in UTC. A DST change inside the window shifts the
// events of the other side by one hour (accepted: same rule as summary.hours).

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

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

// statsTZ parses ?tz= (minutes east of UTC, clamped to +-14 h, else 0).
func statsTZ(c echo.Context) int {
	tz, _ := strconv.Atoi(strings.TrimSpace(c.QueryParam("tz")))
	if tz < -14*60 || tz > 14*60 {
		return 0
	}
	return tz
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
	LastDay string      `json:"lastDay"` // "" when the profile never played
	TZ      int         `json:"tz"`
	Days    []streakDay `json:"days"` // streakWindowDays entries, oldest first, ending today
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
func computeStreaks(evs []statEvent, mins map[string]float64, now time.Time, tzOffsetMin int) streaksResp {
	loc := time.FixedZone("viewer", tzOffsetMin*60)
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
	out := streaksResp{TZ: tzOffsetMin, Days: make([]streakDay, 0, streakWindowDays)}
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

// MeStreaksHandler: GET /api/v1/me/stats/streaks?tz=<minutes>.
func MeStreaksHandler(c echo.Context) error {
	pid := profileID(c)
	tz := statsTZ(c)
	evs := profileEvents(pid, time.Time{}) // all time: the record needs the whole history
	mins := refMinutes(windowRows(pid, streakWindowDays+1))
	return c.JSON(http.StatusOK, computeStreaks(evs, mins, time.Now(), tz))
}
