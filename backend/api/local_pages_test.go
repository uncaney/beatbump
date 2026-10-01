package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// totalStub answers a Meili search with the canned hits capped to `limit`, and
// estimatedTotalHits = the full canned count, like Meilisearch does.
func totalStub(t *testing.T, tracks []map[string]interface{}) {
	t.Helper()
	resetAlbumCoverMemo()
	artist := map[string]interface{}{"id": artistID("Daft Punk"), "name": "Daft Punk"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && strings.Contains(r.URL.Path, "/indexes/artists/documents/") {
			json.NewEncoder(w).Encode(artist)
			return
		}
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/search") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		all := []map[string]interface{}{}
		if strings.Contains(r.URL.Path, "/indexes/tracks/") {
			all = tracks
		}
		lim := stubInt(body["limit"])
		hits := all
		if lim > 0 && lim < len(hits) {
			hits = hits[:lim]
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(all)})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
}

func TestLocalArtistSeeAllExposesTotal(t *testing.T) {
	tracks := []map[string]interface{}{}
	for i := 0; i < 30; i++ {
		tracks = append(tracks, map[string]interface{}{
			"lid": fmt.Sprintf("%011d", i), "title": fmt.Sprintf("T%d", i), "artist": "Daft Punk",
			"albumArtist": "Daft Punk", "album": "Discovery", "track": float64(i + 1), "durationSec": 200.0,
		})
	}
	totalStub(t, tracks)
	resp := buildLocalArtist(artistID("Daft Punk"))
	songs, ok := resp["songs"].(localSongsShelf)
	if !ok || len(songs.Contents) != localArtistSongsPreview {
		t.Fatalf("expected a %d-title preview, got %+v", localArtistSongsPreview, resp["songs"])
	}
	if resp["songsTotal"] != 30 {
		t.Fatalf("songsTotal = %v, want 30", resp["songsTotal"])
	}
	see, ok := resp["seeAll"].(map[string]interface{})
	if !ok {
		t.Fatalf("seeAll missing: %+v", resp)
	}
	if see["title"] != "Voir les 30 titres" || see["total"] != 30 {
		t.Fatalf("seeAll = %+v", see)
	}
	u, err := url.Parse(see["url"].(string))
	if err != nil || u.Path != "/api/v1/local/songs" {
		t.Fatalf("seeAll url = %v (%v)", see["url"], err)
	}
	if u.Query().Get("artist") != "Daft Punk" || u.Query().Get("limit") != "200" {
		t.Fatalf("seeAll query = %v", u.Query())
	}
	// The link must be valid for LocalSongsHandler (sort allow-list).
	if _, ok := validSort(u.Query().Get("sort"), trackSortable, ""); !ok {
		t.Fatalf("seeAll sort %q rejected by LocalSongsHandler", u.Query().Get("sort"))
	}
	// And survive a JSON round trip as the frontend sees it.
	raw, _ := json.Marshal(resp)
	var back struct {
		SongsTotal int `json:"songsTotal"`
		SeeAll     struct {
			URL string `json:"url"`
		} `json:"seeAll"`
		Songs struct {
			Header struct {
				Title string `json:"title"`
			} `json:"header"`
			Items  []map[string]interface{} `json:"items"`
			Total  int                      `json:"total"`
			SeeAll struct {
				URL   string `json:"url"`
				Title string `json:"title"`
			} `json:"seeAll"`
		} `json:"songs"`
	}
	if err := json.Unmarshal(raw, &back); err != nil || back.SongsTotal != 30 || back.SeeAll.URL == "" {
		t.Fatalf("json: %s (%v)", raw, err)
	}
	// The shelf keeps the Carousel shape (header + items) the page renders.
	if back.Songs.Header.Title != "Songs" || len(back.Songs.Items) != localArtistSongsPreview ||
		back.Songs.Total != 30 || back.Songs.SeeAll.URL != back.SeeAll.URL || back.Songs.SeeAll.Title != "Voir les 30 titres" {
		t.Fatalf("songs shelf json: %+v", back.Songs)
	}
}

func TestLocalArtistSeeAllTotalFallsBackToHits(t *testing.T) {
	// A Meili answer without estimatedTotalHits (the shelf stub) still reports
	// the titles it returned, never 0.
	newShelfStub(t)
	resp := buildLocalArtist(artistID("Daft Punk"))
	if resp["songsTotal"] != 2 {
		t.Fatalf("songsTotal = %v, want 2 (hits returned)", resp["songsTotal"])
	}
}

