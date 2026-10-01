package api

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// fakeAlbums is a stable album list: every third album has fewer than
// albumDayMinTracks tracks, one has no trackCount at all.
func fakeAlbums(n int) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		d := map[string]interface{}{"id": fmt.Sprintf("lb-%011x", i+1), "album": fmt.Sprintf("Album %d", i), "albumArtist": "A", "year": "1997"}
		switch {
		case i == 5:
			// no trackCount: skipped
		case i%3 == 0:
			d["trackCount"] = float64(3)
		default:
			d["trackCount"] = float64(4 + i%7)
		}
		out = append(out, d)
	}
	return out
}

func fetchFrom(all []map[string]interface{}, calls *int) func(off, lim int) []map[string]interface{} {
	return func(off, lim int) []map[string]interface{} {
		if calls != nil {
			*calls++
		}
		if off >= len(all) {
			return nil
		}
		end := off + lim
		if end > len(all) {
			end = len(all)
		}
		return all[off:end]
	}
}

func TestAlbumOfDayDeterministicAndSeeded(t *testing.T) {
	all := fakeAlbums(500)
	f := fetchFrom(all, nil)
	a := pickAlbumOfDay("2026-10-01", len(all), f, "")
	b := pickAlbumOfDay("2026-10-01", len(all), f, "")
	if a == nil || mstr(a, "id") != mstr(b, "id") {
		t.Fatalf("same day, different albums: %v / %v", a, b)
	}
	// Over a month: each day eligible, consecutive days differ (chained
	// previous-day skip, as the handler resolves it), and the seed spreads
	// the picks.
	distinct := map[string]bool{}
	day := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	prevShown := ""
	for i := 0; i < 30; i++ {
		got := albumOfDayChained(day.AddDate(0, 0, i), len(all), f)
		date := day.AddDate(0, 0, i).Format("2006-01-02")
		if got == nil || !albumDayEligible(got) || mint(got, "trackCount") < albumDayMinTracks {
			t.Fatalf("%s: ineligible pick %v", date, got)
		}
		if mstr(got, "id") == prevShown {
			t.Fatalf("%s: same album as the day before (%s)", date, prevShown)
		}
		distinct[mstr(got, "id")] = true
		prevShown = mstr(got, "id")
	}
	if len(distinct) < 25 {
		t.Fatalf("seed barely spreads: %d distinct albums over 30 days", len(distinct))
	}
}

func TestAlbumOfDaySkipsSmallAlbums(t *testing.T) {
	// Only album 7 qualifies: whatever the seed, the scan lands on it.
	all := fakeAlbums(10)
	for i, d := range all {
		if i != 7 {
			d["trackCount"] = float64(3)
		}
	}
	for _, date := range []string{"2026-01-01", "2026-06-15", "2027-03-09"} {
		got := pickAlbumOfDay(date, len(all), fetchFrom(all, nil), "")
		if mstr(got, "id") != mstr(all[7], "id") {
			t.Fatalf("%s: picked %v, want the only album with >= 4 tracks", date, got)
		}
	}
	// Nothing qualifies: nil, and the scan is bounded.
	for _, d := range all {
		d["trackCount"] = float64(2)
	}
	if got := pickAlbumOfDay("2026-01-01", len(all), fetchFrom(all, nil), ""); got != nil {
		t.Fatalf("expected no pick, got %v", got)
	}
	big := fakeAlbums(5000)
	for _, d := range big {
		d["trackCount"] = float64(1)
	}
	calls := 0
	if got := pickAlbumOfDay("2026-01-01", len(big), fetchFrom(big, &calls), ""); got != nil || calls > albumDayMaxScan/albumDayWindow+1 {
		t.Fatalf("unbounded scan: pick %v after %d fetches", got, calls)
	}
}

