package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// mixStub is a Meilisearch double for the D1 mixes: it EVALUATES the two
// filters the handlers send (`year IN [1990,...]` and `genre = "X"`), honours
// offset/limit, reports estimatedTotalHits and answers the genre facet, so
// the sampling and the thresholds are exercised for real.
type mixStub struct {
	tracks  []map[string]interface{}
	albums  []map[string]interface{}
	filters []string
}

func (s *mixStub) match(h map[string]interface{}, filter string) bool {
	if filter == "" {
		return true
	}
	if strings.HasPrefix(filter, "year IN [") {
		list := strings.TrimSuffix(strings.TrimPrefix(filter, "year IN ["), "]")
		for _, y := range strings.Split(list, ",") {
			if mnumStr(h, "year") == strings.TrimSpace(y) {
				return true
			}
		}
		return false
	}
	if strings.HasPrefix(filter, "genre = \"") {
		want := strings.TrimSuffix(strings.TrimPrefix(filter, "genre = \""), "\"")
		return mstr(h, "genre") == want
	}
	return false
}

func (s *mixStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/search") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		index := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/indexes/"), "/search")
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		filter := mstr(body, "filter")
		s.filters = append(s.filters, filter)
		src := s.tracks
		if index == "albums" {
			src = s.albums
		}
		resp := map[string]interface{}{}
		if facets, ok := body["facets"].([]interface{}); ok && len(facets) > 0 {
			dist := map[string]int{}
			for _, h := range src {
				if g := mstr(h, "genre"); g != "" {
					dist[g]++
				}
			}
			resp["facetDistribution"] = map[string]interface{}{"genre": dist}
		}
		var all []map[string]interface{}
		for _, h := range src {
			if s.match(h, filter) {
				all = append(all, h)
			}
		}
		resp["estimatedTotalHits"] = len(all)
		off, lim := stubInt(body["offset"]), stubInt(body["limit"])
		if off > len(all) {
			off = len(all)
		}
		all = all[off:]
		if lim >= 0 && lim < len(all) {
			all = all[:lim]
		}
		hits := []interface{}{}
		for _, h := range all {
			hits = append(hits, h)
		}
		resp["hits"] = hits
		json.NewEncoder(w).Encode(resp)
	})
}

// newMixStub seeds: 1990s = 20 albums x 3 tracks (60 tracks, genre Rock),
// 1980s = 3 albums x 10 tracks (30 tracks, genre Synth: big enough in
// tracks, too few albums), 2010s = 1 track (genre Pop). Album docs carry the
// matching years, plus one with a junk year and one duplicated id.
func newMixStub(t *testing.T) *mixStub {
	t.Helper()
	resetAlbumCoverMemo()
	s := &mixStub{}
	n := 0
	add := func(album, artist, year, genre string, tracks int) {
		for i := 0; i < tracks; i++ {
			n++
			s.tracks = append(s.tracks, map[string]interface{}{
				"lid": fmt.Sprintf("%011x", n), "title": fmt.Sprintf("%s %d", album, i+1), "artist": artist, "albumArtist": artist,
				"album": album, "track": float64(i + 1), "durationSec": 200.0, "year": year, "genre": genre,
			})
		}
		s.albums = append(s.albums, map[string]interface{}{"id": albumID(artist, album), "album": album, "albumArtist": artist, "year": year, "coverLid": fmt.Sprintf("%011x", n)})
	}
	for a := 0; a < 20; a++ {
		add(fmt.Sprintf("Nineties %d", a), fmt.Sprintf("Band %d", a), fmt.Sprintf("%d", 1990+a%10), "Rock", 3)
	}
	for a := 0; a < 3; a++ {
		add(fmt.Sprintf("Eighties %d", a), "Synth Band", fmt.Sprintf("%d", 1981+a), "Synth", 10)
	}
	add("Lonely", "Solo", "2015", "Pop", 1)
	s.albums = append(s.albums, map[string]interface{}{"id": "lb-junk", "year": "01-0"}, s.albums[0])
	srv := httptest.NewServer(s.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return s
}

func TestParseDecade(t *testing.T) {
	for raw, want := range map[string]int{"1990": 1990, "2000": 2000, "1995": 0, "199": 0, "abcd": 0, "1890": 0, "": 0} {
		got, ok := parseDecade(raw)
		if got != want || ok != (want != 0) {
			t.Errorf("parseDecade(%q) = (%d,%v), want %d", raw, got, ok, want)
		}
	}
	if decadeFilter(1990) != "year IN [1990,1991,1992,1993,1994,1995,1996,1997,1998,1999]" {
		t.Fatalf("decadeFilter: %s", decadeFilter(1990))
	}
	for raw, want := range map[string]int{"1994": 1990, "2001-05-01": 2000, "2026": 2020, "01-0": 0, "0000": 0, "": 0} {
		if got := decadeOf(raw); got != want {
			t.Errorf("decadeOf(%q) = %d, want %d", raw, got, want)
		}
	}
}

func TestLocalMixRequiresExactlyOneOf(t *testing.T) {
	newMixStub(t)
	for _, q := range []string{"", "decade=1990&genre=Rock", "decade=1995", "decade=abc"} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/mix?"+q, "", nil)
		if err := LocalMixHandler(c); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("?%s: status %d, want 400 (%s)", q, rec.Code, rec.Body.String())
		}
	}
}

