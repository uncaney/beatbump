package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
	// The stale anonymous cookie (another tab) logs in again: nothing left.
	stale, _ := login(t, "anon-3", "Eve", nil)
	if stale.Migrated == nil || *stale.Migrated != (migratedCounts{}) {
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
