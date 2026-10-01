package api

// c40b B6-10 "la file qui apprend": early "next" presses are recorded as
// skips (POST me/skips, through the client history outbox), never as plays.

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

const (
	// skipMaxSeconds / skipMaxFraction: a "next" press is a skip before 20 s
	// or before 30 % of the track (same rule as app/src/lib/skips.ts).
	skipMaxSeconds  = 20.0
	skipMaxFraction = 0.30
	// skipDedupeWindow: an outbox replay of the same (ref, at) is a duplicate.
	skipDedupeWindow = 2 * time.Second
)

var skipSources = map[string]bool{"player": true, "mediasession": true, "fullscreen": true, "keyboard": true}

// isSkipPosition is the server copy of the client rule: before 20 s, or
// before 30 % of a known duration.
func isSkipPosition(position, duration float64) bool {
	if position < 0 {
		return false
	}
	if position < skipMaxSeconds {
		return true
	}
	return duration > 0 && position < duration*skipMaxFraction
}

func numField(m map[string]interface{}, k string) float64 {
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 0
}

// MeRecordSkipHandler: POST /api/v1/me/skips
// {videoId|lid, at, position, duration, source[, clientSentAt]}.
// `at` (epoch ms) is the client time of the press; an outbox replay adds
// clientSentAt and is dated like a replayed play (stampPlayedAt). Harness
// requests are ignored like plays (YTM_STATS_INCLUDE_HARNESS=1 keeps them).
func MeRecordSkipHandler(c echo.Context) error {
	pid := profileID(c)
	var m map[string]interface{}
	if err := decodeBody(c, &m); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad body"})
	}
	ref := strings.TrimSpace(mstr(m, "lid"))
	if ref == "" {
		ref = strings.TrimSpace(mstr(m, "videoId"))
	}
	if ref == "" || len(ref) > 64 {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no ref"})
	}
	position, duration := numField(m, "position"), numField(m, "duration")
	if duration < 0 {
		duration = 0
	}
	if !isSkipPosition(position, duration) {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "not_a_skip"})
	}
	if harnessRequest(c.Request()) {
		return c.JSON(http.StatusOK, map[string]interface{}{"ignored": true})
	}
	source := mstr(m, "source")
	if !skipSources[source] {
		source = "player"
	}
	origin := "youtube"
	if isLid(ref) {
		origin = "local"
	}
	now := time.Now()
	_, stamped := m["at"]
	at := stampPlayedAt(m["at"], m["clientSentAt"], now)
	if stamped && skipAlreadyRecorded(pid, ref, at) {
		return c.JSON(http.StatusOK, map[string]interface{}{"ok": true, "duplicate": true})
	}
	ev := db.SkipEvent{ProfileID: pid, Ref: ref, Position: position, Duration: duration, Source: source, Origin: origin, SkippedAt: at}
	if err := db.DB.Create(&ev).Error; err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "store"})
	}
	invalidateMixCache(pid)
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}

func skipAlreadyRecorded(pid, ref string, at time.Time) bool {
	var n int64
	db.DB.Model(&db.SkipEvent{}).
		Where("profile_id = ? AND ref = ? AND skipped_at > ? AND skipped_at < ?", pid, ref, at.Add(-skipDedupeWindow), at.Add(skipDedupeWindow)).
		Count(&n)
	return n > 0
}

type skipCount struct {
	Ref   string `json:"ref"`
	Count int64  `json:"count"`
	Last  int64  `json:"last"` // epoch ms of the latest skip
}

// MeSkipsHandler: GET /api/v1/me/skips?days=30 -> the profile's skips per
// ref, most skipped first ({rows:[{ref,count,last}], total, days,
// }). days=0|all: no lower bound.
func MeSkipsHandler(c echo.Context) error {
	pid := profileID(c)
	days := statsDays(c)
	q := db.DB.Model(&db.SkipEvent{}).Select("ref, skipped_at").Where("profile_id = ?", pid)
	if days > 0 {
		q = q.Where("skipped_at > ?", time.Now().Add(-time.Duration(days)*24*time.Hour))
	}
	var evs []db.SkipEvent
	q.Find(&evs)
	byRef := map[string]*skipCount{}
	for _, e := range evs {
		r := byRef[e.Ref]
		if r == nil {
			r = &skipCount{Ref: e.Ref}
			byRef[e.Ref] = r
		}
		r.Count++
		if ms := e.SkippedAt.UnixMilli(); ms > r.Last {
			r.Last = ms
		}
	}
	rows := make([]skipCount, 0, len(byRef))
	for _, r := range byRef {
		rows = append(rows, *r)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Count != rows[j].Count {
			return rows[i].Count > rows[j].Count
		}
		if rows[i].Last != rows[j].Last {
			return rows[i].Last > rows[j].Last
		}
		return rows[i].Ref < rows[j].Ref
	})
	return c.JSON(http.StatusOK, map[string]interface{}{"rows": rows, "total": len(evs), "days": days})
}
