package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

func useMergeDB(t *testing.T) {
	t.Helper()
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.Favorite{}, &db.Follow{}, &db.Playlist{}, &db.PlaylistItem{}, &db.AcquireJob{}, &db.NowPlaying{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "")
	resetAdoptions()
}

type loginOut struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Migrated *migratedCounts `json:"migrated"`
	raw      string
}

// login posts me/login with the given bbp cookie ("" = none) and returns the
// answer plus the cookie set in the response.
func login(t *testing.T, cookie, name string, hdr map[string]string) (loginOut, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/me/login", strings.NewReader(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 Chrome/128")
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "bbp", Value: cookie})
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	if err := MeLoginHandler(echo.New().NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	var out loginOut
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad json %v: %s", err, rec.Body.String())
	}
	out.raw = rec.Body.String()
	set := ""
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == "bbp" {
			set = ck.Value
		}
	}
	return out, set
}

// seedProfile writes plays, favourites, follows and playlists for pid.
func seedProfile(t *testing.T, pid string, plays int, favRefs, followIDs, playlistNames []string) {
	t.Helper()
	now := time.Now()
	for i := 0; i < plays; i++ {
		db.DB.Create(&db.PlayEvent{ProfileID: pid, Ref: "ref-" + pid + "-" + string(rune('a'+i)), Title: "T", Data: `{"videoId":"x"}`, PlayedAt: now.Add(-time.Duration(i) * time.Minute)})
	}
	for _, r := range favRefs {
		db.DB.Create(&db.Favorite{ProfileID: pid, Kind: "song", Ref: r, Data: `{"videoId":"` + r + `"}`, CreatedAt: now})
	}
	for _, a := range followIDs {
		db.DB.Create(&db.Follow{ProfileID: pid, ArtistID: a, Name: a, CreatedAt: now})
	}
	for _, n := range playlistNames {
		pl := db.Playlist{ProfileID: pid, Name: n, CreatedAt: now, UpdatedAt: now}
		db.DB.Create(&pl)
		db.DB.Create(&db.PlaylistItem{PlaylistID: pl.ID, Ref: "it-" + n, Data: `{}`, CreatedAt: now})
	}
}

func countWhere(t *testing.T, model interface{}, pid string) int64 {
	t.Helper()
	var n int64
	db.DB.Model(model).Where("profile_id = ?", pid).Count(&n)
	return n
}

func TestLoginMigratesAnonymousIntoNewName(t *testing.T) {
	useMergeDB(t)
	seedProfile(t, "anon-1", 12, []string{"v1", "v2", "v3"}, []string{"la-a"}, []string{"Route"})
	db.DB.Create(&db.NowPlaying{ProfileID: "anon-1", DeviceID: "d1", Payload: "{}", UpdatedAt: time.Now()})
	out, set := login(t, "anon-1", "Alice", nil)
	if out.Migrated == nil {
		t.Fatalf("migrated null: %s", out.raw)
	}
	want := migratedCounts{Plays: 12, Favorites: 3, Follows: 1, Playlists: 1}
	if *out.Migrated != want {
		t.Fatalf("migrated %+v, want %+v", *out.Migrated, want)
	}
	if set != out.ID || !strings.HasPrefix(out.ID, "u-") || out.Name != "Alice" {
		t.Fatalf("cookie %q id %q name %q", set, out.ID, out.Name)
	}
	for _, m := range []interface{}{&db.PlayEvent{}, &db.Favorite{}, &db.Follow{}, &db.Playlist{}, &db.NowPlaying{}} {
		if n := countWhere(t, m, "anon-1"); n != 0 {
			t.Fatalf("%T: %d rows left on the anonymous profile", m, n)
		}
	}
	if n := countWhere(t, &db.NowPlaying{}, out.ID); n != 1 {
		t.Fatalf("now_playing not moved: %d", n)
	}
	var items int64
	db.DB.Model(&db.PlaylistItem{}).Count(&items)
	if items != 1 {
		t.Fatalf("playlist items %d, want 1", items)
	}
	if profileAnonymous(out.ID) {
		t.Fatalf("named profile still anonymous")
	}
}

