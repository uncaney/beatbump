package api

// B8-20 (lane c48b) "Aussi sous": the artists index keys an artist by its raw
// name (artistID = sha1 of the lower-cased name), so "Ed Sheeran feat.
// Khalid" is a different la- artist from "Ed Sheeran" and gets its own page
// (LIBRARY-LINT section 4: 57 groups, 206 names, mostly "feat." credits).
// Nothing here merges anything (decision B7-10: display only, the indexer is
// out of scope): this file groups the artists whose names normalise to the
// same form and names a primary per group (most albums), so that
//
//   - the artist page shows "Aussi sous : <alias>" chips (buildLocalArtist,
//     local_pages.go) and its "Tout lire" plays the union of the group's
//     titles (?group=1 on GET /local/songs, local_browse.go),
//   - the Artists list folds the variants under the primary with a
//     "+N variantes" badge (?collapse=1 on GET /local/artists),
//   - GET /local/artists/aliases lists the groups (the lint, in the app).
//
// The key is matchNorm (local_match.go): case, accents, "feat. / ft. /
// featuring" tails, "&" = "and", punctuation and spacing. It is NOT
// matchPrimaryArtist: that one keeps the first credited name only and would
// fold "Simon & Garfunkel" under "Simon", or "Earth, Wind & Fire" under
// "Earth". A collaboration stays its own artist; only the credits of the
// SAME name are grouped.
//
// Like the duplicate-albums scan (local_duplicates.go): one bounded scan of
// the artists index, memoised aliasMemoTTL, warmed in the background at
// start-up (WarmArtistAliases) and refreshed on demand; the pages and the
// songs union read the memo without ever waiting for a scan.

import (
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/labstack/echo/v4"
)

const (
	// aliasScanCap bounds the artists scan (the library holds ~1 900
	// artists); past it the artists sorted after (name:asc) are left out and
	// the answer says so (`truncated`).
	aliasScanCap  = 4000
	aliasScanPage = 1000
	// aliasGroupCap bounds the members kept per group (the largest real
	// group has 17 names): the songs union filter and the chips row stay
	// small whatever the tags do.
	aliasGroupCap = 40
	aliasMemoTTL  = 10 * time.Minute
	// aliasDefaultLimit / aliasMaxLimit page GET /local/artists/aliases.
	aliasDefaultLimit = 50
	aliasMaxLimit     = 200
	// aliasCollapseRounds bounds the extra Meili pages a collapsed artists
	// page may read to refill the rows hidden as aliases.
	aliasCollapseRounds = 3
)

// aliasArtist is one credit of a group.
type aliasArtist struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	AlbumCount int    `json:"albumCount"`
	TrackCount int    `json:"trackCount"`
}

// aliasGroup is one set of artists with the same normalised name. ID / Name
// are the primary's (most albums, then most tracks, then the shortest name,
// then the smaller id so the answer is stable); Aliases are the other
// credits, same order. Size counts every member (primary included), also
// the ones left out past aliasGroupCap (Truncated).
type aliasGroup struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	AlbumCount int           `json:"albumCount"`
	TrackCount int           `json:"trackCount"`
	Aliases    []aliasArtist `json:"aliases"`
	Size       int           `json:"size"`
	Truncated  bool          `json:"truncated,omitempty"`
}

// aliasKey is the grouping key of an artist name, "" when the name
// normalises to nothing (such artists are never grouped).
func aliasKey(name string) string {
	return matchNorm(name)
}

// aliasBetter orders the members of a group, primary first.
func aliasBetter(a, b aliasArtist) bool {
	if a.AlbumCount != b.AlbumCount {
		return a.AlbumCount > b.AlbumCount
	}
	if a.TrackCount != b.TrackCount {
		return a.TrackCount > b.TrackCount
	}
	if len(a.Name) != len(b.Name) {
		return len(a.Name) < len(b.Name)
	}
	return a.ID < b.ID
}

// aliasArtistScanFn reads one page of the artists index (name:asc) and the
// index's total (0 when unknown); a variable for tests.
var aliasArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) {
	return meiliBrowse("artists", map[string]interface{}{
		"q": "", "offset": off, "limit": lim, "sort": []string{"name:asc"},
		"attributesToRetrieve": []string{"id", "name", "albumCount", "trackCount"},
	})
}

