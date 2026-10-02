package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
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
	seedNamedProfiles(t, "p-test", "p-other")
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
	// Zeta was rejected by its play row without Meili; the 4 survivors are
	// confirmed by ONE batched tracks query (PF4-3), Old rejected by its lid
	if stub.trackCalls != 1 || stub.batchCalls != 1 {
		t.Fatalf("expected 1 batched tracks query, got %d (%d batched)", stub.trackCalls, stub.batchCalls)
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
	seedNamedProfiles(t, "p-test")
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
	// PF4-3: a batch of the 20 first candidates (2 rejects), then a batch
	// of the 2 missing ones
	if tr1 != 2 {
		t.Fatalf("page 1 cost %d tracks queries, want 2", tr1)
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

// L10-6: a request without the bbp cookie gets a fresh random profile id, so
// its never-played scan is never asked again: it must not enter the memo
// (128 entries of ~1000 decoded docs pinned 60 s by a curl loop). With the
// cookie the second page still comes from the memo. Since U12-12 such a
// request is anonymous and answered before any scan, which is stricter still.
func TestNeverPlayedMemoOnlyWithProfileCookie(t *testing.T) {
	useTestDB(t)
	seedNamedProfiles(t, "p-test")
	resetNeverPlayedMemo()
	t.Cleanup(resetNeverPlayedMemo)
	stub := &neverPlayedStub{}
	for i := 0; i < 30; i++ {
		lid := fmt.Sprintf("lida%07d", i)
		a := map[string]interface{}{"id": fmt.Sprintf("lb-a%03d", i), "album": fmt.Sprintf("Anon %03d", i), "albumArtist": "Artist", "coverLid": lid, "dateAdded": float64(1_700_000_000 - i)}
		stub.albums = append(stub.albums, a)
		stub.tracks = append(stub.tracks, map[string]interface{}{"lid": lid, "title": "t", "album": a["album"], "albumArtist": "Artist", "artist": "Artist", "track": 1.0})
	}
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	memoLen := func() int {
		neverPlayedMemoMu.Lock()
		defer neverPlayedMemoMu.Unlock()
		return len(neverPlayedMemo)
	}
	anon := func() {
		e := echo.New()
		rec := httptest.NewRecorder()
		c := e.NewContext(httptest.NewRequest(http.MethodGet, "/api/v1/local/albums?filter=never-played&limit=10", nil), rec)
		if err := LocalAlbumsHandler(c); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("anonymous never-played: err %v code %d", err, rec.Code)
		}
	}
	a0 := stub.albumCalls
	anon()
	anon()
	if got := stub.albumCalls - a0; got != 0 {
		t.Fatalf("anonymous requests: %d album scans, want 0 (anonymous answer, no memo)", got)
	}
	if n := memoLen(); n != 0 {
		t.Fatalf("anonymous requests left %d memo entries", n)
	}
	a1 := stub.albumCalls
	getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played&limit=10")
	getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played&offset=10&limit=10")
	if got := stub.albumCalls - a1; got != 1 {
		t.Fatalf("profile requests: %d album scans, want 1 (memo)", got)
	}
	if n := memoLen(); n != 1 {
		t.Fatalf("profile requests: %d memo entries, want 1", n)
	}
}

// PF4-3: a 200-album page is confirmed in batches (one Meili query per
// trackCount budget), not one query per album, with the same verdicts: a
// lid-only play and a videoId-only play are rejected, an album without
// any track is re-checked on its own and rejected, upper/lower case
// differences between the album doc and its tracks do not matter.
func TestLocalAlbumsNeverPlayedBatchedConfirmation(t *testing.T) {
	useTestDB(t)
	seedNamedProfiles(t, "p-test")
	resetNeverPlayedMemo()
	stub := &neverPlayedStub{}
	for i := 0; i < 260; i++ {
		lid := fmt.Sprintf("lidb%07d", i)
		a := map[string]interface{}{"id": fmt.Sprintf("lb-b%03d", i), "album": fmt.Sprintf("Album %03d", i), "albumArtist": fmt.Sprintf("Artist %d", i%7), "coverLid": lid, "dateAdded": float64(1_700_000_000 - i), "trackCount": 12.0}
		stub.albums = append(stub.albums, a)
		if i == 30 {
			continue // album doc without any track: never offered
		}
		for n := 0; n < 12; n++ {
			tr := map[string]interface{}{"lid": fmt.Sprintf("lidb%04d%03d", i, n), "title": "t", "album": a["album"], "albumArtist": a["albumArtist"], "artist": a["albumArtist"], "track": float64(n + 1)}
			if n == 0 {
				tr["lid"] = lid
			}
			if i == 40 {
				tr["album"] = strings.ToUpper(mstr(a, "album")) // case only differs
			}
			if i == 50 && n == 3 {
				tr["videoId"] = "ytvideo0050"
			}
			stub.tracks = append(stub.tracks, tr)
		}
	}
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	seed := []db.PlayEvent{
		{ProfileID: "p-test", Ref: "lidb0010005", Title: "t", Source: "local"}, // album 10, track 6, lid only
		{ProfileID: "p-test", Ref: "ytvideo0050", Title: "t", Source: "youtube"},
	}
	if err := db.DB.Create(&seed).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}
	t0 := stub.trackCalls
	resp := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played&offset=0&limit=200")
	got := albumTitles(resp)
	if len(got) != 200 {
		t.Fatalf("got %d albums", len(got))
	}
	for _, ti := range got {
		if ti == "Album 010" || ti == "Album 030" || ti == "Album 050" {
			t.Fatalf("%s offered as never played", ti)
		}
	}
	if got[39] != "Album 040" && got[38] != "Album 040" {
		t.Fatalf("Album 040 (case-only difference) missing: %v", got[35:42])
	}
	// 3 rejects -> 203 candidates examined
	if next := int(resp["nextOffset"].(float64)); next != 203 {
		t.Fatalf("nextOffset = %d, want 203", next)
	}
	// 200 albums x 12 tracks = 2400 < 4000 budget: one batch, then one for
	// the 3 missing, plus the lone re-check of the trackless album 30
	if n := stub.trackCalls - t0; n > 3 {
		t.Fatalf("200-album page cost %d tracks queries, want <= 3", n)
	}
}

