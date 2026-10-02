package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// artistDayStub is a Meilisearch double for the artists index: a stable
// name:asc list paged by offset/limit, plus an empty albums index (the cover
// lookup finds nothing, which the card tolerates).
type artistDayStub struct {
	artists []map[string]interface{}
	calls   int
}

func (s *artistDayStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/search") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/indexes/albums/") {
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": []interface{}{}, "estimatedTotalHits": 0})
			return
		}
		s.calls++
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		off, lim := stubInt(body["offset"]), stubInt(body["limit"])
		if off > len(s.artists) {
			off = len(s.artists)
		}
		rest := s.artists[off:]
		if lim >= 0 && lim < len(rest) {
			rest = rest[:lim]
		}
		hits := make([]interface{}, 0, len(rest))
		for _, h := range rest {
			hits = append(hits, h)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(s.artists)})
	})
}

// fakeArtists: n artists "Artist 00".."Artist n-1" in name order; every
// third one has a single album (ineligible), the others 2 to 5.
func fakeArtists(n int) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		name := fmt.Sprintf("Artist %02d", i)
		albums := 2 + i%4
		if i%3 == 0 {
			albums = 1
		}
		out = append(out, map[string]interface{}{"id": artistID(name), "name": name, "albumCount": float64(albums), "trackCount": float64(albums * 9)})
	}
	return out
}

func newArtistDayStub(t *testing.T, n int) *artistDayStub {
	t.Helper()
	resetArtistDayMemo()
	t.Cleanup(resetArtistDayMemo)
	s := &artistDayStub{artists: fakeArtists(n)}
	srv := httptest.NewServer(s.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.Setting{}); err != nil {
		t.Fatal(err)
	}
	artistDayNow = func() time.Time { return time.Date(2026, 10, 2, 9, 30, 0, 0, time.UTC) }
	t.Cleanup(func() { artistDayNow = time.Now })
	return s
}

func artistDayID(resp map[string]interface{}) string {
	a, _ := resp["artist"].(map[string]interface{})
	if a == nil {
		return ""
	}
	return mstr(a, "browseId")
}

func nameOf(stub *artistDayStub, id string) string {
	for _, a := range stub.artists {
		if mstr(a, "id") == id {
			return mstr(a, "name")
		}
	}
	return ""
}

func albumsOf(stub *artistDayStub, id string) int {
	for _, a := range stub.artists {
		if mstr(a, "id") == id {
			return mint(a, "albumCount")
		}
	}
	return 0
}

// Anonymous (no Profile row for the cookie): the library scope, the same
// artist all day, eligible, persisted, different from the day before.
func TestArtistOfDayStableWithinDay(t *testing.T) {
	stub := newArtistDayStub(t, 40)
	a := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day")
	b := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day")
	id := artistDayID(a)
	if id == "" || a["scope"] != "library" || a["reason"] != "du jour" || a["date"] != "2026-10-02" || a["expires"] != "2026-10-03T00:00:00Z" {
		t.Fatalf("answer = %v", a)
	}
	if artistDayID(b) != id {
		t.Fatalf("same day, different artists: %s / %s", id, artistDayID(b))
	}
	if albumsOf(stub, id) < artistDayMinAlbums || a["albumCount"].(float64) < artistDayMinAlbums || a["name"] != nameOf(stub, id) {
		t.Fatalf("ineligible or inconsistent pick: %v", a)
	}
	art := a["artist"].(map[string]interface{})
	if art["type"] != "artist" || art["title"] != nameOf(stub, id) {
		t.Fatalf("card = %v", art)
	}
	if got := artistDayID(getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day?date=2026-10-02")); got != id {
		t.Fatalf("?date=<today> differs: %s / %s", got, id)
	}
	// Persisted: a restart (memo dropped) and a reordered index keep the pick.
	var row db.Setting
	if err := db.DB.First(&row, "key = ?", "artist-of-day:2026-10-02").Error; err != nil || row.Value == "" {
		t.Fatalf("pick not persisted: %v", err)
	}
	resetArtistDayMemo()
	stub.artists = append(fakeArtists(15), stub.artists...)
	if got := artistDayID(getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day")); got != id {
		t.Fatalf("artist moved after a restart + reindex: %s -> %s", id, got)
	}
	// The next day skips today's artist (eligible as well).
	next := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day?date=2026-10-03")
	if artistDayID(next) == "" || artistDayID(next) == id || next["date"] != "2026-10-03" {
		t.Fatalf("next day: %v", next)
	}
	// Bounds and format of ?date=.
	for _, q := range []string{"02/10/2026", "2026-10", "0001-01-01", "9999-12-31", "2027-10-04", "2025-09-30"} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/artist-of-the-day?date="+q, "", nil)
		if err := LocalArtistOfDayHandler(c); err != nil || rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d", q, rec.Code)
		}
	}
	for _, q := range []string{"2027-10-02", "2025-10-01"} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/artist-of-the-day?date="+q, "", nil)
		if err := LocalArtistOfDayHandler(c); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", q, rec.Code)
		}
	}
	// A library with no eligible artist answers artist: null.
	resetArtistDayMemo()
	artistDayNow = func() time.Time { return time.Date(2027, 1, 5, 0, 0, 0, 0, time.UTC) }
	for _, a := range stub.artists {
		a["albumCount"] = float64(1)
	}
	empty := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day")
	if empty["artist"] != nil || empty["reason"] != "empty" {
		t.Fatalf("no eligible artist: %v", empty)
	}
}

