package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// aliasStub is a Meilisearch double for the artist aliases (B8-20): it pages
// the artists index (name:asc), serves artist documents by id, answers the
// tracks searches from the albumArtist names quoted in the filter and the
// albums searches with nothing (no covers).
type aliasStub struct {
	mu          sync.Mutex
	artists     []map[string]interface{}
	tracks      []map[string]interface{}
	scans       int
	trackFilter string
}

func (s *aliasStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/indexes/artists/documents/") {
			id := strings.TrimPrefix(r.URL.Path, "/indexes/artists/documents/")
			for _, a := range s.artists {
				if mstr(a, "id") == id {
					json.NewEncoder(w).Encode(a)
					return
				}
			}
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/indexes/artists/search":
			s.scans++
			off, lim := stubInt(body["offset"]), stubInt(body["limit"])
			hits := []map[string]interface{}{}
			for i := off; i < len(s.artists) && i < off+lim; i++ {
				hits = append(hits, s.artists[i])
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(s.artists)})
		case "/indexes/tracks/search":
			f := mstr(body, "filter")
			s.trackFilter = f
			all := []map[string]interface{}{}
			for _, t := range s.tracks {
				if strings.Contains(f, "\""+escapeMeili(mstr(t, "albumArtist"))+"\"") {
					all = append(all, t)
				}
			}
			hits := all
			if lim := stubInt(body["limit"]); lim >= 0 && lim < len(hits) {
				hits = hits[:lim]
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(all)})
		case "/indexes/albums/search":
			json.NewEncoder(w).Encode(map[string]interface{}{"hits": []interface{}{}, "estimatedTotalHits": 0})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func aliasArtistDoc(name string, albums, tracks int) map[string]interface{} {
	return map[string]interface{}{"id": artistID(name), "name": name, "albumCount": float64(albums), "trackCount": float64(tracks)}
}

// aliasTrackDoc: the lids are prefixed ("a1…") so they never collide with the
// other stubs' "%011x" lids (the exclusions' trackKey memo is global, keyed
// by lid only; startAliasStub resets it as well).
func aliasTrackDoc(i int, aa string) map[string]interface{} {
	return map[string]interface{}{
		"lid": fmt.Sprintf("a1%09d", i), "title": fmt.Sprintf("T%d", i), "artist": aa,
		"albumArtist": aa, "album": "Album " + aa, "track": float64(i), "durationSec": 200.0,
	}
}

func startAliasStub(t *testing.T, s *aliasStub) {
	t.Helper()
	sort.SliceStable(s.artists, func(i, j int) bool { return mstr(s.artists[i], "name") < mstr(s.artists[j], "name") })
	srv := httptest.NewServer(s.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	t.Setenv("MEILI_KEY", "")
	resetAlbumCoverMemo()
	resetTrackKeyMemo()
	resetArtistAliasMemo()
	t.Cleanup(resetArtistAliasMemo)
	t.Cleanup(resetTrackKeyMemo)
}

// edSheeranStub is the LIBRARY-LINT shape in miniature: one artist with
// two "feat." credits and one accent credit (a pure case variant shares
// the artist id, so it cannot be a separate artist), two distinct artists,
// one punctuation pair.
func edSheeranStub() *aliasStub {
	return &aliasStub{
		artists: []map[string]interface{}{
			aliasArtistDoc("Ed Sheeran", 10, 100),
			aliasArtistDoc("Ed Sheeran feat. Khalid", 1, 1),
			aliasArtistDoc("Ed Sheeran feat. Camila Cabello & Cardi B", 1, 1),
			aliasArtistDoc("Ed Shéeran", 1, 2),
			aliasArtistDoc("Daft Punk", 5, 50),
			aliasArtistDoc("AC/DC", 3, 30),
			aliasArtistDoc("AC-DC", 1, 10),
		},
		tracks: []map[string]interface{}{
			aliasTrackDoc(1, "Ed Sheeran"), aliasTrackDoc(2, "Ed Sheeran"), aliasTrackDoc(3, "Ed Sheeran"),
			aliasTrackDoc(4, "Ed Sheeran feat. Khalid"),
			aliasTrackDoc(5, "Ed Sheeran feat. Camila Cabello & Cardi B"),
			aliasTrackDoc(6, "Daft Punk"), aliasTrackDoc(7, "Daft Punk"),
		},
	}
}

type aliasResp struct {
	Group  *aliasGroup  `json:"group"`
	Groups []aliasGroup `json:"groups"`
	Total  int          `json:"total"`
}

func getAliases(t *testing.T, query string) (int, aliasResp, string) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/artists/aliases"+query, nil)
	rec := httptest.NewRecorder()
	if err := LocalArtistAliasesHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	var out aliasResp
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("not JSON: %v (%s)", err, rec.Body.String())
	}
	return rec.Code, out, rec.Body.String()
}

