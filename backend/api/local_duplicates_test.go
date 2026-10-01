package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// dupStub is a Meilisearch double for local/duplicates: it pages the albums
// index (POST /indexes/albums/search, offset/limit) and answers the quality
// multi-search from the album title in each filter.
type dupStub struct {
	mu       sync.Mutex
	albums   []map[string]interface{}
	quality  map[string]int // album title -> best qualityScore
	scans    int
	multi    int
	multiLen int
}

func (s *dupStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		defer s.mu.Unlock()
		switch r.URL.Path {
		case "/indexes/albums/search":
			s.scans++
			off, lim := stubInt(body["offset"]), stubInt(body["limit"])
			hits := []map[string]interface{}{}
			for i := off; i < len(s.albums) && i < off+lim; i++ {
				hits = append(hits, s.albums[i])
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(s.albums)})
		case "/multi-search":
			s.multi++
			qs, _ := body["queries"].([]interface{})
			s.multiLen += len(qs)
			results := []map[string]interface{}{}
			for _, q := range qs {
				f := mstr(q.(map[string]interface{}), "filter")
				title := strings.SplitN(strings.TrimPrefix(f, "album = \""), "\" AND", 2)[0]
				hits := []map[string]interface{}{}
				if v, ok := s.quality[title]; ok {
					hits = append(hits, map[string]interface{}{"qualityScore": float64(v)})
				}
				results = append(results, map[string]interface{}{"hits": hits})
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"results": results})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func dupDoc(id, artist, album string, tracks int, year, source string, added int) map[string]interface{} {
	return map[string]interface{}{
		"id": id, "albumArtist": artist, "album": album, "trackCount": float64(tracks),
		"year": year, "source": source, "dateAdded": float64(added),
	}
}

func startDupStub(t *testing.T, s *dupStub) {
	t.Helper()
	srv := httptest.NewServer(s.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	t.Setenv("MEILI_KEY", "")
	resetDuplicateMemo()
	t.Cleanup(resetDuplicateMemo)
}

type dupResp struct {
	Groups []dupGroup `json:"groups"`
	Total  int        `json:"total"`
}

func getDuplicates(t *testing.T, query string) (dupResp, string) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/duplicates"+query, nil)
	rec := httptest.NewRecorder()
	if err := LocalDuplicatesHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var out dupResp
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out, rec.Body.String()
}

func TestDupNormKeys(t *testing.T) {
	same := [][2]string{
		{"Meteora", "Meteora (Bonus Edition)"},
		{"Willy and the Poor Boys", "Willy & The Poor Boys"},
		{"Discovery", "Discovery (Deluxe) [Remastered]"},
		{"Get Lucky", "Get Lucky (feat. Pharrell Williams & Nile Rodgers)"},
		{"Café", "CAFE"},
	}
	for _, p := range same {
		if dupNorm(p[0]) != dupNorm(p[1]) {
			t.Errorf("%q / %q should share a key: %q vs %q", p[0], p[1], dupNorm(p[0]), dupNorm(p[1]))
		}
	}
	diff := [][2]string{
		{"2U (feat. Justin Bieber) (Afrojack Remix)", "2U (feat. Justin Bieber) (R3hab Remix)"},
		{"Alive 1997", "Alive 2007"},
		{"Unplugged", "Unplugged (Live)"},
		// L12-4: editions with other content are other albums / tracks.
		{"Album", "Album (Drumless Edition)"},
		{"Album", "Album (Live Edition)"},
		{"Album", "Album (Acoustic Edition)"},
		{"Album", "Album (Instrumental)"},
		{"Album", "Album (Remix Edition)"},
		{"Album", "Album (Demo Edition)"},
		{"Song", "Song (Radio Edit)"},
		{"Song (Radio Edit)", "Song (Extended Edit)"},
	}
	for _, p := range diff {
		if dupNorm(p[0]) == dupNorm(p[1]) {
			t.Errorf("%q / %q must stay apart (%q)", p[0], p[1], dupNorm(p[0]))
		}
	}
	if dupAlbumKey("Gorillaz feat. Tony Allen", "Song Machine") != dupAlbumKey("Gorillaz", "Song Machine") {
		t.Error("a featuring album artist should share the main artist key")
	}
	if dupAlbumKey("", "X") != "" || dupAlbumKey("A", "(Deluxe)") != "" {
		t.Error("an empty side gives no key")
	}
}

