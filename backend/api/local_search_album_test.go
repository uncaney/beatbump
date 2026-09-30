package api

import "testing"

func TestLocalSongItemAlbum(t *testing.T) {
	h := map[string]interface{}{"lid": "abc123def45", "title": "T", "artist": "A", "albumArtist": "A", "album": "Alb", "track": 1.0, "durationSec": 10.0}
	it := localSongItem(h)
	if it.Album == nil || it.Album.Text != "Alb" || it.Album.BrowseId == "" {
		t.Fatalf("expected album metadata on local song item, got %+v", it.Album)
	}
	h2 := map[string]interface{}{"lid": "abc123def45", "title": "T", "artist": "A"}
	if localSongItem(h2).Album != nil {
		t.Fatalf("expected no album when the doc has none")
	}
}
