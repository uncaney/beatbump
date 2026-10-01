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

func TestComputeDecades(t *testing.T) {
	evs := []statEvent{
		{Ref: "l1", Source: "local"}, {Ref: "l1", Source: "local"}, // 1994
		{Ref: "l2", Source: "local"}, // 2003
		{Ref: "l3", Source: "local"}, // no year: skipped
		{Ref: "yt", Source: "youtube"},
	}
	d := computeDecades(evs, map[string]float64{"l1": 4, "l2": 2}, map[string]int{"l1": 1994, "l2": 2003})
	if d.Plays != 5 || d.LocalPlays != 4 || d.MatchedPlays != 3 {
		t.Fatalf("counts: %+v", d)
	}
	if len(d.Decades) != 2 || d.Decades[0].Decade != 1990 || d.Decades[0].Minutes != 8 || d.Decades[0].Plays != 2 || d.Decades[1].Decade != 2000 || d.Decades[1].Minutes != 2 {
		t.Fatalf("decades: %+v", d.Decades)
	}
	if e := computeDecades(nil, nil, nil); e.Decades == nil || len(e.Decades) != 0 {
		t.Fatalf("empty must be [] not null: %+v", e)
	}
}

// decadesMeiliStub answers `lid IN [...]` with a year per lid ("1994" as a
// string like the index, 2003 as a number, none for the rest).
func decadesMeiliStub(t *testing.T) *int {
	t.Helper()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		filter, _ := body["filter"].(string)
		hits := []map[string]interface{}{}
		if strings.HasPrefix(filter, "lid IN [") {
			if strings.Contains(filter, `"A"`) {
				hits = append(hits, map[string]interface{}{"lid": "A", "year": "1994"})
			}
			if strings.Contains(filter, `"C"`) {
				hits = append(hits, map[string]interface{}{"lid": "C", "year": 2003})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return &calls
}

func TestMeDecadesHandler(t *testing.T) {
	useTestDB(t)
	seedPlays(t) // local: A x3 (4:00), C (2:00), D (40 d ago); youtube: B x2
	calls := decadesMeiliStub(t)
	out := getJSON(t, MeDecadesHandler, "/api/v1/me/stats/decades?days=30")
	raw, _ := json.Marshal(out)
	decs, _ := out["decades"].([]interface{})
	if len(decs) != 2 {
		t.Fatalf("decades: %s", raw)
	}
	d0 := decs[0].(map[string]interface{})
	d1 := decs[1].(map[string]interface{})
	if d0["decade"].(float64) != 1990 || d0["minutes"].(float64) != 12 || d1["decade"].(float64) != 2000 || d1["minutes"].(float64) != 2 {
		t.Fatalf("decade rows: %s", raw)
	}
	if out["plays"].(float64) != 6 || out["localPlays"].(float64) != 4 || out["matchedPlays"].(float64) != 4 {
		t.Fatalf("counts: %s", raw)
	}
	if *calls != 1 {
		t.Fatalf("meili calls %d, want 1 chunk", *calls)
	}
	// default window = 365 days: D (40 days ago, no year) counts as a local play.
	out = getJSON(t, MeDecadesHandler, "/api/v1/me/stats/decades")
	if out["days"].(float64) != 365 || out["localPlays"].(float64) != 5 {
		t.Fatalf("default window: %v", out)
	}
}

func TestLocalTrackYearsChunks(t *testing.T) {
	calls := decadesMeiliStub(t)
	lids := make([]string, 0, decadeLookupChunk+5)
	for i := 0; i < decadeLookupChunk+4; i++ {
		lids = append(lids, "x"+strings.Repeat("y", i%3)+string(rune('a'+i%26)))
	}
	lids = append(lids, "A")
	years := localTrackYears(lids)
	if *calls != 2 || years["A"] != 1994 {
		t.Fatalf("calls=%d years=%v", *calls, years)
	}
	t.Setenv("MEILI_URL", "")
	if y := localTrackYears([]string{"A"}); len(y) != 0 {
		t.Fatalf("no meili: %v", y)
	}
}

// yearRow builds a per-ref row with a stored item.
func yearRow(ref, artist, album, albumID, length string) playRow {
	item := map[string]interface{}{"videoId": ref, "title": "T" + ref, "length": length,
		"artistInfo": map[string]interface{}{"artist": []interface{}{map[string]interface{}{"text": artist, "browseId": "la-" + artist}}}}
	if album != "" {
		item["album"] = map[string]interface{}{"text": album, "browseId": albumID}
	}
	raw, _ := json.Marshal(item)
	return playRow{Ref: ref, Title: "T" + ref, Artist: artist, Data: string(raw)}
}

func TestComputeYear(t *testing.T) {
	rows := []playRow{
		yearRow("a", "Daft Punk", "Discovery", "lb-disc", "4:00"),
		yearRow("b", "Air", "Moon Safari", "lb-moon", "5:00"),
		yearRow("c", "Justice", "Cross", "lb-cross", "3:00"),
	}
	at := func(y int, m time.Month, d, h int) time.Time { return time.Date(y, m, d, h, 0, 0, 0, time.UTC) }
	evs := []statEvent{
		ev("b", at(2025, 6, 1, 12)), // Air first heard in 2025: not new in 2026
		ev("a", at(2026, 1, 10, 12)),
		ev("a", at(2026, 1, 11, 12)),
		ev("b", at(2026, 3, 1, 12)),
		ev("a", at(2026, 3, 2, 12)),
		ev("c", at(2026, 12, 31, 23)), // UTC: December; UTC+2: 1 Jan 2027
	}
	y := computeYear(evs, rows, 2026, fixedTZ(0))
	if y.Plays != 5 || y.Minutes != 20 || y.DistinctAlbums != 3 || y.DistinctArtists != 3 {
		t.Fatalf("totals: plays=%d minutes=%v albums=%d artists=%d", y.Plays, y.Minutes, y.DistinctAlbums, y.DistinctArtists)
	}
	if y.Months[0] != 8 || y.Months[2] != 9 || y.Months[11] != 3 || y.Months[5] != 0 {
		t.Fatalf("months: %v", y.Months)
	}
	if y.TopArtist == nil || y.TopArtist.Title != "Daft Punk" || y.TopArtist.Count != 3 {
		t.Fatalf("top artist: %+v", y.TopArtist)
	}
	if y.TopAlbum == nil || y.TopAlbum.Title != "Discovery" || y.TopAlbum.AlbumID != "lb-disc" {
		t.Fatalf("top album: %+v", y.TopAlbum)
	}
	if y.NewArtists != 2 || len(y.NewArtistNames) != 2 || y.NewArtistNames[0] != "Daft Punk" {
		t.Fatalf("new artists: %d %v", y.NewArtists, y.NewArtistNames)
	}
	// UTC+2: the 31 Dec 23:00 UTC play moves to 2027.
	y2 := computeYear(evs, rows, 2026, fixedTZ(120))
	if y2.Plays != 4 || y2.Months[11] != 0 || y2.NewArtists != 1 {
		t.Fatalf("tz edge: plays=%d dec=%v new=%d", y2.Plays, y2.Months[11], y2.NewArtists)
	}
	if e := computeYear(evs, rows, 2024, fixedTZ(0)); e.Plays != 0 || e.TopArtist != nil || e.TopAlbum != nil || e.NewArtistNames == nil {
		t.Fatalf("empty year: %+v", e)
	}
}

func TestMeYearHandler(t *testing.T) {
	useTestDB(t)
	seedPlays(t)
	year := time.Now().UTC().Year()
	out := getJSON(t, MeYearHandler, "/api/v1/me/stats/year?tz=0")
	if int(out["year"].(float64)) != year {
		t.Fatalf("default year: %v", out["year"])
	}
	months, _ := out["months"].([]interface{})
	if len(months) != 12 {
		t.Fatalf("months: %v", out["months"])
	}
	ta, _ := out["topArtist"].(map[string]interface{})
	if ta == nil || ta["title"] != "Artist One" {
		raw, _ := json.Marshal(out)
		t.Fatalf("top artist: %s", raw)
	}
	for _, bad := range []string{"1999", "abc", "9999"} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/year?year="+bad, "", nil)
		if err := MeYearHandler(c); err != nil || rec.Code != http.StatusBadRequest {
			t.Fatalf("year=%s: code %d", bad, rec.Code)
		}
	}
	var n int64
	db.DB.Model(&db.PlayEvent{}).Where("profile_id = ?", "p-other").Count(&n)
	if n != 1 {
		t.Fatalf("seed: %d", n)
	}
}
