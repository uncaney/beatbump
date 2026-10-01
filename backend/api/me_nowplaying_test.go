package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

func useNowPlayingDB(t *testing.T) {
	t.Helper()
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.NowPlaying{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "")
}

var chromeUA = map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"}

func npBody(device string, index int, pos float64) string {
	b, _ := json.Marshal(map[string]interface{}{
		"deviceId": device, "deviceName": "Mac", "position": pos,
		"payload": map[string]interface{}{"v": 1, "index": index, "type": "local", "currentTime": pos, "savedAt": 1, "rows": []interface{}{}},
	})
	return string(b)
}

func getNowPlaying(t *testing.T) (int, nowPlayingOut) {
	t.Helper()
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/nowplaying", "", chromeUA)
	if err := MeNowPlayingGetHandler(c); err != nil {
		t.Fatal(err)
	}
	var out nowPlayingOut
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("bad json: %v %s", err, rec.Body.String())
		}
	}
	return rec.Code, out
}

func putNowPlaying(t *testing.T, body string, hdr map[string]string) (int, string) {
	t.Helper()
	c, rec := ctxFor(http.MethodPut, "/api/v1/me/nowplaying", body, hdr)
	if err := MeNowPlayingPutHandler(c); err != nil {
		t.Fatal(err)
	}
	return rec.Code, rec.Body.String()
}

func TestNowPlayingGet404WhenNone(t *testing.T) {
	useNowPlayingDB(t)
	if code, _ := getNowPlaying(t); code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", code)
	}
}

func TestNowPlayingPutThenGetUpserts(t *testing.T) {
	useNowPlayingDB(t)
	if code, b := putNowPlaying(t, npBody("dev-a", 2, 30), chromeUA); code != http.StatusOK {
		t.Fatalf("put: %d %s", code, b)
	}
	if code, b := putNowPlaying(t, npBody("dev-b", 3, 42.5), chromeUA); code != http.StatusOK {
		t.Fatalf("put 2: %d %s", code, b)
	}
	var n int64
	db.DB.Model(&db.NowPlaying{}).Count(&n)
	if n != 1 {
		t.Fatalf("%d rows, want 1 per profile", n)
	}
	code, out := getNowPlaying(t)
	if code != http.StatusOK {
		t.Fatalf("get: %d", code)
	}
	var p struct {
		Index int `json:"index"`
	}
	_ = json.Unmarshal(out.Payload, &p)
	if out.DeviceID != "dev-b" || out.DeviceName != "Mac" || out.Position != 42.5 || p.Index != 3 || out.UpdatedAt == 0 || out.Now == 0 {
		t.Fatalf("unexpected row: %+v index=%d", out, p.Index)
	}
}

func TestNowPlayingPutRejects(t *testing.T) {
	useNowPlayingDB(t)
	cases := []struct {
		name string
		body string
		want int
	}{
		{"bad json", `{"deviceId":`, http.StatusBadRequest},
		{"no payload", `{"deviceId":"d","position":1}`, http.StatusBadRequest},
		{"payload not object", `{"deviceId":"d","payload":"x"}`, http.StatusBadRequest},
		{"no device", `{"payload":{"v":1}}`, http.StatusBadRequest},
		{"too large", `{"deviceId":"d","payload":{"pad":"` + strings.Repeat("x", 70*1024) + `"}}`, http.StatusRequestEntityTooLarge},
		{"payload over 64KB", `{"deviceId":"d","payload":{"pad":"` + strings.Repeat("x", 65*1024) + `"}}`, http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		if code, b := putNowPlaying(t, tc.body, chromeUA); code != tc.want {
			t.Errorf("%s: status %d (%s), want %d", tc.name, code, b, tc.want)
		}
	}
	if code, _ := getNowPlaying(t); code != http.StatusNotFound {
		t.Fatalf("a rejected PUT stored a row")
	}
}

func TestNowPlayingIgnoresHarness(t *testing.T) {
	useNowPlayingDB(t)
	for _, hdr := range []map[string]string{
		{"X-Ytm-Harness": "1", "User-Agent": "Mozilla/5.0 Chrome/128"},
		{"User-Agent": "Mozilla/5.0 HeadlessChrome/128"},
	} {
		code, b := putNowPlaying(t, npBody("dev-h", 1, 5), hdr)
		if code != http.StatusOK || !strings.Contains(b, `"ignored":true`) {
			t.Fatalf("harness put: %d %s", code, b)
		}
	}
	if code, _ := getNowPlaying(t); code != http.StatusNotFound {
		t.Fatalf("harness PUT stored a row")
	}
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "1")
	if code, b := putNowPlaying(t, npBody("dev-h", 1, 5), map[string]string{"X-Ytm-Harness": "1"}); code != http.StatusOK || strings.Contains(b, "ignored") {
		t.Fatalf("opt-in put: %d %s", code, b)
	}
	if code, out := getNowPlaying(t); code != http.StatusOK || out.DeviceID != "dev-h" {
		t.Fatalf("opt-in row missing: %d %+v", code, out)
	}
}

