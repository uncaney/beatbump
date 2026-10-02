package api

// B6-19 "Doublons possibles": the library is fed by two acquisition chains
// (lidarr and soulseek, plus the ytm/ytmusic singles) that often bring the
// same album twice under slightly different tags ("Meteora" / "Meteora (Bonus
// Edition)", "Willy and the Poor Boys" / "Willy & The Poor Boys"). The album id
// is a hash of the raw (albumArtist, album) pair, so those copies are distinct
// lb- albums. This file groups them by the normalised pair (the D5
// local/albums/match normaliser, matchNorm) and picks the copy worth keeping.
// Nothing here deletes anything: it is a report (the /about section) and a
// preference used when mixes collapse duplicate tracks (collapseDuplicates).

import (
	"crypto/sha1"
	"encoding/hex"
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
	// dupScanCap bounds the albums scan (the library holds ~7 000 albums).
	// L12-13: past it the OLDEST albums (dateAdded desc) are left out and the
	// answer says so (`truncated`).
	dupScanCap  = 8000
	dupScanPage = 1000
	// dupQualityCap bounds the quality lookups to the copies of the largest
	// groups (100 per multi-search): the rest keep an unknown quality.
	dupQualityCap = 2000
	dupMemoTTL    = 10 * time.Minute
	// dupDefaultLimit / dupMaxLimit page GET /local/duplicates.
	dupDefaultLimit = 50
	dupMaxLimit     = 200
	// dupLossless is the indexer's qualityScore floor for lossless files
	// (quality_score in indexer.py: FLAC/ALAC/WAV start at 700).
	dupLossless = 700
)

// dupFeatBracketRe drops a bracketed "(feat. X)" only: matchNorm cuts
// everything after "feat", which would merge "2U (feat. Justin Bieber)
// (Afrojack Remix)" with every other remix of 2U.
var dupFeatBracketRe = regexp.MustCompile(`(?i)[\(\[]\s*(?:feat|ft|featuring)\b[^\)\]]*[\)\]]`)

// dupNorm normalises a title for the duplicate keys: matchNorm (case,
// accents, edition qualifiers, punctuation) after removing bracketed
// featurings, so remix / live qualifiers keep two titles apart.
func dupNorm(s string) string {
	return matchNorm(dupFeatBracketRe.ReplaceAllString(s, " "))
}

// dupAlbumKey is the normalised (album artist, title) pair of an album, ""
// when either side normalises to nothing.
func dupAlbumKey(albumArtist, album string) string {
	a, t := matchNorm(albumArtist), dupNorm(album)
	if a == "" || t == "" {
		return ""
	}
	return a + "\x00" + t
}

// dupGroupKey is the URL-safe public key of a group ("dk-" + 12 hex).
func dupGroupKey(norm string) string {
	h := sha1.Sum([]byte(norm))
	return "dk-" + hex.EncodeToString(h[:])[:12]
}

// dupAlbum is one copy of a group.
type dupAlbum struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Year       string `json:"year"`
	TrackCount int    `json:"trackCount"`
	Source     string `json:"source"`
	// Quality is the best qualityScore (0-1000) among the album's tracks;
	// BitrateHint reads it: "lossless" (>= 700), "lossy", "" unknown.
	Quality     int    `json:"quality,omitempty"`
	BitrateHint string `json:"bitrateHint,omitempty"`
	dateAdded   int64
}

// dupGroup is one set of albums with the same normalised pair.
type dupGroup struct {
	Key       string     `json:"key"`
	Albums    []dupAlbum `json:"albums"`
	Suggested string     `json:"suggested"`
}

// dupAlbumScanFn reads one page of the albums index, newest first, and the
// index's total (0 when unknown); a variable for tests. The docs carry
// albumDocAttrs too (L14-4: the same scan feeds ?filter=no-year, whose rows
// localAlbumItem renders).
var dupAlbumScanFn = func(off, lim int) ([]map[string]interface{}, int) {
	return meiliBrowse("albums", map[string]interface{}{
		"q": "", "offset": off, "limit": lim, "sort": []string{"dateAdded:desc"},
		"attributesToRetrieve": []string{"id", "album", "albumArtist", "artistId", "year", "coverLid", "trackCount", "source", "dateAdded"},
	})
}

