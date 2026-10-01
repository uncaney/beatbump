package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestMatchNorm(t *testing.T) {
	for in, want := range map[string]string{
		"Discovery":                                         "discovery",
		"Discovery (Deluxe)":                                "discovery",
		"DISCOVERY [Remastered]":                            "discovery",
		"Abbey Road (2019 Remastered Edition)":              "abbey road",
		"Abbey Road - 2009 Remaster":                        "abbey road",
		"Random Access Memories (10th Anniversary Edition)": "random access memories",
		"Get Lucky (feat. Pharrell Williams)":               "get lucky",
		"Get Lucky feat. Pharrell":                          "get lucky",
		"Céline Dion":                                       "celine dion",
		"Mylène Farmer":                                     "mylene farmer",
		"L'École du micro d'argent":                         "lecole du micro dargent",
		"Alive 2007":                                        "alive 2007",
		"Alive (Live)":                                      "alive live",
		"Red (Taylor's Version)":                            "red taylors version",
		"Simon & Garfunkel":                                 "simon and garfunkel",
		"  Homework!!  ":                                    "homework",
	} {
		if got := matchNorm(in); got != want {
			t.Errorf("matchNorm(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAlbumStrictMatch(t *testing.T) {
	doc := func(album, aa string) map[string]interface{} {
		return map[string]interface{}{"id": "lb-x", "album": album, "albumArtist": aa}
	}
	cases := []struct {
		artist, title string
		d             map[string]interface{}
		want          bool
	}{
		{"Daft Punk", "Discovery (Deluxe)", doc("Discovery", "Daft Punk"), true},
		{"daft punk", "DISCOVERY", doc("Discovery [Remastered]", "Daft Punk"), true},
		{"Daft Punk & Pharrell Williams", "Get Lucky", doc("Get Lucky", "Daft Punk"), true},
		{"Celine Dion", "D'eux", doc("D’eux", "Céline Dion"), true},
		{"Daft Punk", "Alive 2007", doc("Alive 1997", "Daft Punk"), false},
		{"Daft Punk", "Discovery", doc("Discovery", "Justice"), false},
		{"Daft Punk", "Alive", doc("Alive (Live)", "Daft Punk"), false},
		{"", "Discovery", doc("Discovery", "Daft Punk"), false},
		{"Daft Punk", "", doc("", "Daft Punk"), false},
	}
	for _, tc := range cases {
		if got := albumStrictMatch(tc.artist, tc.title, tc.d); got != tc.want {
			t.Errorf("albumStrictMatch(%q, %q, %v) = %v, want %v", tc.artist, tc.title, tc.d, got, tc.want)
		}
	}
}

func TestLocalAlbumMatchHandler(t *testing.T) {
	orig := localAlbumSearchFn
	defer func() { localAlbumSearchFn = orig }()
	localAlbumSearchFn = func(q string) []map[string]interface{} {
		return []map[string]interface{}{
			{"id": "lb-aaa", "album": "Discovery Live", "albumArtist": "Daft Punk"},
			{"id": "lb-bbb", "album": "Discovery", "albumArtist": "Daft Punk", "coverLid": "0123456789a", "trackCount": float64(14)},
		}
	}
	e := echo.New()
	get := func(qs string) (int, map[string]interface{}) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/local/albums/match?"+qs, nil)
		rec := httptest.NewRecorder()
		_ = LocalAlbumMatchHandler(e.NewContext(req, rec))
		var out map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, out := get("artist=Daft+Punk&title=Discovery+%28Deluxe%29")
	m, _ := out["match"].(map[string]interface{})
	if code != 200 || m == nil || m["id"] != "lb-bbb" || m["href"] != "/release?id=lb-bbb" || m["trackCount"] != float64(14) {
		t.Fatalf("strong hit: code %d body %v", code, out)
	}
	code, out = get("artist=Justice&title=Cross")
	if code != 200 || out["match"] != nil {
		t.Fatalf("no hit: code %d body %v", code, out)
	}
	if code, _ = get("title=Discovery"); code != http.StatusBadRequest {
		t.Fatalf("missing artist: code %d", code)
	}
}
