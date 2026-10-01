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

func LocalAlbumsHandler(c echo.Context) error {
	off, lim := pag(c, 60)
	sortBy, ok := validSort(c.QueryParam("sort"), albumSortable, "dateAdded:desc")
	if !ok {
		return badSort(c, c.QueryParam("sort"))
	}
	payload := map[string]interface{}{
		"q": c.QueryParam("q"), "offset": off, "limit": lim, "sort": []string{sortBy},
		"attributesToRetrieve": []string{"id", "album", "albumArtist", "artistId", "year", "coverLid", "trackCount"},
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

// albumNeverPlayed reports whether none of an album's tracks (by lid) is in
// `played` (a profile's distinct play refs - local track refs ARE their lid,
// me.go itemMeta/MeRecordPlayHandler). An album with no resolvable tracks is
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
	}
	return true
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

	var refs []string
	db.DB.Model(&db.PlayEvent{}).Where("profile_id = ?", pid).Distinct("ref").Pluck("ref", &refs)
	played := make(map[string]bool, len(refs))
	for _, r := range refs {
		played[r] = true
	}

	candidates, _ := meiliBrowse("albums", map[string]interface{}{
		"q": "", "offset": 0, "limit": neverPlayedScanCap, "sort": []string{"dateAdded:desc"},
		"attributesToRetrieve": []string{"id", "album", "albumArtist", "artistId", "year", "coverLid", "trackCount"},
	})
	items := make([]IListItemRenderer, 0, limit)
	for _, a := range candidates {
		if len(items) >= limit {
			break
		}
		album, aa := mstr(a, "album"), mstr(a, "albumArtist")
		if album == "" || aa == "" || !albumNeverPlayed(album, aa, played) {
			continue
		}
		items = append(items, localAlbumItem(a))
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items})
}