// groupArtistAliases groups artist docs by aliasKey and keeps the keys with
// at least two credits. Groups come largest first, then by primary name.
// Pure.
func groupArtistAliases(docs []map[string]interface{}) []aliasGroup {
	byKey := map[string][]aliasArtist{}
	seen := map[string]bool{}
	var order []string
	for _, d := range docs {
		id := mstr(d, "id")
		if !isLocalArtist(id) || seen[id] {
			continue
		}
		name := strings.TrimSpace(mstr(d, "name"))
		k := aliasKey(name)
		if name == "" || k == "" {
			continue
		}
		seen[id] = true
		if _, ok := byKey[k]; !ok {
			order = append(order, k)
		}
		byKey[k] = append(byKey[k], aliasArtist{
			ID: id, Name: name, AlbumCount: mint(d, "albumCount"), TrackCount: mint(d, "trackCount"),
		})
	}
	groups := make([]aliasGroup, 0)
	for _, k := range order {
		members := byKey[k]
		if len(members) < 2 {
			continue
		}
		sort.SliceStable(members, func(i, j int) bool { return aliasBetter(members[i], members[j]) })
		g := aliasGroup{
			ID: members[0].ID, Name: members[0].Name,
			AlbumCount: members[0].AlbumCount, TrackCount: members[0].TrackCount,
			Size: len(members),
		}
		rest := members[1:]
		if len(rest) > aliasGroupCap-1 {
			rest = rest[:aliasGroupCap-1]
			g.Truncated = true
		}
		g.Aliases = append([]aliasArtist{}, rest...)
		groups = append(groups, g)
	}
	sort.SliceStable(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		if a.Size != b.Size {
			return a.Size > b.Size
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return groups
}

// aliasIndexOf maps every member id (primary and aliases) to its group index.
func aliasIndexOf(groups []aliasGroup) map[string]int {
	idx := make(map[string]int, len(groups)*3)
	for i, g := range groups {
		idx[g.ID] = i
		for _, a := range g.Aliases {
			idx[a.ID] = i
		}
	}
	return idx
}

// scanArtistAliases is the full (unmemoised) computation: the bounded
// artists scan then the grouping. ok is false when the scan read nothing
// (Meili down): such an answer is not memoised. truncated is true when the
// scan stopped at aliasScanCap with artists left behind. A panic anywhere
// is recovered here (logged, ok=false, nothing memoised).
func scanArtistAliases() (groups []aliasGroup, truncated bool, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("artist aliases: scan failed: %v", r)
			groups, truncated, ok = []aliasGroup{}, false, false
		}
	}()
	var docs []map[string]interface{}
	total, lastFull := 0, false
	for off := 0; off < aliasScanCap; off += aliasScanPage {
		page, n := aliasArtistScanFn(off, aliasScanPage)
		docs = append(docs, page...)
		if n > total {
			total = n
		}
		lastFull = len(page) >= aliasScanPage
		if !lastFull || (total > 0 && len(docs) >= total) {
			break
		}
	}
	if len(docs) == 0 {
		return []aliasGroup{}, false, false
	}
	if len(docs) >= aliasScanCap && lastFull && (total == 0 || total > len(docs)) {
		truncated = true
	}
	return groupArtistAliases(docs), truncated, true
}

var (
	// aliasMu guards the memo fields only: it is held to copy or to swap
	// them, never during a scan (L14-1: artistAliasCached used to wait on
	// it while a scan held it for up to 4 Meili pages x 6 s, so every artist
	// page, "Tout lire" and the collapsed artists list waited on a rescan).
	aliasMu        sync.Mutex
	aliasMemo      []aliasGroup
	aliasMemoIndex map[string]int
	aliasMemoTrunc bool
	aliasMemoAt    time.Time
	aliasMemoNow   = time.Now // swapped by tests
	// aliasScanMu serialises the scans: concurrent artistAliasGroups
	// callers share one scan (the ones queued behind it read its result).
	aliasScanMu sync.Mutex
	// aliasAutoRefresh is set by WarmArtistAliases (main): a stale memo read
	// by a page then triggers one background rescan. Tests leave it off, so
	// a page never starts a scan behind their back.
	aliasAutoRefresh atomic.Bool
	aliasRefreshing  atomic.Bool
)

// artistAliasSnapshot copies the memo under the lock (a few words: the
// slices and the map are never mutated after they are stored, so sharing
// them with the caller is safe).
func artistAliasSnapshot() (groups []aliasGroup, index map[string]int, truncated bool, at time.Time) {
	aliasMu.Lock()
	defer aliasMu.Unlock()
	return aliasMemo, aliasMemoIndex, aliasMemoTrunc, aliasMemoAt
}

func aliasMemoFresh(groups []aliasGroup, at, now time.Time) bool {
	return groups != nil && now.Sub(at) < aliasMemoTTL
}

