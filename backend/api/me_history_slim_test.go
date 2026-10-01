package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

var heavyItem = `{"videoId":"0123456789a","title":"Song A","length":"4:00",` +
	`"artistInfo":{"artist":[{"text":"Artist One","browseId":"la-one"}]},` +
	`"thumbnails":[{"url":"/cover?lid=1","width":60},{"url":"/cover?lid=2","width":120},{"url":"/cover?lid=3","width":226},{"url":"/cover?lid=4","width":544}],` +
	`"loggingContext":{"vssLoggingContext":{"serializedContextData":"` + strings.Repeat("z", 400) + `"}},` +
	`"clickTrackingParams":"` + strings.Repeat("c", 200) + `","playerParams":"8AUB","playlistSetVideoId":"abc","itct":"x","params":"wAEB","musicVideoType":"MUSIC_VIDEO_TYPE_ATV","autoMixList":[1,2]}`

func assertSlim(t *testing.T, raw json.RawMessage, where string) {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("%s: bad item json: %v", where, err)
	}
	for _, k := range historyDropKeys {
		if _, ok := m[k]; ok {
			t.Fatalf("%s: key %q still present", where, k)
		}
	}
	th, _ := m["thumbnails"].([]interface{})
	if len(th) != 2 {
		t.Fatalf("%s: %d thumbnails, want 2", where, len(th))
	}
	// L19: smallest for list rows ([0]) and largest for the fullscreen
	// player (thumbnails.at(-1)); the two smallest gave a blurry 120 px cover.
	if w0, w1 := thumbWidth(th[0]), thumbWidth(th[1]); w0 != 60 || w1 != 544 {
		t.Fatalf("%s: thumbnail widths %v/%v, want first 60 and last 544", where, w0, w1)
	}
	if m["title"] != "Song A" || m["videoId"] != "0123456789a" || m["length"] != "4:00" {
		t.Fatalf("%s: display fields lost: %v", where, m)
	}
	if ai, ok := m["artistInfo"].(map[string]interface{}); !ok || ai["artist"] == nil {
		t.Fatalf("%s: artistInfo lost", where)
	}
}

func thumbWidth(v interface{}) float64 {
	if m, ok := v.(map[string]interface{}); ok {
		w, _ := m["width"].(float64)
		return w
	}
	return -1
}

// K13: a recorded play is stored without the tracking blobs and with at most
// two thumbnails; events stored before this change are slimmed when read.
func TestHistoryEventsAreSlim(t *testing.T) {
	useTestDB(t)
	c, rec := ctxFor(http.MethodPost, "/api/v1/me/history", heavyItem, nil)
	if err := MeRecordPlayHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("record: %v %d %s", err, rec.Code, rec.Body.String())
	}
	var ev db.PlayEvent
	db.DB.First(&ev)
	assertSlim(t, json.RawMessage(ev.Data), "stored")
	if len(ev.Data) > 400 {
		t.Fatalf("stored item is %d bytes, want < 400", len(ev.Data))
	}

	// legacy row written by the previous code: the whole item
	db.DB.Create(&db.PlayEvent{ProfileID: "p-test", Ref: "0123456789a", Title: "Song A", Source: "youtube", Data: heavyItem, PlayedAt: time.Now().Add(-time.Hour)})

	c, rec = ctxFor(http.MethodGet, "/api/v1/me/stats/recent?events=1&limit=200", "", nil)
	if err := MeRecentHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("events: %v %d", err, rec.Code)
	}
	var out struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Items) != 2 {
		t.Fatalf("events body: %v %s", err, rec.Body.String())
	}
	for i, it := range out.Items {
		assertSlim(t, it, "events item "+string(rune('0'+i)))
	}

	c, rec = ctxFor(http.MethodGet, "/api/v1/me/stats/recent", "", nil)
	if err := MeRecentHandler(c); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("recent: %v %d", err, rec.Code)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Items) != 1 {
		t.Fatalf("recent body: %v %s", err, rec.Body.String())
	}
	assertSlim(t, out.Items[0], "recent item")
}

// slimStoredItem leaves rows with nothing to drop untouched (no re-encoding).
func TestSlimStoredItemPassthrough(t *testing.T) {
	in := `{"videoId":"0123456789a","title":"A","thumbnails":[{"url":"/cover?lid=1"}]}`
	var a, b map[string]interface{}
	if err := json.Unmarshal([]byte(in), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(slimStoredItem(in), &b); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("thumbnails <= 2 must survive unchanged, got %v", b)
	}
	plain := `{"videoId":"0123456789a","title":"A"}`
	if got := string(slimStoredItem(plain)); got != plain {
		t.Fatalf("plain row changed: %s", got)
	}
	if got := string(slimStoredItem("not json")); got != "not json" {
		t.Fatalf("unparsable row must pass through, got %s", got)
	}
}
