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
	"sync"
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
	lid := mstr(h, "lid")
	if ex.refs[lid] {
		return true
	}
	if len(ex.keys) == 0 {
		return false
	}
	k := trackKeyMemoised(lid, func() string { return dupTrackKey(h) })
	return k != "" && ex.keys[k]
}

// item: the rendered song item (localSongItem) is excluded, by videoId or
// by the normalised key of its title and first artist.
func (ex *exclusions) item(it IListItemRenderer) bool {
	if ex == nil {
		return false
	}
	ref := ""
	if it.VideoId != nil {
		ref = *it.VideoId
	}
	artist := ""
	if len(it.Subtitle) > 0 {
		artist = it.Subtitle[0].Text
	}
	return ex.song(ref, it.Title, artist)
}

// song: a rendered song (ref, title, first artist) is excluded, by ref or
// by its normalised key. Shared by item (IListItemRenderer) and the
// post-cache filter of local/related (Item).
func (ex *exclusions) song(ref, title, artist string) bool {
	if ex == nil {
		return false
	}
	if ref != "" && ex.refs[ref] {
		return true
	}
	if len(ex.keys) == 0 {
		return false
	}
	k := trackKeyMemoised(ref, func() string { return songTrackKey(title, artist) })
	return k != "" && ex.keys[k]
}

// songTrackKey is dupTrackKey for a rendered song (title, first artist).
func songTrackKey(title, artist string) string {
	t := dupNorm(title)
	if t == "" {
		return ""
	}
	return matchNorm(artist) + "\x00" + t
}

// itemTrackKey is dupTrackKey for a rendered song item (same artist rule:
// localSongItem puts mArtist(h) in Subtitle[0]).
func itemTrackKey(it IListItemRenderer) string {
	artist := ""
	if len(it.Subtitle) > 0 {
		artist = it.Subtitle[0].Text
	}
	return songTrackKey(it.Title, artist)
}

// ---- L13-8: one normalisation per track, generic titles ignored ----

const (
	// trackKeyMemoMax bounds the lid -> normalised key memo.
	trackKeyMemoMax = 4096
	// trackKeyMemoTTL: a retagged track gets a fresh key after this.
	trackKeyMemoTTL = 10 * time.Minute
	// genericTitleMinLen: a normalised title shorter than this is too
	// generic to exclude other songs by ("Go", "One", "Yes").
	genericTitleMinLen = 4
)

// genericTitles are the song titles many albums of the same artist carry
// for different songs: excluding one must not exclude the others.
var genericTitles = map[string]bool{
	"intro": true, "outro": true, "interlude": true, "untitled": true,
	"skit": true, "prelude": true, "introduction": true, "bonus track": true,
}

// genericTrackKey reports whether a dupTrackKey names a song too generic
// to exclude by (artist, title): the title is short or in genericTitles.
func genericTrackKey(k string) bool {
	_, t, ok := strings.Cut(k, "\x00")
	if !ok {
		return true
	}
	return len(t) < genericTitleMinLen || genericTitles[t]
}

type trackKeyEntry struct {
	key string
	at  time.Time
}

var (
	trackKeyMu    sync.Mutex
	trackKeyMemo  = map[string]trackKeyEntry{}
	trackKeyOrder []string // least recently used first
	trackKeyNow   = time.Now
)

// trackKeyMemoised answers the normalised key of local track `lid` from the
// memo (one normalisation per track, however many candidates and requests
// share it), computing it with `compute` on a miss. A ref that is not a lid
// (a YouTube id, "") is computed every time and never stored.
func trackKeyMemoised(lid string, compute func() string) string {
	if !isLid(lid) {
		return compute()
	}
	now := trackKeyNow()
	trackKeyMu.Lock()
	if e, ok := trackKeyMemo[lid]; ok && now.Sub(e.at) < trackKeyMemoTTL {
		trackKeyMu.Unlock()
		return e.key
	}
	trackKeyMu.Unlock()
	k := compute()
	trackKeyRemember(lid, k, now)
	return k
}

// trackKeyRemember stores (lid, key), evicting the least recently stored
// entries beyond trackKeyMemoMax.
func trackKeyRemember(lid, k string, now time.Time) {
	trackKeyMu.Lock()
	defer trackKeyMu.Unlock()
	if _, ok := trackKeyMemo[lid]; !ok {
		trackKeyOrder = append(trackKeyOrder, lid)
	}
	trackKeyMemo[lid] = trackKeyEntry{key: k, at: now}
	for len(trackKeyOrder) > trackKeyMemoMax {
		delete(trackKeyMemo, trackKeyOrder[0])
		trackKeyOrder = trackKeyOrder[1:]
	}
}

// trackKeyKnown returns the memoised keys of lids (fresh entries only) and
// the lids still to resolve.
func trackKeyKnown(lids []string) (map[string]string, []string) {
	now := trackKeyNow()
	known := map[string]string{}
	var missing []string
	trackKeyMu.Lock()
	defer trackKeyMu.Unlock()
	for _, l := range lids {
		if e, ok := trackKeyMemo[l]; ok && now.Sub(e.at) < trackKeyMemoTTL {
			known[l] = e.key
		} else {
			missing = append(missing, l)
		}
	}
	return known, missing
}

// resetTrackKeyMemo empties the memo (tests).
func resetTrackKeyMemo() {
	trackKeyMu.Lock()
	trackKeyMemo = map[string]trackKeyEntry{}
	trackKeyOrder = nil
	trackKeyMu.Unlock()
}

// trackKeyMemoLen is the number of memoised lids (tests).
func trackKeyMemoLen() int {
	trackKeyMu.Lock()
	defer trackKeyMu.Unlock()
	return len(trackKeyMemo)
}

// excludedTrackKeys resolves the local refs of `refs` to their normalised
// (artist, title) keys: the memoised lids cost nothing, the others one
// `lid IN [...]` Meili query per excludeLookupChunk lids, in a stable order
// (L13-8: a continuation request repeats most of the previous exclude=
// list, so the queue the client just played is resolved once). Generic
// keys (genericTrackKey) are left out: "Intro" of one album must not
// exclude "Intro" of another. Without Meili there is no key and the ref
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
	add := func(k string) {
		if k != "" && !genericTrackKey(k) {
			out[k] = true
		}
	}
	known, lids := trackKeyKnown(lids)
	for _, k := range known {
		add(k)
	}
	now := trackKeyNow()
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
			k := dupTrackKey(h)
			if l := mstr(h, "lid"); isLid(l) {
				trackKeyRemember(l, k, now)
			}
			add(k)
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
