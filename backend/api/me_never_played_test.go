package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"beatbump-server/backend/db"
)

// neverPlayedStub serves the two Meili calls MeNeverPlayedHandler makes:
// a POST /indexes/albums/search (dateAdded desc, already sorted + capped
// input) and a POST /indexes/tracks/search per candidate album, matching the
// exact `album = "X" AND albumArtist = "Y"` filter albumTracks sends.
type neverPlayedStub struct {
	albums []map[string]interface{} // already in dateAdded:desc order
	tracks []map[string]interface{}
}

func (s *neverPlayedStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/indexes/albums/search":
			var body map[string]interface{}
			json.NewDecoder(r.Body).Decode(&body)
			lim := len(s.albums)
			if l, ok := body["limit"].(float64); ok && int(l) < lim {
				lim = int(l)
			}
			hits := make([]interface{}, 0, lim)
			for i := 0; i < lim; i++ {
				hits = append(hits, s.albums[i])
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(s.albums)})
		case r.Method == "POST" && r.URL.Path == "/indexes/tracks/search":
			var body map[string]interface{}
			json.NewDecoder(r.Body).Decode(&body)
			filter, _ := body["filter"].(string)
			album, aa := parseAlbumFilter(filter)
			hits := []interface{}{}
			for _, tr := range s.tracks {
				if mstr(tr, "album") == album && mstr(tr, "albumArtist") == aa {
					hits = append(hits, tr)
				}
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

// parseAlbumFilter reads the two `key = "value"` clauses out of a
// `album = "A" AND albumArtist = "B"` filter string (the only shape
// albumTracks sends).
func parseAlbumFilter(filter string) (album, albumArtist string) {
	get := func(key string) string {
		i := strings.Index(filter, key+` = "`)
		if i < 0 {
			return ""
		}
		rest := filter[i+len(key)+4:]
		j := strings.Index(rest, `"`)
		return rest[:j]
	}
	return get("album"), get("albumArtist")
}

func TestMeNeverPlayed(t *testing.T) {
	useTestDB(t)
	// 3 known plays: "A1" (lid aaaaaaaaaa1) was played, so its album must be
	// excluded; the other two albums were never played.
	seed := []db.PlayEvent{
		{ProfileID: "p-test", Ref: "aaaaaaaaaa1", Title: "Track A1", Source: "local"},
	}
	if err := db.DB.Create(&seed).Error; err != nil {
		t.Fatalf("seed plays: %v", err)
	}

	stub := &neverPlayedStub{
		albums: []map[string]interface{}{
			// most recently added first (dateAdded desc, as the real index answers)
			{"id": "lb-played", "album": "Played Album", "albumArtist": "Artist One", "coverLid": "aaaaaaaaaa1"},
			{"id": "lb-unplayed-1", "album": "Fresh Album", "albumArtist": "Artist Two", "coverLid": "bbbbbbbbbb1"},
			{"id": "lb-unplayed-2", "album": "Older Album", "albumArtist": "Artist Three", "coverLid": "ccccccccccc"},
		},
		tracks: []map[string]interface{}{
			{"lid": "aaaaaaaaaa1", "title": "Track A1", "album": "Played Album", "albumArtist": "Artist One", "artist": "Artist One", "track": 1.0},
			{"lid": "bbbbbbbbbb1", "title": "Track B1", "album": "Fresh Album", "albumArtist": "Artist Two", "artist": "Artist Two", "track": 1.0},
			{"lid": "ccccccccccc", "title": "Track C1", "album": "Older Album", "albumArtist": "Artist Three", "artist": "Artist Three", "track": 1.0},
		},
	}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	resp := getJSON(t, MeNeverPlayedHandler, "/api/v1/me/never-played?limit=10")
	items, _ := resp["items"].([]interface{})
	if len(items) != 2 {
		t.Fatalf("expected 2 never-played albums, got %d: %v", len(items), items)
	}
	titles := make([]string, 0, len(items))
	for _, it := range items {
		m := it.(map[string]interface{})
		titles = append(titles, m["title"].(string))
	}
	if titles[0] != "Fresh Album" || titles[1] != "Older Album" {
		t.Fatalf("expected the never-played albums in dateAdded order, got %v", titles)
	}

	// limit truncates
	limited := getJSON(t, MeNeverPlayedHandler, "/api/v1/me/never-played?limit=1")
	litems, _ := limited["items"].([]interface{})
	if len(litems) != 1 {
		t.Fatalf("limit=1: got %d items", len(litems))
	}

	// a profile with no history at all: every album qualifies
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/never-played?limit=10", "", nil)
	c.Request().Header.Del("Cookie")
	c.Request().AddCookie(&http.Cookie{Name: "bbp", Value: "p-nobody"})
	if err := MeNeverPlayedHandler(c); err != nil {
		t.Fatalf("handler: %v", err)
	}
	var fresh map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &fresh); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	fitems, _ := fresh["items"].([]interface{})
	if len(fitems) != 3 {
		t.Fatalf("fresh profile: expected all 3 albums, got %d", len(fitems))
	}
}