func TestLocalMixDecadeSamplesAcrossAlbums(t *testing.T) {
	stub := newMixStub(t)
	resp := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=1990")
	items, _ := resp["items"].([]interface{})
	if len(items) != 40 {
		t.Fatalf("expected 40 tracks, got %d (%v)", len(items), resp["reason"])
	}
	if resp["decade"] != 1990.0 || resp["albums"] != 20.0 {
		t.Fatalf("decade/albums = %v/%v", resp["decade"], resp["albums"])
	}
	albums := map[string]bool{}
	seen := map[string]bool{}
	for _, it := range items {
		m := it.(map[string]interface{})
		vid, _ := m["videoId"].(string)
		if vid == "" || seen[vid] {
			t.Fatalf("missing or duplicated videoId in %v", m)
		}
		seen[vid] = true
		if !strings.HasPrefix(m["title"].(string), "Nineties") {
			t.Fatalf("track outside the decade leaked in: %v", m["title"])
		}
		if al, ok := m["album"].(map[string]interface{}); ok {
			albums[mstr(al, "text")] = true
		}
	}
	if len(albums) < 10 {
		t.Fatalf("expected the sample spread over many albums, got %d", len(albums))
	}
	if !strings.HasPrefix(stub.filters[0], "year IN [1990,") {
		t.Fatalf("first query filter = %q", stub.filters[0])
	}
}

func TestLocalMixGenreAndTooSmall(t *testing.T) {
	newMixStub(t)
	resp := getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Rock")
	raw, _ := resp["items"].([]interface{})
	if len(raw) != 40 || resp["genre"] != "Rock" {
		t.Fatalf("genre mix: %d items, genre=%v, reason=%v", len(raw), resp["genre"], resp["reason"])
	}
	// 30 tracks but only 3 albums: not a mix.
	small := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=1980")
	sitems, _ := small["items"].([]interface{})
	if len(sitems) != 0 || small["reason"] != "too_small" || small["albums"] != 3.0 {
		t.Fatalf("1980s should be too_small, got %v", small)
	}
	empty := getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Nope")
	eitems, _ := empty["items"].([]interface{})
	if len(eitems) != 0 || empty["reason"] != "too_small" {
		t.Fatalf("unknown genre should be too_small, got %v", empty)
	}
}

func TestLocalMixesCards(t *testing.T) {
	newMixStub(t)
	resp := getJSON(t, LocalMixesHandler, "/api/v1/local/mixes")
	decades, _ := resp["decades"].([]interface{})
	if len(decades) != 1 {
		t.Fatalf("expected only the 1990s card (20 albums; 1980s has 3, 2010s 1), got %v", decades)
	}
	d := decades[0].(map[string]interface{})
	if d["decade"] != 1990.0 || d["albums"] != 20.0 {
		t.Fatalf("decade card = %v", d)
	}
	genres, _ := resp["genres"].([]interface{})
	if len(genres) != 0 {
		t.Fatalf("no genre reaches 200 tracks in the fixture, got %v", genres)
	}
	dc, gc := mixCards(map[int]int{1970: 14, 1990: 15, 2000: 40}, map[string]int{"Rock": 3000, "Pop": 199, "Jazz": 200, "Blues": 200})
	if len(dc) != 2 || dc[0].Decade != 2000 || dc[1].Decade != 1990 {
		t.Fatalf("decade cards = %v", dc)
	}
	if len(gc) != 3 || gc[0].Name != "Rock" || gc[1].Name != "Blues" || gc[2].Name != "Jazz" {
		t.Fatalf("genre cards = %v", gc)
	}
}