func TestLoginMergesIntoExistingName(t *testing.T) {
	useMergeDB(t)
	first, _ := login(t, "", "Bob", nil)
	named := first.ID
	if first.Migrated != nil {
		t.Fatalf("no cookie must not migrate: %s", first.raw)
	}
	seedProfile(t, named, 2, []string{"v1"}, []string{"la-a"}, []string{"Route"})
	db.DB.Create(&db.NowPlaying{ProfileID: named, DeviceID: "old", Payload: "{}", UpdatedAt: time.Now().Add(-time.Hour)})
	seedProfile(t, "anon-2", 3, []string{"v1", "v2"}, []string{"la-a", "la-b"}, []string{"Route", "Soir"})
	db.DB.Create(&db.NowPlaying{ProfileID: "anon-2", DeviceID: "new", Payload: "{}", UpdatedAt: time.Now()})

	out, _ := login(t, "anon-2", "bob", nil) // same name, other case
	if out.ID != named || out.Migrated == nil {
		t.Fatalf("id %q (want %q) %s", out.ID, named, out.raw)
	}
	want := migratedCounts{Plays: 3, Favorites: 1, Follows: 1, Playlists: 2}
	if *out.Migrated != want {
		t.Fatalf("migrated %+v, want %+v", *out.Migrated, want)
	}
	if n := countWhere(t, &db.PlayEvent{}, named); n != 5 {
		t.Fatalf("plays %d, want 5", n)
	}
	if n := countWhere(t, &db.Favorite{}, named); n != 2 {
		t.Fatalf("favorites %d, want 2 (v1 kept once)", n)
	}
	if n := countWhere(t, &db.Follow{}, named); n != 2 {
		t.Fatalf("follows %d, want 2", n)
	}
	var names []string
	db.DB.Model(&db.Playlist{}).Where("profile_id = ?", named).Order("name").Pluck("name", &names)
	if strings.Join(names, "|") != "Route|Route (appareil)|Soir" {
		t.Fatalf("playlists %v", names)
	}
	var np db.NowPlaying
	db.DB.Where("profile_id = ?", named).First(&np)
	if np.DeviceID != "new" || countWhere(t, &db.NowPlaying{}, "anon-2") != 0 {
		t.Fatalf("now_playing kept %q, want the most recent", np.DeviceID)
	}
	for _, m := range []interface{}{&db.PlayEvent{}, &db.Favorite{}, &db.Follow{}, &db.Playlist{}} {
		if n := countWhere(t, m, "anon-2"); n != 0 {
			t.Fatalf("%T: %d rows left on the anonymous profile", m, n)
		}
	}
}

func TestLoginNamedToNamedNeverMerges(t *testing.T) {
	useMergeDB(t)
	alice, _ := login(t, "", "Alice", nil)
	seedProfile(t, alice.ID, 4, []string{"v1"}, nil, []string{"A"})
	out, set := login(t, alice.ID, "Carol", nil)
	if out.Migrated != nil || !strings.Contains(out.raw, `"migrated":null`) {
		t.Fatalf("named -> named merged: %s", out.raw)
	}
	if set != out.ID || out.ID == alice.ID {
		t.Fatalf("cookie %q id %q", set, out.ID)
	}
	if countWhere(t, &db.PlayEvent{}, alice.ID) != 4 || countWhere(t, &db.PlayEvent{}, out.ID) != 0 {
		t.Fatalf("plays moved between two named profiles")
	}
	// A named row that lost its u- prefix convention is still protected by
	// its Profile name.
	db.DB.Create(&db.Profile{ID: "legacy", Name: "Dan", CreatedAt: time.Now()})
	seedProfile(t, "legacy", 1, nil, nil, nil)
	if out, _ := login(t, "legacy", "Carol", nil); out.Migrated != nil {
		t.Fatalf("named legacy profile merged: %s", out.raw)
	}
}

