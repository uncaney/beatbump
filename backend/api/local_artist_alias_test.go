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
	getAliases(t, "")
	if s.scans != 2*aliasScanCap/aliasScanPage {
		t.Errorf("memo not refreshed after the TTL: %d", s.scans)
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
	if block["primary"] != artistID("Ed Sheeran") || len(others) != 3 || others[0]["name"] != "Ed Sheeran" || others[0]["href"] != "/artist/"+artistID("Ed Sheeran") {
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
