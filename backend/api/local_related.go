package api

import (
	"math/rand"
	"net/http"
	"strings"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

// LocalRelatedHandler answers GET /api/v1/local/related with owned-library
// tracks related to the current one ("Dans ta bibliothèque" in the Related tab).
// Seed: ?lid=<11 hex> (local track) or ?title=&artist= (a YouTube track is
// matched against the index by its metadata). The pool is the radio pool
// (same artist, same genre, library sample), seed excluded, one card per
// album with the seed artist first (relatedByAlbum).
//
// EQ1: ?seed=album:<id>|artist:<id>|favorites builds a flat "Radio ciblée"
// queue instead (localRelatedSeedHandler) - every track owned by that
// album/artist, or every favourited song, extended with the regular radio
// pool, capped at 30 tracks with at most 2 per album (radioFromSeedTracks).
//
// c40b B6-10: `exclude=<ref>,<ref>` (the queue the client just played) and
// `personal=1` (the profile's twice-skipped refs, requestExclusions) are left
// out of both answers, every copy of those songs included (c43b L12-18).
// personal=1 is served uncached (perProfileRelated); exclude= is part of the
// shared cache key.
func LocalRelatedHandler(c echo.Context) error {
	if seed := strings.TrimSpace(c.QueryParam("seed")); seed != "" {
		return localRelatedSeedHandler(c, seed)
	}
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
	items := relatedByAlbum(seed, lid, withoutRefs(radioPool(seed, lid), requestExclusions(c)), 20)
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "seed": lid})
}

// relatedByAlbum turns the radio pool into the "Dans ta bibliothèque" cards
// (audit UX v6 TOP 6): one card per album (a compilation no longer shows the
// same cover twice), never the same thumbnail twice, and the current artist's
// albums first so the visible cards are about the track being played. Within
// each group the pool order is shuffled so the row varies between tracks.
func relatedByAlbum(seed map[string]interface{}, seedLid string, pool []map[string]interface{}, limit int) []Item {
	rand.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	// c41b B6-19: one copy per normalised (artist, title), the suggested
	// album's when the song exists in several copies.
	pool = collapseLibraryDuplicates(pool)
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

// localRelatedSeedHandler answers ?seed=album:<id>|artist:<id>|favorites (EQ1
// targeted radio): resolves the seed to its own tracks ("core"), then
// radioFromSeedTracks extends it with the regular radio pool. name is the
// human title the front shows as "Radio : <name>".
func localRelatedSeedHandler(c echo.Context, seed string) error {
	var core []map[string]interface{}
	var name string
	switch {
	case seed == "favorites":
		name = "Favoris"
		core = favoriteTracks(profileID(c))
	case strings.HasPrefix(seed, "album:"):
		id := strings.TrimPrefix(seed, "album:")
		a := meiliGetDoc("albums", id)
		if a == nil {
			return c.JSON(http.StatusNotFound, map[string]interface{}{"error": "not_found", "items": []Item{}})
		}
		name = mstr(a, "album")
		core = albumTracks(name, mstr(a, "albumArtist"))
	case strings.HasPrefix(seed, "artist:"):
		id := strings.TrimPrefix(seed, "artist:")
		a := meiliGetDoc("artists", id)
		if a == nil {
			return c.JSON(http.StatusNotFound, map[string]interface{}{"error": "not_found", "items": []Item{}})
		}
		name = mstr(a, "name")
		core = meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "filter": "albumArtist = \"" + escapeMeili(name) + "\"",
			"limit": 200, "attributesToRetrieve": localTrackAttrs,
		})
	default:
		return c.JSON(http.StatusBadRequest, map[string]interface{}{"error": "bad_request", "reason": "unknown seed: " + seed})
	}
	if len(core) == 0 {
		return c.JSON(http.StatusNotFound, map[string]interface{}{"error": "not_found", "items": []Item{}})
	}
	ex := requestExclusions(c)
	items := radioFromSeedTracks(withoutRefs(core, ex), 30, 2, ex)
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "seed": seed, "name": name})
}

// favoriteTracks resolves a profile's favourited local songs (lid refs only)
// to their Meili hits, most recently favourited first.
func favoriteTracks(pid string) []map[string]interface{} {
	var refs []struct{ Ref string }
	db.DB.Model(&db.Favorite{}).Select("ref").
		Where("profile_id = ? AND kind = ?", pid, "song").
		Order("created_at desc").Limit(60).Scan(&refs)
	out := make([]map[string]interface{}, 0, len(refs))
	for _, r := range refs {
		if !isLid(r.Ref) {
			continue
		}
		if h := meiliByLid(r.Ref); h != nil {
			out = append(out, h)
		}
	}
	return out
}

// radioFromSeedTracks turns the seed's own tracks into a flat radio queue:
// the seed tracks first, extended with radioPool() seeded by the first one so
// a single-album or single-artist radio does not stop at its own tracklist,
// deduped and capped at `maxPerAlbum` tracks per album (relatedByAlbum caps
// at one card per album - too narrow for a from-scratch "Radio" queue, which
// wants real tracks, not one per album).
// Refs in `ex` (c40b) never enter the radio, the extension included.
func radioFromSeedTracks(core []map[string]interface{}, limit, maxPerAlbum int, ex *exclusions) []Item {
	var ext []map[string]interface{}
	if len(core) > 0 {
		first := core[0]
		ext = withoutRefs(radioPool(first, mstr(first, "lid")), ex)
		rand.Shuffle(len(ext), func(i, j int) { ext[i], ext[j] = ext[j], ext[i] })
	}
	// c41b B6-19: one copy per normalised (artist, title), across the seed
	// tracks and the extension.
	preferred := duplicatePreferred()
	core = collapseDuplicates(core, preferred)
	ext = collapseDuplicates(ext, preferred)
	seenKey := map[string]bool{}
	seenLid := map[string]bool{}
	albumCount := map[string]int{}
	out := make([]Item, 0, limit)
	add := func(h map[string]interface{}) {
		l := mstr(h, "lid")
		if l == "" || seenLid[l] {
			return
		}
		albumKey, _, _ := trackAlbumKey(h)
		if albumKey != "" && albumCount[albumKey] >= maxPerAlbum {
			return
		}
		k := dupTrackKey(h)
		if k != "" && seenKey[k] {
			return
		}
		if k != "" {
			seenKey[k] = true
		}
		seenLid[l] = true
		if albumKey != "" {
			albumCount[albumKey]++
		}
		out = append(out, lidItem(h))
	}
	for _, h := range core {
		if len(out) >= limit {
			break
		}
		add(h)
	}
	for _, h := range ext {
		if len(out) >= limit {
			break
		}
		add(h)
	}
	return out
}