// dupBetterFn orders the copies of a group (a variable so tests can make
// one group fail).
var dupBetterFn = dupBetter

// dupQualityFn returns the best track qualityScore of each album (by id),
// one Meili multi-search for every album of every group (a variable for
// tests). Albums it cannot resolve are simply absent.
var dupQualityFn = func(albums []dupAlbum) map[string]int {
	out := map[string]int{}
	for start := 0; start < len(albums); start += 100 {
		end := start + 100
		if end > len(albums) {
			end = len(albums)
		}
		queries := make([]map[string]interface{}, 0, end-start)
		for _, a := range albums[start:end] {
			queries = append(queries, map[string]interface{}{
				"indexUid": "tracks", "q": "",
				"filter": "album = \"" + escapeMeili(a.Title) + "\" AND albumArtist = \"" + escapeMeili(a.Artist) + "\"",
				"limit":  1, "sort": []string{"qualityScore:desc"},
				"attributesToRetrieve": []string{"qualityScore"},
			})
		}
		res, err := meiliReq("POST", "/multi-search", map[string]interface{}{"queries": queries})
		if err != nil || res == nil {
			continue
		}
		results, _ := res["results"].([]interface{})
		for i, r := range results {
			if i >= end-start {
				break
			}
			m, _ := r.(map[string]interface{})
			hits, _ := m["hits"].([]interface{})
			if len(hits) == 0 {
				continue
			}
			if h, ok := hits[0].(map[string]interface{}); ok {
				out[albums[start+i].ID] = mint(h, "qualityScore")
			}
		}
	}
	return out
}

// dupYear is the numeric year of a copy (0 unknown).
func dupYear(a dupAlbum) int {
	y, _ := strconv.Atoi(strings.TrimSpace(a.Year))
	return y
}

// dupBetter reports whether copy a should be kept over copy b: more tracks,
// then higher quality (lossless first), then the unqualified title ("Album"
// over "Album (Deluxe Edition)", L12-4: never the reissue just because it is
// newer), then newest (year, then date added), then the smaller id so the
// answer is stable.
func dupBetter(a, b dupAlbum) bool {
	if a.TrackCount != b.TrackCount {
		return a.TrackCount > b.TrackCount
	}
	if a.Quality != b.Quality {
		return a.Quality > b.Quality
	}
	if qa, qb := matchHasPackaging(a.Title), matchHasPackaging(b.Title); qa != qb {
		return !qa
	}
	if ya, yb := dupYear(a), dupYear(b); ya != yb {
		return ya > yb
	}
	if a.dateAdded != b.dateAdded {
		return a.dateAdded > b.dateAdded
	}
	return a.ID < b.ID
}

// groupDuplicateAlbums groups album docs by dupAlbumKey and keeps the keys
// with at least two copies; within a group the copies are ordered best first
// (Suggested = Albums[0]). Groups come largest first, then by artist, title.
// Pure: quality is read from the `quality` map (album id -> qualityScore).
func groupDuplicateAlbums(docs []map[string]interface{}, quality map[string]int) []dupGroup {
	byKey := map[string][]dupAlbum{}
	seen := map[string]bool{}
	var order []string
	for _, d := range docs {
		id := mstr(d, "id")
		if !isLocalAlbum(id) || seen[id] {
			continue
		}
		seen[id] = true
		k := dupAlbumKey(mstr(d, "albumArtist"), mstr(d, "album"))
		if k == "" {
			continue
		}
		a := dupAlbum{
			ID: id, Title: mstr(d, "album"), Artist: mstr(d, "albumArtist"),
			Year: mnumStr(d, "year"), TrackCount: mint(d, "trackCount"),
			Source: mstr(d, "source"), dateAdded: albumDateAdded(d),
		}
		if q, ok := quality[id]; ok && q > 0 {
			a.Quality = q
			a.BitrateHint = "lossy"
			if q >= dupLossless {
				a.BitrateHint = "lossless"
			}
		}
		if _, ok := byKey[k]; !ok {
			order = append(order, k)
		}
		byKey[k] = append(byKey[k], a)
	}
	groups := make([]dupGroup, 0)
	for _, k := range order {
		albums := byKey[k]
		if len(albums) < 2 {
			continue
		}
		if g, ok := dupBuildGroup(k, albums); ok {
			groups = append(groups, g)
		}
	}
	sort.SliceStable(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		if len(a.Albums) != len(b.Albums) {
			return len(a.Albums) > len(b.Albums)
		}
		if x, y := strings.ToLower(a.Albums[0].Artist), strings.ToLower(b.Albums[0].Artist); x != y {
			return x < y
		}
		return strings.ToLower(a.Albums[0].Title) < strings.ToLower(b.Albums[0].Title)
	})
	return groups
}