func TestArtistAliasesFeatVariantsGrouped(t *testing.T) {
	startAliasStub(t, edSheeranStub())
	code, out, raw := getAliases(t, "")
	if code != 200 || out.Total != 2 || len(out.Groups) != 2 {
		t.Fatalf("want 2 groups, got %d: %s", code, raw)
	}
	g := out.Groups[0]
	if g.ID != artistID("Ed Sheeran") || g.Name != "Ed Sheeran" || g.Size != 4 || len(g.Aliases) != 3 {
		t.Fatalf("Ed Sheeran group: %+v", g)
	}
	names := []string{}
	for _, a := range g.Aliases {
		names = append(names, a.Name)
	}
	if strings.Join(names, "|") != "Ed Shéeran|Ed Sheeran feat. Khalid|Ed Sheeran feat. Camila Cabello & Cardi B" {
		t.Errorf("aliases order (albums, tracks, shortest name): %v", names)
	}
	if g2 := out.Groups[1]; g2.ID != artistID("AC/DC") || g2.Size != 2 || g2.Aliases[0].Name != "AC-DC" {
		t.Errorf("AC/DC group: %+v", g2)
	}
	if !strings.Contains(raw, `"truncated":false`) {
		t.Errorf("full scan must not be flagged: %s", raw)
	}
	// ?id= of an alias answers the whole group; an artist of no group is a 404.
	code, out, raw = getAliases(t, "?id="+artistID("Ed Sheeran feat. Khalid"))
	if code != 200 || out.Group == nil || out.Group.ID != artistID("Ed Sheeran") || out.Total != 1 {
		t.Fatalf("by alias id: %d %s", code, raw)
	}
	code, out, raw = getAliases(t, "?id="+artistID("Daft Punk"))
	if code != 404 || out.Group != nil || out.Total != 0 || !strings.Contains(raw, `"groups":[]`) {
		t.Fatalf("no group: want 404 group null groups [], got %d %s", code, raw)
	}
}

func TestArtistAliasesDistinctArtistsNotGrouped(t *testing.T) {
	startAliasStub(t, &aliasStub{artists: []map[string]interface{}{
		aliasArtistDoc("Simon", 2, 20),
		aliasArtistDoc("Simon & Garfunkel", 6, 60),
		aliasArtistDoc("Daft Punk", 5, 50),
		aliasArtistDoc("Daft Punk & Pharrell Williams", 1, 1),
		aliasArtistDoc("Earth", 1, 8),
		aliasArtistDoc("Earth, Wind & Fire", 4, 40),
		aliasArtistDoc("Blur", 7, 70),
		aliasArtistDoc("Blur 2", 1, 5),
	}})
	code, out, raw := getAliases(t, "")
	if code != 200 || out.Total != 0 || !strings.Contains(raw, `"groups":[]`) {
		t.Fatalf("collaborations and distinct names must not be grouped: %d %s", code, raw)
	}
	if names := artistAliasNames("Simon"); len(names) != 1 || names[0] != "Simon" {
		t.Errorf("Simon must stay alone: %v", names)
	}
}

func TestArtistAliasesScanBoundedAndMemoised(t *testing.T) {
	s := &aliasStub{}
	for i := 0; i < aliasScanCap+500; i++ {
		s.artists = append(s.artists, aliasArtistDoc(fmt.Sprintf("Artist %06d", i), 1, 10))
	}
	startAliasStub(t, s)
	base := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	now := base
	aliasMemoNow = func() time.Time { return now }
	t.Cleanup(func() { aliasMemoNow = time.Now })
	_, out, raw := getAliases(t, "")
	if out.Total != 0 || !strings.Contains(raw, `"groups":[]`) {
		t.Fatalf("no group: %s", raw)
	}
	if s.scans != aliasScanCap/aliasScanPage {
		t.Errorf("scan not bounded: %d pages", s.scans)
	}
	if !strings.Contains(raw, `"truncated":true`) {
		t.Errorf("capped scan must be flagged: %s", raw)
	}
	now = base.Add(aliasMemoTTL - time.Second)
	getAliases(t, "")
	if s.scans != aliasScanCap/aliasScanPage {
		t.Errorf("memo not used inside the TTL: %d", s.scans)
	}
	now = base.Add(aliasMemoTTL + time.Second)
	// B9-10: past the TTL the lint answers the stale memo at once and
	// rescans behind it.
	if _, _, raw := getAliases(t, ""); !strings.Contains(raw, `"stale":true`) {
		t.Errorf("stale memo not flagged: %s", raw)
	}
	waitAliasRefresh(t)
	if s.scans != 2*aliasScanCap/aliasScanPage {
		t.Errorf("memo not refreshed after the TTL: %d", s.scans)
	}
	if _, _, raw := getAliases(t, ""); strings.Contains(raw, `"stale"`) {
		t.Errorf("refreshed memo still flagged stale: %s", raw)
	}
}