func TestLocalDuplicatesGroupsAndSuggestion(t *testing.T) {
	s := &dupStub{
		albums: []map[string]interface{}{
			dupDoc("lb-000000000001", "Linkin Park", "Meteora (Bonus Edition)", 2, "2003", "ytm", 50),
			dupDoc("lb-000000000002", "Linkin Park", "Meteora", 13, "2003", "lidarr", 40),
			dupDoc("lb-000000000003", "Daft Punk", "Discovery", 14, "2001", "soulseek", 30),
			dupDoc("lb-000000000004", "Daft Punk", "Discovery (Remastered)", 14, "2001", "lidarr", 20),
			dupDoc("lb-000000000005", "Daft Punk", "Homework", 16, "1997", "lidarr", 10),
			dupDoc("lb-000000000006", "Daft Punk", "Discovery [Deluxe]", 14, "2021", "soulseek", 5),
			dupDoc("lb-000000000007", "CCR", "Willy and the Poor Boys", 13, "2008", "lidarr", 4),
			dupDoc("lb-000000000008", "CCR", "Willy & The Poor Boys", 12, "1969", "soulseek", 3),
		},
		// Discovery: same track count; the lidarr copy is lossless.
		quality: map[string]int{"Discovery": 300, "Discovery (Remastered)": 910, "Discovery [Deluxe]": 300},
	}
	startDupStub(t, s)
	out, raw := getDuplicates(t, "?limit=50")
	if out.Total != 3 || len(out.Groups) != 3 {
		t.Fatalf("want 3 groups, got %d/%d: %s", out.Total, len(out.Groups), raw)
	}
	byArtist := map[string]dupGroup{}
	for _, g := range out.Groups {
		byArtist[g.Albums[0].Artist] = g
		if g.Suggested != g.Albums[0].ID {
			t.Errorf("%s: suggested %s is not albums[0] %s", g.Key, g.Suggested, g.Albums[0].ID)
		}
		if !strings.HasPrefix(g.Key, "dk-") || len(g.Key) != 15 {
			t.Errorf("bad key %q", g.Key)
		}
	}
	// Largest group first.
	if len(out.Groups[0].Albums) != 3 {
		t.Fatalf("first group should be the 3 Discovery copies: %+v", out.Groups[0])
	}
	if g := byArtist["Daft Punk"]; g.Suggested != "lb-000000000004" || g.Albums[0].BitrateHint != "lossless" {
		t.Errorf("Discovery: the lossless copy should win: %+v", g)
	}
	if g := byArtist["Linkin Park"]; g.Suggested != "lb-000000000002" {
		t.Errorf("Meteora: the 13-track copy should win: %+v", g)
	}
	if g := byArtist["CCR"]; g.Suggested != "lb-000000000007" {
		t.Errorf("Willy: more tracks wins: %+v", g)
	}
	// Only the grouped copies are looked up for quality, in one multi-search.
	if s.multi != 1 || s.multiLen != 7 {
		t.Errorf("quality lookups: %d calls / %d queries, want 1 / 7", s.multi, s.multiLen)
	}
	if !strings.Contains(raw, `"truncated":false`) {
		t.Errorf("a full scan is not truncated: %s", raw)
	}
	// Memoised: a second call does not scan again.
	scans := s.scans
	getDuplicates(t, "")
	if s.scans != scans {
		t.Errorf("second call rescanned (%d -> %d)", scans, s.scans)
	}
	// sameTracks=1 drops Meteora (13 vs 2), keeps Willy (13 vs 12).
	st, _ := getDuplicates(t, "?sameTracks=1")
	if st.Total != 2 {
		t.Errorf("sameTracks: want 2 groups, got %+v", st)
	}
	// Paging.
	p, _ := getDuplicates(t, "?limit=1&offset=2")
	if p.Total != 3 || len(p.Groups) != 1 {
		t.Errorf("paging: %+v", p)
	}
}