// dupBuildGroup orders one group's copies and names the suggested one.
// L12-13: a panic while building one group (bad data) drops that group
// with a log line instead of killing the scan, and the server with it.
func dupBuildGroup(k string, albums []dupAlbum) (g dupGroup, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("duplicates: group %s skipped: %v", dupGroupKey(k), r)
			g, ok = dupGroup{}, false
		}
	}()
	sort.SliceStable(albums, func(i, j int) bool { return dupBetterFn(albums[i], albums[j]) })
	return dupGroup{Key: dupGroupKey(k), Albums: albums, Suggested: albums[0].ID}, true
}

// splitByTrackCount keeps, inside each group, only copies whose track counts
// are within 1 of a neighbour (?sameTracks=1: "Meteora" 13 tracks and
// "Meteora (Bonus Edition)" 2 tracks are then not the same album). A group
// can split into several; sub-groups of one copy are dropped.
func splitByTrackCount(groups []dupGroup) []dupGroup {
	out := make([]dupGroup, 0, len(groups))
	for _, g := range groups {
		albums := append([]dupAlbum{}, g.Albums...)
		sort.SliceStable(albums, func(i, j int) bool { return albums[i].TrackCount > albums[j].TrackCount })
		var cur []dupAlbum
		parts := 0
		flush := func() {
			if len(cur) >= 2 {
				sort.SliceStable(cur, func(i, j int) bool { return dupBetter(cur[i], cur[j]) })
				key := g.Key
				if parts > 0 {
					key = g.Key + "-" + strconv.Itoa(parts)
				}
				parts++
				out = append(out, dupGroup{Key: key, Albums: cur, Suggested: cur[0].ID})
			}
			cur = nil
		}
		for _, a := range albums {
			if len(cur) > 0 && cur[len(cur)-1].TrackCount-a.TrackCount > 1 {
				flush()
			}
			cur = append(cur, a)
		}
		flush()
	}
	return out
}

// scanDuplicateGroups is the full (unmemoised) computation: the bounded
// albums scan, the grouping, the quality lookup for the grouped copies only,
// then the final ordering. ok is false when the scan read nothing (Meili
// down): such an answer is not memoised. L12-13: truncated is true when the
// scan stopped at dupScanCap with albums left behind (the index total, or a
// full last page when the total is unknown). A panic anywhere in the scan
// is recovered here (logged, ok=false, nothing memoised).
func scanDuplicateGroups() (groups []dupGroup, truncated bool, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("duplicates: scan failed: %v", r)
			groups, truncated, ok = []dupGroup{}, false, false
		}
	}()
	var docs []map[string]interface{}
	total, lastFull := 0, false
	for off := 0; off < dupScanCap; off += dupScanPage {
		page, n := dupAlbumScanFn(off, dupScanPage)
		docs = append(docs, page...)
		if n > total {
			total = n
		}
		lastFull = len(page) >= dupScanPage
		if !lastFull || (total > 0 && len(docs) >= total) {
			break
		}
	}
	if len(docs) == 0 {
		return []dupGroup{}, false, false
	}
	if len(docs) >= dupScanCap && lastFull && (total == 0 || total > len(docs)) {
		truncated = true
	}
	groups = groupDuplicateAlbums(docs, nil)
	var copies []dupAlbum
	for _, g := range groups {
		if len(copies)+len(g.Albums) > dupQualityCap {
			break // largest groups first: the rest keep an unknown quality
		}
		copies = append(copies, g.Albums...)
	}
	if len(copies) == 0 {
		return groups, truncated, true
	}
	quality := dupQualityFn(copies)
	inGroups := map[string]bool{}
	for _, g := range groups {
		for _, a := range g.Albums {
			inGroups[a.ID] = true
		}
	}
	kept := make([]map[string]interface{}, 0, len(inGroups))
	for _, d := range docs {
		if inGroups[mstr(d, "id")] {
			kept = append(kept, d)
		}
	}
	return groupDuplicateAlbums(kept, quality), truncated, true
}