// A named profile never gets an artist it played (by name, or by the artist
// id a YouTube play carries), and keeps its pick for the day.
func TestArtistOfDayExcludesPlayedArtists(t *testing.T) {
	stub := newArtistDayStub(t, 40)
	db.DB.Create(&db.Profile{ID: "p-test", Name: "Camille", CreatedAt: time.Now()})
	// Every eligible artist is played except "Artist 07" (2 + 7%4 = 5 albums):
	// "Artist 11" only through its artist id (a YouTube play of a renamed credit).
	for _, a := range stub.artists {
		name := mstr(a, "name")
		if mint(a, "albumCount") < artistDayMinAlbums || name == "Artist 07" {
			continue
		}
		ev := db.PlayEvent{ProfileID: "p-test", Ref: "v" + name, Title: "t", Artist: strings.ToUpper(name), Source: "local", PlayedAt: time.Now()}
		if name == "Artist 11" {
			ev.Artist = "Someone Else"
			ev.ArtistID = mstr(a, "id")
		}
		db.DB.Create(&ev)
	}
	want := artistID("Artist 07")
	for _, d := range []string{"", "?date=2026-10-03", "?date=2026-10-04"} {
		resp := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day"+d)
		if artistDayID(resp) != want || resp["scope"] != "profile" || resp["reason"] != "du jour" {
			t.Fatalf("%q: picked %s (%v), want the only never-played artist", d, nameOf(stub, artistDayID(resp)), resp["reason"])
		}
	}
	var row db.Setting
	if err := db.DB.First(&row, "key = ?", "artist-of-day:2026-10-02:p-test").Error; err != nil {
		t.Fatalf("profile pick not persisted: %v", err)
	}
	// Another profile's history does not leak: a second named profile with
	// no plays gets the day's free pick, which may differ.
	db.DB.Create(&db.Profile{ID: "p-other", Name: "Lou", CreatedAt: time.Now()})
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/artist-of-the-day", "", nil)
	c.Request().Header.Set("Cookie", "bbp=p-other")
	if err := LocalArtistOfDayHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("p-other: %v %d", err, rec.Code)
	}
	var other map[string]interface{}
	json.Unmarshal(rec.Body.Bytes(), &other)
	if artistDayID(other) == "" || other["scope"] != "profile" {
		t.Fatalf("p-other answer: %v", other)
	}
	// The pure pick: a skip that rejects everything gives nil, bounded.
	calls := 0
	fetch := func(off, lim int) []map[string]interface{} {
		calls++
		if off >= len(stub.artists) {
			return nil
		}
		end := off + lim
		if end > len(stub.artists) {
			end = len(stub.artists)
		}
		return stub.artists[off:end]
	}
	if doc, ok := pickArtistOfDayOK("2026-10-02", len(stub.artists), fetch, func(map[string]interface{}) bool { return true }); doc != nil || !ok || calls > artistDayMaxScan/artistDayWindow+1 {
		t.Fatalf("all skipped: doc %v ok %v calls %d", doc, ok, calls)
	}
}

// When every eligible artist was played, the profile still gets a card: the
// library pick of the day, flagged "all_played", persisted as such.
func TestArtistOfDayFallbackWhenAllPlayed(t *testing.T) {
	stub := newArtistDayStub(t, 24)
	db.DB.Create(&db.Profile{ID: "p-test", Name: "Camille", CreatedAt: time.Now()})
	for _, a := range stub.artists {
		db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "v" + mstr(a, "name"), Title: "t", Artist: mstr(a, "name"), Source: "local", PlayedAt: time.Now()})
	}
	resp := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day")
	id := artistDayID(resp)
	if id == "" || resp["reason"] != "all_played" || resp["scope"] != "profile" {
		t.Fatalf("fallback answer: %v", resp)
	}
	day := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	lib := artistOfDay("2026-10-02", day, "")
	libCard, _ := lib["artist"].(IListItemRenderer)
	if libCard.BrowseId != id || lib["reason"] != "du jour" || lib["scope"] != "library" {
		t.Fatalf("fallback %s is not the library pick %s (%v)", id, libCard.BrowseId, lib)
	}
	resetArtistDayMemo()
	again := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day")
	if artistDayID(again) != id || again["reason"] != "all_played" {
		t.Fatalf("fallback not persisted: %v", again)
	}
	// A failed Meili window is answered but never kept.
	resetArtistDayMemo()
	calls := 0
	failing := func(off, lim int) []map[string]interface{} {
		calls++
		if calls == 1 {
			return nil
		}
		end := off + lim
		if end > len(stub.artists) {
			end = len(stub.artists)
		}
		return stub.artists[off:end]
	}
	if doc, ok := pickArtistOfDayOK("2026-10-05", len(stub.artists), failing, nil); ok || doc == nil {
		t.Fatalf("a failed window must flag the pick: ok=%v doc=%v", ok, doc)
	}
}