// L12-4: a derived edition never joins the plain album's group, and at equal
// track count and quality the copy without a packaging qualifier is the one
// suggested (not the newest reissue).
func TestDuplicatesContentEditionsAndUnqualifiedSuggested(t *testing.T) {
	docs := []map[string]interface{}{
		dupDoc("lb-000000000011", "Band", "Album (Deluxe Edition)", 10, "2022", "soulseek", 9),
		dupDoc("lb-000000000012", "Band", "Album", 10, "2015", "lidarr", 8),
		dupDoc("lb-000000000013", "Band", "Album (Drumless Edition)", 10, "2023", "soulseek", 7),
		dupDoc("lb-000000000014", "Band", "Album (Live Edition)", 10, "2024", "soulseek", 6),
		dupDoc("lb-000000000015", "Band", "Album (Drumless Edition) [Remastered]", 10, "2024", "lidarr", 5),
	}
	groups := groupDuplicateAlbums(docs, nil)
	if len(groups) != 2 {
		t.Fatalf("want 2 groups (plain + drumless), got %+v", groups)
	}
	ids := func(g dupGroup) []string {
		out := []string{}
		for _, a := range g.Albums {
			out = append(out, a.ID)
		}
		return out
	}
	var plain, drumless dupGroup
	for _, g := range groups {
		switch len(g.Albums) {
		case 2:
			if g.Albums[0].ID == "lb-000000000012" || g.Albums[1].ID == "lb-000000000012" {
				plain = g
			} else {
				drumless = g
			}
		}
	}
	if plain.Suggested != "lb-000000000012" {
		t.Errorf("plain group: the unqualified copy should be suggested: %v", ids(plain))
	}
	if drumless.Suggested != "lb-000000000013" {
		t.Errorf("drumless group: the copy without [Remastered] should be suggested: %v", ids(drumless))
	}
	for _, g := range groups {
		for _, a := range g.Albums {
			if a.ID == "lb-000000000014" {
				t.Errorf("the live edition has no duplicate: %v", ids(g))
			}
		}
	}
	// Quality still beats the bare title: the lossless reissue is kept.
	q := groupDuplicateAlbums(docs[:2], map[string]int{"lb-000000000011": 900, "lb-000000000012": 300})
	if len(q) != 1 || q[0].Suggested != "lb-000000000011" {
		t.Errorf("lossless deluxe should win on quality: %+v", q)
	}
	// Track side: "Song (Radio Edit)" and "Song (Instrumental)" are not "Song".
	hit := func(title string) map[string]interface{} {
		return map[string]interface{}{"title": title, "artist": "Band"}
	}
	if dupTrackKey(hit("Song")) == dupTrackKey(hit("Song (Instrumental)")) ||
		dupTrackKey(hit("Song")) == dupTrackKey(hit("Song (Radio Edit)")) {
		t.Error("track keys must keep content qualifiers apart")
	}
	if dupTrackKey(hit("Song")) != dupTrackKey(hit("Song (Remastered)")) {
		t.Error("a remastered track is the same song")
	}
}

func TestLocalDuplicatesMemoExpiresAndBoundedScan(t *testing.T) {
	var albums []map[string]interface{}
	for i := 0; i < dupScanCap+500; i++ {
		albums = append(albums, dupDoc(fmt.Sprintf("lb-%012x", i+1), "A", fmt.Sprintf("Album %d", i), 10, "2000", "lidarr", 0))
	}
	s := &dupStub{albums: albums}
	startDupStub(t, s)
	base := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	now := base
	dupMemoNow = func() time.Time { return now }
	t.Cleanup(func() { dupMemoNow = time.Now })
	out, raw := getDuplicates(t, "")
	if out.Total != 0 || !strings.Contains(raw, `"groups":[]`) {
		t.Fatalf("no duplicate: want groups [] total 0, got %s", raw)
	}
	if s.scans != dupScanCap/dupScanPage {
		t.Errorf("scan not bounded: %d pages", s.scans)
	}
	// L12-13: the albums past the cap are left out and the answer says so.
	if !strings.Contains(raw, `"truncated":true`) {
		t.Errorf("capped scan must be flagged: %s", raw)
	}
	if s.multi != 0 {
		t.Errorf("no group, no quality lookup (%d)", s.multi)
	}
	now = base.Add(dupMemoTTL - time.Second)
	getDuplicates(t, "")
	if s.scans != dupScanCap/dupScanPage {
		t.Errorf("memo not used inside the TTL")
	}
	now = base.Add(dupMemoTTL + time.Second)
	getDuplicates(t, "")
	if s.scans != 2*dupScanCap/dupScanPage {
		t.Errorf("memo not refreshed after the TTL: %d", s.scans)
	}
}

func TestLocalDuplicatesMeiliDownNotMemoised(t *testing.T) {
	s := &dupStub{}
	startDupStub(t, s)
	out, raw := getDuplicates(t, "")
	if out.Total != 0 || !strings.Contains(raw, `"groups":[]`) {
		t.Fatalf("empty: %s", raw)
	}
	s.mu.Lock()
	s.albums = []map[string]interface{}{
		dupDoc("lb-000000000001", "A", "X", 3, "2000", "lidarr", 2),
		dupDoc("lb-000000000002", "A", "X (Deluxe)", 5, "2000", "soulseek", 1),
	}
	s.mu.Unlock()
	if out, _ := getDuplicates(t, ""); out.Total != 1 || out.Groups[0].Suggested != "lb-000000000002" {
		t.Fatalf("an empty scan must not be memoised: %+v", out)
	}
}