var (
	dupMu        sync.Mutex
	dupMemo      []dupGroup
	dupMemoTrunc bool
	dupMemoAt    time.Time
	dupMemoNow   = time.Now // swapped by tests
)

// duplicateGroups is scanDuplicateGroups behind a dupMemoTTL memo. The lock
// is held during a recompute so concurrent callers share one scan. The
// second value says whether the scan left albums out (L12-13).
func duplicateGroups() ([]dupGroup, bool) {
	dupMu.Lock()
	defer dupMu.Unlock()
	now := dupMemoNow()
	if dupMemo != nil && now.Sub(dupMemoAt) < dupMemoTTL {
		return dupMemo, dupMemoTrunc
	}
	groups, truncated, ok := scanDuplicateGroups()
	if ok {
		dupMemo, dupMemoTrunc, dupMemoAt = groups, truncated, now
		setDuplicatePreferred(groups, now)
	}
	return groups, truncated
}

// resetDuplicateMemo drops the memo (tests).
func resetDuplicateMemo() {
	dupMu.Lock()
	dupMemo, dupMemoTrunc, dupMemoAt = nil, false, time.Time{}
	dupMu.Unlock()
	dupPrefMu.Lock()
	dupPref, dupPrefAt = nil, time.Time{}
	dupPrefMu.Unlock()
}

// LocalDuplicatesHandler serves GET /api/v1/local/duplicates.
//
//	?limit=50&offset=0   page of groups (limit 1-200), largest groups first
//	?sameTracks=1        only copies whose track counts are within 1
//
// Answer: {"groups": [{key, albums: [{id, title, artist, year, trackCount,
// source, quality?, bitrateHint?}], suggested}], "total": N, "offset", "limit"}.
// albums[0] is always the suggested copy (more tracks, then lossless / higher
// qualityScore, then the title without a packaging qualifier, then newest). An empty library or no duplicate answers
// {"groups": [], "total": 0} (never null). Read only: nothing is deleted.
//
//	?key=dk-…            one group: {"group": {...}, "groups": [{...}],
//	                     "total": 1}; an unknown key answers 404
//	                     {"error": "not_found", "group": null, "groups": [],
//	                     "total": 0}. Keys are stable while the copies keep
//	                     their tags (sha1 of the normalised pair); a
//	                     sameTracks=1 split adds a "-1", "-2" suffix.
//
// Harness contract: `total` is always a number and `groups` always an array,
// so a check can read `.groups[0].key` and fetch it back with ?key=.
// L12-13: `truncated` (bool) says the scan stopped at dupScanCap albums,
// the oldest ones left out.
func LocalDuplicatesHandler(c echo.Context) error {
	groups, truncated := duplicateGroups()
	if c.QueryParam("sameTracks") == "1" {
		groups = splitByTrackCount(groups)
	}
	if key := strings.TrimSpace(c.QueryParam("key")); key != "" {
		for _, g := range groups {
			if g.Key == key {
				return c.JSON(http.StatusOK, map[string]interface{}{"group": g, "groups": []dupGroup{g}, "total": 1})
			}
		}
		return c.JSON(http.StatusNotFound, map[string]interface{}{"error": "not_found", "group": nil, "groups": []dupGroup{}, "total": 0})
	}
	off, lim := 0, dupDefaultLimit
	if v, err := strconv.Atoi(c.QueryParam("offset")); err == nil && v > 0 {
		off = v
	}
	if v, err := strconv.Atoi(c.QueryParam("limit")); err == nil && v > 0 {
		lim = v
	}
	if lim > dupMaxLimit {
		lim = dupMaxLimit
	}
	page := []dupGroup{}
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

// ---- one copy per track in mixes, related and Pour toi (B6-19) ----

var (
	dupPrefMu sync.Mutex
	// dupPref is the set of suggested album ids of the last scan (only the
	// albums that belong to a group).
	dupPref   map[string]bool
	dupPrefAt time.Time
	// dupAutoRefresh is set by WarmDuplicates (main): a stale preference set
	// then triggers one background rescan. Tests leave it off, so a sampler
	// never starts a scan behind their back.
	dupAutoRefresh atomic.Bool
	dupRefreshing  atomic.Bool
)

// setDuplicatePreferred records the suggested copies of a scan.
func setDuplicatePreferred(groups []dupGroup, at time.Time) {
	p := map[string]bool{}
	for _, g := range groups {
		p[g.Suggested] = true
	}
	dupPrefMu.Lock()
	dupPref, dupPrefAt = p, at
	dupPrefMu.Unlock()
}

// WarmDuplicates runs the first duplicate scan in the background at start-up
// and lets later samplers refresh it when it is older than dupMemoTTL.
func WarmDuplicates() {
	dupAutoRefresh.Store(true)
	refreshDuplicatesAsync()
}

func refreshDuplicatesAsync() {
	if !dupRefreshing.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer dupRefreshing.Store(false)
		// L12-13: a panic in a bare goroutine kills the whole server; the
		// scan recovers its own, this is the last net.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("duplicates: background refresh failed: %v", r)
			}
		}()
		duplicateGroups()
	}()
}