// I19: an artist with more titles than one songs page: the label counts what
// the seeAll link loads, the real count and the remaining pages ride along.
func TestLocalArtistSeeAllLabelMatchesLoadedCount(t *testing.T) {
	see := localArtistSeeAll("Big Artist", 350)
	if see["title"] != "Voir les 200 titres" || see["total"] != 200 || see["artistTotal"] != 350 {
		t.Fatalf("seeAll = %+v", see)
	}
	pages, _ := see["pages"].([]string)
	if len(pages) != 2 || pages[0] != see["url"] {
		t.Fatalf("pages = %v", pages)
	}
	u, _ := url.Parse(pages[1])
	if u.Query().Get("offset") != "200" || u.Query().Get("limit") != "200" || see["next"] != pages[1] {
		t.Fatalf("second page = %v next = %v", pages[1], see["next"])
	}
	small := localArtistSeeAll("Small", 30)
	if small["title"] != "Voir les 30 titres" || small["next"] != nil || len(small["pages"].([]string)) != 1 {
		t.Fatalf("small seeAll = %+v", small)
	}
	huge := localArtistSeeAll("Huge", 5000)
	if len(huge["pages"].([]string)) != localArtistSeeAllPages {
		t.Fatalf("pages not bounded: %d", len(huge["pages"].([]string)))
	}
}

// c21d leftover: a local album header carries the duration of its tracks (as
// the "1 h 14 min" label AND the numeric durationSec) and the year as a string
// even when the Meili document stores a number.
func TestBuildLocalAlbumLengthAndNumericYear(t *testing.T) {
	id := albumID("Daft Punk", "Discovery")
	stub := &meiliStub{
		albums: map[string]map[string]interface{}{
			id: {"id": id, "album": "Discovery", "albumArtist": "Daft Punk", "year": 2001.0, "coverLid": "e182ccc85ad"},
		},
		tracks: []map[string]interface{}{
			{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": 1.0, "durationSec": 3600.0},
			{"lid": "f182ccc85ad", "title": "Aerodynamic", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": 2.0, "durationSec": 840.0},
			// a track without durationSec still counts as a song
			{"lid": "g182ccc85ad", "title": "Digital Love", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": 3.0},
		},
	}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	page, ok := buildLocalAlbum(id)
	if !ok {
		t.Fatalf("album doc path must build")
	}
	sub := page["items"].(map[string]interface{})["releaseInfo"].(map[string]interface{})["subtitles"].([]map[string]interface{})[0]
	if sub["year"] != "2001" {
		t.Fatalf("numeric year must come back as a string, got %#v", sub["year"])
	}
	if sub["length"] != "1 h 14 min" || sub["durationSec"] != 4440 || sub["tracks"] != "3 songs" {
		t.Fatalf("length from the track sum, got %#v", sub)
	}
	// JSON shape: the page reads `year` as a string, `durationSec` as a number.
	raw, _ := json.Marshal(sub)
	var back struct {
		Year        string `json:"year"`
		Length      string `json:"length"`
		DurationSec int    `json:"durationSec"`
	}
	if err := json.Unmarshal(raw, &back); err != nil || back.Year != "2001" || back.Length != "1 h 14 min" || back.DurationSec != 4440 {
		t.Fatalf("json shape: %s (%v)", raw, err)
	}

	// Rebuilt (doc-less) album: year from the first track, numeric too.
	stub.albums = map[string]map[string]interface{}{}
	stub.tracks = []map[string]interface{}{
		{"lid": "aaaaaaaaaaa", "title": "First", "artist": "Sam Gellaitry", "album": "Assumptions", "track": 1.0, "durationSec": 1500.0, "year": 2023.0},
		{"lid": "bbbbbbbbbbb", "title": "Second", "artist": "Sam Gellaitry", "album": "Assumptions", "track": 2.0, "durationSec": 1020.0, "year": 2023.0},
	}
	page, ok = buildLocalAlbum(localAlbumRef("Sam Gellaitry", "Assumptions"))
	if !ok {
		t.Fatalf("rebuilt album must build")
	}
	sub = page["items"].(map[string]interface{})["releaseInfo"].(map[string]interface{})["subtitles"].([]map[string]interface{})[0]
	if sub["year"] != "2023" || sub["length"] != "42 min" || sub["durationSec"] != 2520 {
		t.Fatalf("rebuilt header, got %#v", sub)
	}
}

func TestMnumStrAndDurationLabel(t *testing.T) {
	m := map[string]interface{}{"s": "1999", "f": 2001.0, "x": true}
	if mnumStr(m, "s") != "1999" || mnumStr(m, "f") != "2001" || mnumStr(m, "x") != "" || mnumStr(m, "none") != "" {
		t.Fatalf("mnumStr: %q %q %q", mnumStr(m, "s"), mnumStr(m, "f"), mnumStr(m, "x"))
	}
	for sec, want := range map[int]string{0: "", -5: "", 20: "1 min", 2520: "42 min", 3600: "1 h", 4440: "1 h 14 min", 7199: "2 h"} {
		if got := durationLabel(sec); got != want {
			t.Fatalf("durationLabel(%d) = %q, want %q", sec, got, want)
		}
	}
}