// artistAliasGroups is scanArtistAliases behind an aliasMemoTTL memo.
// Concurrent callers share one scan (aliasScanMu); the memo lock itself is
// never held during a scan, so artistAliasCached keeps answering the
// previous snapshot meanwhile.
func artistAliasGroups() (groups []aliasGroup, index map[string]int, truncated bool) {
	if g, i, tr, at := artistAliasSnapshot(); aliasMemoFresh(g, at, aliasMemoNow()) {
		return g, i, tr
	}
	aliasScanMu.Lock()
	defer aliasScanMu.Unlock()
	// A scan that finished while this caller waited serves it too.
	now := aliasMemoNow()
	if g, i, tr, at := artistAliasSnapshot(); aliasMemoFresh(g, at, now) {
		return g, i, tr
	}
	groups, truncated, ok := scanArtistAliases()
	index = aliasIndexOf(groups)
	if ok {
		aliasMu.Lock()
		aliasMemo, aliasMemoIndex, aliasMemoTrunc, aliasMemoAt = groups, index, truncated, now
		aliasMu.Unlock()
	}
	return groups, index, truncated
}

// resetArtistAliasMemo drops the memo (tests).
func resetArtistAliasMemo() {
	aliasMu.Lock()
	aliasMemo, aliasMemoIndex, aliasMemoTrunc, aliasMemoAt = nil, nil, false, time.Time{}
	aliasMu.Unlock()
}

// WarmArtistAliases runs the first scan in the background at start-up and
// lets later page reads refresh it when it is older than aliasMemoTTL.
func WarmArtistAliases() {
	aliasAutoRefresh.Store(true)
	refreshArtistAliasesAsync()
}

func refreshArtistAliasesAsync() {
	if !aliasRefreshing.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer aliasRefreshing.Store(false)
		defer func() {
			if r := recover(); r != nil {
				log.Printf("artist aliases: background refresh failed: %v", r)
			}
		}()
		artistAliasGroups()
	}()
}

// artistAliasCached never blocks a page on a scan: it answers the last
// known groups (possibly stale, nil before the first scan; the memo lock is
// only ever held to copy or swap, see aliasMu) and, when auto refresh is on
// and the memo is stale, starts one rescan.
func artistAliasCached() ([]aliasGroup, map[string]int) {
	groups, index, _, at := artistAliasSnapshot()
	if aliasAutoRefresh.Load() && !aliasMemoFresh(groups, at, aliasMemoNow()) {
		refreshArtistAliasesAsync()
	}
	return groups, index
}

// artistAliasGroupOf is the cached group an artist id belongs to (primary
// or alias); ok is false when it belongs to none (or before the first scan).
func artistAliasGroupOf(id string) (aliasGroup, bool) {
	groups, index := artistAliasCached()
	i, ok := index[id]
	if !ok || i < 0 || i >= len(groups) {
		return aliasGroup{}, false
	}
	return groups[i], true
}

// aliasFeatWordRe is the credit word of a "feat." tail, whatever its spelling.
var aliasFeatWordRe = regexp.MustCompile(`\b(?:feat|ft|featuring)\b\.?`)

// aliasDisplayKey is the key two credits are the SAME chip under (U13-3):
// unlike aliasKey it keeps the credited guests, but reads "ft." / "feat." /
// "featuring" (dotted or not, bracketed or not) as one word, folds case,
// accents, "&" / "and", punctuation and spacing. "The Chainsmokers ft.
// Halsey" and "The Chainsmokers (feat. Halsey)" are one chip; "... ft.
// Daya" is another.
func aliasDisplayKey(name string) string {
	s := matchAccents.Replace(strings.ToLower(name))
	s = aliasFeatWordRe.ReplaceAllString(s, " feat ")
	s = strings.ReplaceAll(s, "&", " and ")
	s = strings.ReplaceAll(s, "'", "")
	s = matchNonAlnum.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}

// dedupeAliasPeers keeps one credit per aliasDisplayKey, the first one in
// the input (the peers come primary first, then aliasBetter order: most
// albums wins). The dropped spellings still count in the group (Size) and
// in the songs union (artistAliasNames): only the chips row is deduped.
func dedupeAliasPeers(peers []aliasArtist) []aliasArtist {
	seen := make(map[string]bool, len(peers))
	out := make([]aliasArtist, 0, len(peers))
	for _, p := range peers {
		k := aliasDisplayKey(p.Name)
		if k == "" {
			k = strings.ToLower(p.Name)
		}
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, p)
	}
	return out
}

