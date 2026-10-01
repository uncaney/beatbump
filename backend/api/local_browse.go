package api

// Local collection browse: paginated + sorted listings of the whole self-hosted
// library (artists / albums / songs / genres) straight from Meilisearch. Items are
// returned in the SAME IListItemRenderer shape the search/results UI consumes, so the
// existing card component handles playback, the 3-dot menu and navigation unchanged.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

// allow-lists mirror the Meili sortableAttributes for each index.
var albumSortable = map[string]bool{"album": true, "albumArtist": true, "dateAdded": true, "trackCount": true, "year": true}
var artistSortable = map[string]bool{"albumCount": true, "dateAdded": true, "name": true, "trackCount": true}
var trackSortable = map[string]bool{"album": true, "albumArtist": true, "artist": true, "dateAdded": true, "durationSec": true, "title": true, "track": true, "year": true}

func pag(c echo.Context, defLimit int) (int, int) {
	off, _ := strconv.Atoi(c.QueryParam("offset"))
	if off < 0 {
		off = 0
	}
	lim, _ := strconv.Atoi(c.QueryParam("limit"))
	if lim <= 0 {
		lim = defLimit
	}
	if lim > 200 {
		lim = 200
	}
	return off, lim
}

// "field[:dir]" validated against an allow-list. Empty -> def. A field outside
// the allow-list or a direction other than asc/desc is reported (ok=false) so
// the handler answers 400 instead of silently sorting by the default (audit
// v3 G18).
func validSort(raw string, allow map[string]bool, def string) (string, bool) {
	if raw == "" {
		return def, true
	}
	parts := strings.SplitN(raw, ":", 2)
	field := parts[0]
	dir := "asc"
	if len(parts) == 2 {
		dir = parts[1]
	}
	if dir != "asc" && dir != "desc" {
		return "", false
	}
	if !allow[field] {
		return "", false
	}
	return field + ":" + dir, true
}

// badSort is the 400 answer for an unknown ?sort= value.
func badSort(c echo.Context, raw string) error {
	return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "unknown sort: " + raw})
}

func meiliBrowse(index string, payload map[string]interface{}) ([]map[string]interface{}, int) {
	out, err := meiliReq("POST", "/indexes/"+index+"/search", payload)
	if err != nil || out == nil {
		return nil, 0
	}
	total := 0
	if v, ok := out["estimatedTotalHits"].(float64); ok {
		total = int(v)
	}
	if v, ok := out["totalHits"].(float64); ok && int(v) > total {
		total = int(v)
	}
	raw, _ := out["hits"].([]interface{})
	res := make([]map[string]interface{}, 0, len(raw))
	for _, h := range raw {
		if m, ok := h.(map[string]interface{}); ok {
			res = append(res, m)
		}
	}
	return res, total
}

// localArtistItem produces a card the frontend routes to /artist/la-… on click.
// isChannelOrArtist requires a non-empty subtitle + ARTIST endpoint; the click
// handler reads artistInfo.artist[0].browseId, so both are set here.
func localArtistItem(a map[string]interface{}, cover string) IListItemRenderer {
	id := mstr(a, "id")
	name := mstr(a, "name")
	item := IListItemRenderer{
		Title:      name,
		Subtitle:   []Artist{{Text: name, BrowseId: id, PageType: "MUSIC_PAGE_TYPE_ARTIST"}},
		Endpoint:   &Endpoint{BrowseId: id, PageType: "MUSIC_PAGE_TYPE_ARTIST"},
		BrowseId:   id,
		Type:       "artist",
		Thumbnails: []Thumbnail{{URL: coverURL(cover), Width: 226, Height: 226}},
	}
	item.ArtistInfo.Artist = []Artist{{Text: name, BrowseId: id}}
	return item
}

// artistCovers batch-resolves a cover per artist (most recent album's coverLid),
// so a grid of N artists costs one extra Meili query instead of N.
func artistCovers(arts []map[string]interface{}) map[string]string {
	ids := make([]string, 0, len(arts))
	for _, a := range arts {
		if id := mstr(a, "id"); id != "" {
			ids = append(ids, "\""+id+"\"")
		}
	}
	m := map[string]string{}
	if len(ids) == 0 {
		return m
	}
	hits := meiliSearchIndex("albums", map[string]interface{}{
		"q": "", "filter": "artistId IN [" + strings.Join(ids, ",") + "]",
		"limit": 2000, "sort": []string{"year:desc"},
		"attributesToRetrieve": []string{"artistId", "coverLid"},
	})
	for _, h := range hits {
		aid := mstr(h, "artistId")
		if aid == "" {
			continue
		}
		if _, seen := m[aid]; !seen {
			m[aid] = mstr(h, "coverLid")
		}
	}
	return m
}

