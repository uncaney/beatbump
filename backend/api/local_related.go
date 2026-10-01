package api

import (
	"math/rand"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

// LocalRelatedHandler answers GET /api/v1/local/related with owned-library
// tracks related to the current one ("Dans ta bibliothèque" in the Related tab).
// Seed: ?lid=<11 hex> (local track) or ?title=&artist= (a YouTube track is
// matched against the index by its metadata). The pool is the radio pool
// (same artist, same genre, library sample), seed excluded, one card per
// album with the seed artist first (relatedByAlbum).
func LocalRelatedHandler(c echo.Context) error {
	lid := strings.TrimSpace(c.QueryParam("lid"))
	title := strings.TrimSpace(c.QueryParam("title"))
	artist := strings.TrimSpace(c.QueryParam("artist"))
	var seed map[string]interface{}
	if isLid(lid) {
		seed = meiliByLid(lid)
	} else if title != "" {
		seed = meiliSeedByMetadata(title, artist)
		if seed != nil {
			lid = mstr(seed, "lid")
		}
	}
	if seed == nil {
		return c.JSON(http.StatusNotFound, map[string]interface{}{"error": "not_found", "items": []Item{}})
	}
	items := relatedByAlbum(seed, lid, radioPool(seed, lid), 20)
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "seed": lid})
}

// relatedByAlbum turns the radio pool into the "Dans ta bibliothèque" cards
// (audit UX v6 TOP 6): one card per album (a compilation no longer shows the
// same cover twice), never the same thumbnail twice, and the current artist's
// albums first so the visible cards are about the track being played. Within
// each group the pool order is shuffled so the row varies between tracks.
func relatedByAlbum(seed map[string]interface{}, seedLid string, pool []map[string]interface{}, limit int) []Item {
	rand.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	seedArtists := map[string]bool{}
	for _, a := range []string{mArtist(seed), mstr(seed, "albumArtist")} {
		if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
			seedArtists[a] = true
		}
	}
	sameArtist := func(h map[string]interface{}) bool {
		for _, a := range []string{mstr(h, "artist"), mstr(h, "albumArtist")} {
			if seedArtists[strings.ToLower(strings.TrimSpace(a))] {
				return true
			}
		}
		return false
	}
	seenLid := map[string]bool{seedLid: true}
	seenAlbum := map[string]bool{}
	seenCover := map[string]bool{}
	var first, rest []Item
	for _, h := range pool {
		l := mstr(h, "lid")
		if l == "" || seenLid[l] {
			continue
		}
		seenLid[l] = true
		albumKey, _, _ := trackAlbumKey(h)
		if albumKey != "" && seenAlbum[albumKey] {
			continue
		}
		it := lidItem(h)
		cover := ""
		if len(it.Thumbnails) > 0 {
			cover = it.Thumbnails[0].URL
		}
		if cover != "" && seenCover[cover] {
			continue
		}
		if albumKey != "" {
			seenAlbum[albumKey] = true
		}
		if cover != "" {
			seenCover[cover] = true
		}
		if sameArtist(h) {
			first = append(first, it)
		} else {
			rest = append(rest, it)
		}
	}
	out := append(first, rest...)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// meiliSeedByMetadata finds the owned track that best matches a title/artist
// pair (first full-text hit whose title matches case-insensitively).
func meiliSeedByMetadata(title, artist string) map[string]interface{} {
	q := strings.TrimSpace(title + " " + artist)
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": q, "limit": 5,
		"attributesToRetrieve": []string{"title", "artist", "albumArtist", "album", "genre", "path", "durationSec", "lid", "track"},
	})
	want := strings.ToLower(title)
	for _, h := range hits {
		if strings.ToLower(mstr(h, "title")) == want && mstr(h, "lid") != "" {
			return h
		}
	}
	for _, h := range hits {
		if mstr(h, "lid") != "" && strings.Contains(strings.ToLower(mstr(h, "title")), want) {
			return h
		}
	}
	return nil
}
