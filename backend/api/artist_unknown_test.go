package api

import (
	"errors"
	"fmt"
	"testing"

	"beatbump-server/backend/_youtube"
	ytapi "beatbump-server/backend/_youtube/api"
)

func TestArtistUnknownOnEmptyUpstreamAnswer(t *testing.T) {
	var h _youtube.HomeResponse
	if !artistUnknown(h) {
		t.Fatal("empty answer should be unknown")
	}
	h.Header.MusicImmersiveHeaderRenderer.Title.Runs = append(h.Header.MusicImmersiveHeaderRenderer.Title.Runs, struct {
		Text string `json:"text"`
	}{Text: "Daft Punk"})
	if artistUnknown(h) {
		t.Fatal("an answer with a title is a known artist")
	}
}

func TestSafeParseArtistDoesNotPanicWithoutTabs(t *testing.T) {
	var h _youtube.HomeResponse
	h.Header.MusicImmersiveHeaderRenderer.Title.Runs = append(h.Header.MusicImmersiveHeaderRenderer.Title.Runs, struct {
		Text string `json:"text"`
	}{Text: "Daft Punk"})
	if _, err := safeParseArtist(h); err != nil {
		t.Fatalf("header without tabs must parse: %v", err)
	}
}

func TestLocalArtistUnknown(t *testing.T) {
	if !localArtistUnknown(map[string]interface{}{"header": map[string]interface{}{"name": ""}, "carousels": []Carousel{}}) {
		t.Fatal("empty local artist should be unknown")
	}
	if localArtistUnknown(map[string]interface{}{"header": map[string]interface{}{"name": "Daft Punk"}, "carousels": []Carousel{}}) {
		t.Fatal("named local artist is known")
	}
}

func TestArtistUpstreamErrorOnlyUpstream404IsUnknown(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want int
	}{
		{&ytapi.UpstreamStatusError{StatusCode: 404, Status: "404 Not Found"}, 404},
		{fmt.Errorf("browse: %w", &ytapi.UpstreamStatusError{StatusCode: 404, Status: "404 Not Found"}), 404},
		{&ytapi.UpstreamStatusError{StatusCode: 400, Status: "400 Bad Request"}, 502},
		{&ytapi.UpstreamStatusError{StatusCode: 500, Status: "500 Internal Server Error"}, 502},
		{errors.New("dial tcp: timeout"), 502},
	} {
		got, body := artistUpstreamError(tc.err)
		if got != tc.want {
			t.Errorf("artistUpstreamError(%v) = %d, want %d", tc.err, got, tc.want)
		}
		if (got == 404) != (body["error"] == "not_found") {
			t.Errorf("artistUpstreamError(%v) body %v does not match status %d", tc.err, body, got)
		}
	}
}