func LocalArtistsHandler(c echo.Context) error {
	off, lim := pag(c, 60)
	sortBy, ok := validSort(c.QueryParam("sort"), artistSortable, "name:asc")
	if !ok {
		return badSort(c, c.QueryParam("sort"))
	}
	hits, total := meiliBrowse("artists", map[string]interface{}{
		"q": c.QueryParam("q"), "offset": off, "limit": lim, "sort": []string{sortBy},
		"attributesToRetrieve": []string{"id", "name", "albumCount", "trackCount"},
	})
	covers := artistCovers(hits)
	items := make([]IListItemRenderer, 0, len(hits))
	for _, a := range hits {
		items = append(items, localArtistItem(a, covers[mstr(a, "id")]))
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"items": items, "total": total, "offset": off, "limit": lim, "sort": sortBy,
	})
}

// albumDocAttrs is what localAlbumItem needs from an albums doc.
var albumDocAttrs = []string{"id", "album", "albumArtist", "artistId", "year", "coverLid", "trackCount"}

// BI4: ?filter= values of GET /local/albums, the lists behind the home rows'
// "Voir tout". The albums index is filterable on albumArtist / artistId /
// source only (local_covers.go), so both are materialised from a bounded
// newest-first scan (recentAlbumDocs), sorted in Go and paged here.
//
//	never-played  albums none of whose tracks the profile played (the
//	              me/never-played logic, profile cookie), up to the scan cap
//	added-30d     albums added in the last addedRecentlyDays days
var albumFilters = map[string]bool{"never-played": true, "added-30d": true}

const (
	albumFilterScanPage = 200
	albumFilterScanCap  = 1000
	addedRecentlyDays   = 30
)

// badFilter is the 400 answer for an unknown ?filter= value.
func badFilter(c echo.Context, raw string) error {
	return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "unknown filter: " + raw})
}

func LocalAlbumsHandler(c echo.Context) error {
	off, lim := pag(c, 60)
	sortBy, ok := validSort(c.QueryParam("sort"), albumSortable, "dateAdded:desc")
	if !ok {
		return badSort(c, c.QueryParam("sort"))
	}
	if f := c.QueryParam("filter"); f != "" {
		if !albumFilters[f] {
			return badFilter(c, f)
		}
		return localAlbumsFiltered(c, f, off, lim, sortBy)
	}
	payload := map[string]interface{}{
		"q": c.QueryParam("q"), "offset": off, "limit": lim, "sort": []string{sortBy},
		"attributesToRetrieve": albumDocAttrs,
	}
	if aid := c.QueryParam("artistId"); aid != "" {
		payload["filter"] = "artistId = \"" + escapeMeili(aid) + "\""
	}
	hits, total := meiliBrowse("albums", payload)
	items := make([]IListItemRenderer, 0, len(hits))
	for _, a := range hits {
		items = append(items, localAlbumItem(a))
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"items": items, "total": total, "offset": off, "limit": lim, "sort": sortBy,
	})
}

// recentAlbumDocs scans the albums index newest first (dateAdded desc,
// epoch seconds) and returns the docs added since `cutoff` (0: every doc,
// up to the cap), honouring the listing's q and artistId. Bounded by
// albumFilterScanCap docs (five pages).
func recentAlbumDocs(q, artistId string, cutoff int64) []map[string]interface{} {
	out := make([]map[string]interface{}, 0)
	attrs := append(append([]string{}, albumDocAttrs...), "dateAdded")
	for off := 0; off < albumFilterScanCap; off += albumFilterScanPage {
		payload := map[string]interface{}{
			"q": q, "offset": off, "limit": albumFilterScanPage, "sort": []string{"dateAdded:desc"},
			"attributesToRetrieve": attrs,
		}
		if artistId != "" {
			payload["filter"] = "artistId = \"" + escapeMeili(artistId) + "\""
		}
		hits, _ := meiliBrowse("albums", payload)
		if len(hits) == 0 {
			break
		}
		stop := false
		for _, a := range hits {
			if cutoff > 0 && albumDateAdded(a) < cutoff {
				stop = true
				break
			}
			out = append(out, a)
		}
		if stop || len(hits) < albumFilterScanPage {
			break
		}
	}
	return out
}