func TestArtistDayMemoLRU(t *testing.T) {
	m := &dayMemo{max: 3}
	m.put("a", map[string]interface{}{"k": "a"})
	for i := 0; i < 6; i++ {
		m.put(fmt.Sprintf("d%d", i), map[string]interface{}{})
		if _, ok := m.get("a"); !ok {
			t.Fatalf("a evicted after %d puts", i+1)
		}
	}
	if len(m.m) != 3 || len(m.order) != 3 {
		t.Fatalf("memo size %d / %d, want 3", len(m.m), len(m.order))
	}
	if _, ok := m.get("d0"); ok {
		t.Fatal("d0 should have been evicted")
	}
}

// L13-7: the "never played" check compares normalised artist credits, not
// raw strings: a play recorded as "Daft Punk feat. Pharrell", "Daft Punk &
// Pharrell", "Pharrell feat. Daft Punk" or with accents / punctuation marks
// Daft Punk as played.
func TestPlayedArtistNamesNormalised(t *testing.T) {
	cases := map[string][]string{
		"Daft Punk feat. Pharrell Williams": {"daft punk", "pharrell williams"},
		"Daft Punk & Pharrell Williams":     {"daft punk", "pharrell williams"},
		"Pharrell Williams ft Daft Punk":    {"pharrell williams", "daft punk"},
		"  DAFT PUNK  ":                     {"daft punk"},
		"Beyoncé":                           {"beyonce"},
		"Simon & Garfunkel":                 {"simon and garfunkel", "simon", "garfunkel"},
		"":                                  nil,
	}
	for raw, want := range cases {
		got := playedArtistNames(raw)
		have := map[string]bool{}
		for _, n := range got {
			have[n] = true
		}
		for _, w := range want {
			if !have[w] {
				t.Fatalf("%q: names %v, want %q among them", raw, got, w)
			}
		}
		if want == nil && len(got) != 0 {
			t.Fatalf("%q: names %v, want none", raw, got)
		}
	}
	p := playedArtists{names: map[string]bool{}, ids: map[string]bool{}}
	for _, n := range playedArtistNames("Daft Punk feat. Pharrell Williams") {
		p.names[n] = true
	}
	if !p.has(map[string]interface{}{"id": "la-x", "name": "Daft Punk"}) || !p.has(map[string]interface{}{"id": "la-y", "name": "Pharrell Williams"}) {
		t.Fatalf("a featured credit must mark both artists as played")
	}
	if p.has(map[string]interface{}{"id": "la-z", "name": "Daft"}) || p.has(map[string]interface{}{"id": "la-w", "name": ""}) {
		t.Fatalf("a prefix or an empty name must not match")
	}
}

func TestArtistOfDayExcludesFeaturedCredits(t *testing.T) {
	stub := newArtistDayStub(t, 40)
	db.DB.Create(&db.Profile{ID: "p-test", Name: "Camille", CreatedAt: time.Now()})
	// Every eligible artist is played except "Artist 07", each through a
	// credit the raw comparison used to miss.
	i := 0
	for _, a := range stub.artists {
		name := mstr(a, "name")
		if mint(a, "albumCount") < artistDayMinAlbums || name == "Artist 07" {
			continue
		}
		var credit string
		switch i % 4 {
		case 0:
			credit = name + " feat. Guest Star"
		case 1:
			credit = "Guest Star feat. " + name
		case 2:
			credit = strings.ToUpper(name) + " & Guest Star"
		default:
			credit = "Guest Star; " + name
		}
		i++
		db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "v" + name, Title: "t", Artist: credit, Source: "local", PlayedAt: time.Now()})
	}
	want := artistID("Artist 07")
	resp := getJSON(t, LocalArtistOfDayHandler, "/api/v1/local/artist-of-the-day")
	if artistDayID(resp) != want || resp["scope"] != "profile" || resp["reason"] != "du jour" {
		t.Fatalf("picked %s (%v), want the only never-played artist", nameOf(stub, artistDayID(resp)), resp["reason"])
	}
}
