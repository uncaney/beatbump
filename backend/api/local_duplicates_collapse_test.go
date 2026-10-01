package api

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func dupHit(lid, title, artist, album string) map[string]interface{} {
	return map[string]interface{}{"lid": lid, "title": title, "artist": artist, "albumArtist": artist, "album": album}
}

func withPreferred(t *testing.T, p map[string]bool) {
	t.Helper()
	old := duplicatePreferred
	duplicatePreferred = func() map[string]bool { return p }
	t.Cleanup(func() { duplicatePreferred = old })
}

func lids(hits []map[string]interface{}) string {
	var out []string
	for _, h := range hits {
		out = append(out, mstr(h, "lid"))
	}
	return strings.Join(out, ",")
}

func TestCollapseDuplicatesPure(t *testing.T) {
	hits := []map[string]interface{}{
		dupHit("a1", "Numb", "Linkin Park", "Meteora (Bonus Edition)"),
		dupHit("b1", "One More Time", "Daft Punk", "Discovery"),
		dupHit("a2", "Numb", "Linkin Park", "Meteora"),
		dupHit("c1", "Get Lucky (feat. Pharrell Williams)", "Daft Punk", "Get Lucky"),
		{"lid": "c2", "title": "Get Lucky", "artist": "Daft Punk feat. Pharrell Williams", "albumArtist": "Daft Punk", "album": "Random Access Memories"},
		dupHit("d1", "Get Lucky (Daft Punk Remix)", "Daft Punk", "Get Lucky"),
		dupHit("e1", "", "X", "Y"),
		dupHit("e2", "", "X", "Y"),
		dupHit("b2", "One More Time - 2021 Remaster", "Daft Punk", "Discovery [Deluxe]"),
	}
	// No preference: the first copy stays, in place; the remix and the
	// untitled hits are kept.
	got := lids(collapseDuplicates(hits, nil))
	if got != "a1,b1,c1,d1,e1,e2" {
		t.Errorf("no preference: %s", got)
	}
	// The suggested album's copy wins, at the first copy's position.
	pref := map[string]bool{
		albumID("Linkin Park", "Meteora"):              true,
		albumID("Daft Punk", "Random Access Memories"): true,
	}
	got = lids(collapseDuplicates(hits, pref))
	if got != "a2,b1,c2,d1,e1,e2" {
		t.Errorf("with preference: %s", got)
	}
	if len(collapseDuplicates(nil, pref)) != 0 {
		t.Error("nil in, empty out")
	}
}

// newDupMixStub: 20 albums each present twice (lidarr "Album N" and the
// soulseek "Album N (Deluxe Edition)"), the same 3 songs on both.
func newDupMixStub(t *testing.T) *mixStub {
	t.Helper()
	resetAlbumCoverMemo()
	resetMixSurveyMemo()
	resetCrossoverMemo()
	s := &mixStub{}
	n := 0
	for a := 0; a < 20; a++ {
		artist := fmt.Sprintf("Band %d", a)
		for _, album := range []string{fmt.Sprintf("Album %d", a), fmt.Sprintf("Album %d (Deluxe Edition)", a)} {
			for i := 0; i < 3; i++ {
				n++
				s.tracks = append(s.tracks, map[string]interface{}{
					"lid": fmt.Sprintf("%011x", n), "title": fmt.Sprintf("Song %d-%d", a, i), "artist": artist, "albumArtist": artist,
					"album": album, "track": float64(i + 1), "durationSec": 200.0, "year": "1995", "genre": "Rock",
				})
			}
			s.albums = append(s.albums, map[string]interface{}{"id": albumID(artist, album), "album": album, "albumArtist": artist, "year": "1995", "coverLid": fmt.Sprintf("%011x", n)})
		}
	}
	return s
}

func TestLocalMixOneCopyPerSong(t *testing.T) {
	stub := newDupMixStub(t)
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	pref := map[string]bool{}
	for a := 0; a < 20; a++ {
		pref[albumID(fmt.Sprintf("Band %d", a), fmt.Sprintf("Album %d", a))] = true
	}
	withPreferred(t, pref)
	for run := 0; run < 5; run++ {
		resp := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=1990")
		items, _ := resp["items"].([]interface{})
		if len(items) != 40 {
			t.Fatalf("run %d: want 40 items, got %d", run, len(items))
		}
		seen := map[string]bool{}
		fromPref := 0
		for _, it := range items {
			m := it.(map[string]interface{})
			title, _ := m["title"].(string)
			if seen[title] {
				t.Fatalf("run %d: %q twice", run, title)
			}
			seen[title] = true
			alb, _ := m["album"].(map[string]interface{})
			bid, _ := alb["browseId"].(string)
			if id, _, _ := parseLocalAlbumRef(bid); pref[id] {
				fromPref++
			}
		}
		// A song drawn in both copies keeps the suggested one; a song drawn
		// once keeps whichever copy came: the suggested copies dominate.
		if fromPref <= len(items)/2 {
			t.Fatalf("run %d: only %d/%d items from the suggested copies", run, fromPref, len(items))
		}
	}
}

func TestRelatedOneCopyPerSong(t *testing.T) {
	stub := newShelfStub(t)
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
		{"lid": "b1b2c3d4e5f", "title": "Get Lucky", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Random Access Memories", "genre": "House", "track": 8.0, "durationSec": 369.0},
		{"lid": "b1b2c3d4e60", "title": "Get Lucky (feat. Pharrell Williams)", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Random Access Memories (Deluxe)", "genre": "House", "track": 8.0, "durationSec": 369.0},
		{"lid": "0123456789a", "title": "Lady", "artist": "Modjo", "albumArtist": "Modjo", "album": "Modjo", "genre": "House", "track": 3.0, "durationSec": 300.0},
	}
	withPreferred(t, map[string]bool{albumID("Daft Punk", "Random Access Memories (Deluxe)"): true})
	seed := stub.hits["tracks"][0]
	for run := 0; run < 20; run++ {
		items := relatedByAlbum(seed, "e182ccc85ad", radioPool(seed, "e182ccc85ad"), 20)
		lucky := 0
		for _, it := range items {
			if strings.HasPrefix(it.Title, "Get Lucky") {
				lucky++
				if it.VideoID != "b1b2c3d4e60" {
					t.Fatalf("run %d: kept the non-suggested Get Lucky %s", run, it.VideoID)
				}
			}
		}
		if lucky != 1 || len(items) != 2 {
			t.Fatalf("run %d: want Get Lucky once + Lady, got %+v", run, items)
		}
	}
}