// sortAlbumDocs orders album docs by a validated "field:dir" (albumSortable)
// in Go, since the filtered listings are materialised rather than paged by
// Meili. Strings compare case-insensitively; dateAdded / trackCount as
// numbers; year as the 4-digit string the index stores.
func sortAlbumDocs(docs []map[string]interface{}, sortBy string) {
	parts := strings.SplitN(sortBy, ":", 2)
	field := parts[0]
	desc := len(parts) == 2 && parts[1] == "desc"
	if field == "dateAdded" && desc {
		return // the scan order
	}
	less := func(a, b map[string]interface{}) bool {
		switch field {
		case "dateAdded":
			return albumDateAdded(a) < albumDateAdded(b)
		case "trackCount":
			return mint(a, field) < mint(b, field)
		case "year":
			return mnumStr(a, field) < mnumStr(b, field)
		}
		return strings.ToLower(mstr(a, field)) < strings.ToLower(mstr(b, field))
	}
	sort.SliceStable(docs, func(i, j int) bool {
		if desc {
			return less(docs[j], docs[i])
		}
		return less(docs[i], docs[j])
	})
}

// localAlbumsFiltered answers GET /local/albums?filter=never-played|added-30d.
// `total` is exact for added-30d; for never-played it counts the survivors
// of the play_events pair filter (an upper bound: the Meili confirmation may
// still reject a few, the client then sees a short page and stops).
func localAlbumsFiltered(c echo.Context, filter string, off, lim int, sortBy string) error {
	items := make([]IListItemRenderer, 0, lim)
	total := 0
	switch filter {
	case "added-30d":
		cutoff := time.Now().Add(-addedRecentlyDays * 24 * time.Hour).Unix()
		docs := recentAlbumDocs(c.QueryParam("q"), c.QueryParam("artistId"), cutoff)
		sortAlbumDocs(docs, sortBy)
		total = len(docs)
		start, end := off, off+lim
		if start > total {
			start = total
		}
		if end > total {
			end = total
		}
		for _, a := range docs[start:end] {
			items = append(items, localAlbumItem(a))
		}
	case "never-played":
		if off > neverPlayedMaxOffset {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "offset too large"})
		}
		scan := neverPlayedScanFor(profileID(c), c.QueryParam("q"), c.QueryParam("artistId"), sortBy)
		var next int
		items, next = neverPlayedWindow(scan.candidates, scan.refs, off, lim)
		return c.JSON(http.StatusOK, map[string]interface{}{
			"items": items, "total": len(scan.candidates), "offset": off, "limit": lim, "sort": sortBy, "filter": filter,
			"nextOffset": next,
		})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"items": items, "total": total, "offset": off, "limit": lim, "sort": sortBy, "filter": filter,
	})
}

// L9-2: the never-played list pages over the CANDIDATES (the albums the
// play_events pair filter keeps, no Meili involved), not over the confirmed
// albums: `offset` is a candidate index, each page confirms with Meili only
// the candidates it walks from `offset` until `limit` albums are found, and
// answers `nextOffset` (the candidate index to ask next; the client follows
// it). A page therefore costs `limit` + the rejects inside its own window,
// whatever its depth, instead of re-confirming every earlier album. `total`
// is the candidate count (the same space as offset). The scan itself
// (recentAlbumDocs + loadPlayedIndex + pair filter + sort) is memoised 60 s
// per (profile, q, artistId, sort) in a bounded map, so infinite scroll does
// not rescan five Meili pages per page either.
const (
	neverPlayedMaxOffset = 2000
	neverPlayedMemoTTL   = 60 * time.Second
	neverPlayedMemoMax   = 128
)

type neverPlayedScan struct {
	candidates []map[string]interface{}
	refs       map[string]bool
	at         time.Time
}

var (
	neverPlayedMemoMu sync.Mutex
	neverPlayedMemo   = map[string]*neverPlayedScan{}
)

// resetNeverPlayedMemo empties the scan memo (tests).
func resetNeverPlayedMemo() {
	neverPlayedMemoMu.Lock()
	neverPlayedMemo = map[string]*neverPlayedScan{}
	neverPlayedMemoMu.Unlock()
}

