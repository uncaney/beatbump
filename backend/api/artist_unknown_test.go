package api

import (
	"testing"

	"beatbump-server/backend/_youtube"
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
