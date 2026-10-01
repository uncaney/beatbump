package api

import (
	"encoding/json"
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
