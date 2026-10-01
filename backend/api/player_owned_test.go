package api

import (
	"sync/atomic"
	"testing"
	"time"
)

// K14: the owned verdict of a videoId is asked to Meili once per hour, not on
// every player.json of the same radio.
func TestCachedOwnsTrackMemoisesPerVideoId(t *testing.T) {
	var calls int32
	prevFn, prevNow := ownsTrackFn, ownedNow
	t.Cleanup(func() {
		ownsTrackFn, ownedNow = prevFn, prevNow
		ownedVerdicts.Range(func(k, _ interface{}) bool { ownedVerdicts.Delete(k); return true })
	})
	ownedVerdicts.Range(func(k, _ interface{}) bool { ownedVerdicts.Delete(k); return true })
	ownsTrackFn = func(videoId, title, artist string) bool {
		atomic.AddInt32(&calls, 1)
		return videoId == "ownedOwned1"
	}
	base := time.Now()
	ownedNow = func() time.Time { return base }

	if !cachedOwnsTrack("ownedOwned1", "T", "A") || cachedOwnsTrack("notOwned01", "T", "A") {
		t.Fatalf("verdicts do not follow the underlying check")
	}
	for i := 0; i < 5; i++ {
		cachedOwnsTrack("ownedOwned1", "T", "A")
		cachedOwnsTrack("notOwned01", "T", "A")
	}
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("%d Meili checks for 2 videoIds replayed 6 times, want 2", n)
	}

	// expired after one hour: asked again
	ownedNow = func() time.Time { return base.Add(ownedVerdictTTL + time.Second) }
	cachedOwnsTrack("ownedOwned1", "T", "A")
	if n := atomic.LoadInt32(&calls); n != 3 {
		t.Fatalf("%d checks after the TTL, want 3", n)
	}

	// an empty videoId is never memoised (title/artist check only)
	cachedOwnsTrack("", "T", "A")
	cachedOwnsTrack("", "T", "A")
	if n := atomic.LoadInt32(&calls); n != 5 {
		t.Fatalf("%d checks with empty videoId, want 5", n)
	}
}
