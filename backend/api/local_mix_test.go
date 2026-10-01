package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// mixStub is a Meilisearch double for the D1 mixes: it EVALUATES the two
// filters the handlers send (`year IN [1990,...]` and `genre = "X"`), honours
// offset/limit, reports estimatedTotalHits and answers the genre facet, so
// the sampling and the thresholds are exercised for real.
type mixStub struct {
	mu      sync.Mutex // mixSample / genreAlbumCounts query concurrently
	tracks  []map[string]interface{}
	albums  []map[string]interface{}
	filters []string
	surveys []string // filters of the survey requests (limit == mixSurveyLimit)
}

func (s *mixStub) match(h map[string]interface{}, filter string) bool {
	if filter == "" {
		return true
	}
	// c39b: composed filters, "(a) AND (b)" (crossovers) and the album
	// tracks filter `album = "X" AND albumArtist = "Y"`.
	if strings.Contains(filter, " AND ") {
		for _, part := range strings.Split(filter, " AND ") {
			part = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(part), "("), ")")
			if !s.match(h, part) {
				return false
			}
		}
		return true
	}
	if field, val, ok := strings.Cut(filter, " = \""); ok && field != "genre" {
		return mstr(h, field) == strings.TrimSuffix(val, "\"")
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
		s.mu.Lock()
		s.filters = append(s.filters, filter)
		if stubInt(body["limit"]) == mixSurveyLimit {
			s.surveys = append(s.surveys, filter)
		}
		s.mu.Unlock()
		src := s.tracks
		if index == "albums" {
			src = s.albums
		}
		resp := map[string]interface{}{}
		var all []map[string]interface{}
		for _, h := range src {
			if s.match(h, filter) {
				all = append(all, h)
			}
		}
		// Facets over the filtered docs (c39b: genres inside a decade).
		if facets, ok := body["facets"].([]interface{}); ok && len(facets) > 0 {
			dist := map[string]int{}
			for _, h := range all {
				if g := mstr(h, "genre"); g != "" {
					dist[g]++
				}
			}
			resp["facetDistribution"] = map[string]interface{}{"genre": dist}
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
	resetMixSurveyMemo()
	resetCrossoverMemo()
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

func TestLocalMixParamValidation(t *testing.T) {
	newMixStub(t)
	// c39b: decade + genre and year + genre are allowed now; decade + year is not.
	for _, q := range []string{"", "decade=1990&year=1994", "decade=1995", "decade=abc", "year=97", "year=abcd", "year=1850"} {
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
	albums := map[string]int{"Rock": 48, "Pop": 30, "Jazz": 15, "Blues": 15, "OST": 3}
	dc, gc := mixCards(map[int]int{1970: 14, 1990: 15, 2000: 40}, map[string]int{"Rock": 3000, "Pop": 199, "Jazz": 200, "Blues": 200, "OST": 900}, albums)
	if len(dc) != 2 || dc[0].Decade != 2000 || dc[1].Decade != 1990 {
		t.Fatalf("decade cards = %v", dc)
	}
	// OST: 900 tracks but 3 albums -> no card (L8-6); Pop: 199 tracks -> none.
	if len(gc) != 3 || gc[0].Name != "Rock" || gc[1].Name != "Blues" || gc[2].Name != "Jazz" || gc[0].Albums != 48 {
		t.Fatalf("genre cards = %v", gc)
	}
}

// surveyCalls counts the survey requests (limit == mixSurveyLimit) the stub
// saw for a filter.
func (s *mixStub) surveyCalls(filter string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, f := range s.surveys {
		if f == filter {
			n++
		}
	}
	return n
}

// newMixStubGenres seeds two big genres: "Rock" = 20 albums x 10 tracks
// (200 tracks, 20 albums: a mix) and "Soundtrack" = 3 albums x 70 tracks
// (210 tracks, 3 albums: never a mix), plus the 1990s decade from them.
func newMixStubGenres(t *testing.T) *mixStub {
	t.Helper()
	resetAlbumCoverMemo()
	resetMixSurveyMemo()
	resetCrossoverMemo()
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
		add(fmt.Sprintf("Rock %d", a), fmt.Sprintf("Band %d", a), fmt.Sprintf("%d", 1990+a%10), "Rock", 10)
	}
	for a := 0; a < 3; a++ {
		add(fmt.Sprintf("Score %d", a), "Composer", fmt.Sprintf("%d", 2001+a), "Soundtrack", 70)
	}
	srv := httptest.NewServer(s.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return s
}

// L8-6: every genre card /local/mixes lists answers a non-empty /local/mix.
func TestLocalMixesCardsAlwaysPlayable(t *testing.T) {
	newMixStubGenres(t)
	resp := getJSON(t, LocalMixesHandler, "/api/v1/local/mixes")
	genres, _ := resp["genres"].([]interface{})
	if len(genres) != 1 {
		t.Fatalf("expected only Rock (Soundtrack has 210 tracks on 3 albums), got %v", genres)
	}
	g := genres[0].(map[string]interface{})
	if g["name"] != "Rock" || g["count"] != 200.0 || g["albums"] != 20.0 {
		t.Fatalf("genre card = %v", g)
	}
	for _, it := range genres {
		name := it.(map[string]interface{})["name"].(string)
		mix := getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre="+name)
		items, _ := mix["items"].([]interface{})
		if len(items) == 0 {
			t.Fatalf("listed card %q does not play: %v", name, mix["reason"])
		}
	}
	dead := getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Soundtrack")
	if dead["reason"] != "too_small" || dead["albums"] != 3.0 {
		t.Fatalf("Soundtrack should stay too_small: %v", dead)
	}
}

// L8-9: the survey of a filter is memoised for mixSurveyTTL (the sample is
// still fresh per tap), an empty survey is never memoised, and the memo
// expires.
func TestLocalMixSurveyMemo(t *testing.T) {
	stub := newMixStubGenres(t)
	rock := genreFilter("Rock")
	a := getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Rock")
	b := getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Rock")
	if stub.surveyCalls(rock) != 1 {
		t.Fatalf("survey ran %d times for two taps, want 1", stub.surveyCalls(rock))
	}
	ai, _ := a["items"].([]interface{})
	bi, _ := b["items"].([]interface{})
	if len(ai) != 40 || len(bi) != 40 {
		t.Fatalf("both taps should give 40 tracks: %d / %d", len(ai), len(bi))
	}
	// Unknown genre: 0 / 0 is not kept, the next tap surveys again.
	getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Nope")
	getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Nope")
	if stub.surveyCalls(genreFilter("Nope")) != 2 {
		t.Fatalf("empty survey memoised: %d calls", stub.surveyCalls(genreFilter("Nope")))
	}
	// /local/mixes primes the memo for its listed genres.
	getJSON(t, LocalMixesHandler, "/api/v1/local/mixes")
	if stub.surveyCalls(rock) != 1 {
		t.Fatalf("cards listing re-surveyed Rock: %d calls", stub.surveyCalls(rock))
	}
	// Past the TTL the survey runs again.
	base := time.Now()
	mixSurveyNow = func() time.Time { return base.Add(mixSurveyTTL + time.Second) }
	t.Cleanup(func() { mixSurveyNow = time.Now })
	getJSON(t, LocalMixHandler, "/api/v1/local/mix?genre=Rock")
	if stub.surveyCalls(rock) != 2 {
		t.Fatalf("memo did not expire: %d calls", stub.surveyCalls(rock))
	}
}

// newMixStubCross (c39b): Rock 1990s = 20 albums, Rock 2000s = 16, Pop 1997
// = 15, Jazz 1995 = 5 (3 tracks each). Years: 1997 = 17 albums (15 Pop + 2
// Rock), every other year <= 7.
func newMixStubCross(t *testing.T) *mixStub {
	t.Helper()
	resetAlbumCoverMemo()
	resetMixSurveyMemo()
	resetCrossoverMemo()
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
		add(fmt.Sprintf("R90 %d", a), fmt.Sprintf("Band %d", a), fmt.Sprintf("%d", 1990+a%10), "Rock", 3)
	}
	for a := 0; a < 16; a++ {
		add(fmt.Sprintf("R00 %d", a), fmt.Sprintf("Crew %d", a), fmt.Sprintf("%d", 2000+a%10), "Rock", 3)
	}
	for a := 0; a < 15; a++ {
		add(fmt.Sprintf("P97 %d", a), fmt.Sprintf("Singer %d", a), "1997", "Pop", 3)
	}
	for a := 0; a < 5; a++ {
		add(fmt.Sprintf("J95 %d", a), fmt.Sprintf("Trio %d", a), "1995", "Jazz", 3)
	}
	srv := httptest.NewServer(s.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return s
}

func TestMixFilterComposition(t *testing.T) {
	if mixFilter(decadeFilter(1990)) != decadeFilter(1990) {
		t.Fatalf("a single filter must stay as is: %s", mixFilter(decadeFilter(1990)))
	}
	want := `(year IN [1990,1991,1992,1993,1994,1995,1996,1997,1998,1999]) AND (genre = "Rock")`
	if got := crossFilter(1990, "Rock"); got != want {
		t.Fatalf("crossFilter = %s", got)
	}
	if yearFilter(1997) != "year IN [1997]" {
		t.Fatalf("yearFilter = %s", yearFilter(1997))
	}
	for raw, want := range map[string]int{"1997": 1997, "2026": 2026, "199": 0, "19977": 0, "abcd": 0, "1850": 0} {
		got, ok := parseYear(raw)
		if got != want || ok != (want != 0) {
			t.Errorf("parseYear(%q) = (%d,%v)", raw, got, ok)
		}
	}
}

func TestLocalMixDecadeAndGenre(t *testing.T) {
	stub := newMixStubCross(t)
	resp := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=1990&genre=Rock")
	items, _ := resp["items"].([]interface{})
	if len(items) != 40 || resp["decade"] != 1990.0 || resp["genre"] != "Rock" || resp["albums"] != 20.0 {
		t.Fatalf("1990s Rock: %d items, %v", len(items), resp)
	}
	for _, it := range items {
		if title := it.(map[string]interface{})["title"].(string); !strings.HasPrefix(title, "R90 ") {
			t.Fatalf("track outside 1990s Rock: %s", title)
		}
	}
	if stub.surveyCalls(crossFilter(1990, "Rock")) != 1 {
		t.Fatalf("the combined filter was not surveyed as such: %v", stub.surveys)
	}
	// Each slice alone is bigger than the crossing.
	decade := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=1990")
	if decade["albums"].(float64) <= 20 {
		t.Fatalf("decade alone should hold more albums: %v", decade["albums"])
	}
	small := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=1990&genre=Jazz")
	if small["reason"] != "too_small" || small["albums"] != 5.0 {
		t.Fatalf("1990s Jazz should be too_small: %v", small)
	}
	none := getJSON(t, LocalMixHandler, "/api/v1/local/mix?decade=2000&genre=Pop")
	if none["reason"] != "too_small" {
		t.Fatalf("2000s Pop should be too_small: %v", none)
	}
}

func TestLocalMixYear(t *testing.T) {
	newMixStubCross(t)
	resp := getJSON(t, LocalMixHandler, "/api/v1/local/mix?year=1997")
	items, _ := resp["items"].([]interface{})
	if len(items) != 40 || resp["year"] != 1997.0 || resp["albums"] != 17.0 {
		t.Fatalf("1997: %d items, %v", len(items), resp)
	}
	for _, it := range items {
		title := it.(map[string]interface{})["title"].(string)
		if !strings.HasPrefix(title, "P97 ") && !strings.HasPrefix(title, "R90 7 ") && !strings.HasPrefix(title, "R90 17 ") {
			t.Fatalf("track outside 1997: %s", title)
		}
	}
	small := getJSON(t, LocalMixHandler, "/api/v1/local/mix?year=1995")
	if small["reason"] != "too_small" || small["albums"] != 7.0 {
		t.Fatalf("1995 should be too_small (7 albums): %v", small)
	}
	both := getJSON(t, LocalMixHandler, "/api/v1/local/mix?year=1997&genre=Pop")
	if both["albums"] != 15.0 || both["genre"] != "Pop" {
		t.Fatalf("1997 Pop: %v", both)
	}
}

func TestLocalMixesYearsAndCrossovers(t *testing.T) {
	stub := newMixStubCross(t)
	resp := getJSON(t, LocalMixesHandler, "/api/v1/local/mixes")
	years, _ := resp["years"].([]interface{})
	if len(years) != 1 || years[0].(map[string]interface{})["year"] != 1997.0 || years[0].(map[string]interface{})["albums"] != 17.0 {
		t.Fatalf("years = %v", years)
	}
	cross, _ := resp["crossovers"].([]interface{})
	var got []string
	for _, c := range cross {
		m := c.(map[string]interface{})
		got = append(got, fmt.Sprintf("%v:%v:%v", m["decade"], m["genre"], m["albums"]))
	}
	if strings.Join(got, ",") != "1990:Rock:20,2000:Rock:16,1990:Pop:15" {
		t.Fatalf("crossovers = %v", got)
	}
	// Every listed crossover plays.
	for _, c := range cross {
		m := c.(map[string]interface{})
		mix := getJSON(t, LocalMixHandler, fmt.Sprintf("/api/v1/local/mix?decade=%v&genre=%v", m["decade"], m["genre"]))
		if items, _ := mix["items"].([]interface{}); len(items) == 0 {
			t.Fatalf("crossover %v does not play: %v", m, mix["reason"])
		}
	}
	// Memoised: a second build sends no Meili request.
	stub.mu.Lock()
	before := len(stub.filters)
	stub.mu.Unlock()
	crossoverCards([]decadeCard{{Decade: 1990, Albums: 40}, {Decade: 2000, Albums: 16}})
	stub.mu.Lock()
	after := len(stub.filters)
	stub.mu.Unlock()
	if after != before {
		t.Fatalf("crossovers rebuilt within the TTL: %d requests", after-before)
	}
}

func TestPickCrossoversSpread(t *testing.T) {
	var cands []crossoverCard
	for i, d := range []int{2020, 2010, 2000, 1990, 1980, 1970, 1960} {
		cands = append(cands, crossoverCard{Decade: d, Genre: "Rock", Count: 900 - i, Albums: 60 - i})
	}
	cands = append(cands,
		crossoverCard{Decade: 2020, Genre: "Pop", Count: 500, Albums: 40},
		crossoverCard{Decade: 2020, Genre: "Jazz", Count: 400, Albums: 30},
		crossoverCard{Decade: 1990, Genre: "Pop", Count: 300, Albums: 20},
		crossoverCard{Decade: 1980, Genre: "Soul", Count: 300, Albums: 14},
	)
	out := pickCrossovers(cands)
	if len(out) != mixCrossMax {
		t.Fatalf("want %d cards, got %v", mixCrossMax, out)
	}
	perGenre := map[string]int{}
	for _, c := range out {
		perGenre[c.Genre]++
		if c.Albums < mixMinAlbums {
			t.Fatalf("card under the album threshold: %v", c)
		}
	}
	// First pass: Rock 2020, Rock 2010, Pop 2020, (Jazz 2020 skipped: 2020
	// holds 2), Pop 1990; the fill then adds Rock 2000 and Rock 1990.
	if out[0] != cands[0] || out[1] != cands[1] || perGenre["Rock"] < 2 || perGenre["Pop"] != 2 {
		t.Fatalf("spread = %v", out)
	}
	if c := crossoverCandidates(map[int]map[string]int{1990: {"Rock": 60, "Jazz": 14}, 2000: {"Rock": 60}}, 5); len(c) != 2 || c[0].Decade != 2000 {
		t.Fatalf("candidates = %v", c)
	}
}
