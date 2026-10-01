package api

// Local artist + album pages, built from Meilisearch into the SAME JSON shapes
// the YouTube-backed ArtistEndpointHandler / AlbumEndpointHandler return, so the
// existing Svelte pages render them unchanged.

import (
	"fmt"
	"sort"
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

	songs := meiliSearchIndex("tracks", map[string]interface{}{
		"q": "", "filter": "albumArtist = \"" + escapeMeili(name) + "\"", "limit": 12,
		"attributesToRetrieve": []string{"lid", "title", "artist", "albumArtist", "track", "durationSec"},
	})
	songItems := make([]IListItemRenderer, 0, len(songs))
	for _, s := range songs {
		songItems = append(songItems, localSongItem(s))
	}

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
	if len(songItems) > 0 {
		sz := Carousel{}
		sz.Header.Title = "Songs"
		sz.Contents = songItems
		resp["songs"] = sz
	}
	if cover != "" {
		resp["headerThumbnail"] = []Thumbnail{{URL: coverURL(cover)}}
	}
	return resp
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
