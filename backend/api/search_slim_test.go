package api

import (
	"encoding/json"
	"strings"
	"testing"
)

// K11: search results carry no loggingContext / clickTrackingParams /
// playerParams, and keep every field the front reads.
func TestSlimSearchItemsDropsTrackingKeys(t *testing.T) {
	vid, pl := "dQw4w9WgXcQ", "RDAMVMdQw4w9WgXcQ"
	items := []IListItemRenderer{{
		Title:               "Never Gonna Give You Up",
		Subtitle:            []Artist{{Text: "Rick Astley", BrowseId: "UC1", PageType: "MUSIC_PAGE_TYPE_ARTIST"}},
		ArtistInfo:          ArtistInfo{Artist: []Artist{{Text: "Rick Astley", BrowseId: "UC1"}}},
		Explicit:            true,
		Endpoint:            &Endpoint{BrowseId: "MPREb_1", PageType: "MUSIC_PAGE_TYPE_ALBUM"},
		Length:              "3:33",
		MusicVideoType:      "MUSIC_VIDEO_TYPE_ATV",
		VideoId:             &vid,
		PlaylistId:          &pl,
		Thumbnails:          []Thumbnail{{URL: "https://i/1", Width: 60, Height: 60}},
		Type:                "songs",
		PlayerParams:        strings.Repeat("p", 200),
		ClickTrackingParams: strings.Repeat("c", 200),
		LoggingContext:      &ItemLoggingContext{VssLoggingContext: VssLoggingContext{SerializedContextData: strings.Repeat("z", 400)}},
	}}
	slimSearchItems(items)
	raw, err := json.Marshal(items[0])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"loggingContext", "clickTrackingParams", "playerParams"} {
		if _, ok := m[k]; ok {
			t.Fatalf("key %q still serialised: %s", k, raw)
		}
	}
	for _, k := range []string{"videoId", "playlistId", "title", "subtitle", "thumbnails", "artistInfo", "explicit", "endpoint", "length", "musicVideoType", "type"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("key %q lost: %s", k, raw)
		}
	}
	if len(raw) > 600 {
		t.Fatalf("slim item is still %d bytes: %s", len(raw), raw)
	}
}

// An item without a logging context serialises no loggingContext key at all
// (the struct value used to emit an empty one on every item).
func TestEmptyLoggingContextIsOmitted(t *testing.T) {
	raw, _ := json.Marshal(IListItemRenderer{Title: "x"})
	if strings.Contains(string(raw), "loggingContext") {
		t.Fatalf("empty loggingContext serialised: %s", raw)
	}
	with := IListItemRenderer{Title: "x", LoggingContext: &ItemLoggingContext{VssLoggingContext: VssLoggingContext{SerializedContextData: "abc"}}}
	raw, _ = json.Marshal(with)
	if !strings.Contains(string(raw), `"serializedContextData":"abc"`) {
		t.Fatalf("non-empty loggingContext lost: %s", raw)
	}
}
