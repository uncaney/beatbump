package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// shelfStub is a Meilisearch double for localShelf: one canned hit list per
// index, plus the list of indexes queried (in order) so a test can assert that
// e.g. filter=albums never touches the tracks index.
type shelfStub struct {
	hits    map[string][]map[string]interface{}
	queried []string
}

func (s *shelfStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !strings.HasPrefix(r.URL.Path, "/indexes/") || !strings.HasSuffix(r.URL.Path, "/search") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		index := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/indexes/"), "/search")
		s.queried = append(s.queried, index)
		hits := []interface{}{}
		for _, h := range s.hits[index] {
			hits = append(hits, h)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits})
	})
}

func newShelfStub(t *testing.T) *shelfStub {
	t.Helper()
	stub := &shelfStub{hits: map[string][]map[string]interface{}{
		"tracks": {
			{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": 1.0, "durationSec": 320.0},
			{"title": "Ghost (no lid)", "artist": "Daft Punk"},
		},
		"albums": {
			{"id": albumID("Daft Punk", "Discovery"), "album": "Discovery", "albumArtist": "Daft Punk", "year": "2001", "coverLid": "e182ccc85ad", "artistId": artistID("Daft Punk")},
			{"id": "", "album": "Broken doc"},
		},
		"artists": {
			{"id": artistID("Daft Punk"), "name": "Daft Punk"},
			{"id": "", "name": "Broken doc"},
		},
	}}
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return stub
}

func TestLocalShelfFollowsFilter(t *testing.T) {
	// songs / all / "" -> playable track hits
	for _, f := range []string{"", "all", "songs"} {
		stub := newShelfStub(t)
		s := localShelf("daft punk", f)
		if s == nil || !s.Local || s.Header.Title != "Your Library" {
			t.Fatalf("filter=%q: expected the local shelf, got %+v", f, s)
		}
		if len(s.Contents) != 1 || s.Contents[0].VideoId == nil || *s.Contents[0].VideoId != "e182ccc85ad" || s.Contents[0].Type != "song" {
			t.Fatalf("filter=%q: expected 1 song hit (lid e182ccc85ad), got %+v", f, s.Contents)
		}
		if strings.Join(stub.queried, ",") != "tracks" {
			t.Fatalf("filter=%q: expected only the tracks index, queried %v", f, stub.queried)
		}
	}

	// albums -> album hits with lb- ids (rows navigate to /release?id=lb-…)
	stub := newShelfStub(t)
	s := localShelf("discovery", "albums")
	if s == nil || !s.Local || s.Header.Title != "Your Library" {
		t.Fatalf("filter=albums: expected the local shelf, got %+v", s)
	}
	if len(s.Contents) != 1 {
		t.Fatalf("filter=albums: expected 1 album hit (doc without id dropped), got %+v", s.Contents)
	}
	it := s.Contents[0]
	if it.Type != "album" || it.Title != "Discovery" || it.Endpoint == nil ||
		it.Endpoint.PageType != "MUSIC_PAGE_TYPE_ALBUM" || !isLocalAlbum(it.Endpoint.BrowseId) ||
		it.Endpoint.BrowseId != albumID("Daft Punk", "Discovery") {
		t.Fatalf("filter=albums: expected an lb- album item, got %+v", it)
	}
	if it.VideoId != nil {
		t.Fatalf("filter=albums: album rows must not carry a videoId, got %+v", it)
	}
	if strings.Join(stub.queried, ",") != "albums" {
		t.Fatalf("filter=albums: expected only the albums index, queried %v", stub.queried)
	}

	// artists -> artist hits with la- ids (rows navigate to /artist/la-…)
	stub = newShelfStub(t)
	s = localShelf("daft", "artists")
	if s == nil || !s.Local || len(s.Contents) != 1 {
		t.Fatalf("filter=artists: expected 1 artist hit, got %+v", s)
	}
	it = s.Contents[0]
	if it.Type != "artist" || it.Title != "Daft Punk" || it.Endpoint == nil ||
		it.Endpoint.PageType != "MUSIC_PAGE_TYPE_ARTIST" || !isLocalArtist(it.Endpoint.BrowseId) ||
		it.Endpoint.BrowseId != artistID("Daft Punk") {
		t.Fatalf("filter=artists: expected an la- artist item, got %+v", it)
	}
	if len(it.Thumbnails) == 0 || !strings.Contains(it.Thumbnails[0].URL, "lid=e182ccc85ad") {
		t.Fatalf("filter=artists: expected the cover resolved from the albums index, got %+v", it.Thumbnails)
	}
	// artists index for the hits, albums index for the batch cover lookup
	if strings.Join(stub.queried, ",") != "artists,albums" {
		t.Fatalf("filter=artists: expected artists then albums, queried %v", stub.queried)
	}

	// playlists / videos / unknown -> no local shelf, no Meili call
	for _, f := range []string{"all_playlists", "featured_playlists", "community_playlists", "videos", "bogus"} {
		stub = newShelfStub(t)
		if s := localShelf("daft punk", f); s != nil {
			t.Fatalf("filter=%q: expected no local shelf, got %+v", f, s)
		}
		if len(stub.queried) != 0 {
			t.Fatalf("filter=%q: expected no Meili query, got %v", f, stub.queried)
		}
	}

	// empty query -> nothing, whatever the filter
	stub = newShelfStub(t)
	if s := localShelf("", "albums"); s != nil || len(stub.queried) != 0 {
		t.Fatalf("empty query must yield no shelf and no query, got %+v %v", s, stub.queried)
	}
}

func TestLocalShelfNoHitsIsNil(t *testing.T) {
	stub := newShelfStub(t)
	stub.hits["albums"] = nil
	if s := localShelf("nothing", "albums"); s != nil {
		t.Fatalf("no album hits must yield no shelf, got %+v", s)
	}
	stub.hits["tracks"] = []map[string]interface{}{{"title": "no lid"}}
	if s := localShelf("nothing", "songs"); s != nil {
		t.Fatalf("track hits without lid must yield no shelf, got %+v", s)
	}
}