// waitAliasRefresh waits for the background rescan started by the lint to
// finish (up to 5 s).
func waitAliasRefresh(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for aliasRefreshing.Load() {
		if time.Now().After(deadline) {
			t.Fatalf("background alias refresh still running")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// B9-10 (L14-11): during a forced rescan (the scan function blocks), the
// lint answers the previous groups in well under 100 ms instead of waiting
// on the scan, like the artist page and the collapsed list already did.
func TestArtistAliasesLintServesStaleDuringScan(t *testing.T) {
	startAliasStub(t, edSheeranStub())
	base := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	now := base
	aliasMemoNow = func() time.Time { return now }
	t.Cleanup(func() { aliasMemoNow = time.Now })
	if _, out, _ := getAliases(t, ""); out.Total != 2 {
		t.Fatalf("warm-up: %+v", out)
	}
	prev := aliasArtistScanFn
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	aliasArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		return prev(off, lim)
	}
	t.Cleanup(func() { aliasArtistScanFn = prev })
	now = base.Add(aliasMemoTTL + time.Second)
	t0 := time.Now()
	code, out, raw := getAliases(t, "?id="+artistID("Ed Sheeran feat. Khalid"))
	elapsed := time.Since(t0)
	if code != 200 || out.Group == nil || out.Group.Name != "Ed Sheeran" || !strings.Contains(raw, `"stale":true`) {
		t.Fatalf("stale answer: %d %s", code, raw)
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("lint waited on the scan: %s", elapsed)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatalf("no background rescan started")
	}
	close(release)
	waitAliasRefresh(t)
	if _, _, raw := getAliases(t, ""); strings.Contains(raw, `"stale"`) {
		t.Errorf("memo not refreshed by the background scan: %s", raw)
	}
}

func TestArtistAliasesMeiliDownNotMemoised(t *testing.T) {
	s := &aliasStub{}
	startAliasStub(t, s)
	if _, out, _ := getAliases(t, ""); out.Total != 0 {
		t.Fatalf("empty: %+v", out)
	}
	s.mu.Lock()
	s.artists = edSheeranStub().artists
	s.mu.Unlock()
	if _, out, _ := getAliases(t, ""); out.Total != 2 {
		t.Fatalf("an empty scan must not be memoised: %+v", out)
	}
}

// local/songs?artist=X&group=1 plays the union of the group's credits;
// without group=1 the plain equality filter is untouched.
func TestLocalSongsGroupUnion(t *testing.T) {
	s := edSheeranStub()
	startAliasStub(t, s)
	artistAliasGroups() // warm the memo (the handler never scans itself)
	get := func(q string) map[string]interface{} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/songs?"+q, "", nil)
		if err := LocalSongsHandler(c); err != nil {
			t.Fatal(err)
		}
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out map[string]interface{}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	plain := get("artist=Ed+Sheeran&limit=200")
	if mint(plain, "total") != 3 || s.trackFilter != `albumArtist = "Ed Sheeran"` {
		t.Fatalf("plain: total %v filter %q", plain["total"], s.trackFilter)
	}
	if _, ok := plain["group"]; ok {
		t.Errorf("plain answer must not carry group: %v", plain["group"])
	}
	union := get("artist=Ed+Sheeran&group=1&limit=200")
	if mint(union, "total") != 5 || mint(union, "group") != 4 {
		t.Fatalf("union: total %v group %v (%s)", union["total"], union["group"], s.trackFilter)
	}
	if !strings.HasPrefix(s.trackFilter, "albumArtist IN [") || !strings.Contains(s.trackFilter, `"Ed Sheeran feat. Khalid"`) || !strings.Contains(s.trackFilter, `"Ed Sheeran feat. Camila Cabello & Cardi B"`) {
		t.Errorf("union filter: %q", s.trackFilter)
	}
	// An artist of no group: the union is the artist alone.
	alone := get("artist=Daft+Punk&group=1&limit=200")
	if mint(alone, "total") != 2 || mint(alone, "group") != 1 {
		t.Errorf("Daft Punk alone: %v", alone)
	}
}

// local/artists?collapse=1 hides the alias rows, badges the primary and
// says where to continue; a filtered list (?q=) is never collapsed.
func TestLocalArtistsCollapsed(t *testing.T) {
	startAliasStub(t, edSheeranStub())
	artistAliasGroups()
	get := func(q string) map[string]interface{} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/local/artists?"+q, "", nil)
		if err := LocalArtistsHandler(c); err != nil {
			t.Fatal(err)
		}
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out map[string]interface{}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	titles := func(out map[string]interface{}) ([]string, []string) {
		items, _ := out["items"].([]interface{})
		var ts, subs []string
		for _, it := range items {
			m, _ := it.(map[string]interface{})
			ts = append(ts, mstr(m, "title"))
			runs, _ := m["subtitle"].([]interface{})
			sub := ""
			for _, r := range runs {
				rm, _ := r.(map[string]interface{})
				sub += mstr(rm, "text")
			}
			subs = append(subs, sub)
		}
		return ts, subs
	}
	// name:asc raw order: AC-DC, AC/DC, Daft Punk, Ed Sheeran, Ed Sheeran feat. C…, Ed Sheeran feat. K…, Ed Shéeran
	out := get("collapse=1&limit=3&sort=name:asc")
	ts, subs := titles(out)
	if strings.Join(ts, "|") != "AC/DC|Daft Punk|Ed Sheeran" {
		t.Fatalf("collapsed page: %v", ts)
	}
	// B9-8: the subtitle is the counts, never the name again, then the badge.
	if subs[0] != "3 albums · 30 titres · +1 variante" {
		t.Errorf("AC/DC subtitle: %q", subs[0])
	}
	if subs[1] != "5 albums · 50 titres" {
		t.Errorf("Daft Punk subtitle (no badge): %q", subs[1])
	}
	if subs[2] != "10 albums · 100 titres · +3 variantes" {
		t.Errorf("Ed Sheeran subtitle: %q", subs[2])
	}
	for i, s := range subs {
		if strings.Contains(s, ts[i]) {
			t.Errorf("subtitle repeats the name: %q", s)
		}
	}
	if mint(out, "nextOffset") != 4 || mint(out, "total") != 7 || out["collapsed"] != true {
		t.Errorf("paging: nextOffset %v total %v collapsed %v", out["nextOffset"], out["total"], out["collapsed"])
	}
	// The next page from nextOffset holds the three remaining aliases only: nothing.
	out = get("collapse=1&limit=3&sort=name:asc&offset=4")
	if ts, _ := titles(out); len(ts) != 0 || mint(out, "nextOffset") != 7 {
		t.Errorf("tail page: %v nextOffset %v", ts, out["nextOffset"])
	}
	// Filtered: every credit shows, no badge, no nextOffset.
	out = get("collapse=1&limit=3&sort=name:asc&q=ed")
	ts, subs = titles(out)
	if len(ts) != 3 || strings.Join(subs, "") != "AC-DCAC/DCDaft Punk" {
		t.Errorf("filtered list must not collapse: %v %v", ts, subs)
	}
	if _, ok := out["nextOffset"]; ok {
		t.Errorf("filtered list pages by row count: %v", out["nextOffset"])
	}
}

// The local artist page carries its group's other credits and a seeAll
// link over the union (?group=1, union total).
func TestLocalArtistPageAliasesAndGroupSeeAll(t *testing.T) {
	startAliasStub(t, edSheeranStub())
	artistAliasGroups()
	resp := buildLocalArtist(artistID("Ed Sheeran feat. Khalid"))
	block, ok := resp["aliases"].(map[string]interface{})
	if !ok {
		t.Fatalf("no aliases block: %v", resp["aliases"])
	}
	others, _ := block["others"].([]map[string]interface{})
	// U13-3: "Ed Shéeran" is a spelling of the "Ed Sheeran" chip (one chip,
	// the primary's); the group itself still counts 4 and the union plays it.
	if block["primary"] != artistID("Ed Sheeran") || len(others) != 2 || others[0]["name"] != "Ed Sheeran" || others[0]["href"] != "/artist/"+artistID("Ed Sheeran") || block["size"] != 4 {
		t.Fatalf("aliases block: %v", block)
	}
	seeAll, _ := resp["seeAll"].(map[string]interface{})
	if seeAll == nil || !strings.Contains(mstr(seeAll, "url"), "group=1") || seeAll["artistTotal"] != 5 || seeAll["ownTotal"] != 1 || seeAll["group"] != true {
		t.Fatalf("seeAll: %v", seeAll)
	}
	if resp["artistSongsTotal"] != 5 || resp["artistOwnSongsTotal"] != 1 {
		t.Errorf("totals: %v / %v", resp["artistSongsTotal"], resp["artistOwnSongsTotal"])
	}
	// An artist of no group: no block, plain seeAll.
	resp = buildLocalArtist(artistID("Daft Punk"))
	if _, ok := resp["aliases"]; ok {
		t.Errorf("Daft Punk has no aliases block: %v", resp["aliases"])
	}
	seeAll, _ = resp["seeAll"].(map[string]interface{})
	if seeAll == nil || strings.Contains(mstr(seeAll, "url"), "group=1") || seeAll["artistTotal"] != 2 {
		t.Errorf("plain seeAll: %v", seeAll)
	}
}

// U13-3: the "ft." / "feat." / "featuring" spellings of one credit make ONE
// "Aussi sous" chip; the group and the songs union keep every spelling.
func TestArtistAliasPeersDedupeFeatSpellings(t *testing.T) {
	startAliasStub(t, &aliasStub{artists: []map[string]interface{}{
		aliasArtistDoc("The Chainsmokers", 12, 120),
		aliasArtistDoc("The Chainsmokers ft. Halsey", 2, 2),
		aliasArtistDoc("The Chainsmokers feat. Halsey", 1, 1),
		aliasArtistDoc("The Chainsmokers (featuring Halsey)", 1, 1),
		aliasArtistDoc("The Chainsmokers ft. Daya", 1, 1),
		// A collaboration is its own artist (matchNorm keeps "& Coldplay"): a
		// separate group, never a chip of The Chainsmokers.
		aliasArtistDoc("The Chainsmokers & Coldplay", 1, 1),
		aliasArtistDoc("The Chainsmokers and Coldplay", 1, 1),
	}})
	artistAliasGroups()
	g, ok := artistAliasGroupOf(artistID("The Chainsmokers"))
	if !ok || g.Size != 5 || len(g.Aliases) != 4 {
		t.Fatalf("group keeps every spelling: ok=%v %+v", ok, g)
	}
	names := func(ps []aliasArtist) string {
		out := []string{}
		for _, p := range ps {
			out = append(out, p.Name)
		}
		return strings.Join(out, "|")
	}
	// The primary page: one chip per credit, the spelling with most albums first.
	if got := names(artistAliasPeers(artistID("The Chainsmokers"))); got != "The Chainsmokers ft. Halsey|The Chainsmokers ft. Daya" {
		t.Errorf("primary peers: %s", got)
	}
	// An alias page: the primary first, never a spelling of its own credit.
	if got := names(artistAliasPeers(artistID("The Chainsmokers feat. Halsey"))); got != "The Chainsmokers|The Chainsmokers ft. Daya" {
		t.Errorf("alias peers: %s", got)
	}
	// The songs union still covers every spelling.
	if n := len(artistAliasNames("The Chainsmokers")); n != 5 {
		t.Errorf("union names: want 5, got %d", n)
	}
	// The collaboration's own group: "&" and "and" are one chip.
	if got := names(artistAliasPeers(artistID("The Chainsmokers & Coldplay"))); got != "" {
		t.Errorf("'&' / 'and' spellings are one credit, no chip: %q", got)
	}
	for _, c := range []struct{ a, b string; same bool }{
		{"The Chainsmokers ft. Halsey", "The Chainsmokers feat. Halsey", true},
		{"The Chainsmokers ft. Halsey", "The Chainsmokers (featuring Halsey)", true},
		{"The Chainsmokers ft. Halsey", "The Chainsmokers ft. Daya", false},
		{"Ed Shéeran", "ed sheeran", true},
		{"Simon & Garfunkel", "Simon and Garfunkel", true},
		{"Ed Sheeran", "Ed Sheeran feat. Khalid", false},
	} {
		if (aliasDisplayKey(c.a) == aliasDisplayKey(c.b)) != c.same {
			t.Errorf("aliasDisplayKey(%q) vs (%q): same=%v, want %v", c.a, c.b, !c.same, c.same)
		}
	}
}
