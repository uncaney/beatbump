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
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

const (
	// dupScanCap bounds the albums scan (the library holds ~7 000 albums).
	dupScanCap  = 8000
	dupScanPage = 1000
	dupMemoTTL  = 10 * time.Minute
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

// dupAlbumScanFn reads one page of the albums index, newest first (a
// variable for tests).
var dupAlbumScanFn = func(off, lim int) []map[string]interface{} {
	hits, _ := meiliBrowse("albums", map[string]interface{}{
		"q": "", "offset": off, "limit": lim, "sort": []string{"dateAdded:desc"},
		"attributesToRetrieve": []string{"id", "album", "albumArtist", "year", "trackCount", "source", "dateAdded"},
	})
	return hits
}

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
// then higher quality (lossless first), then newest (year, then date added),
// then the smaller id so the answer is stable.
func dupBetter(a, b dupAlbum) bool {
	if a.TrackCount != b.TrackCount {
		return a.TrackCount > b.TrackCount
	}
	if a.Quality != b.Quality {
		return a.Quality > b.Quality
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
		sort.SliceStable(albums, func(i, j int) bool { return dupBetter(albums[i], albums[j]) })
		groups = append(groups, dupGroup{Key: dupGroupKey(k), Albums: albums, Suggested: albums[0].ID})
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
// down): such an answer is not memoised.
func scanDuplicateGroups() (groups []dupGroup, ok bool) {
	var docs []map[string]interface{}
	for off := 0; off < dupScanCap; off += dupScanPage {
		page := dupAlbumScanFn(off, dupScanPage)
		docs = append(docs, page...)
		if len(page) < dupScanPage {
			break
		}
	}
	if len(docs) == 0 {
		return []dupGroup{}, false
	}
	groups = groupDuplicateAlbums(docs, nil)
	var copies []dupAlbum
	for _, g := range groups {
		copies = append(copies, g.Albums...)
	}
	if len(copies) == 0 {
		return groups, true
	}
	quality := dupQualityFn(copies)
	inGroups := map[string]bool{}
	for _, a := range copies {
		inGroups[a.ID] = true
	}
	kept := make([]map[string]interface{}, 0, len(copies))
	for _, d := range docs {
		if inGroups[mstr(d, "id")] {
			kept = append(kept, d)
		}
	}
	return groupDuplicateAlbums(kept, quality), true
}

var (
	dupMu      sync.Mutex
	dupMemo    []dupGroup
	dupMemoAt  time.Time
	dupMemoNow = time.Now // swapped by tests
)

// duplicateGroups is scanDuplicateGroups behind a dupMemoTTL memo. The lock
// is held during a recompute so concurrent callers share one scan.
func duplicateGroups() []dupGroup {
	dupMu.Lock()
	defer dupMu.Unlock()
	now := dupMemoNow()
	if dupMemo != nil && now.Sub(dupMemoAt) < dupMemoTTL {
		return dupMemo
	}
	groups, ok := scanDuplicateGroups()
	if ok {
		dupMemo, dupMemoAt = groups, now
	}
	return groups
}

// resetDuplicateMemo drops the memo (tests).
func resetDuplicateMemo() {
	dupMu.Lock()
	dupMemo, dupMemoAt = nil, time.Time{}
	dupMu.Unlock()
}

// LocalDuplicatesHandler serves GET /api/v1/local/duplicates.
//
//	?limit=50&offset=0   page of groups (limit 1-200), largest groups first
//	?sameTracks=1        only copies whose track counts are within 1
//
// Answer: {"groups": [{key, albums: [{id, title, artist, year, trackCount,
// source, quality?, bitrateHint?}], suggested}], "total": N, "offset", "limit"}.
// albums[0] is always the suggested copy (more tracks, then lossless / higher
// qualityScore, then newest). An empty library or no duplicate answers
// {"groups": [], "total": 0} (never null). Read only: nothing is deleted.
func LocalDuplicatesHandler(c echo.Context) error {
	groups := duplicateGroups()
	if c.QueryParam("sameTracks") == "1" {
		groups = splitByTrackCount(groups)
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
		"groups": page, "total": len(groups), "offset": off, "limit": lim,
	})
}
