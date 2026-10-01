package api

import (
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

func resetOwnedVerdicts() {
	ownedVerdicts.Range(func(k, _ interface{}) bool { ownedVerdicts.Delete(k); return true })
	ownedVerdictCount.Store(0)
}

func countOwnedVerdicts() int {
	n := 0
	ownedVerdicts.Range(func(_, _ interface{}) bool { n++; return true })
	return n
}

// K14: the owned verdict of a videoId is asked to Meili once per hour, not on
// every player.json of the same radio.
func TestCachedOwnsTrackMemoisesPerVideoId(t *testing.T) {
	var calls int32
	prevFn, prevNow := ownsTrackFn, ownedNow
	t.Cleanup(func() {
		ownsTrackFn, ownedNow = prevFn, prevNow
		resetOwnedVerdicts()
	})
	resetOwnedVerdicts()
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

// L22: above ownedVerdictMaxEntries an insert purges the expired entries;
// fresh ones survive and the counter follows.
func TestOwnedVerdictsPurgeExpiredWhenLarge(t *testing.T) {
	prevFn, prevNow := ownsTrackFn, ownedNow
	t.Cleanup(func() {
		ownsTrackFn, ownedNow = prevFn, prevNow
		resetOwnedVerdicts()
	})
	resetOwnedVerdicts()
	ownsTrackFn = func(videoId, title, artist string) bool { return false }
	base := time.Now()
	ownedNow = func() time.Time { return base }

	for i := 0; i < ownedVerdictMaxEntries; i++ {
		cachedOwnsTrack(fmt.Sprintf("vid%08d", i), "T", "A")
	}
	if n := countOwnedVerdicts(); n != ownedVerdictMaxEntries {
		t.Fatalf("%d entries after %d inserts", n, ownedVerdictMaxEntries)
	}
	// replays do not grow the map
	cachedOwnsTrack("vid00000001", "T", "A")
	if n := countOwnedVerdicts(); n != ownedVerdictMaxEntries {
		t.Fatalf("%d entries after a replay, want %d", n, ownedVerdictMaxEntries)
	}

	// over the cap but nothing expired yet: nothing is dropped
	ownedNow = func() time.Time { return base.Add(time.Minute) }
	cachedOwnsTrack("freshOne001", "T", "A")
	if n := countOwnedVerdicts(); n != ownedVerdictMaxEntries+1 {
		t.Fatalf("%d entries, want %d (fresh entries must not be purged)", n, ownedVerdictMaxEntries+1)
	}

	// one hour later an insert purges the expired ones and keeps the fresh one
	ownedNow = func() time.Time { return base.Add(ownedVerdictTTL + 30*time.Second) }
	cachedOwnsTrack("laterOne001", "T", "A")
	if n := countOwnedVerdicts(); n != 2 {
		t.Fatalf("%d entries after the purge, want 2 (freshOne001 + laterOne001)", n)
	}
	for _, k := range []string{"freshOne001", "laterOne001"} {
		if _, ok := ownedVerdicts.Load(k); !ok {
			t.Fatalf("%s purged although fresh", k)
		}
	}
	if c := ownedVerdictCount.Load(); c != 2 {
		t.Fatalf("counter %d after the purge, want 2", c)
	}
}

// L22: once an acquisition lands, InvalidateOwnedVerdict makes the next play
// ask Meili again instead of serving the stale owned=false for an hour.
func TestInvalidateOwnedVerdictReasksMeili(t *testing.T) {
	var calls int32
	var inLibrary atomic.Bool
	prevFn, prevNow := ownsTrackFn, ownedNow
	t.Cleanup(func() {
		ownsTrackFn, ownedNow = prevFn, prevNow
		resetOwnedVerdicts()
	})
	resetOwnedVerdicts()
	ownsTrackFn = func(videoId, title, artist string) bool {
		atomic.AddInt32(&calls, 1)
		return inLibrary.Load()
	}
	base := time.Now()
	ownedNow = func() time.Time { return base }

	if cachedOwnsTrack("acq00000001", "T", "A") {
		t.Fatalf("owned before the acquisition")
	}
	inLibrary.Store(true) // the download completed at t+2 min
	ownedNow = func() time.Time { return base.Add(2 * time.Minute) }
	if cachedOwnsTrack("acq00000001", "T", "A") || atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("memo must still serve the old verdict without invalidation (calls=%d)", calls)
	}

	InvalidateOwnedVerdict("acq00000001")
	if !cachedOwnsTrack("acq00000001", "T", "A") {
		t.Fatalf("still not owned after invalidation")
	}
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("%d Meili checks, want 2 (one before, one after the invalidation)", n)
	}
	if c := ownedVerdictCount.Load(); c != 1 {
		t.Fatalf("counter %d, want 1", c)
	}

	// unknown videoId: no-op, counter untouched
	InvalidateOwnedVerdict("neverSeen01")
	if c := ownedVerdictCount.Load(); c != 1 {
		t.Fatalf("counter %d after a no-op invalidation, want 1", c)
	}
}
