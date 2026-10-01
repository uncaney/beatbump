package api

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"sync"
	"testing"
)

// fakeAlbumMeili answers /indexes/albums/search like Meili: artistId IN
// filter, year:desc, `distinct: "artistId"` (first album per artist), limit,
// and records every request body. noDistinct makes it refuse the distinct
// parameter with a 400, like a Meili older than 1.11.
type fakeAlbumMeili struct {
	mu         sync.Mutex
	albums     []map[string]interface{}
	bodies     []map[string]interface{}
	noDistinct bool
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
	distinct, _ := body["distinct"].(string)
	if distinct != "" && f.noDistinct {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"bad_request"}`))
		return
	}
	hits := []map[string]interface{}{}
	kept := map[string]bool{}
	for _, a := range f.albums {
		aid := mstr(a, "artistId")
		if !want[aid] || (distinct == "artistId" && kept[aid]) {
			continue
		}
		kept[aid] = true
		hits = append(hits, map[string]interface{}{"artistId": a["artistId"], "coverLid": a["coverLid"]})
	}
	limit := int(body["limit"].(float64))
	if len(hits) > limit {
		hits = hits[:limit]
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits})
}

func prolificFixture() *fakeAlbumMeili {
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
	return f
}

func checkProlificCovers(t *testing.T, got map[string]string) {
	t.Helper()
	want := map[string]string{"la-prolific": "p0", "la-a": "a-new", "la-b": "b-only"}
	if len(got) != len(want) {
		t.Fatalf("covers = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("covers[%s] = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

// PF4-2: one Meili query whatever the artists' album counts: distinct on
// artistId, limit = number of distinct artists, artistId + coverLid only.
func TestArtistCoverLidsOneDistinctQuery(t *testing.T) {
	f := prolificFixture()
	srv := httptest.NewServer(f)
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	checkProlificCovers(t, artistCoverLids([]string{"la-prolific", "la-a", "la-b", "la-none", "la-a"}))
	if len(f.bodies) != 1 {
		t.Fatalf("meili queries = %d, want 1", len(f.bodies))
	}
	b := f.bodies[0]
	if b["distinct"] != "artistId" || b["limit"].(float64) != 4 {
		t.Fatalf("query = %v", b)
	}
	if s, _ := b["sort"].([]interface{}); len(s) != 1 || s[0] != "year:desc" {
		t.Fatalf("sort = %v", b["sort"])
	}
	attrs, _ := b["attributesToRetrieve"].([]interface{})
	if len(attrs) != 2 || attrs[0] != "artistId" || attrs[1] != "coverLid" {
		t.Fatalf("attributesToRetrieve = %v", attrs)
	}
}

// PF4-2: meiliReq reuses one keep-alive connection for sequential queries
// (shared client, body drained before Close).
func TestMeiliReqReusesConnection(t *testing.T) {
	f := prolificFixture()
	srv := httptest.NewUnstartedServer(f)
	var mu sync.Mutex
	conns := 0
	srv.Config.ConnState = func(_ net.Conn, st http.ConnState) {
		if st == http.StateNew {
			mu.Lock()
			conns++
			mu.Unlock()
		}
	}
	srv.Start()
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)
	for i := 0; i < 5; i++ {
		checkProlificCovers(t, artistCoverLids([]string{"la-prolific", "la-a", "la-b"}))
	}
	mu.Lock()
	defer mu.Unlock()
	if conns != 1 {
		t.Fatalf("5 sequential queries opened %d connections, want 1", conns)
	}
}

// Fallback (Meili refuses `distinct`): PF3-8 bounded rounds. No more
// "limit 2000": a round asks for 2*len(artists) albums with artistId +
// coverLid only, and an artist crowded out by a prolific one gets a
// follow-up round of its own.
func TestArtistCoverLidsBoundedLimit(t *testing.T) {
	f := prolificFixture()
	f.noDistinct = true
	srv := httptest.NewServer(f)
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	checkProlificCovers(t, artistCoverLids([]string{"la-prolific", "la-a", "la-b", "la-none", "la-a"}))
	rounds := f.bodies[1:] // bodies[0] is the refused distinct query
	if len(rounds) < 2 || len(rounds) > artistCoverRounds {
		t.Fatalf("meili rounds = %d", len(rounds))
	}
	// Round 1: 4 distinct artists -> limit 8, filled by la-prolific alone.
	if l := rounds[0]["limit"].(float64); l != 8 {
		t.Fatalf("round 1 limit = %v, want 8", l)
	}
	for i, b := range rounds {
		if l := b["limit"].(float64); l > 8 || l >= 2000 {
			t.Fatalf("round %d limit = %v", i, l)
		}
		attrs, _ := b["attributesToRetrieve"].([]interface{})
		if len(attrs) != 2 || attrs[0] != "artistId" || attrs[1] != "coverLid" {
			t.Fatalf("round %d attributesToRetrieve = %v", i, attrs)
		}
	}
	// Round 2 only asks for the artists still without a cover.
	if f2, _ := rounds[1]["filter"].(string); regexp.MustCompile(`la-prolific`).MatchString(f2) {
		t.Fatalf("round 2 filter re-asks a covered artist: %s", f2)
	}
}

// One query is enough, and no ids means no query at all.
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
