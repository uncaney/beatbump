package api

// c40b B6-10: the personal answers (me/mix "Pour toi", the queue
// continuation through local/related?personal=1 and local/mix?personal=1)
// leave out
//   - every ref skipped at least skipExcludeMin times in skipExcludeWindow,
//   - every ref played (or skipped) in the last recentPlayWindow: no repeat
//     within 3 h (c40b item 3).
//
// c43b L12-18: an exclusion is applied on the normalised (artist, title) key
// as well as on the ref, so another copy of the same song (other album,
// other lid: the lidarr and soulseek copies) is left out too.

import (
	"sort"
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
	// recentPlayWindow: no repeat of a ref played (or skipped) this recently.
	recentPlayWindow = 3 * time.Hour
	// maxExcludeParam bounds the client exclude= list.
	maxExcludeParam = 200
	// maxExcludeBytes (L12-17): a raw exclude= value longer than this is
	// ignored (the useful list is 200 refs of at most 64 bytes).
	maxExcludeBytes = 16 << 10
	// excludeLookupChunk bounds one Meili `lid IN [...]` lookup.
	excludeLookupChunk = 200
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

// recentRefs: refs the profile played or skipped in recentPlayWindow.
func recentRefs(pid string, now time.Time) map[string]bool {
	out := map[string]bool{}
	if pid == "" {
		return out
	}
	since := now.Add(-recentPlayWindow)
	var refs []string
	db.DB.Model(&db.PlayEvent{}).Where("profile_id = ? AND played_at > ?", pid, since).Distinct().Pluck("ref", &refs)
	for _, r := range refs {
		out[r] = true
	}
	refs = nil
	db.DB.Model(&db.SkipEvent{}).Where("profile_id = ? AND skipped_at > ?", pid, since).Distinct().Pluck("ref", &refs)
	for _, r := range refs {
		out[r] = true
	}
	return out
}

// profileExclusions = skippedRefs ∪ recentRefs.
func profileExclusions(pid string, now time.Time) map[string]bool {
	out := skippedRefs(pid, now)
	for r := range recentRefs(pid, now) {
		out[r] = true
	}
	return out
}

// exclusions: the refs an answer must leave out, plus (L12-18) the
// normalised (artist, title) keys (dupTrackKey) of the excluded local tracks.
// Built by resolveExclusions; a nil *exclusions excludes nothing.
type exclusions struct {
	refs map[string]bool
	keys map[string]bool
}

func (ex *exclusions) empty() bool {
	return ex == nil || (len(ex.refs) == 0 && len(ex.keys) == 0)
}

// hit: the track hit is excluded, by lid or by its normalised key.
func (ex *exclusions) hit(h map[string]interface{}) bool {
	if ex == nil {
		return false
	}
	if ex.refs[mstr(h, "lid")] {
		return true
	}
	if len(ex.keys) == 0 {
		return false
	}
	k := dupTrackKey(h)
	return k != "" && ex.keys[k]
}

// item: the rendered song item (localSongItem) is excluded, by videoId or
// by the normalised key of its title and first artist.
func (ex *exclusions) item(it IListItemRenderer) bool {
	if ex == nil {
		return false
	}
	if it.VideoId != nil && ex.refs[*it.VideoId] {
		return true
	}
	if len(ex.keys) == 0 {
		return false
	}
	k := itemTrackKey(it)
	return k != "" && ex.keys[k]
}

// itemTrackKey is dupTrackKey for a rendered song item (same artist rule:
// localSongItem puts mArtist(h) in Subtitle[0]).
func itemTrackKey(it IListItemRenderer) string {
	t := dupNorm(it.Title)
	if t == "" {
		return ""
	}
	artist := ""
	if len(it.Subtitle) > 0 {
		artist = it.Subtitle[0].Text
	}
	return matchNorm(artist) + "\x00" + t
}

// excludedTrackKeys resolves the local refs of `refs` to their normalised
// (artist, title) keys: one `lid IN [...]` Meili query per excludeLookupChunk
// lids, in a stable order. Without Meili there is no key and the ref
// exclusion still applies on its own.
func excludedTrackKeys(refs map[string]bool) map[string]bool {
	lids := make([]string, 0, len(refs))
	for r := range refs {
		if isLid(r) {
			lids = append(lids, r)
		}
	}
	sort.Strings(lids)
	out := map[string]bool{}
	for i := 0; i < len(lids); i += excludeLookupChunk {
		end := min(i+excludeLookupChunk, len(lids))
		quoted := make([]string, 0, end-i)
		for _, l := range lids[i:end] {
			quoted = append(quoted, "\""+escapeMeili(l)+"\"")
		}
		hits := meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "filter": "lid IN [" + strings.Join(quoted, ",") + "]", "limit": end - i,
			"attributesToRetrieve": []string{"lid", "title", "artist", "albumArtist"},
		})
		for _, h := range hits {
			if k := dupTrackKey(h); k != "" {
				out[k] = true
			}
		}
	}
	return out
}

// resolveExclusions turns a ref set into exclusions (refs + their keys).
func resolveExclusions(refs map[string]bool) *exclusions {
	if len(refs) == 0 {
		return &exclusions{refs: refs}
	}
	return &exclusions{refs: refs, keys: excludedTrackKeys(refs)}
}

// requestRefs: the refs a local/related or local/mix answer must leave
// out. `exclude=a,b,c` (refs the client just played, at most
// maxExcludeParam, a raw value of at most maxExcludeBytes) always applies;
// `personal=1` with a bbp cookie adds the profile exclusions (such requests
// bypass the shared cache, see perProfileRelated).
func requestRefs(c echo.Context) map[string]bool {
	out := map[string]bool{}
	n := 0
	for _, raw := range c.QueryParams()["exclude"] {
		if len(raw) > maxExcludeBytes {
			continue
		}
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

// requestExclusions is requestRefs resolved to refs + normalised keys.
func requestExclusions(c echo.Context) *exclusions {
	return resolveExclusions(requestRefs(c))
}

// personalRequest: the caller asked for its profile exclusions.
func personalRequest(c echo.Context) bool {
	return c.QueryParam("personal") == "1"
}

// withoutRefs drops the excluded hits (same slice reused).
func withoutRefs(hits []map[string]interface{}, ex *exclusions) []map[string]interface{} {
	if ex.empty() {
		return hits
	}
	out := hits[:0:0]
	for _, h := range hits {
		if !ex.hit(h) {
			out = append(out, h)
		}
	}
	return out
}

// itemsWithout drops the excluded rendered items.
func itemsWithout(items []IListItemRenderer, ex *exclusions) []IListItemRenderer {
	if ex.empty() {
		return items
	}
	out := make([]IListItemRenderer, 0, len(items))
	for _, it := range items {
		if ex.item(it) {
			continue
		}
		out = append(out, it)
	}
	return out
}
