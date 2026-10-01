package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// BI4: GET /local/albums?filter=added-30d|never-played, the lists behind the
// home rows' "Voir tout". Five albums newest first: added 1, 10, 29, 31 and
// 100 days ago; the profile played the newest one (its play row names the
// album), the 31-day one only through its track lid (no album label, so the
// Meili confirmation must catch it).
func newAlbumFilterStub(t *testing.T) *neverPlayedStub {
	t.Helper()
	now := time.Now().Unix()
	days := func(n int) float64 { return float64(now - int64(n)*86400) }
	stub := &neverPlayedStub{
		albums: []map[string]interface{}{
			{"id": "lb-d1", "album": "Zeta", "albumArtist": "Artist A", "coverLid": "lidd1000000", "dateAdded": days(1), "year": "2024", "trackCount": 12.0},
			{"id": "lb-d10", "album": "alpha", "albumArtist": "Artist B", "coverLid": "lidd1000010", "dateAdded": days(10), "year": "2021", "trackCount": 8.0},
			{"id": "lb-d29", "album": "Mid", "albumArtist": "Artist C", "coverLid": "lidd1000029", "dateAdded": days(29), "year": "2023", "trackCount": 10.0},
			{"id": "lb-d31", "album": "Old", "albumArtist": "Artist D", "coverLid": "lidd1000031", "dateAdded": days(31), "year": "2019", "trackCount": 9.0},
			{"id": "lb-d100", "album": "Ancient", "albumArtist": "Artist E", "coverLid": "lidd1000100", "dateAdded": days(100), "year": "2010", "trackCount": 5.0},
		},
	}
	for _, a := range stub.albums {
		stub.tracks = append(stub.tracks, map[string]interface{}{
			"lid": mstr(a, "coverLid"), "title": mstr(a, "album") + " 1", "album": mstr(a, "album"), "albumArtist": mstr(a, "albumArtist"), "artist": mstr(a, "albumArtist"), "track": 1.0,
		})
	}
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return stub
}

func albumTitles(resp map[string]interface{}) []string {
	items, _ := resp["items"].([]interface{})
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.(map[string]interface{})["title"].(string))
	}
	return out
}

func TestLocalAlbumsFilterAdded30d(t *testing.T) {
	useTestDB(t)
	newAlbumFilterStub(t)
	resp := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=added-30d")
	if got := albumTitles(resp); len(got) != 3 || got[0] != "Zeta" || got[1] != "alpha" || got[2] != "Mid" {
		t.Fatalf("added-30d: got %v", got)
	}
	if resp["total"].(float64) != 3 || resp["filter"] != "added-30d" || resp["sort"] != "dateAdded:desc" {
		t.Fatalf("added-30d envelope: %v", resp)
	}
	// paging over the materialised list
	page := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=added-30d&offset=1&limit=1")
	if got := albumTitles(page); len(got) != 1 || got[0] != "alpha" || page["total"].(float64) != 3 {
		t.Fatalf("added-30d offset=1 limit=1: got %v total %v", got, page["total"])
	}
	// another sort is applied in Go, case-insensitively
	sorted := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=added-30d&sort=album:asc")
	if got := albumTitles(sorted); len(got) != 3 || got[0] != "alpha" || got[1] != "Mid" || got[2] != "Zeta" {
		t.Fatalf("added-30d sort=album:asc: got %v", got)
	}
	byYear := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=added-30d&sort=year:desc")
	if got := albumTitles(byYear); len(got) != 3 || got[0] != "Zeta" || got[1] != "Mid" || got[2] != "alpha" {
		t.Fatalf("added-30d sort=year:desc: got %v", got)
	}
}

func TestLocalAlbumsFilterNeverPlayed(t *testing.T) {
	useTestDB(t)
	stub := newAlbumFilterStub(t)
	seed := []db.PlayEvent{
		{ProfileID: "p-test", Ref: "lidd1000000", Title: "Zeta 1", Artist: "Artist A", Album: "Zeta", Source: "local"},
		{ProfileID: "p-test", Ref: "lidd1000031", Title: "Old 1", Source: "local"}, // no album label: Meili must catch it
		{ProfileID: "p-other", Ref: "lidd1000100", Title: "Ancient 1", Artist: "Artist E", Album: "Ancient", Source: "local"},
	}
	if err := db.DB.Create(&seed).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}
	resp := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played")
	if got := albumTitles(resp); len(got) != 3 || got[0] != "alpha" || got[1] != "Mid" || got[2] != "Ancient" {
		t.Fatalf("never-played: got %v", got)
	}
	// Zeta was rejected by its play row without Meili: 4 confirmations, not 5
	if stub.trackCalls != 4 {
		t.Fatalf("expected 4 tracks queries, got %d", stub.trackCalls)
	}
	// total = survivors of the pair filter (Old is only rejected by Meili: upper bound 4)
	if resp["total"].(float64) != 4 {
		t.Fatalf("never-played total: %v", resp["total"])
	}
	page := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played&offset=1&limit=1")
	if got := albumTitles(page); len(got) != 1 || got[0] != "Mid" {
		t.Fatalf("never-played offset=1 limit=1: got %v", got)
	}
	// the profile cookie scopes the history: p-other sees Ancient as played... and Zeta as never played
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/albums?filter=never-played&sort=album:asc", "", nil)
	c.Request().Header.Del("Cookie")
	c.Request().AddCookie(&http.Cookie{Name: "bbp", Value: "p-other"})
	if err := LocalAlbumsHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("p-other: err %v code %d", err, rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "Zeta") || strings.Contains(body, "Ancient") {
		t.Fatalf("p-other never-played: %s", body)
	}
}