// artistAliasPeers lists the OTHER credits of an artist's group (the chips
// of its page), nil when it has none. U13-3: the "ft." / "feat." /
// "featuring" spellings of one credit make one chip (dedupeAliasPeers); the
// page's own spelling is never a chip either way.
func artistAliasPeers(id string) []aliasArtist {
	g, ok := artistAliasGroupOf(id)
	if !ok {
		return nil
	}
	peers := make([]aliasArtist, 0, len(g.Aliases)+1)
	if g.ID != id {
		peers = append(peers, aliasArtist{ID: g.ID, Name: g.Name, AlbumCount: g.AlbumCount, TrackCount: g.TrackCount})
	}
	for _, a := range g.Aliases {
		if a.ID != id {
			peers = append(peers, a)
		}
	}
	own := ""
	if g.ID == id {
		own = aliasDisplayKey(g.Name)
	} else {
		for _, a := range g.Aliases {
			if a.ID == id {
				own = aliasDisplayKey(a.Name)
				break
			}
		}
	}
	peers = dedupeAliasPeers(peers)
	if own == "" {
		return peers
	}
	// A spelling of the page's own credit ("... feat. Halsey" on the "... ft.
	// Halsey" page) is not "another name" either.
	kept := peers[:0]
	for _, p := range peers {
		if aliasDisplayKey(p.Name) != own {
			kept = append(kept, p)
		}
	}
	return kept
}

// artistAliasNames lists every credit name of the group an artist NAME
// belongs to (itself first); just [name] when it has none. Bounded by
// aliasGroupCap through the groups themselves.
func artistAliasNames(name string) []string {
	names := []string{name}
	g, ok := artistAliasGroupOf(artistID(name))
	if !ok {
		return names
	}
	seen := map[string]bool{name: true}
	add := func(n string) {
		if n != "" && !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	add(g.Name)
	for _, a := range g.Aliases {
		add(a.Name)
	}
	return names
}

// aliasSongsFilter is the Meili tracks filter of a credits union
// (albumArtist IN [...]; Meili >= 1.0, the engine is 1.12).
func aliasSongsFilter(names []string) string {
	quoted := make([]string, 0, len(names))
	for _, n := range names {
		quoted = append(quoted, "\""+escapeMeili(n)+"\"")
	}
	return "albumArtist IN [" + strings.Join(quoted, ", ") + "]"
}

// aliasBadge is the "+N variantes" badge of a collapsed primary row.
func aliasBadge(n int) string {
	if n == 1 {
		return "+1 variante"
	}
	return "+" + strconv.Itoa(n) + " variantes"
}

// LocalArtistAliasesHandler serves GET /api/v1/local/artists/aliases.
//
//	?limit=50&offset=0   page of groups (limit 1-200), largest groups first
//	?id=la-…             the group this artist belongs to (primary or alias):
//	                     {"group": {...}, "groups": [{...}], "total": 1}; an
//	                     artist of no group answers 404 {"error": "not_found",
//	                     "group": null, "groups": [], "total": 0}
//
// Answer: {"groups": [{id, name, albumCount, trackCount, aliases: [{id, name,
// albumCount, trackCount}], size}], "total": N, "offset", "limit",
// "truncated"}. `id` / `name` are the primary (most albums); `aliases` the
// other credits. `total` is always a number and `groups` always an array.
// `truncated` says the scan stopped at aliasScanCap artists. Read only:
// nothing is merged, in the base or in the index (B7-10).
func LocalArtistAliasesHandler(c echo.Context) error {
	groups, index, truncated := artistAliasGroups()
	if id := strings.TrimSpace(c.QueryParam("id")); id != "" {
		if i, ok := index[id]; ok && i >= 0 && i < len(groups) {
			g := groups[i]
			return c.JSON(http.StatusOK, map[string]interface{}{"group": g, "groups": []aliasGroup{g}, "total": 1, "truncated": truncated})
		}
		return c.JSON(http.StatusNotFound, map[string]interface{}{"error": "not_found", "group": nil, "groups": []aliasGroup{}, "total": 0})
	}
	off, lim := 0, aliasDefaultLimit
	if v, err := strconv.Atoi(c.QueryParam("offset")); err == nil && v > 0 {
		off = v
	}
	if v, err := strconv.Atoi(c.QueryParam("limit")); err == nil && v > 0 {
		lim = v
	}
	if lim > aliasMaxLimit {
		lim = aliasMaxLimit
	}
	page := []aliasGroup{}
	if off < len(groups) {
		end := off + lim
		if end > len(groups) {
			end = len(groups)
		}
		page = groups[off:end]
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"groups": page, "total": len(groups), "offset": off, "limit": lim, "truncated": truncated,
	})
}
