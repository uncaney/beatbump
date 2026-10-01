package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"sync"
	"testing"
)

// fakeAlbumMeili answers /indexes/albums/search like Meili: artistId IN
// filter, year:desc, limit, and records every request body.
type fakeAlbumMeili struct {
	mu     sync.Mutex
	albums []map[string]interface{}
	bodies []map[string]interface{}
}

var inIDs = regexp.MustCompile(`"([^"]+)"`)

func (f *fakeAlbumMeili) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]interface{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	f.bodies = append(f.bodies, body)
	f.mu.Unlock()
	want := map[string]bool{}
	filter, _ := body["filter"].(string)
	for _, m := range inIDs.FindAllStringSubmatch(filter, -1) {
		want[m[1]] = true
	}
	hits := []map[string]interface{}{}
	for _, a := range f.albums {
		if want[mstr(a, "artistId")] {
			hits = append(hits, map[string]interface{}{"artistId": a["artistId"], "coverLid": a["coverLid"]})
		}
	}
	limit := int(body["limit"].(float64))
	if len(hits) > limit {
		hits = hits[:limit]
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits})
}

// PF3-8: no more "limit 2000": a round asks for 2*len(artists) albums with
// artistId + coverLid only, and an artist crowded out by a prolific one gets
// a follow-up round of its own.
func TestArtistCoverLidsBoundedLimit(t *testing.T) {
	f := &fakeAlbumMeili{}
	// Albums are listed newest first (the fake keeps insertion order as year:desc).
	for i := 0; i < 30; i++ {
		f.albums = append(f.albums, map[string]interface{}{"artistId": "la-prolific", "coverLid": "p" + strconv.Itoa(i)})
	}
	f.albums = append(f.albums,
		map[string]interface{}{"artistId": "la-a", "coverLid": "a-new"},
		map[string]interface{}{"artistId": "la-a", "coverLid": "a-old"},
		map[string]interface{}{"artistId": "la-b", "coverLid": "b-only"},
	)
	srv := httptest.NewServer(f)
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	got := artistCoverLids([]string{"la-prolific", "la-a", "la-b", "la-none", "la-a"})
	want := map[string]string{"la-prolific": "p0", "la-a": "a-new", "la-b": "b-only"}
	if len(got) != len(want) {
		t.Fatalf("covers = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("covers[%s] = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
	if len(f.bodies) < 2 || len(f.bodies) > artistCoverRounds {
		t.Fatalf("meili rounds = %d", len(f.bodies))
	}
	// Round 1: 4 distinct artists -> limit 8, filled by la-prolific alone.
	if l := f.bodies[0]["limit"].(float64); l != 8 {
		t.Fatalf("round 1 limit = %v, want 8", l)
	}
	for i, b := range f.bodies {
		if l := b["limit"].(float64); l > 8 || l >= 2000 {
			t.Fatalf("round %d limit = %v", i, l)
		}
		attrs, _ := b["attributesToRetrieve"].([]interface{})
		if len(attrs) != 2 || attrs[0] != "artistId" || attrs[1] != "coverLid" {
			t.Fatalf("round %d attributesToRetrieve = %v", i, attrs)
		}
	}
	// Round 2 only asks for the artists still without a cover.
	if f2, _ := f.bodies[1]["filter"].(string); regexp.MustCompile(`la-prolific`).MatchString(f2) {
		t.Fatalf("round 2 filter re-asks a covered artist: %s", f2)
	}
}

// One round is enough when Meili returns fewer hits than the limit.
func TestArtistCoverLidsSingleRound(t *testing.T) {
	f := &fakeAlbumMeili{albums: []map[string]interface{}{{"artistId": "la-a", "coverLid": "a1"}}}
	srv := httptest.NewServer(f)
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)
	got := artistCoverLids([]string{"la-a", "la-z"})
	if got["la-a"] != "a1" || len(got) != 1 || len(f.bodies) != 1 {
		t.Fatalf("covers=%v rounds=%d", got, len(f.bodies))
	}
	if n := len(artistCoverLids(nil)); n != 0 || len(f.bodies) != 1 {
		t.Fatalf("empty ids queried meili (n=%d rounds=%d)", n, len(f.bodies))
	}
}
