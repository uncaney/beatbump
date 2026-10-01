package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// newInLibraryStub answers the albums-index pages MeNewInLibraryHandler
// reads (already in dateAdded desc order; offset/limit honoured).
type newInLibraryStub struct {
	albums []map[string]interface{}
}

func (s *newInLibraryStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/indexes/albums/search") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		all := s.albums
		off, lim := stubInt(body["offset"]), stubInt(body["limit"])
		if off > len(all) {
			off = len(all)
		}
		all = all[off:]
		if lim > 0 && lim < len(all) {
			all = all[:lim]
		}
		hits := []interface{}{}
		for _, h := range all {
			hits = append(hits, h)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(s.albums)})
	})
}

func TestMeNewInLibrary(t *testing.T) {
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.Follow{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	// Followed: a local artist by la- id, a YouTube artist by name only.
	follows := []db.Follow{
		{ProfileID: "p-test", ArtistID: artistID("Daft Punk"), Name: "Daft Punk", CreatedAt: now},
		{ProfileID: "p-test", ArtistID: "UCyoutube123", Name: "Justice", CreatedAt: now},
		{ProfileID: "p-other", ArtistID: artistID("Air"), Name: "Air", CreatedAt: now},
	}
	if err := db.DB.Create(&follows).Error; err != nil {
		t.Fatal(err)
	}
	// Top artist by plays (no follow): Phoenix, 3 plays.
	item := `{"videoId":"abcabcabca1","title":"1901","artistInfo":{"artist":[{"text":"Phoenix","browseId":"` + artistID("Phoenix") + `"}]}}`
	plays := []db.PlayEvent{
		{ProfileID: "p-test", Ref: "abcabcabca1", Title: "1901", Artist: "Phoenix", Source: "local", Data: item, PlayedAt: now.Add(-1 * time.Hour)},
		{ProfileID: "p-test", Ref: "abcabcabca1", Title: "1901", Artist: "Phoenix", Source: "local", Data: item, PlayedAt: now.Add(-2 * time.Hour)},
		{ProfileID: "p-test", Ref: "abcabcabca1", Title: "1901", Artist: "Phoenix", Source: "local", Data: item, PlayedAt: now.Add(-200 * 24 * time.Hour)},
	}
	if err := db.DB.Create(&plays).Error; err != nil {
		t.Fatal(err)
	}

	day := int64(24 * 3600)
	ts := func(daysAgo int64) float64 { return float64(now.Unix() - daysAgo*day) }
	stub := &newInLibraryStub{albums: []map[string]interface{}{
		{"id": "lb-dp-new", "album": "Random Access Memories", "albumArtist": "Daft Punk", "artistId": artistID("Daft Punk"), "coverLid": "aaaaaaaaaa1", "dateAdded": ts(2)},
		{"id": "lb-justice-new", "album": "Hyperdrama", "albumArtist": "JUSTICE", "artistId": artistID("JUSTICE"), "coverLid": "bbbbbbbbbb1", "dateAdded": ts(5)},
		{"id": "lb-phoenix-new", "album": "Alpha Zulu", "albumArtist": "Phoenix", "artistId": artistID("Phoenix"), "coverLid": "ccccccccccc", "dateAdded": ts(10)},
		{"id": "lb-stranger", "album": "Unrelated", "albumArtist": "Someone Else", "artistId": artistID("Someone Else"), "coverLid": "ddddddddddd", "dateAdded": ts(12)},
		{"id": "lb-air-new", "album": "Moon Safari", "albumArtist": "Air", "artistId": artistID("Air"), "coverLid": "eeeeeeeeeee", "dateAdded": ts(14)},
		{"id": "lb-dp-old", "album": "Discovery", "albumArtist": "Daft Punk", "artistId": artistID("Daft Punk"), "coverLid": "fffffffffff", "dateAdded": ts(45)},
	}}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()
	t.Setenv("MEILI_URL", srv.URL)

	resp := getJSON(t, MeNewInLibraryHandler, "/api/v1/me/new-in-library?days=30&limit=12")
	items, _ := resp["items"].([]interface{})
	titles := make([]string, 0, len(items))
	for _, it := range items {
		titles = append(titles, it.(map[string]interface{})["title"].(string))
	}
	want := []string{"Random Access Memories", "Hyperdrama", "Alpha Zulu"}
	if strings.Join(titles, "|") != strings.Join(want, "|") {
		t.Fatalf("items = %v, want %v (followed by id, followed by name case-insensitively, top artist; not a stranger, not another profile's follow, not older than 30 d)", titles, want)
	}
	if resp["days"] != 30.0 {
		t.Fatalf("days = %v", resp["days"])
	}

	// a wider window reaches Discovery (45 d); limit truncates
	wide := getJSON(t, MeNewInLibraryHandler, "/api/v1/me/new-in-library?days=60")
	if w, _ := wide["items"].([]interface{}); len(w) != 4 {
		t.Fatalf("days=60: expected 4 albums, got %d", len(w))
	}
	lim := getJSON(t, MeNewInLibraryHandler, "/api/v1/me/new-in-library?limit=1")
	if l, _ := lim["items"].([]interface{}); len(l) != 1 {
		t.Fatalf("limit=1: got %d", len(l))
	}

	// a profile with no follow and no play: nothing (and no Meili call needed)
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/new-in-library", "", nil)
	c.Request().Header.Del("Cookie")
	c.Request().AddCookie(&http.Cookie{Name: "bbp", Value: "p-nobody"})
	if err := MeNewInLibraryHandler(c); err != nil {
		t.Fatal(err)
	}
	var fresh map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &fresh); err != nil {
		t.Fatal(err)
	}
	if f, _ := fresh["items"].([]interface{}); len(f) != 0 {
		t.Fatalf("fresh profile: expected no items, got %v", f)
	}
}

func TestNewInLibraryDays(t *testing.T) {
	for raw, want := range map[string]int{"": 30, "7": 7, "0": 30, "-3": 30, "x": 30, "9999": 365} {
		c, _ := ctxFor(http.MethodGet, "/api/v1/me/new-in-library?days="+raw, "", nil)
		if got := newInLibraryDays(c); got != want {
			t.Errorf("days=%q -> %d, want %d", raw, got, want)
		}
	}
}