func npTakeBody(device string, pos float64) string {
	b, _ := json.Marshal(map[string]interface{}{
		"deviceId": device, "deviceName": "iPhone de Camille", "position": pos, "takenBy": device, "takenAt": 1,
		"payload": map[string]interface{}{"v": 1, "index": 0, "type": "local", "currentTime": pos, "savedAt": 1, "rows": []interface{}{}},
	})
	return string(b)
}

func TestNowPlayingTakeOver(t *testing.T) {
	useNowPlayingDB(t)
	if code, b := putNowPlaying(t, npBody("dev-a", 1, 30), chromeUA); code != http.StatusOK || strings.Contains(b, "takenBy") {
		t.Fatalf("put a: %d %s", code, b)
	}
	// B takes the playback over.
	if code, b := putNowPlaying(t, npTakeBody("dev-b", 31), chromeUA); code != http.StatusOK || !strings.Contains(b, `"takenBy":"dev-b"`) {
		t.Fatalf("take b: %d %s", code, b)
	}
	code, out := getNowPlaying(t)
	if code != http.StatusOK || out.DeviceID != "dev-b" || out.TakenBy != "dev-b" || out.TakenAt == 0 {
		t.Fatalf("after take: %d %+v", code, out)
	}
	// A's next plain push is refused and names the taker.
	code, b := putNowPlaying(t, npBody("dev-a", 1, 45), chromeUA)
	if code != http.StatusConflict || !strings.Contains(b, `"takenBy":"dev-b"`) || !strings.Contains(b, `"deviceName":"iPhone de Camille"`) {
		t.Fatalf("a after take: %d %s", code, b)
	}
	if _, out := getNowPlaying(t); out.DeviceID != "dev-b" || out.Position != 31 {
		t.Fatalf("refused push overwrote the row: %+v", out)
	}
	// The taker's own plain pushes keep the take.
	if code, b := putNowPlaying(t, npBody("dev-b", 1, 50), chromeUA); code != http.StatusOK || !strings.Contains(b, `"takenBy":"dev-b"`) {
		t.Fatalf("b push: %d %s", code, b)
	}
	// A presses play again: a take back.
	if code, b := putNowPlaying(t, npTakeBody("dev-a", 46), chromeUA); code != http.StatusOK {
		t.Fatalf("a take back: %d %s", code, b)
	}
	if code, _ := putNowPlaying(t, npBody("dev-b", 1, 65), chromeUA); code != http.StatusConflict {
		t.Fatalf("b after take back: %d, want 409", code)
	}
}

func TestNowPlayingTakeRules(t *testing.T) {
	useNowPlayingDB(t)
	bad := `{"deviceId":"dev-a","takenBy":"dev-b","payload":{"v":1}}`
	if code, _ := putNowPlaying(t, bad, chromeUA); code != http.StatusBadRequest {
		t.Fatalf("takenBy for another device: %d, want 400", code)
	}
	if code, _ := putNowPlaying(t, npTakeBody("dev-b", 10), chromeUA); code != http.StatusOK {
		t.Fatalf("take: %d", code)
	}
	// A stale take (taker silent past the guard) no longer blocks anyone.
	old := time.Now().Add(-nowPlayingTakeGuard - time.Minute)
	db.DB.Model(&db.NowPlaying{}).Where("profile_id = ?", "p-test").Updates(map[string]interface{}{"updated_at": old, "taken_at": old})
	if code, b := putNowPlaying(t, npBody("dev-a", 1, 20), chromeUA); code != http.StatusOK || strings.Contains(b, "takenBy") {
		t.Fatalf("after stale take: %d %s", code, b)
	}
	if _, out := getNowPlaying(t); out.DeviceID != "dev-a" || out.TakenBy != "" || out.TakenAt != 0 {
		t.Fatalf("stale take not cleared: %+v", out)
	}
}

func TestNowPlayingMigratesOldTable(t *testing.T) {
	useTestDB(t)
	// A table from before 40A (no taken_* columns) with a row in it.
	if err := db.DB.Exec(`CREATE TABLE now_playings (profile_id text PRIMARY KEY, device_id text, device_name text, payload text, position real, updated_at datetime)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.DB.Exec(`INSERT INTO now_playings VALUES ('p-test','dev-a','Mac','{"v":1}',12,?)`, time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.DB.AutoMigrate(&db.NowPlaying{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if code, out := getNowPlaying(t); code != http.StatusOK || out.DeviceID != "dev-a" || out.TakenBy != "" {
		t.Fatalf("old row after migration: %d %+v", code, out)
	}
	if code, b := putNowPlaying(t, npBody("dev-b", 1, 5), chromeUA); code != http.StatusOK {
		t.Fatalf("put after migration: %d %s", code, b)
	}
}