// neverPlayedScanFor returns the memoised candidate scan of a profile's
// never-played listing, computing it on a miss or after neverPlayedMemoTTL.
// When the map is full, expired entries are dropped first, then the oldest.
func neverPlayedScanFor(pid, q, artistId, sortBy string) *neverPlayedScan {
	key := pid + "\x00" + q + "\x00" + artistId + "\x00" + sortBy
	now := time.Now()
	neverPlayedMemoMu.Lock()
	if s, ok := neverPlayedMemo[key]; ok && now.Sub(s.at) < neverPlayedMemoTTL {
		neverPlayedMemoMu.Unlock()
		return s
	}
	neverPlayedMemoMu.Unlock()

	docs := recentAlbumDocs(q, artistId, 0)
	sortAlbumDocs(docs, sortBy)
	played := loadPlayedIndex(pid)
	cands := make([]map[string]interface{}, 0, len(docs))
	for _, a := range docs {
		if album, aa := mstr(a, "album"), mstr(a, "albumArtist"); album != "" && aa != "" && !played.knownPlayed(album, aa) {
			cands = append(cands, a)
		}
	}
	s := &neverPlayedScan{candidates: cands, refs: played.refs, at: now}

	neverPlayedMemoMu.Lock()
	defer neverPlayedMemoMu.Unlock()
	if len(neverPlayedMemo) >= neverPlayedMemoMax {
		for k, v := range neverPlayedMemo {
			if now.Sub(v.at) >= neverPlayedMemoTTL {
				delete(neverPlayedMemo, k)
			}
		}
		for len(neverPlayedMemo) >= neverPlayedMemoMax {
			oldK, oldAt := "", now
			for k, v := range neverPlayedMemo {
				if oldK == "" || v.at.Before(oldAt) {
					oldK, oldAt = k, v.at
				}
			}
			delete(neverPlayedMemo, oldK)
		}
	}
	neverPlayedMemo[key] = s
	return s
}

// neverPlayedWindow confirms candidates from index `off` until `limit`
// never-played albums are collected (or the candidates run out) and returns
// them with the candidate index right after the last one examined.
func neverPlayedWindow(cands []map[string]interface{}, refs map[string]bool, off, limit int) ([]IListItemRenderer, int) {
	items := make([]IListItemRenderer, 0, limit)
	i := off
	for ; i < len(cands) && len(items) < limit; i++ {
		a := cands[i]
		if albumNeverPlayed(mstr(a, "album"), mstr(a, "albumArtist"), refs) {
			items = append(items, localAlbumItem(a))
		}
	}
	if i < off {
		i = off
	}
	return items, i
}

func LocalSongsHandler(c echo.Context) error {
	off, lim := pag(c, 60)
	sortBy, ok := validSort(c.QueryParam("sort"), trackSortable, "dateAdded:desc")
	if !ok {
		return badSort(c, c.QueryParam("sort"))
	}
	filters := []string{}
	if g := c.QueryParam("genre"); g != "" {
		filters = append(filters, "genre = \""+escapeMeili(g)+"\"")
	}
	if ar := c.QueryParam("artist"); ar != "" {
		filters = append(filters, "albumArtist = \""+escapeMeili(ar)+"\"")
	}
	payload := map[string]interface{}{
		"q": c.QueryParam("q"), "offset": off, "limit": lim, "sort": []string{sortBy},
		"attributesToRetrieve": []string{"lid", "title", "artist", "albumArtist", "album", "track", "durationSec"},
	}
	if len(filters) > 0 {
		payload["filter"] = strings.Join(filters, " AND ")
	}
	hits, total := meiliBrowse("tracks", payload)
	items := localSongItemsWithCovers(hits)
	return c.JSON(http.StatusOK, map[string]interface{}{
		"items": items, "total": total, "offset": off, "limit": lim, "sort": sortBy,
	})
}

// LocalGenresHandler returns genre values by track count (best-effort: the genre
// field is free-text and frequently multi-valued/multilingual, capped to top-100
// by Meili faceting). Good enough for a browse-by-genre entry point.
func LocalGenresHandler(c echo.Context) error {
	type genre struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	genres := []genre{}
	out, err := meiliReq("POST", "/indexes/tracks/search", map[string]interface{}{
		"q": c.QueryParam("q"), "limit": 0, "facets": []string{"genre"},
	})
	if err == nil && out != nil {
		if fd, ok := out["facetDistribution"].(map[string]interface{}); ok {
			if g, ok := fd["genre"].(map[string]interface{}); ok {
				for name, cnt := range g {
					if strings.TrimSpace(name) == "" {
						continue
					}
					genres = append(genres, genre{Name: name, Count: mintFloat(cnt)})
				}
			}
		}
	}
	sort.Slice(genres, func(i, j int) bool { return genres[i].Count > genres[j].Count })
	return c.JSON(http.StatusOK, map[string]interface{}{"genres": genres})
}

func mintFloat(v interface{}) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

// neverPlayedScanCap bounds how many of the most recently added albums are
// examined (dateAdded desc) looking for `limit` never-played ones, so a large
// library with a thin history still answers in one bounded pass instead of
// walking every album.
const neverPlayedScanCap = 120

