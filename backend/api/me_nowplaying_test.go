package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

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
	if out.DeviceID != "dev-b" || out.DeviceName != "Mac" || out.Position != 42.5 || p.Index != 3 || out.UpdatedAt == 0 {
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