// B8-19: GET /local/albums?filter=no-year, LIBRARY-LINT's 148 albums without
// a year. The albums index has no "year" filterable attribute, so the
// listing is materialised from the same bounded newest-first scan as
// added-30d/never-played: an empty year, a garbage one ("Unknown") and one
// out of yearOf's accepted range are all "no year"; a real 4-digit year is
// kept out.
func TestLocalAlbumsFilterNoYear(t *testing.T) {
	useTestDB(t)
	resetNoYearAlbumsMemo() // L14-4: the list reads the memoised whole-library scan
	t.Cleanup(resetNoYearAlbumsMemo)
	stub := &neverPlayedStub{
		albums: []map[string]interface{}{
			{"id": "lb-y1", "album": "Zeta", "albumArtist": "Artist A", "coverLid": "lidy1000000", "dateAdded": 5000.0, "year": "2024", "trackCount": 12.0},
			{"id": "lb-y2", "album": "Blank", "albumArtist": "Artist B", "coverLid": "lidy1000010", "dateAdded": 4000.0, "year": "", "trackCount": 8.0},
			{"id": "lb-y3", "album": "Garbage", "albumArtist": "Artist C", "coverLid": "lidy1000029", "dateAdded": 3000.0, "year": "Unknown", "trackCount": 10.0},
			{"id": "lb-y4", "album": "Missing", "albumArtist": "Artist D", "coverLid": "lidy1000031", "dateAdded": 2000.0, "trackCount": 9.0},
			{"id": "lb-y5", "album": "Alpha", "albumArtist": "Artist E", "coverLid": "lidy1000100", "dateAdded": 1000.0, "year": "2010", "trackCount": 5.0},
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

	resp := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=no-year")
	got := albumTitles(resp)
	if len(got) != 3 || got[0] != "Blank" || got[1] != "Garbage" || got[2] != "Missing" {
		t.Fatalf("no-year: got %v", got)
	}
	if resp["total"].(float64) != 3 || resp["filter"] != "no-year" || resp["sort"] != "dateAdded:desc" {
		t.Fatalf("no-year envelope: %v", resp)
	}
	page := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=no-year&offset=1&limit=1")
	if got := albumTitles(page); len(got) != 1 || got[0] != "Garbage" || page["total"].(float64) != 3 {
		t.Fatalf("no-year offset=1 limit=1: got %v total %v", got, page["total"])
	}
	sorted := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=no-year&sort=album:asc")
	if got := albumTitles(sorted); len(got) != 3 || got[0] != "Blank" || got[1] != "Garbage" || got[2] != "Missing" {
		t.Fatalf("no-year sort=album:asc: got %v", got)
	}
}