func TestLocalDuplicatesByKey(t *testing.T) {
	s := &dupStub{albums: []map[string]interface{}{
		dupDoc("lb-000000000001", "Linkin Park", "Meteora (Bonus Edition)", 2, "2003", "ytm", 50),
		dupDoc("lb-000000000002", "Linkin Park", "Meteora", 13, "2003", "lidarr", 40),
		dupDoc("lb-000000000003", "Boston", "Don’t Look Back", 8, "1978", "lidarr", 30),
		dupDoc("lb-000000000004", "Boston", "Don't Look Back", 1, "1978", "soulseek", 20),
	}}
	startDupStub(t, s)
	all, _ := getDuplicates(t, "")
	if all.Total != 2 {
		t.Fatalf("want 2 groups: %+v", all)
	}
	key := all.Groups[1].Key
	one, raw := getDuplicates(t, "?key="+key)
	if one.Total != 1 || len(one.Groups) != 1 || one.Groups[0].Key != key || !strings.Contains(raw, `"group":{`) {
		t.Fatalf("by key: %s", raw)
	}
	if one.Groups[0].Suggested != all.Groups[1].Suggested {
		t.Errorf("by key suggests %s, list suggests %s", one.Groups[0].Suggested, all.Groups[1].Suggested)
	}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/duplicates?key=dk-000000000000", nil)
	rec := httptest.NewRecorder()
	LocalDuplicatesHandler(e.NewContext(req, rec))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"groups":[]`) || !strings.Contains(rec.Body.String(), `"total":0`) {
		t.Errorf("unknown key: %d %s", rec.Code, rec.Body.String())
	}
}

// L12-13: a panic while building one group drops that group only; a panic in
// the scan itself answers an empty, unmemoised list; the background refresh
// survives both (a bare goroutine panic would kill this test binary).
func TestLocalDuplicatesRecoversFromPanics(t *testing.T) {
	s := &dupStub{albums: []map[string]interface{}{
		dupDoc("lb-000000000001", "Linkin Park", "Meteora (Bonus Edition)", 2, "2003", "ytm", 50),
		dupDoc("lb-000000000002", "Linkin Park", "Meteora", 13, "2003", "lidarr", 40),
		dupDoc("lb-000000000003", "Boston", "Don't Look Back", 8, "1978", "lidarr", 30),
		dupDoc("lb-000000000004", "Boston", "Don't Look Back (Remastered)", 8, "1978", "soulseek", 20),
	}}
	startDupStub(t, s)
	dupBetterFn = func(a, b dupAlbum) bool {
		if a.Artist == "Boston" || b.Artist == "Boston" {
			panic("bad group")
		}
		return dupBetter(a, b)
	}
	t.Cleanup(func() { dupBetterFn = dupBetter })
	out, raw := getDuplicates(t, "")
	if out.Total != 1 || len(out.Groups) != 1 || out.Groups[0].Albums[0].Artist != "Linkin Park" {
		t.Fatalf("only the panicking group should be dropped: %s", raw)
	}
	if !strings.Contains(raw, `"truncated":false`) {
		t.Fatalf("a small library is not truncated: %s", raw)
	}
	// The scan itself panics: empty answer, nothing memoised.
	resetDuplicateMemo()
	scan := dupAlbumScanFn
	dupAlbumScanFn = func(off, lim int) ([]map[string]interface{}, int) { panic("meili exploded") }
	t.Cleanup(func() { dupAlbumScanFn = scan })
	out, raw = getDuplicates(t, "")
	if out.Total != 0 || !strings.Contains(raw, `"groups":[]`) {
		t.Fatalf("a failed scan answers empty: %s", raw)
	}
	refreshDuplicatesAsync()
	deadline := time.Now().Add(5 * time.Second)
	for dupRefreshing.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if dupRefreshing.Load() {
		t.Fatal("background refresh did not finish")
	}
	// Healthy again: the empty answer was not memoised, both groups are back.
	dupAlbumScanFn = scan
	dupBetterFn = dupBetter
	if out, raw := getDuplicates(t, ""); out.Total != 2 {
		t.Fatalf("after recovery: %s", raw)
	}
}

// L12-13: the quality lookups stop at dupQualityCap copies (largest groups
// first); the groups past it are still listed, with an unknown quality.
func TestLocalDuplicatesQualityLookupBounded(t *testing.T) {
	var albums []map[string]interface{}
	n := dupQualityCap/2 + 100
	for i := 0; i < n; i++ {
		albums = append(albums,
			dupDoc(fmt.Sprintf("lb-%012x", 2*i+1), "Artist", fmt.Sprintf("Album %d", i), 10, "2000", "lidarr", 2),
			dupDoc(fmt.Sprintf("lb-%012x", 2*i+2), "Artist", fmt.Sprintf("Album %d (Deluxe)", i), 10, "2000", "soulseek", 1),
		)
	}
	s := &dupStub{albums: albums}
	startDupStub(t, s)
	out, raw := getDuplicates(t, "?limit=1")
	if out.Total != n {
		t.Fatalf("want %d groups, got %d", n, out.Total)
	}
	if s.multiLen != dupQualityCap {
		t.Errorf("quality lookups: %d queries, want %d", s.multiLen, dupQualityCap)
	}
	if !strings.Contains(raw, `"truncated":false`) {
		t.Fatalf("%d albums fit the scan cap: %s", len(albums), raw[:200])
	}
}
