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
		"bossa nova/samba/soundtrack":     {"bossa nova", "samba", "soundtrack"},
		"_Soundtrack":                     {},
		"B.O.":                            {},
		"O.S.T":                           {},
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
	want := []genreEntry{{Name: "Rock", Count: 13}, {Name: "Acoustic Rock", Count: 3}, {Name: "Blues Rock", Count: 3}}
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
