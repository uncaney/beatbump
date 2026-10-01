package api

import (
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