func TestLoginIdempotent(t *testing.T) {
	useMergeDB(t)
	seedProfile(t, "anon-3", 2, []string{"v1"}, nil, nil)
	first, set := login(t, "anon-3", "Eve", nil)
	if first.Migrated == nil || first.Migrated.Plays != 2 {
		t.Fatalf("first: %s", first.raw)
	}
	again, _ := login(t, set, "Eve", nil)
	if again.Migrated != nil || again.ID != first.ID {
		t.Fatalf("second login migrated: %s", again.raw)
	}
	// The stale anonymous cookie (another tab) logs in again: nothing left,
	// and (c45b L12-8) `migrated` is null, never an all-zero object.
	stale, _ := login(t, "anon-3", "Eve", nil)
	if stale.Migrated != nil || !strings.Contains(stale.raw, `"migrated":null`) || stale.ID != first.ID {
		t.Fatalf("stale cookie: %s", stale.raw)
	}
	if n := countWhere(t, &db.PlayEvent{}, first.ID); n != 2 {
		t.Fatalf("plays %d, want 2", n)
	}
	var p db.Profile
	db.DB.Where("id = ?", first.ID).First(&p)
	var n int64
	db.DB.Model(&db.Profile{}).Where("id = ?", first.ID).Count(&n)
	if n != 1 || p.Name != "Eve" {
		t.Fatalf("profile rows %d name %q", n, p.Name)
	}
}

func TestLoginHarnessNeverMerges(t *testing.T) {
	useMergeDB(t)
	seedProfile(t, "anon-h", 3, []string{"v1"}, nil, nil)
	for _, hdr := range []map[string]string{
		{"X-Ytm-Harness": "1"},
		{"User-Agent": "Mozilla/5.0 HeadlessChrome/128"},
	} {
		out, _ := login(t, "anon-h", "Harness", hdr)
		if out.Migrated != nil {
			t.Fatalf("harness merged: %s", out.raw)
		}
	}
	if countWhere(t, &db.PlayEvent{}, "anon-h") != 3 {
		t.Fatalf("harness login moved plays")
	}
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "1")
	out, _ := login(t, "anon-h", "Harness", map[string]string{"X-Ytm-Harness": "1"})
	if out.Migrated == nil || out.Migrated.Plays != 3 {
		t.Fatalf("opt-in harness: %s", out.raw)
	}
}

// L12-6: skips recorded anonymously follow the device into the named profile.
func TestLoginMovesSkipEvents(t *testing.T) {
	useMergeDB(t)
	if err := db.DB.AutoMigrate(&db.SkipEvent{}); err != nil {
		t.Fatal(err)
	}
	seedProfile(t, "anon-sk", 1, nil, nil, nil)
	now := time.Now()
	for i := 0; i < 3; i++ {
		db.DB.Create(&db.SkipEvent{ProfileID: "anon-sk", Ref: "0123456789a", Position: 4, Source: "player", Origin: "local", SkippedAt: now.Add(-time.Duration(i) * time.Hour)})
	}
	db.DB.Create(&db.SkipEvent{ProfileID: "someone-else", Ref: "0123456789a", Position: 4, SkippedAt: now})
	out, _ := login(t, "anon-sk", "Skipper", nil)
	if out.Migrated == nil || out.Migrated.Skips != 3 || out.Migrated.Plays != 1 {
		t.Fatalf("migrated %s", out.raw)
	}
	if n := countWhere(t, &db.SkipEvent{}, "anon-sk"); n != 0 {
		t.Fatalf("%d skips left on the anonymous profile", n)
	}
	if n := countWhere(t, &db.SkipEvent{}, out.ID); n != 3 {
		t.Fatalf("named profile has %d skips, want 3", n)
	}
	if n := countWhere(t, &db.SkipEvent{}, "someone-else"); n != 1 {
		t.Fatalf("another profile's skip moved")
	}
	// the moved skips exclude the ref like the named profile's own
	if refs := skippedRefs(out.ID, time.Now()); !refs["0123456789a"] {
		t.Fatalf("moved skips not excluded: %v", refs)
	}
}

// ---- c45b B7-17 (L12-8): clean login ----

// loginRaw is login() without the fatal on a non-200 answer (concurrent use).
func loginRaw(cookie, name string) (int, loginOut) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/me/login", strings.NewReader(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 Chrome/128")
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "bbp", Value: cookie})
	}
	rec := httptest.NewRecorder()
	if err := MeLoginHandler(echo.New().NewContext(req, rec)); err != nil {
		return 0, loginOut{raw: err.Error()}
	}
	var out loginOut
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	out.raw = rec.Body.String()
	return rec.Code, out
}

