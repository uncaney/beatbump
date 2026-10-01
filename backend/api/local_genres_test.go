package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestSplitGenreValue(t *testing.T) {
	cases := map[string][]string{
		"Acoustic Rock;Blues Rock; Rock ": {"Acoustic Rock", "Blues Rock", "Rock"},
		"bossa nova/samba/soundtrack":     {"bossa nova", "samba", "Bande originale"},
		"_Soundtrack":                     {"Bande originale"},
		"B.O.":                            {"Bande originale"},
		"O.S.T":                           {"Bande originale"},
		"_Unknown":                        {},
		"X.Y.":                            {},
		"":                                {},
		" ; ;x":                           {},
		"R&B":                             {"R&B"},
		"Hip  Hop":                        {"Hip Hop"},
	}
	for in, want := range cases {
		got := splitGenreValue(in)
		if len(got) == 0 && len(want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("splitGenreValue(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeGenres(t *testing.T) {
	raw := map[string]int{
		"Rock":                    100,
		"rock":                    5,
		"Blues Rock;Rock":         20,
		"Rock;rock":               3,
		"_Soundtrack":             50,
		"B.O.":                    40,
		"":                        9,
		"Electronic/House":        10,
		"House":                   30,
		"Classic Rock;Blues Rock": 7,
	}
	got := normalizeGenres(raw)
	want := []genreEntry{
		{Name: "Rock", Count: 128},
		{Name: "Bande originale", Count: 90},
		{Name: "House", Count: 40},
		{Name: "Blues Rock", Count: 27},
		{Name: "Electronic", Count: 10},
		{Name: "Classic Rock", Count: 7},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeGenres = %+v\nwant %+v", got, want)
	}
}

func TestGenreFilterFor(t *testing.T) {
	raw := map[string]int{"House": 30, "Electronic/House": 10, "Rock": 4, "Blues Rock;Rock": 2, `Say "Hi"`: 1}
	if f := genreFilterFor("House", raw); f != `genre IN ["Electronic/House", "House"]` {
		t.Fatalf("House filter = %s", f)
	}
	// L11-1: the exact value is always part of the list, even when the facet does not list it.
	if f := genreFilterFor("blues rock", raw); f != `genre IN ["Blues Rock;Rock", "blues rock"]` {
		t.Fatalf("blues rock filter = %s", f)
	}
	if f := genreFilterFor(`Say "Hi"`, raw); f != `genre = "Say \"Hi\""` {
		t.Fatalf("exact filter = %s", f)
	}
	if f := genreFilterFor("Jazz", raw); f != `genre = "Jazz"` {
		t.Fatalf("unknown genre must keep the exact filter, got %s", f)
	}
}

// The handler answers the normalized list from the Meili facet.
func TestLocalGenresHandlerNormalizes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"hits": []interface{}{},
			"facetDistribution": map[string]interface{}{"genre": map[string]interface{}{
				"Acoustic Rock;Blues Rock;Rock": 3.0, "Rock": 10.0, "_Soundtrack": 8.0, "B.O.": 6.0, "": 2.0,
			}},
		})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/genres", "", nil)
	if err := LocalGenresHandler(c); err != nil {
		t.Fatal(err)
	}
	var body struct {
		Genres []genreEntry `json:"genres"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := []genreEntry{{Name: "Bande originale", Count: 14}, {Name: "Rock", Count: 13}, {Name: "Acoustic Rock", Count: 3}, {Name: "Blues Rock", Count: 3}}
	if !reflect.DeepEqual(body.Genres, want) {
		t.Fatalf("genres = %+v, want %+v", body.Genres, want)
	}
}

// Audit L11-1: the exact genre value must always be matched, even when the facet
// (alphabetical, capped at 100 values) does not list it and only shows combined tags.
func TestGenreFilterAlwaysIncludesExactName(t *testing.T) {
	raw := map[string]int{"Alternative Rock;Rock": 12, "Blues Rock": 3} // facet truncated before "Rock"
	f := genreFilterFor("Rock", raw)
	if !strings.Contains(f, "\"Rock\"") {
		t.Fatalf("exact genre missing from filter: %s", f)
	}
	if !strings.Contains(f, "genre IN [") {
		t.Fatalf("expected an IN filter with the combined tags too: %s", f)
	}
	if got := genreFilterFor("Jazz", map[string]int{}); got != "genre = \"Jazz\"" {
		t.Fatalf("empty facet: %s", got)
	}
}

// Audit L11-6: slash names that are one genre, commas, pipes, and the
// soundtrack spellings grouped under "Bande originale".
func TestSplitGenreValueRules(t *testing.T) {
	cases := map[string][]string{
		"Singer/Songwriter":              {"Singer/Songwriter"},
		"AC/DC":                          {"AC/DC"},
		"R&B/Soul":                       {"R&B/Soul"},
		"Rock/Pop":                       {"Rock/Pop"},
		"Electronic/House":               {"Electronic", "House"},
		"Rock / Pop Rock / Classic Rock": {"Rock", "Pop Rock", "Classic Rock"},
		"Rock, Britpop":                  {"Rock", "Britpop"},
		"Rock | Pop Rock":                {"Rock", "Pop Rock"},
		"Soundtrack, Classical":          {"Bande originale", "Classical"},
		"BSO":                            {"Bande originale"},
		"OST":                            {"Bande originale"},
		"Score":                          {"Bande originale"},
		"Original Soundtrack":            {"Bande originale"},
		"Bande Originale de Film":        {"Bande originale"},
		"Soundtrack (Film)":              {"Bande originale"},
		"Sound Track":                    {"Bande originale"},
		"CORE":                           {"CORE"},
		"Hardcore":                       {"Hardcore"},
	}
	for in, want := range cases {
		if got := splitGenreValue(in); !reflect.DeepEqual(got, want) {
			t.Errorf("splitGenreValue(%q) = %q, want %q", in, got, want)
		}
	}
	// one value with two spellings counts once
	got := normalizeGenres(map[string]int{"Soundtrack;Score": 4, "B.O.": 2, "BSO": 1, "Singer/Songwriter": 3})
	want := []genreEntry{{Name: "Bande originale", Count: 7}, {Name: "Singer/Songwriter", Count: 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeGenres = %+v, want %+v", got, want)
	}
}

func TestGenreFilterSoundtrackGroup(t *testing.T) {
	raw := map[string]int{"B.O.": 21, "Jazz;Score": 3, "Rock": 4}
	f := genreFilterFor("Bande originale", raw)
	for _, v := range []string{`"B.O."`, `"Jazz;Score"`, `"BSO"`, `"OST"`, `"Soundtrack"`, `"Score"`, `"Bande originale"`, `"_Soundtrack"`} {
		if !strings.Contains(f, v) {
			t.Errorf("Bande originale filter misses %s: %s", v, f)
		}
	}
	if strings.Contains(f, `"Rock"`) {
		t.Fatalf("unrelated value in the group filter: %s", f)
	}
	// an old link with a raw spelling lands on the same group
	if g := genreFilterFor("Soundtrack", raw); !strings.Contains(g, `"B.O."`) || !strings.Contains(g, `"Soundtrack"`) {
		t.Fatalf("Soundtrack filter = %s", g)
	}
	// slash names keep their exact filter
	if g := genreFilterFor("Singer/Songwriter", map[string]int{"Singer/Songwriter": 3}); g != `genre = "Singer/Songwriter"` {
		t.Fatalf("Singer/Songwriter filter = %s", g)
	}
}

// The facet distribution is the first 100 values in alphabetical order: the
// songs filter also asks the facet search, keeps the values that really hold
// the genre (not the typo-tolerant neighbours), and memoises it per name.
func TestGenreSongsFilterUsesFacetSearch(t *testing.T) {
	resetGenreFacetCache()
	t.Cleanup(resetGenreFacetCache)
	facetCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/indexes/tracks/search":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"hits":              []interface{}{},
				"facetDistribution": map[string]interface{}{"genre": map[string]interface{}{"Alternative Metal;Metal": 2.0, "Blues": 1.0}},
			})
		case "/indexes/tracks/facet-search":
			facetCalls++
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["facetName"] != "genre" || body["facetQuery"] != "Metal" {
				t.Errorf("facet-search body %v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"facetHits": []interface{}{
				map[string]interface{}{"value": "Metal", "count": 25.0},
				map[string]interface{}{"value": "Metal/Hard Rock", "count": 1.0},
				map[string]interface{}{"value": "Medal Songs", "count": 3.0},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	want := `genre IN ["Alternative Metal;Metal", "Metal", "Metal/Hard Rock"]`
	if f := genreSongsFilter("Metal"); f != want {
		t.Fatalf("Metal filter = %s, want %s", f, want)
	}
	if f := genreSongsFilter("metal"); f != `genre IN ["Alternative Metal;Metal", "Metal", "Metal/Hard Rock", "metal"]` {
		t.Fatalf("metal filter = %s", f)
	}
	if facetCalls != 1 {
		t.Fatalf("facet search not memoised per name: %d calls", facetCalls)
	}
}

// An engine without facet search keeps the previous behaviour (facet
// distribution + the exact name), and the failure is not memoised.
func TestGenreSongsFilterFacetSearchUnavailable(t *testing.T) {
	resetGenreFacetCache()
	t.Cleanup(resetGenreFacetCache)
	facetCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/indexes/tracks/facet-search" {
			facetCalls++
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"hits":              []interface{}{},
			"facetDistribution": map[string]interface{}{"genre": map[string]interface{}{"Blues Rock;Rock": 2.0}},
		})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	if f := genreSongsFilter("Rock"); f != `genre IN ["Blues Rock;Rock", "Rock"]` {
		t.Fatalf("fallback filter = %s", f)
	}
	if f := genreSongsFilter("Jazz"); f != `genre = "Jazz"` {
		t.Fatalf("fallback exact = %s", f)
	}
	_ = genreSongsFilter("Rock")
	if facetCalls != 3 {
		t.Fatalf("a failed facet search must not be memoised: %d calls", facetCalls)
	}
}
