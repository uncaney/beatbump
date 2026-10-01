package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"

	"github.com/glebarez/sqlite"
	"github.com/labstack/echo/v4"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// useTestDB swaps db.DB for a fresh in-memory sqlite for the test.
func useTestDB(t *testing.T) {
	t.Helper()
	prev := db.DB
	d, err := gorm.Open(sqlite.Open("file:"+strings.ReplaceAll(t.Name(), "/", "_")+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, _ := d.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := d.AutoMigrate(&db.Profile{}, &db.PlayEvent{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = d
	t.Cleanup(func() { db.DB = prev; _ = sqlDB.Close() })
}

func ctxFor(method, target string, body string, hdr map[string]string) (echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	req.AddCookie(&http.Cookie{Name: "bbp", Value: "p-test"})
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	return e.NewContext(req, rec), rec
}

const songBody = `{"videoId":"0123456789a","title":"Song A","length":"4:00","album":{"text":"Album X","browseId":"lb-x"},"artistInfo":{"artist":[{"text":"Artist One","browseId":"la-one"}]}}`

func countEvents(t *testing.T) int64 {
	t.Helper()
	var n int64
	db.DB.Model(&db.PlayEvent{}).Count(&n)
	return n
}

func TestRecordPlayIgnoresHarness(t *testing.T) {
	useTestDB(t)
	for _, hdr := range []map[string]string{
		{"X-Ytm-Harness": "1"},
		{"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0 Safari/537.36"},
	} {
		c, rec := ctxFor(http.MethodPost, "/api/v1/me/history", songBody, hdr)
		if err := MeRecordPlayHandler(c); err != nil {
			t.Fatalf("handler: %v", err)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d, want 200", rec.Code)
		}
		var body map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["ignored"] != true {
			t.Fatalf("body %s, want ignored:true", rec.Body.String())
		}
	}
	if n := countEvents(t); n != 0 {
		t.Fatalf("harness plays recorded: %d", n)
	}
}

func TestRecordPlayIncludesHarnessWithEnv(t *testing.T) {
	useTestDB(t)
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "1")
	c, rec := ctxFor(http.MethodPost, "/api/v1/me/history", songBody, map[string]string{"X-Ytm-Harness": "1", "User-Agent": "HeadlessChrome/1"})
	if err := MeRecordPlayHandler(c); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "ignored") {
		t.Fatalf("status %d body %s, want recorded", rec.Code, rec.Body.String())
	}
	if n := countEvents(t); n != 1 {
		t.Fatalf("events %d, want 1", n)
	}
}

func TestRecordPlayNormalWritesAlbum(t *testing.T) {
	useTestDB(t)
	c, rec := ctxFor(http.MethodPost, "/api/v1/me/history", songBody, map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"})
	if err := MeRecordPlayHandler(c); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var ev db.PlayEvent
	if err := db.DB.First(&ev).Error; err != nil {
		t.Fatalf("no event: %v", err)
	}
	if ev.ProfileID != "p-test" || ev.Ref != "0123456789a" || ev.Album != "Album X" || ev.ArtistID != "la-one" || ev.Source != "local" {
		t.Fatalf("event %+v", ev)
	}
}

// seedPlays writes a small history: Song A x3 (Album X, Artist One, 4:00),
// Song B x2 (Album X, Artist One, no length), Song C x1 (Album Y, Artist Two,
// 2:00), plus an old Song D play 40 days ago (outside the 30-day window).
func seedPlays(t *testing.T) {
	t.Helper()
	now := time.Now()
	mk := func(ref, title, artist, album, length string, at time.Time, src string) db.PlayEvent {
		item := map[string]interface{}{"videoId": ref, "title": title,
			"artistInfo": map[string]interface{}{"artist": []interface{}{map[string]interface{}{"text": artist, "browseId": "id-" + artist}}}}
		if album != "" {
			item["album"] = map[string]interface{}{"text": album}
		}
		if length != "" {
			item["length"] = length
		}
		raw, _ := json.Marshal(item)
		return db.PlayEvent{ProfileID: "p-test", Ref: ref, Title: title, Artist: artist, Source: src, Data: string(raw), PlayedAt: at}
	}
	evs := []db.PlayEvent{
		mk("A", "Song A", "Artist One", "Album X", "4:00", now.Add(-1*time.Hour), "local"),
		mk("A", "Song A", "Artist One", "Album X", "4:00", now.Add(-2*time.Hour), "local"),
		mk("A", "Song A", "Artist One", "Album X", "4:00", now.Add(-26*time.Hour), "local"),
		mk("B", "Song B", "Artist One", "Album X", "", now.Add(-3*time.Hour), "youtube"),
		mk("B", "Song B", "Artist One", "Album X", "", now.Add(-4*time.Hour), "youtube"),
		mk("C", "Song C", "Artist Two", "Album Y", "2:00", now.Add(-5*time.Hour), "local"),
		mk("D", "Song D", "Artist Old", "Album Z", "3:00", now.Add(-40*24*time.Hour), "local"),
	}
	// another profile must never leak in
	other := mk("E", "Song E", "Artist Other", "Album W", "3:00", now, "local")
	other.ProfileID = "p-other"
	evs = append(evs, other)
	if err := db.DB.Create(&evs).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func getJSON(t *testing.T, h echo.HandlerFunc, target string) map[string]interface{} {
	t.Helper()
	c, rec := ctxFor(http.MethodGet, target, "", nil)
	if err := h(c); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: status %d body %s", target, rec.Code, rec.Body.String())
	}
	var out map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s: bad json %v", target, err)
	}
	return out
}

func rowsOf(m map[string]interface{}) []map[string]interface{} {
	raw, _ := m["rows"].([]interface{})
	out := make([]map[string]interface{}, 0, len(raw))
	for _, r := range raw {
		out = append(out, r.(map[string]interface{}))
	}
	return out
}

// windowRows.data is the data of the ref's most recent play, not max(data)
// (audit v3 G10): the older JSON here sorts lexicographically AFTER the newer
// one, so max(data) would have returned the stale, length-less variant.
func TestWindowRows_LatestData(t *testing.T) {
	useTestDB(t)
	now := time.Now()
	older := db.PlayEvent{ProfileID: "p-test", Ref: "A", Title: "Song A", Source: "local", PlayedAt: now.Add(-2 * time.Hour),
		Data: `{"videoId":"A","title":"Song A"}`}
	newer := db.PlayEvent{ProfileID: "p-test", Ref: "A", Title: "Song A", Source: "local", PlayedAt: now.Add(-1 * time.Hour),
		Data: `{"album":{"text":"Album New"},"length":"4:00","title":"Song A","videoId":"A"}`}
	other := db.PlayEvent{ProfileID: "p-other", Ref: "A", Title: "Song A", Source: "local", PlayedAt: now,
		Data: `{"album":{"text":"Album Other"},"title":"Song A","videoId":"A"}`}
	if err := db.DB.Create(&[]db.PlayEvent{older, newer, other}).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}
	rows := windowRows("p-test", 30)
	if len(rows) != 1 || rows[0].Ref != "A" || rows[0].Cnt != 2 {
		t.Fatalf("expected one row for A with 2 plays, got %+v", rows)
	}
	if rows[0].Data != newer.Data {
		t.Fatalf("data must come from the most recent play, got %s", rows[0].Data)
	}
	if itemLengthSec(rows[0].Data) != 240 || itemAlbum(rows[0].Data) != "Album New" {
		t.Fatalf("latest data must carry length and album, got %s", rows[0].Data)
	}
	// the summary is therefore not "estimated" for this ref
	sum := summarize(rows, []time.Time{older.PlayedAt, newer.PlayedAt}, []string{"local", "local"}, 0)
	if sum.Estimated {
		t.Fatalf("summary must not be estimated when the latest play carries a length: %+v", sum)
	}
}

func TestTopTracksArtistsAlbums(t *testing.T) {
	useTestDB(t)
	seedPlays(t)

	tr := getJSON(t, MeTopHandler, "/api/v1/me/stats/top?days=30&by=tracks&limit=20")
	rows := rowsOf(tr)
	if len(rows) != 3 || rows[0]["key"] != "A" || rows[0]["count"] != float64(3) || rows[1]["key"] != "B" || rows[2]["key"] != "C" {
		t.Fatalf("tracks rows %v", rows)
	}
	if rows[0]["item"] == nil {
		t.Fatalf("track row must carry the stored item")
	}
	if items, _ := tr["items"].([]interface{}); len(items) != 3 {
		t.Fatalf("legacy items missing: %v", tr["items"])
	}
	if counts, _ := tr["counts"].([]interface{}); len(counts) != 3 {
		t.Fatalf("legacy counts missing: %v", tr["counts"])
	}

	ar := rowsOf(getJSON(t, MeTopHandler, "/api/v1/me/stats/top?days=30&by=artists"))
	if len(ar) != 2 || ar[0]["key"] != "Artist One" || ar[0]["count"] != float64(5) || ar[0]["artistId"] != "id-Artist One" || ar[1]["key"] != "Artist Two" {
		t.Fatalf("artists rows %v", ar)
	}

	al := rowsOf(getJSON(t, MeTopHandler, "/api/v1/me/stats/top?days=30&by=albums"))
	if len(al) != 2 || al[0]["key"] != "Album X" || al[0]["count"] != float64(5) || al[0]["artist"] != "Artist One" || al[1]["key"] != "Album Y" {
		t.Fatalf("albums rows %v", al)
	}

	// window: 365 days includes Song D; limit truncates
	all := rowsOf(getJSON(t, MeTopHandler, "/api/v1/me/stats/top?days=365&by=tracks"))
	if len(all) != 4 {
		t.Fatalf("365d rows %d, want 4", len(all))
	}
	lim := rowsOf(getJSON(t, MeTopHandler, "/api/v1/me/stats/top?days=365&by=tracks&limit=2"))
	if len(lim) != 2 {
		t.Fatalf("limit rows %d, want 2", len(lim))
	}
	// legacy call (no by/days): tracks, 30 days
	legacy := getJSON(t, MeTopHandler, "/api/v1/me/stats/top?limit=60")
	if legacy["by"] != "tracks" || legacy["days"] != float64(30) {
		t.Fatalf("legacy defaults %v", legacy)
	}
}

func TestSummary(t *testing.T) {
	useTestDB(t)
	seedPlays(t)
	s := getJSON(t, MeStatsSummaryHandler, "/api/v1/me/stats/summary?days=30")
	if s["plays"] != float64(6) || s["distinctTracks"] != float64(3) || s["distinctArtists"] != float64(2) {
		t.Fatalf("summary %v", s)
	}
	// ST1: Song A + Song B share Album X, Song C is Album Y -> 2 distinct albums.
	if s["distinctAlbums"] != float64(2) {
		t.Fatalf("distinctAlbums %v, want 2", s["distinctAlbums"])
	}
	// 3x4:00 + 2x3.5 (estimated) + 1x2:00 = 12 + 7 + 2 = 21 min
	if s["minutes"] != float64(21) || s["estimated"] != true {
		t.Fatalf("minutes %v estimated %v", s["minutes"], s["estimated"])
	}
	if s["local"] != float64(4) || s["youtube"] != float64(2) {
		t.Fatalf("sources %v/%v", s["local"], s["youtube"])
	}
	th, _ := s["topHour"].(float64)
	if th < 0 || th > 23 {
		t.Fatalf("topHour %v", s["topHour"])
	}
	hours, _ := s["hours"].([]interface{})
	if len(hours) != 24 {
		t.Fatalf("hours len %d", len(hours))
	}

	// unknown profile: empty window
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/summary?days=7&tz=120", "", nil)
	c.Request().Header.Del("Cookie")
	c.Request().AddCookie(&http.Cookie{Name: "bbp", Value: "p-nobody"})
	if err := MeStatsSummaryHandler(c); err != nil {
		t.Fatalf("handler: %v", err)
	}
	var e map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	if e["plays"] != float64(0) || e["topHour"] != float64(-1) || e["minutes"] != float64(0) || e["estimated"] != false {
		t.Fatalf("empty summary %v", e)
	}
}

func TestParseClockAndAggregateHelpers(t *testing.T) {
	for in, want := range map[string]int{"3:45": 225, "1:02:03": 3723, "": 0, "x": 0, "4": 0, "-1:00": 0} {
		if got := parseClock(in); got != want {
			t.Fatalf("parseClock(%q)=%d want %d", in, got, want)
		}
	}
	rows := []playRow{
		{Ref: "a", Title: "a", Artist: "", Cnt: 2, Data: `{"artistInfo":{"artist":[{"text":"Zed","browseId":"z"}]},"album":{"text":"Alb"}}`},
		{Ref: "b", Title: "b", Artist: "zed", Cnt: 1, Data: `{"album":{"text":"alb"}}`},
		{Ref: "c", Title: "c", Artist: "", Cnt: 5, Data: ""},
	}
	ar := aggregateBy(rows, "artists", 0)
	if len(ar) != 1 || ar[0].Count != 3 || ar[0].ArtistID != "z" {
		t.Fatalf("artists %+v", ar)
	}
	al := aggregateBy(rows, "albums", 0)
	if len(al) != 1 || al[0].Count != 3 || al[0].Title != "Alb" {
		t.Fatalf("albums %+v", al)
	}
	tr := aggregateBy(rows, "tracks", 2)
	if len(tr) != 2 || tr[0].Key != "c" || tr[1].Key != "a" {
		t.Fatalf("tracks %+v", tr)
	}
	if got := aggregateBy(nil, "albums", 5); got == nil || len(got) != 0 {
		t.Fatalf("nil rows must give empty slice, got %v", got)
	}
}