// Two concurrent logins on the same anonymous cookie (double tap, two tabs):
// one adoption, the other answers the same profile with migrated null, no
// row duplicated or lost.
func TestLoginConcurrentAdoptsOnce(t *testing.T) {
	useMergeDB(t)
	seedProfile(t, "anon-cc", 7, []string{"v1", "v2"}, []string{"la-a"}, []string{"Route"})
	const n = 4
	codes := make([]int, n)
	outs := make([]loginOut, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i], outs[i] = loginRaw("anon-cc", "Twins")
		}(i)
	}
	close(start)
	wg.Wait()
	adopted := 0
	for i := 0; i < n; i++ {
		if codes[i] != http.StatusOK {
			t.Fatalf("login %d: %d %s", i, codes[i], outs[i].raw)
		}
		if outs[i].ID != outs[0].ID || outs[i].Name != "Twins" {
			t.Fatalf("login %d answered another profile: %s", i, outs[i].raw)
		}
		if outs[i].Migrated != nil {
			adopted++
			if outs[i].Migrated.Plays != 7 || outs[i].Migrated.Favorites != 2 || outs[i].Migrated.Follows != 1 || outs[i].Migrated.Playlists != 1 {
				t.Fatalf("login %d migrated %+v", i, *outs[i].Migrated)
			}
		} else if !strings.Contains(outs[i].raw, `"migrated":null`) {
			t.Fatalf("login %d: %s", i, outs[i].raw)
		}
	}
	if adopted != 1 {
		t.Fatalf("%d logins adopted, want exactly 1", adopted)
	}
	named := outs[0].ID
	if countWhere(t, &db.PlayEvent{}, named) != 7 || countWhere(t, &db.Favorite{}, named) != 2 || countWhere(t, &db.Playlist{}, named) != 1 {
		t.Fatalf("named rows: plays %d favs %d playlists %d", countWhere(t, &db.PlayEvent{}, named), countWhere(t, &db.Favorite{}, named), countWhere(t, &db.Playlist{}, named))
	}
	if countWhere(t, &db.PlayEvent{}, "anon-cc") != 0 {
		t.Fatalf("plays left on the anonymous profile")
	}
	var profiles int64
	db.DB.Model(&db.Profile{}).Where("id = ?", named).Count(&profiles)
	if profiles != 1 {
		t.Fatalf("%d profile rows for %s", profiles, named)
	}
}

