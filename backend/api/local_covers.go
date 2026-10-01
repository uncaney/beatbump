package api

// Album cover resolution for local track items.
//
// /cover?lid= is served by the ytm-cache bridge from the embedded art of the
// track file behind that lid; tracks without embedded art render a "?"
// placeholder. The albums index carries a coverLid per album (the lid the
// indexer found art for), so a track item prefers its ALBUM's coverLid and
// only falls back to its own lid when the album has none / is unknown. Covers
// are then consistent across one album, which is what users expect.
//
// Rule (trackCoverLid):
//
//	album known in the albums index AND coverLid != ""  -> album coverLid
//	otherwise                                            -> the track's own lid
//
// The albums index is NOT filterable on id (filterable: albumArtist, artistId,
// source), so the batch lookup filters on the distinct albumArtist values of
// the hits and keeps the ids we asked for. Resolved (and absent) ids are kept
// in a process-wide memo with a TTL so every localSongItem / lidItem caller
// benefits -- including callers this lane cannot edit (me.go's mix builds its
// items one by one; radioPool primes the memo for the whole pool first).

import (
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	albumCoverTTL         = 15 * time.Minute // a resolved coverLid
	albumCoverNegativeTTL = 2 * time.Minute  // "no album doc / no coverLid" (Meili hiccups heal fast)
	albumCoverBatchLimit  = 1000             // Meili maxTotalHits default
	albumCoverMaxPages    = 10               // 10 000 albums per batch at most
)

type albumCoverEntry struct {
	cover string
	at    time.Time
}

var albumCoverMemo sync.Map // albumId -> albumCoverEntry

func albumCoverCached(id string) (string, bool) {
	v, ok := albumCoverMemo.Load(id)
	if !ok {
		return "", false
	}
	e := v.(albumCoverEntry)
	ttl := albumCoverTTL
	if e.cover == "" {
		ttl = albumCoverNegativeTTL
	}
	if time.Since(e.at) > ttl {
		albumCoverMemo.Delete(id)
		return "", false
	}
	return e.cover, true
}

func albumCoverStore(id, cover string) {
	if id == "" {
		return
	}
	albumCoverMemo.Store(id, albumCoverEntry{cover: cover, at: time.Now()})
}

// resetAlbumCoverMemo drops every memoised cover (tests).
func resetAlbumCoverMemo() {
	albumCoverMemo.Range(func(k, _ interface{}) bool {
		albumCoverMemo.Delete(k)
		return true
	})
}

// trackAlbumKey returns the canonical album id of a track hit plus the
// (albumArtist, album) pair it was keyed on; id is "" when the doc has no album.
// Mirrors the indexer's aggregation key (albumArtist, else artist) exactly as
// localSongItem's Album.BrowseId does.
func trackAlbumKey(h map[string]interface{}) (id, albumArtist, album string) {
	album = mstr(h, "album")
	if album == "" {
		return "", "", ""
	}
	albumArtist = trackAlbumArtist(h)
	return albumID(albumArtist, album), albumArtist, album
}

// albumCovers batch-resolves album id -> coverLid for the distinct albums of a
// hit list with one albums-index query per page of albumCoverBatchLimit hits
// (memo hits cost nothing). Pages are fetched while ids are still wanted and
// the previous page was full, up to albumCoverMaxPages: an albumArtist shared
// by more than 1000 albums ("Various Artists") used to leave every album past
// the first page unresolved AND memoised as absent (audit v3 G9). Ids absent
// from the whole result are memoised as "" so the per-item fallback in
// trackCoverLid does not fire for them; when the page cap is hit, or on a
// Meili error, nothing negative is memoised (the fallback GET still works).
func albumCovers(hits []map[string]interface{}) map[string]string {
	out := map[string]string{}
	want := map[string]bool{}
	artists := map[string]bool{}
	for _, h := range hits {
		id, aa, _ := trackAlbumKey(h)
		if id == "" {
			continue
		}
		if _, done := out[id]; done || want[id] {
			continue
		}
		if c, ok := albumCoverCached(id); ok {
			out[id] = c
			continue
		}
		want[id] = true
		artists[aa] = true
	}
	if len(want) == 0 {
		return out
	}
	names := make([]string, 0, len(artists))
	for aa := range artists {
		names = append(names, "\""+escapeMeili(aa)+"\"")
	}
	sort.Strings(names)
	filter := "albumArtist IN [" + strings.Join(names, ",") + "]"
	exhausted := false
	for page := 0; page < albumCoverMaxPages && len(want) > 0; page++ {
		res, err := meiliReq("POST", "/indexes/albums/search", map[string]interface{}{
			"q": "", "filter": filter,
			"offset":               page * albumCoverBatchLimit,
			"limit":                albumCoverBatchLimit,
			"attributesToRetrieve": []string{"id", "coverLid"},
		})
		if err != nil || res == nil {
			return out
		}
		raw, _ := res["hits"].([]interface{})
		for _, r := range raw {
			a, ok := r.(map[string]interface{})
			if !ok {
				continue
			}
			id := mstr(a, "id")
			if !want[id] {
				continue
			}
			cover := mstr(a, "coverLid")
			out[id] = cover
			albumCoverStore(id, cover)
			delete(want, id)
		}
		if len(raw) < albumCoverBatchLimit {
			exhausted = true
			break
		}
	}
	for id := range want {
		out[id] = ""
		if exhausted {
			albumCoverStore(id, "")
		}
	}
	return out
}

// albumCoverFor resolves one album id through the memo, else one document GET
// (the per-item fallback for callers that did not batch first).
func albumCoverFor(id string) string {
	if id == "" {
		return ""
	}
	if c, ok := albumCoverCached(id); ok {
		return c
	}
	cover := ""
	if a := meiliGetDoc("albums", id); a != nil {
		cover = mstr(a, "coverLid")
	}
	albumCoverStore(id, cover)
	return cover
}

// trackCoverLid applies the cover rule to a track hit: album coverLid when the
// album is known and has one, else the track's own lid.
func trackCoverLid(h map[string]interface{}) string {
	lid := mstr(h, "lid")
	id, _, _ := trackAlbumKey(h)
	if c := albumCoverFor(id); c != "" {
		return c
	}
	return lid
}

// localSongItemsWithCovers builds song items for a hit list after ONE batched
// album-cover lookup. Hits without a lid are skipped (not playable). Same item
// shape as localSongItem, which stays usable on its own (memo + single GET).
func localSongItemsWithCovers(hits []map[string]interface{}) []IListItemRenderer {
	albumCovers(hits)
	out := make([]IListItemRenderer, 0, len(hits))
	for _, h := range hits {
		if mstr(h, "lid") == "" {
			continue
		}
		out = append(out, localSongItem(h))
	}
	return out
}