func TestLocalAlbumsUnknownFilterIs400(t *testing.T) {
	useTestDB(t)
	newAlbumFilterStub(t)
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/albums?filter=bogus", "", nil)
	if err := LocalAlbumsHandler(c); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "unknown filter: bogus") {
		t.Fatalf("expected 400 unknown filter, got %d %s", rec.Code, rec.Body.String())
	}
}

// L9-2: a deep page of never-played costs about what the first one costs:
// the Meili confirmations only cover the requested window (offset is a
// candidate index, nextOffset tells the client where to continue) and the
// newest-first scan is memoised per profile, so page 5 neither rescans the
// albums index nor re-confirms pages 1-4.
func TestLocalAlbumsNeverPlayedPagingCostIsFlat(t *testing.T) {
	useTestDB(t)
	stub := &neverPlayedStub{}
	for i := 0; i < 300; i++ {
		lid := fmt.Sprintf("lidp%07d", i)
		a := map[string]interface{}{"id": fmt.Sprintf("lb-p%03d", i), "album": fmt.Sprintf("Album %03d", i), "albumArtist": "Artist", "coverLid": lid, "dateAdded": float64(1_700_000_000 - i)}
		stub.albums = append(stub.albums, a)
		stub.tracks = append(stub.tracks, map[string]interface{}{"lid": lid, "title": "t", "album": a["album"], "albumArtist": "Artist", "artist": "Artist", "track": 1.0})
	}
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	// one album in every ten was played through its lid only (no album label):
	// only Meili can reject it, the pair filter keeps it as a candidate
	seed := []db.PlayEvent{}
	for i := 5; i < 300; i += 10 {
		seed = append(seed, db.PlayEvent{ProfileID: "p-test", Ref: fmt.Sprintf("lidp%07d", i), Title: "t", Source: "local"})
	}
	if err := db.DB.Create(&seed).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}

	cost := func(off int) (tracks, albums int, resp map[string]interface{}) {
		t0, a0 := stub.trackCalls, stub.albumCalls
		resp = getJSON(t, LocalAlbumsHandler, fmt.Sprintf("/api/v1/local/albums?filter=never-played&offset=%d&limit=20", off))
		return stub.trackCalls - t0, stub.albumCalls - a0, resp
	}
	tr1, al1, p1 := cost(0)
	if len(albumTitles(p1)) != 20 || al1 != 2 { // 300 docs = 2 scan pages of 200
		t.Fatalf("page 1: %d items, %d album scans", len(albumTitles(p1)), al1)
	}
	next := int(p1["nextOffset"].(float64))
	if next != 22 { // two rejects (5, 15) inside the first window
		t.Fatalf("page 1 nextOffset = %d", next)
	}
	seen := map[string]bool{}
	for _, ti := range albumTitles(p1) {
		seen[ti] = true
	}
	var pageN map[string]interface{}
	var trN, alN int
	for page := 2; page <= 5; page++ {
		trN, alN, pageN = cost(next)
		next = int(pageN["nextOffset"].(float64))
		// each page starts where the previous one stopped: no album twice, no played one
		for _, ti := range albumTitles(pageN) {
			if seen[ti] || strings.HasSuffix(ti, "5") {
				t.Fatalf("page %d: %q repeated or played", page, ti)
			}
			seen[ti] = true
		}
	}
	if got := albumTitles(pageN); len(got) != 20 || alN != 0 {
		t.Fatalf("page 5: %d items, %d album scans (memo expected)", len(got), alN)
	}
	if trN > tr1+3 {
		t.Fatalf("page 5 cost %d tracks queries, page 1 cost %d", trN, tr1)
	}
	if pageN["total"].(float64) != 300 {
		t.Fatalf("total = %v", pageN["total"])
	}
	// an offset past the cap is refused before any Meili work
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/albums?filter=never-played&offset=2001", "", nil)
	if err := LocalAlbumsHandler(c); err != nil || rec.Code != http.StatusBadRequest {
		t.Fatalf("offset cap: err %v code %d", err, rec.Code)
	}
}
