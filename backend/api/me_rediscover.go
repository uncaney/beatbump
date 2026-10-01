package api

// D3 "Redécouvrir" (c29b): tracks the profile used to play and stopped
// playing.
//
//	GET /api/v1/me/stats/rediscover?limit=12
//
// A track qualifies when the profile played it at least rediscoverMinPlays
// times more than rediscoverOldDays ago AND not once in the last
// rediscoverQuietDays. Same auth / profile resolution as me/never-played
// (profileID cookie); an anonymous or fresh profile simply has no row that
// qualifies. Items are the stored play rows (the most recent play's item,
// slimmed like the history), most plays first, so the home row renders them
// with the usual card component and plays them as is.

import (
	"encoding/json"
	"net/http"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

const (
	rediscoverMinPlays  = 3
	rediscoverOldDays   = 60
	rediscoverQuietDays = 30
	rediscoverDefLimit  = 12
	rediscoverMaxLimit  = 50
)

// rediscoverRow is one qualifying ref.
type rediscoverRow struct {
	Ref  string
	Data string
	Old  int
}

// rediscoverRows runs the three-window query at `now`: per ref, plays before
// now-oldDays (>= minPlays) and plays since now-quietDays (= 0). Rows whose
// stored item is empty cannot be rendered and are skipped by the caller.
func rediscoverRows(pid string, now time.Time, limit int) []rediscoverRow {
	oldCut := now.Add(-rediscoverOldDays * 24 * time.Hour)
	quietCut := now.Add(-rediscoverQuietDays * 24 * time.Hour)
	latestData := "(SELECT p2.data FROM play_events p2 WHERE p2.profile_id = play_events.profile_id AND p2.ref = play_events.ref ORDER BY p2.played_at DESC, p2.id DESC LIMIT 1)"
	var rows []rediscoverRow
	db.DB.Model(&db.PlayEvent{}).
		Select("ref, "+latestData+" as data, sum(case when played_at < ? then 1 else 0 end) as old", oldCut).
		Where("profile_id = ?", pid).
		Group("ref").
		Having("sum(case when played_at < ? then 1 else 0 end) >= ? AND sum(case when played_at >= ? then 1 else 0 end) = 0", oldCut, rediscoverMinPlays, quietCut).
		Order("old desc, max(played_at) desc").
		Limit(limit).
		Scan(&rows)
	return rows
}

// MeRediscoverHandler: GET /api/v1/me/stats/rediscover?limit=12.
func MeRediscoverHandler(c echo.Context) error {
	pid := profileID(c)
	limit := clampLimit(c, rediscoverDefLimit, rediscoverMaxLimit)
	rows := rediscoverRows(pid, time.Now(), limit)
	items := make([]json.RawMessage, 0, len(rows))
	counts := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		if r.Data == "" {
			continue
		}
		items = append(items, slimStoredItem(r.Data))
		counts = append(counts, map[string]interface{}{"ref": r.Ref, "plays": r.Old})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "counts": counts})
}
