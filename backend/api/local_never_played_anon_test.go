package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// seedNamedProfiles gives the test profiles a name: the never-played filter
// only runs for named profiles (U12-12).
func seedNamedProfiles(t *testing.T, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if err := db.DB.Create(&db.Profile{ID: id, Name: "name-" + id, CreatedAt: time.Now()}).Error; err != nil {
			t.Fatalf("seed profile %s: %v", id, err)
		}
	}
}

// U12-12: an anonymous profile used to get the whole library (capped at the
// scan size, "1 000 albums") as "never played". It now gets an empty list and
// reason "anonymous", with a numeric nextOffset; the offset cap still holds.
func TestLocalAlbumsNeverPlayedAnonymous(t *testing.T) {
	useTestDB(t)
	stub := newAlbumFilterStub(t)
	resp := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played&limit=20")
	if got := albumTitles(resp); len(got) != 0 {
		t.Fatalf("anonymous never-played: got %v", got)
	}
	if resp["reason"] != "anonymous" || resp["total"].(float64) != 0 || resp["filter"] != "never-played" {
		t.Fatalf("anonymous envelope: %v", resp)
	}
	if _, ok := resp["nextOffset"].(float64); !ok {
		t.Fatalf("nextOffset must stay a number: %v", resp["nextOffset"])
	}
	if stub.trackCalls != 0 || stub.albumCalls != 0 {
		t.Fatalf("anonymous answer must not scan Meili (tracks %d, albums %d)", stub.trackCalls, stub.albumCalls)
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/albums?filter=never-played&offset=2001", "", nil)
	if err := LocalAlbumsHandler(c); err != nil || rec.Code != http.StatusBadRequest {
		t.Fatalf("offset cap: err %v code %d", err, rec.Code)
	}
	// a profile row without a name is still anonymous
	if err := db.DB.Create(&db.Profile{ID: "p-test", CreatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	if resp := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played"); resp["reason"] != "anonymous" {
		t.Fatalf("nameless profile: %v", resp)
	}
	// once named, the filter runs (all 5 albums unplayed)
	db.DB.Model(&db.Profile{}).Where("id = ?", "p-test").Update("name", "paul")
	resp = getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=never-played")
	if resp["reason"] != nil || len(albumTitles(resp)) != 5 {
		t.Fatalf("named never-played: %v", resp)
	}
}

// L11-7: a database error on the profile lookup answers 500, never the
// anonymous state (a named user must not be asked "Dis-moi ton prénom").
func TestLocalAlbumsNeverPlayedProfileDBError(t *testing.T) {
	useTestDB(t)
	stub := newAlbumFilterStub(t)
	if err := db.DB.Migrator().DropTable(&db.Profile{}); err != nil {
		t.Fatal(err)
	}
	if anon, err := profileAnonymousErr("p-test"); err == nil || anon {
		t.Fatalf("profileAnonymousErr on a broken table: anon %v err %v", anon, err)
	}
	if profileAnonymous("p-test") {
		t.Fatalf("profileAnonymous must count a DB error as named")
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/albums?filter=never-played", "", nil)
	if err := LocalAlbumsHandler(c); err != nil || rec.Code != http.StatusInternalServerError {
		t.Fatalf("db error: err %v code %d body %s", err, rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "anonymous") {
		t.Fatalf("db error answered as anonymous: %s", rec.Body.String())
	}
	if stub.trackCalls != 0 {
		t.Fatalf("no scan on a profile error")
	}
}

func TestProfileAnonymousErrMissingRow(t *testing.T) {
	useTestDB(t)
	if anon, err := profileAnonymousErr("p-nobody"); err != nil || !anon {
		t.Fatalf("missing row: anon %v err %v", anon, err)
	}
	if anon, err := profileAnonymousErr(""); err != nil || !anon {
		t.Fatalf("empty id: anon %v err %v", anon, err)
	}
}
