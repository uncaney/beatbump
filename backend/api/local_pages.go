package api

// Local artist + album pages, built from Meilisearch into the SAME JSON shapes
// the YouTube-backed ArtistEndpointHandler / AlbumEndpointHandler return, so the
// existing Svelte pages render them unchanged.

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
)

func buildLocalArtist(artistId string) map[string]interface{} {
	resp := map[string]interface{}{}

	albs := meiliSearchIndex("albums", map[string]interface{}{
		"q": "", "filter": "artistId = \"" + artistId + "\"", "limit": 100,
		"sort":                 []string{"year:desc"},
		"attributesToRetrieve": []string{"id", "album", "albumArtist", "year", "coverLid"},
	})

	name := ""
	if art := meiliGetDoc("artists", artistId); art != nil {
		name = mstr(art, "name")
	}
	if name == "" && len(albs) > 0 {
		name = mstr(albs[0], "albumArtist")
	}

	cover := ""
	albumItems := make([]IListItemRenderer, 0, len(albs))
	for _, a := range albs {
		albumItems = append(albumItems, localAlbumItem(a))
		if cover == "" {
			cover = mstr(a, "coverLid")
		}
	}

	songs, songsTotal := meiliBrowse("tracks", map[string]interface{}{
		"q": "", "filter": "albumArtist = \"" + escapeMeili(name) + "\"", "limit": localArtistSongsPreview,
		"attributesToRetrieve": []string{"lid", "title", "artist", "albumArtist", "album", "track", "durationSec"},
	})
	if songsTotal < len(songs) {
		songsTotal = len(songs)
	}
	// The artist's album docs are already in hand: memoise their covers so the
	// song rows need no extra albums query.
	for _, a := range albs {
		albumCoverStore(mstr(a, "id"), mstr(a, "coverLid"))
	}
	songItems := localSongItemsWithCovers(songs)

	// Two thumbnail sizes: ArtistPageHeader iterates thumbnails and references
	// thumbnail[i+1], so a single entry made the page crash (now also guarded UI-side).
	cu := coverURL(cover)
	resp["header"] = map[string]interface{}{
		"name": name, "description": "", "buttons": map[string]interface{}{},
		"thumbnails":           []Thumbnail{{URL: cu, Width: 226, Height: 226}, {URL: cu, Width: 540, Height: 540}},
		"foregroundThumbnails": nil,
	}
	carousels := make([]Carousel, 0)
	if len(albumItems) > 0 {
		cz := Carousel{}
		cz.Header.Title = "Albums"
		cz.Contents = albumItems
		carousels = append(carousels, cz)
	}
	resp["carousels"] = carousels
	// X1 / A2: the page lists localArtistSongsPreview titles inline; the total
	// and a seeAll link (same albumArtist filter, LocalSongsHandler cap) let it
	// load and play every title of the artist ("Voir les N titres"). Both ride
	// on the songs shelf (the artist page loader only forwards `songs`) and at
	// the top level.
	// I19: the count shown ("Voir les N titres", "N titres" next to Lire
	// tout) is what the seeAll link really loads (one LocalSongsHandler
	// page, capped at localArtistSeeAllLimit); the full count rides along as
	// artistTotal with the page URLs that cover it.
	var seeAll map[string]interface{}
	shownTotal := songsTotal
	if name != "" && songsTotal > 0 {
		seeAll = localArtistSeeAll(name, songsTotal)
		shownTotal = seeAll["total"].(int)
		resp["songsTotal"] = shownTotal
		resp["artistSongsTotal"] = songsTotal
		resp["seeAll"] = seeAll
	}
	if len(songItems) > 0 {
		sz := localSongsShelf{Total: shownTotal, SeeAll: seeAll}
		sz.Header.Title = "Songs"
		sz.Contents = songItems
		resp["songs"] = sz
	}
	if cover != "" {
		resp["headerThumbnail"] = []Thumbnail{{URL: coverURL(cover)}}
	}
	return resp
}

// localSongsShelf is the local artist "Songs" shelf: the Carousel JSON the page
// already renders, plus the artist's title count and the seeAll link.
type localSongsShelf struct {
	Carousel
	Total  int                    `json:"total"`
	SeeAll map[string]interface{} `json:"seeAll,omitempty"`
}

// localArtistSongsPreview is the number of titles the artist page lists inline.
const localArtistSongsPreview = 12

// localArtistSeeAllLimit matches the LocalSongsHandler page cap (pag: 200).
const localArtistSeeAllLimit = 200

// localArtistSeeAllPages bounds the page URLs listed for a very large artist.
const localArtistSeeAllPages = 5