func TestLocalAlbumOfDayHandler(t *testing.T) {
	stub := newMixStub(t)
	resetAlbumDayMemo()
	t.Cleanup(resetAlbumDayMemo)
	// The mixStub album docs carry no trackCount: give them one (the 1980s
	// albums have 10 tracks, the rest 3 or fewer).
	for _, a := range stub.albums {
		switch {
		case len(mstr(a, "album")) > 8 && mstr(a, "album")[:8] == "Eighties":
			a["trackCount"] = float64(10)
		default:
			a["trackCount"] = float64(3)
		}
	}
	albumDayNow = func() time.Time { return time.Date(2026, 10, 1, 22, 30, 0, 0, time.UTC) }
	t.Cleanup(func() { albumDayNow = time.Now })
	a := getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day")
	b := getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day")
	album, _ := a["album"].(map[string]interface{})
	if album == nil || a["reason"] != "du jour" || a["date"] != "2026-10-01" || a["expires"] != "2026-10-02T00:00:00Z" {
		t.Fatalf("answer = %v", a)
	}
	if b["album"].(map[string]interface{})["browseId"] != album["browseId"] {
		t.Fatalf("same day, different albums")
	}
	title, _ := album["title"].(string)
	if len(title) < 8 || title[:8] != "Eighties" {
		t.Fatalf("picked an album with < 4 tracks: %v", title)
	}
	tracks, _ := a["tracks"].([]interface{})
	if len(tracks) != 10 || a["year"] == "" || a["trackCount"] != 10.0 {
		t.Fatalf("tracks %d year %v trackCount %v", len(tracks), a["year"], a["trackCount"])
	}
	// The next day (explicit date) differs from today's album, with a
	// library big enough for the seed to matter (40 more 8-track albums).
	for i := 0; i < 40; i++ {
		stub.albums = append(stub.albums, map[string]interface{}{"id": fmt.Sprintf("lb-%011x", 0xabc000+i), "album": fmt.Sprintf("Extra %d", i), "albumArtist": "X", "year": "2004", "trackCount": float64(8)})
	}
	resetAlbumDayMemo()
	today := getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day")["album"].(map[string]interface{})["browseId"]
	again := getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day?date=2026-10-01")["album"].(map[string]interface{})["browseId"]
	if today != again {
		t.Fatalf("?date=<today> differs from today: %v / %v", today, again)
	}
	for _, d := range []string{"2026-10-02", "2026-10-03", "2026-12-25"} {
		next := getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day?date="+d)
		prevDay, _ := time.Parse("2006-01-02", d)
		prev := getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day?date="+prevDay.AddDate(0, 0, -1).Format("2006-01-02"))
		if next["album"].(map[string]interface{})["browseId"] == prev["album"].(map[string]interface{})["browseId"] || next["date"] != d {
			t.Fatalf("%s kept the album of the day before: %v", d, next["album"])
		}
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/local/album-of-day?date=01/10/2026", "", nil)
	if err := LocalAlbumOfDayHandler(c); err != nil || rec.Code != http.StatusBadRequest {
		t.Fatalf("bad date: %v %d", err, rec.Code)
	}
}

// L12-7: the pick of a date is persisted, so a restart (memo dropped) or a
// library change (index order moved) keeps the same album for that date.
func TestAlbumOfDayPersistedAcrossRestarts(t *testing.T) {
	stub := newMixStub(t)
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.Setting{}); err != nil {
		t.Fatal(err)
	}
	resetAlbumDayMemo()
	t.Cleanup(resetAlbumDayMemo)
	for i, a := range stub.albums {
		a["trackCount"] = float64(5 + i%3)
	}
	albumDayNow = func() time.Time { return time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { albumDayNow = time.Now })
	id := func(m map[string]interface{}) interface{} {
		a, _ := m["album"].(map[string]interface{})
		return a["browseId"]
	}
	first := id(getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day"))
	if first == nil {
		t.Fatal("no album")
	}
	var row db.Setting
	if err := db.DB.First(&row, "key = ?", "album-of-day:2026-10-01").Error; err != nil || row.Value == "" {
		t.Fatalf("pick not persisted: %v", err)
	}
	// "Restart" + an acquisition wave that shifts every offset.
	resetAlbumDayMemo()
	for i := 0; i < 60; i++ {
		stub.albums = append([]map[string]interface{}{{"id": fmt.Sprintf("lb-%011x", 0xdd0000+i), "album": fmt.Sprintf("AAA %02d", i), "albumArtist": "Z", "year": "2020", "trackCount": float64(9)}}, stub.albums...)
	}
	if again := id(getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day")); again != first {
		t.Fatalf("album of the day moved after a restart: %v -> %v", first, again)
	}
	// The next day skips the persisted album of today.
	if next := id(getJSON(t, LocalAlbumOfDayHandler, "/api/v1/local/album-of-day?date=2026-10-02")); next == first || next == nil {
		t.Fatalf("next day repeats today: %v", next)
	}
	// ?date= bounds: +/- 366 days.
	for _, q := range []string{"0001-01-01", "9999-12-31", "2027-10-03", "2025-09-29"} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/album-of-day?date="+q, "", nil)
		if err := LocalAlbumOfDayHandler(c); err != nil || rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d", q, rec.Code)
		}
	}
	for _, q := range []string{"2027-10-01", "2025-09-30"} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/album-of-day?date="+q, "", nil)
		if err := LocalAlbumOfDayHandler(c); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", q, rec.Code)
		}
	}
}

func TestAlbumOfDayMemoLRU(t *testing.T) {
	resetAlbumDayMemo()
	t.Cleanup(resetAlbumDayMemo)
	albumDayMemoPut("today", map[string]interface{}{"d": "today"})
	for i := 0; i < albumDayMemoMax+4; i++ {
		albumDayMemoPut(fmt.Sprintf("2026-01-%02d", i+1), map[string]interface{}{})
		// today keeps being read: it is never the least recently used
		if _, ok := albumDayMemoGet("today"); !ok {
			t.Fatalf("today evicted after %d other dates", i+1)
		}
	}
	if len(albumDayMemo) != albumDayMemoMax || len(albumDayOrder) != albumDayMemoMax {
		t.Fatalf("memo size %d / %d, want %d", len(albumDayMemo), len(albumDayOrder), albumDayMemoMax)
	}
	if _, ok := albumDayMemoGet("2026-01-01"); ok {
		t.Fatal("the oldest date should have been evicted")
	}
}

func TestAlbumOfDayFailedWindowNotKept(t *testing.T) {
	all := fakeAlbums(200)
	calls := 0
	failing := func(off, lim int) []map[string]interface{} {
		calls++
		if calls == 1 {
			return nil // Meili timed out on the first window
		}
		return fetchFrom(all, nil)(off, lim)
	}
	if doc, ok := pickAlbumOfDayOK("2026-10-01", len(all), failing, ""); ok || doc == nil {
		t.Fatalf("a failed window must flag the (slid) pick: ok=%v doc=%v", ok, doc)
	}
	if _, ok := pickAlbumOfDayOK("2026-10-01", len(all), fetchFrom(all, nil), ""); !ok {
		t.Fatal("healthy fetch flagged as failed")
	}
	// The stored chain day is used as the previous-day skip.
	day := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	free := pickAlbumOfDay("2026-10-05", len(all), fetchFrom(all, nil), "")
	got, _ := albumOfDayResolve(day, len(all), fetchFrom(all, nil), func(d string) string {
		if d == "2026-10-04" {
			return mstr(free, "id")
		}
		return ""
	})
	if mstr(got, "id") == mstr(free, "id") {
		t.Fatalf("persisted previous day not skipped: %v", got)
	}
}