// A write that left with the anonymous cookie and lands after the merge is
// served as the named profile (adoption grace), and a later login of the
// same name re-adopts what still landed on the old id (prevAnon).
func TestLoginInflightWriteFollowsAdoption(t *testing.T) {
	useMergeDB(t)
	seedProfile(t, "anon-if", 1, nil, nil, nil)
	first, set := login(t, "anon-if", "Flo", nil)
	if first.Migrated == nil || first.Migrated.Plays != 1 {
		t.Fatalf("first: %s", first.raw)
	}
	// 1. in flight: POST me/history still carrying the old cookie (ctxFor
	// would add its own p-test cookie first: build the request by hand).
	hreq := httptest.NewRequest(http.MethodPost, "/api/v1/me/history", strings.NewReader(`{"videoId":"late1","title":"Late"}`))
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("User-Agent", "Mozilla/5.0 Chrome/128")
	hreq.AddCookie(&http.Cookie{Name: "bbp", Value: "anon-if"})
	rec := httptest.NewRecorder()
	if err := MeRecordPlayHandler(echo.New().NewContext(hreq, rec)); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("history: %v %d %s", err, rec.Code, rec.Body.String())
	}
	if countWhere(t, &db.PlayEvent{}, first.ID) != 2 || countWhere(t, &db.PlayEvent{}, "anon-if") != 0 {
		t.Fatalf("late play orphaned: named %d anon %d", countWhere(t, &db.PlayEvent{}, first.ID), countWhere(t, &db.PlayEvent{}, "anon-if"))
	}
	switched := ""
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == "bbp" {
			switched = ck.Value
		}
	}
	if switched != set {
		t.Fatalf("cookie not switched to the named profile: %q", switched)
	}
	// 2. after the grace: a play lands on the old id; the same name's next
	// login with prevAnon takes it; another name never does.
	adoptionNow = func() time.Time { return time.Now().Add(adoptionGrace + time.Minute) }
	t.Cleanup(func() { adoptionNow = time.Now })
	db.DB.Create(&db.PlayEvent{ProfileID: "anon-if", Ref: "late2", Title: "T", Data: `{"videoId":"late2"}`, PlayedAt: time.Now()})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/me/login", strings.NewReader(`{"name":"Gus","prevAnon":"anon-if"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 Chrome/128")
	req.AddCookie(&http.Cookie{Name: "bbp", Value: set})
	rr := httptest.NewRecorder()
	if err := MeLoginHandler(echo.New().NewContext(req, rr)); err != nil || rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"migrated":null`) {
		t.Fatalf("other name took the remembered id: %v %s", err, rr.Body.String())
	}
	if countWhere(t, &db.PlayEvent{}, "anon-if") != 1 {
		t.Fatalf("late play moved to another name")
	}
	req = httptest.NewRequest(http.MethodPost, "/api/v1/me/login", strings.NewReader(`{"name":"flo","prevAnon":"anon-if"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 Chrome/128")
	req.AddCookie(&http.Cookie{Name: "bbp", Value: "fresh-anon"})
	rr = httptest.NewRecorder()
	if err := MeLoginHandler(echo.New().NewContext(req, rr)); err != nil || rr.Code != http.StatusOK {
		t.Fatalf("relogin: %v %d", err, rr.Code)
	}
	var again loginOut
	_ = json.Unmarshal(rr.Body.Bytes(), &again)
	if again.ID != first.ID || again.Migrated == nil || again.Migrated.Plays != 1 {
		t.Fatalf("prevAnon not re-adopted: %s", rr.Body.String())
	}
	if countWhere(t, &db.PlayEvent{}, first.ID) != 3 || countWhere(t, &db.PlayEvent{}, "anon-if") != 0 {
		t.Fatalf("plays: named %d anon %d", countWhere(t, &db.PlayEvent{}, first.ID), countWhere(t, &db.PlayEvent{}, "anon-if"))
	}
	// the adopted id stays anonymous for every other reader
	if !profileAnonymous("anon-if") {
		t.Fatalf("adopted anonymous id reads as named")
	}
}

// L13-6: the adoption survives a restart. After the in-memory map is lost
// (resetAdoptions), a write still carrying the adopted cookie is served as
// the named profile from profiles.adopted_by / adopted_at, for the grace
// only; an id never adopted costs one lookup, then a negative memo entry.
func TestLoginAdoptionSurvivesRestart(t *testing.T) {
	useMergeDB(t)
	seedProfile(t, "anon-rs", 1, nil, nil, nil)
	first, set := login(t, "anon-rs", "Rae", nil)
	if first.Migrated == nil || first.Migrated.Plays != 1 {
		t.Fatalf("first: %s", first.raw)
	}
	resetAdoptions() // simulated restart / promotion: the map is empty
	post := func(cookie string) (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/me/history", strings.NewReader(`{"videoId":"late-rs","title":"Late"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 Chrome/128")
		req.AddCookie(&http.Cookie{Name: "bbp", Value: cookie})
		rec := httptest.NewRecorder()
		if err := MeRecordPlayHandler(echo.New().NewContext(req, rec)); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("history: %v %d %s", err, rec.Code, rec.Body.String())
		}
		switched := ""
		for _, ck := range rec.Result().Cookies() {
			if ck.Name == "bbp" {
				switched = ck.Value
			}
		}
		return rec.Code, switched
	}
	if _, switched := post("anon-rs"); switched != set {
		t.Fatalf("after the restart the cookie was not switched: %q", switched)
	}
	if countWhere(t, &db.PlayEvent{}, first.ID) != 2 || countWhere(t, &db.PlayEvent{}, "anon-rs") != 0 {
		t.Fatalf("late play orphaned after restart: named %d anon %d", countWhere(t, &db.PlayEvent{}, first.ID), countWhere(t, &db.PlayEvent{}, "anon-rs"))
	}
	// Warm now: the database is not read again for this id.
	reads := 0
	prev := adoptedByRow
	adoptedByRow = func(pid string) (string, time.Time) { reads++; return prev(pid) }
	t.Cleanup(func() { adoptedByRow = prev })
	if got := resolveAdopted("anon-rs"); got != first.ID || reads != 0 {
		t.Fatalf("memo after the fallback: %q (%d reads)", got, reads)
	}
	// An id never adopted: one read, then the negative entry answers.
	for i := 0; i < 5; i++ {
		if got := resolveAdopted("anon-never"); got != "anon-never" {
			t.Fatalf("never adopted: %q", got)
		}
	}
	if reads != 1 {
		t.Fatalf("negative memo: %d reads, want 1", reads)
	}
	// A login of that id turns the negative entry positive at once.
	_, set2 := login(t, "anon-never", "Noa", nil)
	if got := resolveAdopted("anon-never"); got != set2 {
		t.Fatalf("after login: %q want %q", got, set2)
	}
	// Past the grace the row no longer redirects, with or without the map.
	resetAdoptions()
	adoptionNow = func() time.Time { return time.Now().Add(adoptionGrace + time.Minute) }
	t.Cleanup(func() { adoptionNow = time.Now })
	if got := resolveAdopted("anon-rs"); got != "anon-rs" {
		t.Fatalf("grace not honoured from the database: %q", got)
	}
	// A row adopted before the column existed (adopted_at NULL): no grace.
	db.DB.Create(&db.Profile{ID: "anon-old", AdoptedBy: first.ID, CreatedAt: time.Now()})
	adoptionNow = time.Now
	if got := resolveAdopted("anon-old"); got != "anon-old" {
		t.Fatalf("adopted_at NULL redirected: %q", got)
	}
}