// playedIndex folds a profile's play history for the never-played checks
// (L8-4): every distinct play ref (local lid or YouTube videoId) and every
// (album, artist) pair the play rows carry, lower-cased. The pairs reject
// most candidates without Meili; the refs confirm the survivors.
type playedIndex struct {
	refs   map[string]bool
	albums map[string]bool
}

// albumPairKey is the case-insensitive (album, artist) key of playedIndex.
func albumPairKey(album, artist string) string {
	return strings.ToLower(strings.TrimSpace(album)) + "\x00" + strings.ToLower(strings.TrimSpace(artist))
}

// loadPlayedIndex reads a profile's play_events in two aggregate queries
// (distinct refs; distinct album/artist pairs). Rows without an album
// label (YouTube plays, legacy rows) only contribute their ref: the albums
// they belong to are confirmed through Meili like before.
func loadPlayedIndex(pid string) playedIndex {
	idx := playedIndex{refs: map[string]bool{}, albums: map[string]bool{}}
	var refs []string
	db.DB.Model(&db.PlayEvent{}).Where("profile_id = ?", pid).Distinct("ref").Pluck("ref", &refs)
	for _, r := range refs {
		if r != "" {
			idx.refs[r] = true
		}
	}
	var pairs []struct {
		Album  string
		Artist string
	}
	db.DB.Model(&db.PlayEvent{}).Select("album, artist").Where("profile_id = ? AND album <> ''", pid).Group("album, artist").Scan(&pairs)
	for _, p := range pairs {
		idx.albums[albumPairKey(p.Album, p.Artist)] = true
	}
	return idx
}

// knownPlayed reports whether a play row already names this album (by its
// album + albumArtist pair): no Meili query is needed to reject it.
func (p playedIndex) knownPlayed(album, albumArtist string) bool {
	return p.albums[albumPairKey(album, albumArtist)]
}

// albumNeverPlayed reports whether none of an album's tracks is in `played`
// (a profile's distinct play refs): by lid (local track refs ARE their lid,
// me.go itemMeta/MeRecordPlayHandler) and, L8-13, by the YouTube videoId
// the track was acquired from, so an album streamed before it was acquired
// is not offered as never played. An album with no resolvable tracks is
// never offered (nothing to confirm it was never played).
func albumNeverPlayed(album, albumArtist string, played map[string]bool) bool {
	tracks := albumTracks(album, albumArtist)
	if len(tracks) == 0 {
		return false
	}
	for _, t := range tracks {
		if played[mstr(t, "lid")] {
			return false
		}
		if vid := mstr(t, "videoId"); vid != "" && played[vid] {
			return false
		}
	}
	return true
}

// neverPlayedAlbums walks `candidates` (album docs, in the wanted order) and
// returns the never-played ones after the first `skip`, at most `limit`
// (limit <= 0: no cap). L8-4: a candidate whose (album, albumArtist) pair is
// on a play row is dropped without Meili; only the survivors cost one
// albumTracks query each (the lid / videoId confirmation). The walk stops as
// soon as `limit` albums are collected, so the home row (limit 10) costs at
// most 10 confirmations plus the survivors the confirmation rejects.
func neverPlayedAlbums(candidates []map[string]interface{}, played playedIndex, skip, limit int) []IListItemRenderer {
	items := make([]IListItemRenderer, 0)
	found := 0
	for _, a := range candidates {
		if limit > 0 && len(items) >= limit {
			break
		}
		album, aa := mstr(a, "album"), mstr(a, "albumArtist")
		if album == "" || aa == "" || played.knownPlayed(album, aa) {
			continue
		}
		if !albumNeverPlayed(album, aa, played.refs) {
			continue
		}
		found++
		if found <= skip {
			continue
		}
		items = append(items, localAlbumItem(a))
	}
	return items
}

// MeNeverPlayedHandler: GET /api/v1/me/never-played?limit=10 (D2). Local
// albums (dateAdded desc) none of whose tracks appear anywhere in the
// profile's play history - the set difference between the library and
// play_events, computed here since the Meili index carries no "played"
// field. Anonymous profiles have no history (every album qualifies); the
// client hides the row for an anonymous profile and when the answer is
// empty, same as the other personal rows.
func MeNeverPlayedHandler(c echo.Context) error {
	pid := profileID(c)
	limit := clampLimit(c, 10, 50)
	played := loadPlayedIndex(pid)
	candidates, _ := meiliBrowse("albums", map[string]interface{}{
		"q": "", "offset": 0, "limit": neverPlayedScanCap, "sort": []string{"dateAdded:desc"},
		"attributesToRetrieve": albumDocAttrs,
	})
	return c.JSON(http.StatusOK, map[string]interface{}{"items": neverPlayedAlbums(candidates, played, 0, limit)})
}
