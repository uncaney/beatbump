package api

// c40b B6-10: the personal answers (me/mix "Pour toi", the queue
// continuation through local/related?personal=1 and local/mix?personal=1)
// leave out
//   - every ref skipped at least skipExcludeMin times in skipExcludeWindow.

import (
	"strings"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

const (
	// skipExcludeMin skips in skipExcludeWindow keep a ref out of the
	// personal mixes and the continuation.
	skipExcludeMin    = 2
	skipExcludeWindow = 30 * 24 * time.Hour
	// maxExcludeParam bounds the client exclude= list.
	maxExcludeParam = 200
)

// skippedRefs: refs the profile skipped at least skipExcludeMin times in
// skipExcludeWindow before now.
func skippedRefs(pid string, now time.Time) map[string]bool {
	out := map[string]bool{}
	if pid == "" {
		return out
	}
	var rows []struct{ Ref string }
	db.DB.Model(&db.SkipEvent{}).Select("ref").
		Where("profile_id = ? AND skipped_at > ?", pid, now.Add(-skipExcludeWindow)).
		Group("ref").Having("count(*) >= ?", skipExcludeMin).Scan(&rows)
	for _, r := range rows {
		out[r.Ref] = true
	}
	return out
}

// profileExclusions: what the personal answers leave out for pid.
func profileExclusions(pid string, now time.Time) map[string]bool {
	return skippedRefs(pid, now)
}

// requestExclusions: what a local/related or local/mix answer must leave
// out. `exclude=a,b,c` (refs the client just played, at most
// maxExcludeParam) always applies; `personal=1` with a bbp cookie adds the
// profile exclusions (such requests bypass the shared cache, see
// perProfileRelated).
func requestExclusions(c echo.Context) map[string]bool {
	out := map[string]bool{}
	n := 0
	for _, raw := range c.QueryParams()["exclude"] {
		for _, r := range strings.Split(raw, ",") {
			if r = strings.TrimSpace(r); r != "" && len(r) <= 64 && n < maxExcludeParam {
				out[r] = true
				n++
			}
		}
	}
	if personalRequest(c) && hasProfileCookie(c) {
		for r := range profileExclusions(profileID(c), time.Now()) {
			out[r] = true
		}
	}
	return out
}

// personalRequest: the caller asked for its profile exclusions.
func personalRequest(c echo.Context) bool {
	return c.QueryParam("personal") == "1"
}

// withoutRefs drops the hits whose lid is in ex (same slice reused).
func withoutRefs(hits []map[string]interface{}, ex map[string]bool) []map[string]interface{} {
	if len(ex) == 0 {
		return hits
	}
	out := hits[:0:0]
	for _, h := range hits {
		if !ex[mstr(h, "lid")] {
			out = append(out, h)
		}
	}
	return out
}

// itemsWithout drops the rendered items whose videoId is in ex.
func itemsWithout(items []IListItemRenderer, ex map[string]bool) []IListItemRenderer {
	if len(ex) == 0 {
		return items
	}
	out := make([]IListItemRenderer, 0, len(items))
	for _, it := range items {
		if it.VideoId != nil && ex[*it.VideoId] {
			continue
		}
		out = append(out, it)
	}
	return out
}
