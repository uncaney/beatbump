package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// pagedTracksStub is a Meili stand-in that honours offset / limit over a
// fixed tracks index and reports estimatedTotalHits, like the real engine:
// a window past the end answers no hit. Every other index answers nothing.
type pagedTracksStub struct {
	mu      sync.Mutex
	tracks  []map[string]interface{}
	offsets []int
}

func (s *pagedTracksStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Method != "POST" || !strings.HasPrefix(r.URL.Path, "/indexes/tracks/") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"hits": []interface{}{}, "estimatedTotalHits": 0})
			return
		}
		off, lim := 0, 20
		if v, ok := body["offset"].(float64); ok {
			off = int(v)
		}
		if v, ok := body["limit"].(float64); ok {
			lim = int(v)
		}
		s.mu.Lock()
		if lim > 0 {
			s.offsets = append(s.offsets, off)
		}
		s.mu.Unlock()
		hits := []map[string]interface{}{}
		for i := off; i < off+lim && i < len(s.tracks); i++ {
			hits = append(hits, s.tracks[i])
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"hits": hits, "estimatedTotalHits": len(s.tracks)})
	})
}

func newPagedTracksStub(t *testing.T, n int) *pagedTracksStub {
	t.Helper()
	resetAlbumCoverMemo()
	resetTrackTotalMemo()
	t.Cleanup(resetTrackTotalMemo)
	s := &pagedTracksStub{}
	for i := 0; i < n; i++ {
		s.tracks = append(s.tracks, map[string]interface{}{
			"lid": fmt.Sprintf("%011x", 0xa0000+i), "title": fmt.Sprintf("Song %d", i),
			"artist": fmt.Sprintf("Artist %d", i%7), "albumArtist": fmt.Sprintf("Artist %d", i%7),
			"album": fmt.Sprintf("Album %d", i%11), "track": float64(i%9 + 1), "durationSec": 30.0,
		})
	}
	srv := httptest.NewServer(s.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return s
}

// A fresh install holds a few dozen tracks: the cold-start sample (the "Pour
// toi" mix of a profile without history, and the offline pack drawn from it)
// must still find tracks. With offsets drawn in 0..40000 every window landed
// past the end of the index and the mix came back empty.
func TestRandomLibrarySampleSmallLibrary(t *testing.T) {
	stub := newPagedTracksStub(t, 28)
	for round := 0; round < 5; round++ {
		items := randomLibrarySample(40)
		if len(items) < 20 {
			t.Fatalf("round %d: a 28-track library gave %d sample items (expected most of the library)", round, len(items))
		}
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	for _, off := range stub.offsets {
		if off < 0 || off > 28-4 {
			t.Fatalf("window offset %d outside the 28-track library (offsets %v)", off, stub.offsets)
		}
	}
}

func TestRandomTrackOffsetStaysInside(t *testing.T) {
	cases := []struct{ total, window int }{{0, 4}, {3, 4}, {4, 4}, {5, 4}, {28, 60}, {54000, 4}}
	for _, c := range cases {
		for i := 0; i < 200; i++ {
			off := randomTrackOffset(c.total, c.window)
			if off < 0 || (c.total > c.window && off > c.total-c.window) || (c.total <= c.window && off != 0) {
				t.Fatalf("randomTrackOffset(%d, %d) = %d", c.total, c.window, off)
			}
		}
	}
}

func TestLibraryTrackTotalMemoised(t *testing.T) {
	stub := newPagedTracksStub(t, 12)
	if n := libraryTrackTotal(); n != 12 {
		t.Fatalf("libraryTrackTotal = %d, want 12", n)
	}
	stub.tracks = stub.tracks[:3]
	if n := libraryTrackTotal(); n != 12 {
		t.Fatalf("memoised total = %d, want 12 until the TTL", n)
	}
	resetTrackTotalMemo()
	if n := libraryTrackTotal(); n != 3 {
		t.Fatalf("after reset = %d, want 3", n)
	}
}

// The me/mix cold start (no play, no favourite) answers the library sample.
func TestMeMixColdStartSmallLibrary(t *testing.T) {
	newPagedTracksStub(t, 28)
	items := itemsWithout(randomLibrarySample(40), resolveExclusions(nil))
	if len(items) == 0 {
		t.Fatal("cold-start mix empty on a 28-track library")
	}
}
