package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestValidSortAllowList(t *testing.T) {
	cases := []struct {
		raw, want string
		ok        bool
	}{
		{"", "dateAdded:desc", true},
		{"album", "album:asc", true},
		{"year:desc", "year:desc", true},
		{"zz:desc", "", false},
		{"album:sideways", "", false},
		{"id:asc", "", false},
	}
	for _, tc := range cases {
		got, ok := validSort(tc.raw, albumSortable, "dateAdded:desc")
		if got != tc.want || ok != tc.ok {
			t.Errorf("validSort(%q) = (%q,%v), want (%q,%v)", tc.raw, got, ok, tc.want, tc.ok)
		}
	}
}

// local/albums?sort=<unknown> -> 400 {"error":"bad_request"} (audit v3 G18),
// answered before any Meili call. Same for artists and songs.
func TestLocalBrowseUnknownSortIs400(t *testing.T) {
	for name, h := range map[string]echo.HandlerFunc{
		"albums":  LocalAlbumsHandler,
		"artists": LocalArtistsHandler,
		"songs":   LocalSongsHandler,
	} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/"+name+"?sort=zz:desc", "", nil)
		if err := h(c); err != nil {
			t.Fatalf("%s: handler error: %v", name, err)
		}
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, rec.Code)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: body not JSON: %v (%s)", name, err, rec.Body.String())
		}
		if body["error"] != "bad_request" {
			t.Fatalf("%s: error = %q, want bad_request", name, body["error"])
		}
	}
}

// D4: /library/genres "Lire"/"Aléatoire" load local/songs?genre=<g>&limit=200;
// the genre filter must reach Meili as an exact match (and combine with
// artist when both are given).

// lastFilterFor returns the filter sent with the most recent query to `index`.
func lastFilterFor(stub *shelfStub, index string) string {
	for i := len(stub.queried) - 1; i >= 0; i-- {
		if stub.queried[i] == index {
			return stub.filters[i]
		}
	}
	return ""
}

func TestLocalSongsGenreFilter(t *testing.T) {
	stub := newShelfStub(t)
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/songs?genre=House&limit=200", "", nil)
	if err := LocalSongsHandler(c); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	last := lastFilterFor(stub, "tracks")
	if last != `genre = "House"` {
		t.Fatalf("filter = %q, want genre = \"House\"", last)
	}

	c, rec = ctxFor(http.MethodGet, "/api/v1/local/songs?genre=House&artist=Daft+Punk", "", nil)
	if err := LocalSongsHandler(c); err != nil {
		t.Fatal(err)
	}
	last = lastFilterFor(stub, "tracks")
	if last != `genre = "House" AND albumArtist = "Daft Punk"` {
		t.Fatalf("combined filter = %q", last)
	}
}

// EQ4: the local songs endpoint pages past the search shelf's 12-result cap
// with ?q=&offset=&limit= like any other local/* listing.
func TestLocalSongsQueryPagination(t *testing.T) {
	stub := newShelfStub(t)
	stub.hits["tracks"] = make([]map[string]interface{}, 0, 20)
	for i := 0; i < 20; i++ {
		stub.hits["tracks"] = append(stub.hits["tracks"], map[string]interface{}{
			"lid": fmt.Sprintf("%011x", i+1), "title": "Track", "artist": "A", "albumArtist": "A", "album": "Alb", "track": float64(i), "durationSec": 200.0,
		})
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/songs?q=track&offset=12&limit=12", "", nil)
	if err := LocalSongsHandler(c); err != nil {
		t.Fatal(err)
	}
	var body struct {
		Items  []map[string]interface{} `json:"items"`
		Total  int                      `json:"total"`
		Offset int                      `json:"offset"`
		Limit  int                      `json:"limit"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Offset != 12 || body.Limit != 12 || len(body.Items) != 8 {
		t.Fatalf("offset=%d limit=%d items=%d, want 12/12/8", body.Offset, body.Limit, len(body.Items))
	}
}