// duplicatePreferred never blocks a sampler on a scan: it answers the last
// known suggested copies (possibly stale, nil before the first scan) and,
// when auto refresh is on and the set is stale, starts one rescan.
var duplicatePreferred = func() map[string]bool {
	dupPrefMu.Lock()
	p, at := dupPref, dupPrefAt
	dupPrefMu.Unlock()
	if dupAutoRefresh.Load() && (p == nil || dupMemoNow().Sub(at) >= dupMemoTTL) {
		refreshDuplicatesAsync()
	}
	return p
}

// dupTrackKey is the normalised (artist, title) of a track hit, "" when the
// title normalises to nothing (such hits are never collapsed).
func dupTrackKey(h map[string]interface{}) string {
	t := dupNorm(mstr(h, "title"))
	if t == "" {
		return ""
	}
	return matchNorm(mArtist(h)) + "\x00" + t
}

// collapseDuplicates keeps one track hit per normalised (artist, title):
// the one whose album is a suggested copy (`preferred`, album id -> true)
// when the group has one, else the first. The kept hit takes the position
// of the first occurrence, so the caller's order (shuffle, seed first) is
// preserved. Pure; hits without a key pass through untouched.
func collapseDuplicates(hits []map[string]interface{}, preferred map[string]bool) []map[string]interface{} {
	isPreferred := func(h map[string]interface{}) bool {
		if len(preferred) == 0 {
			return false
		}
		id, _, _ := trackAlbumKey(h)
		return id != "" && preferred[id]
	}
	pos := map[string]int{}
	out := make([]map[string]interface{}, 0, len(hits))
	for _, h := range hits {
		k := dupTrackKey(h)
		if k == "" {
			out = append(out, h)
			continue
		}
		i, ok := pos[k]
		if !ok {
			pos[k] = len(out)
			out = append(out, h)
			continue
		}
		if !isPreferred(out[i]) && isPreferred(h) {
			out[i] = h
		}
	}
	return out
}

// collapseLibraryDuplicates is collapseDuplicates with the library's
// current suggested copies.
func collapseLibraryDuplicates(hits []map[string]interface{}) []map[string]interface{} {
	return collapseDuplicates(hits, duplicatePreferred())
}

// dupOversample is how many more hits a sampler draws so the collapse still
// leaves n items (duplicates are a few percent of the library).
func dupOversample(n int) int { return n + n/4 + 1 }