// L13-6: two concurrent logins, one slow: the second waits at most
// loginLockTimeout and answers 503 (no unbounded pile-up); a login of
// unrelated profiles is not blocked; the slow one still completes.
func TestLoginConcurrentSlowBounded(t *testing.T) {
	useMergeDB(t)
	seedProfile(t, "anon-slow", 3, nil, nil, nil)
	seedProfile(t, "anon-free", 2, nil, nil, nil)
	loginLockTimeout = 300 * time.Millisecond
	t.Cleanup(func() { loginLockTimeout = 5 * time.Second })
	gate := make(chan struct{})
	entered := make(chan struct{}, 1)
	var first int32
	loginLockedHook = func(to string) {
		if atomic.CompareAndSwapInt32(&first, 0, 1) {
			entered <- struct{}{}
			<-gate // the slow login holds its locks until the test opens the gate
		}
	}
	t.Cleanup(func() { loginLockedHook = nil })
	type res struct {
		code int
		out  loginOut
	}
	slow := make(chan res, 1)
	go func() {
		code, out := loginRaw("anon-slow", "Sam")
		slow <- res{code, out}
	}()
	<-entered
	// Unrelated profiles: served at once.
	start := time.Now()
	if code, out := loginRaw("anon-free", "Fay"); code != http.StatusOK || out.Migrated == nil || out.Migrated.Plays != 2 || time.Since(start) > loginLockTimeout {
		t.Fatalf("unrelated login blocked: %d %s (%s)", code, out.raw, time.Since(start))
	}
	// Same source (double tap, second tab): bounded wait, then 503.
	start = time.Now()
	code, out := loginRaw("anon-slow", "Sam")
	if el := time.Since(start); code != http.StatusServiceUnavailable || !strings.Contains(out.raw, "busy") || el < loginLockTimeout || el > 6*time.Second {
		t.Fatalf("second login: %d %s after %s", code, out.raw, el)
	}
	// Same target from another device: bounded too.
	if code, out := loginRaw("anon-other", "Sam"); code != http.StatusServiceUnavailable {
		t.Fatalf("same name login: %d %s", code, out.raw)
	}
	close(gate)
	r := <-slow
	if r.code != http.StatusOK || r.out.Migrated == nil || r.out.Migrated.Plays != 3 {
		t.Fatalf("slow login: %d %s", r.code, r.out.raw)
	}
	// Nothing left held: the next login of the same profile runs at once.
	start = time.Now()
	if code, out := loginRaw("anon-slow", "Sam"); code != http.StatusOK || time.Since(start) > loginLockTimeout {
		t.Fatalf("after release: %d %s (%s)", code, out.raw, time.Since(start))
	}
	loginLocks.mu.Lock()
	left := len(loginLocks.held)
	loginLocks.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d lock entries left", left)
	}
}