// localArtistSeeAll is the "Voir les N titres" link of a local artist page: the
// track list through /api/v1/local/songs (album order), one page of
// localArtistSeeAllLimit. I19: `title` / `total` count what that link loads
// (min(total, limit)), so the label never announces titles "Lire tout" will
// not play; `artistTotal` is the real count and `pages` the URLs (offset by
// limit, at most localArtistSeeAllPages) that load all of them.
func localArtistSeeAll(name string, total int) map[string]interface{} {
	pageURL := func(offset int) string {
		q := url.Values{}
		q.Set("artist", name)
		q.Set("limit", strconv.Itoa(localArtistSeeAllLimit))
		q.Set("sort", "album:asc")
		if offset > 0 {
			q.Set("offset", strconv.Itoa(offset))
		}
		return "/api/v1/local/songs?" + q.Encode()
	}
	shown := total
	if shown > localArtistSeeAllLimit {
		shown = localArtistSeeAllLimit
	}
	pages := []string{}
	for off := 0; off < total && len(pages) < localArtistSeeAllPages; off += localArtistSeeAllLimit {
		pages = append(pages, pageURL(off))
	}
	out := map[string]interface{}{
		"title":       fmt.Sprintf("Voir les %d titres", shown),
		"url":         pageURL(0),
		"total":       shown,
		"artistTotal": total,
		"limit":       localArtistSeeAllLimit,
		"pages":       pages,
	}
	if total > localArtistSeeAllLimit {
		out["next"] = pageURL(localArtistSeeAllLimit)
	}
	return out
}

var localTrackAttrs = []string{"lid", "title", "artist", "albumArtist", "album", "track", "durationSec", "year"}

// trackAlbumArtist mirrors the indexer's album aggregation key: albumArtist, else artist.
func trackAlbumArtist(t map[string]interface{}) string {
	if aa := mstr(t, "albumArtist"); aa != "" {
		return aa
	}
	return mstr(t, "artist")
}

// albumTracks lists the tracks of an album known to the albums index (exact
// album + albumArtist strings, Meili track order).
func albumTracks(album, aa string) []map[string]interface{} {
	return meiliSearchIndex("tracks", map[string]interface{}{
		"q": "", "filter": "album = \"" + escapeMeili(album) + "\" AND albumArtist = \"" + escapeMeili(aa) + "\"",
		"limit": 300, "sort": []string{"track:asc"},
		"attributesToRetrieve": localTrackAttrs,
	})
}

// rebuildAlbumTracks is the F2 fallback: no album doc exists for albumId, so the
// album is rebuilt from the tracks index using the (albumArtist, album) hint the
// browseId carries. The filter is widened to artist (singles have no albumArtist
// tag; the indexer then keys the album by the first artist) and every hit is
// re-checked against the canonical id, exactly as the indexer would have keyed
// it, so a homonymous album by another artist never leaks in.
func rebuildAlbumTracks(albumId, aa, album string) []map[string]interface{} {
	if album == "" || aa == "" {
		return nil
	}
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": "", "filter": "album = \"" + escapeMeili(album) + "\" AND (albumArtist = \"" + escapeMeili(aa) + "\" OR artist = \"" + escapeMeili(aa) + "\")",
		"limit": 300, "sort": []string{"track:asc"},
		"attributesToRetrieve": localTrackAttrs,
	})
	out := make([]map[string]interface{}, 0, len(hits))
	for _, t := range hits {
		if mstr(t, "lid") == "" || albumID(trackAlbumArtist(t), mstr(t, "album")) != albumId {
			continue
		}
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool { return mint(out[i], "track") < mint(out[j], "track") })
	return out
}

// buildLocalAlbum renders a local album page for a browseId produced by
// localAlbumItem (bare lb- id) or localSongItem (lb- id + hint). ok is false only
// when neither an album doc nor a single track exists for it (the handler then
// answers 404 instead of an empty page).
func buildLocalAlbum(ref string) (map[string]interface{}, bool) {
	albumId, hintAA, hintAlbum := parseLocalAlbumRef(ref)
	var album, aa, year, cover string
	var tracks []map[string]interface{}
	found := false
	if a := meiliGetDoc("albums", albumId); a != nil {
		found = true
		album, aa, year, cover = mstr(a, "album"), mstr(a, "albumArtist"), mstr(a, "year"), mstr(a, "coverLid")
		tracks = albumTracks(album, aa)
	}
	if len(tracks) == 0 {
		// Missing album doc (or a stale one): rebuild from the tracks index. Prefer
		// the hint carried by the browseId, else the doc's own key.
		if hintAlbum == "" {
			hintAA, hintAlbum = aa, album
		}
		if rebuilt := rebuildAlbumTracks(albumId, hintAA, hintAlbum); len(rebuilt) > 0 {
			tracks = rebuilt
			first := tracks[0]
			album, aa = mstr(first, "album"), trackAlbumArtist(first)
			if year == "" {
				year = mstr(first, "year")
			}
			if cover == "" {
				cover = mstr(first, "lid")
			}
		}
	}
	if len(tracks) > 0 {
		found = true
	}
	if !found {
		return nil, false
	}
	// The page cover (album doc coverLid, else the first rebuilt track's lid) is
	// the cover of every row: memoise it under the canonical id, no extra query.
	if cover != "" {
		albumCoverStore(albumId, cover)
	}
	items := make([]IListItemRenderer, 0, len(tracks))
	for _, t := range tracks {
		items = append(items, localSongItem(t))
	}

	releaseInfo := map[string]interface{}{
		"thumbnails": []Thumbnail{{URL: coverURL(cover), Width: 540, Height: 540}},
		"artist":     []map[string]interface{}{{"name": aa, "channelId": artistID(aa)}},
		"title":      album,
		"subtitles":  []map[string]interface{}{{"year": year, "tracks": fmt.Sprintf("%d songs", len(items)), "length": ""}},
		"playlistId": "", "autoMixId": "",
	}
	return map[string]interface{}{"items": map[string]interface{}{"items": items, "releaseInfo": releaseInfo}}, true
}
