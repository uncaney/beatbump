package api

// Local artist + album pages, built from Meilisearch into the SAME JSON shapes
// the YouTube-backed ArtistEndpointHandler / AlbumEndpointHandler return, so the
// existing Svelte pages render them unchanged.

import "fmt"

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

func buildLocalAlbum(albumId string) map[string]interface{} {
	empty := map[string]interface{}{"items": map[string]interface{}{
		"items": []IListItemRenderer{}, "releaseInfo": map[string]interface{}{}}}
	a := meiliGetDoc("albums", albumId)
	if a == nil {
		return empty
	}
	album := mstr(a, "album")
	aa := mstr(a, "albumArtist")
	year := mstr(a, "year")
	cover := mstr(a, "coverLid")

	tracks := meiliSearchIndex("tracks", map[string]interface{}{
		"q": "", "filter": "album = \"" + escapeMeili(album) + "\" AND albumArtist = \"" + escapeMeili(aa) + "\"",
		"limit": 300, "sort": []string{"track:asc"},
		"attributesToRetrieve": []string{"lid", "title", "artist", "albumArtist", "track", "durationSec"},
	})
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
	return map[string]interface{}{"items": map[string]interface{}{"items": items, "releaseInfo": releaseInfo}}
}
