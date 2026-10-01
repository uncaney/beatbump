package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLocalAlbumRefRoundTrip(t *testing.T) {
	ref := localAlbumRef("Daft Punk", "Discovery")
	if !strings.HasPrefix(ref, albumID("Daft Punk", "Discovery")+".") {
		t.Fatalf("ref must start with the canonical lb- id: %s", ref)
	}
	if strings.ContainsAny(ref, "/+=%&? ") {
		t.Fatalf("ref must be URL-safe without encoding: %s", ref)
	}
	id, aa, album := parseLocalAlbumRef(ref)
	if id != albumID("Daft Punk", "Discovery") || aa != "Daft Punk" || album != "Discovery" {
		t.Fatalf("round trip failed: %q %q %q", id, aa, album)
	}
	// Bare ids (albums index, old favourites) parse to themselves with no hint.
	id, aa, album = parseLocalAlbumRef("lb-ab66e8a3d472")
	if id != "lb-ab66e8a3d472" || aa != "" || album != "" {
		t.Fatalf("bare id must parse unchanged: %q %q %q", id, aa, album)
	}
	if id, _, _ = parseLocalAlbumRef("lb-ab66e8a3d472.!!notbase64"); id != "lb-ab66e8a3d472" {
		t.Fatalf("garbage hint must still yield the canonical id, got %q", id)
	}
}

// meiliStub is a minimal Meilisearch double: album docs by id + a tracks search
// that applies the filter substrings the code under test is expected to send.
type meiliStub struct {
	albums map[string]map[string]interface{}
	tracks []map[string]interface{}
	// filters received by /indexes/tracks/search, in order
	filters []string
}

func (s *meiliStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/indexes/albums/documents/"):
			id := strings.TrimPrefix(r.URL.Path, "/indexes/albums/documents/")
			if doc, ok := s.albums[id]; ok {
				json.NewEncoder(w).Encode(doc)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		case r.Method == "POST" && r.URL.Path == "/indexes/tracks/search":
			var body map[string]interface{}
			json.NewDecoder(r.Body).Decode(&body)
			filter, _ := body["filter"].(string)
			s.filters = append(s.filters, filter)
			hits := []interface{}{}
			for _, tr := range s.tracks {
				if s.match(filter, tr) {
					hits = append(hits, tr)
				}
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

// match evaluates the two filter shapes buildLocalAlbum sends:
//
//	album = "A" AND albumArtist = "B"
//	album = "A" AND (albumArtist = "B" OR artist = "B")
func (s *meiliStub) match(filter string, tr map[string]interface{}) bool {
	get := func(key string) (string, bool) {
		i := strings.Index(filter, key+` = "`)
		if i < 0 {
			return "", false
		}
		rest := filter[i+len(key)+4:]
		j := strings.Index(rest, `"`)
		return rest[:j], true
	}
	album, _ := get("album")
	if mstr(tr, "album") != album {
		return false
	}
	aa, _ := get("albumArtist")
	if ar, widened := get("artist"); widened {
		return mstr(tr, "albumArtist") == aa || mstr(tr, "artist") == ar
	}
	return mstr(tr, "albumArtist") == aa
}

func TestBuildLocalAlbumRebuildsFromTracks(t *testing.T) {
	stub := &meiliStub{
		albums: map[string]map[string]interface{}{},
		tracks: []map[string]interface{}{
			// a single: no albumArtist tag, indexer keys the album by the artist
			{"lid": "bbbbbbbbbbb", "title": "Second", "artist": "Sam Gellaitry", "album": "Assumptions", "track": 2.0, "durationSec": 200.0, "year": "2023"},
			{"lid": "aaaaaaaaaaa", "title": "First", "artist": "Sam Gellaitry", "album": "Assumptions", "track": 1.0, "durationSec": 180.0, "year": "2023"},
			// homonymous album by another artist: passes the widened filter, must be dropped
			{"lid": "ccccccccccc", "title": "Decoy", "artist": "Someone Else", "albumArtist": "Someone Else", "album": "Assumptions", "track": 1.0},
			// no lid: never rendered
			{"title": "Ghost", "artist": "Sam Gellaitry", "album": "Assumptions", "track": 3.0},
		},
	}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	// The browseId exactly as localSongItem emits it for one of those tracks.
	ref := localSongItem(stub.tracks[0]).Album.BrowseId
	page, ok := buildLocalAlbum(ref)
	if !ok {
		t.Fatalf("expected a rebuilt album page for %s", ref)
	}
	inner := page["items"].(map[string]interface{})
	items := inner["items"].([]IListItemRenderer)
	if len(items) != 2 || items[0].Title != "First" || items[1].Title != "Second" {
		t.Fatalf("expected the 2 tracks of the single in track order, got %+v", items)
	}
	ri := inner["releaseInfo"].(map[string]interface{})
	if ri["title"] != "Assumptions" {
		t.Fatalf("title from first track, got %v", ri["title"])
	}
	if art := ri["artist"].([]map[string]interface{}); art[0]["name"] != "Sam Gellaitry" || art[0]["channelId"] != artistID("Sam Gellaitry") {
		t.Fatalf("artist from first track, got %v", art)
	}
	if th := ri["thumbnails"].([]Thumbnail); !strings.Contains(th[0].URL, "lid=aaaaaaaaaaa") {
		t.Fatalf("cover from first track, got %v", th)
	}
	if sub := ri["subtitles"].([]map[string]interface{}); sub[0]["year"] != "2023" || sub[0]["tracks"] != "2 songs" {
		t.Fatalf("subtitles from tracks, got %v", sub)
	}
	// Items keep the hinted ref so album -> album navigation stays resolvable.
	if items[0].Album == nil || items[0].Album.BrowseId != ref {
		t.Fatalf("rebuilt items must carry the same album ref, got %+v", items[0].Album)
	}
	// A hint whose key does not hash to the (doc-less) id: the decoy passes the
	// widened Meili filter but fails the canonical-id check, so nothing is built.
	forged := albumID("Sam Gellaitry", "Assumptions") + "." + strings.SplitN(localAlbumRef("Someone Else", "Assumptions"), ".", 2)[1]
	if _, ok := buildLocalAlbum(forged); ok {
		t.Fatalf("hint/id mismatch must not build a page")
	}
}

func TestBuildLocalAlbumNotFoundAndDocPath(t *testing.T) {
	stub := &meiliStub{
		albums: map[string]map[string]interface{}{
			albumID("Daft Punk", "Discovery"): {"id": albumID("Daft Punk", "Discovery"), "album": "Discovery", "albumArtist": "Daft Punk", "year": "2001", "coverLid": "e182ccc85ad"},
		},
		tracks: []map[string]interface{}{
			{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": 1.0},
		},
	}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	// Album doc present: the regular path (bare id, as localAlbumItem emits it).
	page, ok := buildLocalAlbum(albumID("Daft Punk", "Discovery"))
	if !ok || len(page["items"].(map[string]interface{})["items"].([]IListItemRenderer)) != 1 {
		t.Fatalf("album doc path broken: ok=%v page=%v", ok, page)
	}
	// No doc, no track: not found (handler answers 404), with and without a hint.
	if _, ok := buildLocalAlbum("lb-000000000000"); ok {
		t.Fatalf("bare unknown id must not be found")
	}
	if _, ok := buildLocalAlbum(localAlbumRef("Nobody", "Nothing")); ok {
		t.Fatalf("hinted id with no tracks must not be found")
	}
}
