package api

import (
	"testing"
	"time"
)

// L14-1: a page never waits on an alias scan. With a scan blocked on a
// channel, artistAliasCached answers at once: nil before the first scan,
// the previous groups during a rescan; the scan's result is read afterwards.
func TestArtistAliasCachedNeverWaitsForScan(t *testing.T) {
	resetArtistAliasMemo()
	t.Cleanup(resetArtistAliasMemo)
	orig, origNow := aliasArtistScanFn, aliasMemoNow
	t.Cleanup(func() { aliasArtistScanFn, aliasMemoNow = orig, origNow })
	was := aliasAutoRefresh.Load()
	aliasAutoRefresh.Store(false)
	t.Cleanup(func() { aliasAutoRefresh.Store(was) })

	clock := time.Unix(1_700_000_000, 0)
	aliasMemoNow = func() time.Time { return clock }
	gate := make(chan struct{})
	docs := []map[string]interface{}{aliasArtistDoc("AC/DC", 3, 30), aliasArtistDoc("AC-DC", 1, 10), aliasArtistDoc("Daft Punk", 5, 50)}
	aliasArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		<-gate // every scan waits until the test opens the gate
		if off > 0 {
			return nil, len(docs)
		}
		return docs, len(docs)
	}

	// A reader must answer within this while a scan is blocked.
	const patience = 500 * time.Millisecond
	readCached := func() ([]aliasGroup, map[string]int) {
		type res struct {
			g []aliasGroup
			i map[string]int
		}
		ch := make(chan res, 1)
		go func() {
			g, i := artistAliasCached()
			ch <- res{g, i}
		}()
		select {
		case r := <-ch:
			return r.g, r.i
		case <-time.After(patience):
			t.Fatalf("artistAliasCached blocked on the scan")
			return nil, nil
		}
	}

	// 1. First scan in flight (start-up warm): the reader gets nil, nil.
	scanDone := make(chan struct{})
	go func() {
		artistAliasGroups()
		close(scanDone)
	}()
	time.Sleep(20 * time.Millisecond) // let the goroutine reach the gate
	if g, i := readCached(); g != nil || i != nil {
		t.Fatalf("before the first scan: %v %v, want nil, nil", g, i)
	}
	gate <- struct{}{}
	<-scanDone
	g, _ := readCached()
	if len(g) != 1 || g[0].Name != "AC/DC" {
		t.Fatalf("after the first scan: %+v", g)
	}

	// 2. Memo stale, rescan in flight: the reader gets the previous groups.
	clock = clock.Add(aliasMemoTTL + time.Second)
	rescanDone := make(chan struct{})
	go func() {
		artistAliasGroups()
		close(rescanDone)
	}()
	time.Sleep(20 * time.Millisecond)
	if g, _ := readCached(); len(g) != 1 || g[0].Name != "AC/DC" {
		t.Fatalf("during the rescan: %+v, want the previous snapshot", g)
	}
	// A second artistAliasGroups caller shares the running scan (one gate
	// release serves both).
	sharedDone := make(chan struct{})
	go func() {
		artistAliasGroups()
		close(sharedDone)
	}()
	time.Sleep(20 * time.Millisecond)
	gate <- struct{}{}
	<-rescanDone
	select {
	case <-sharedDone:
	case <-time.After(patience):
		t.Fatalf("the queued caller did not share the scan")
	}
	if g, _ := readCached(); len(g) != 1 {
		t.Fatalf("after the rescan: %+v", g)
	}
}

// L14-1 for the lint: with a stale memo and a rescan blocked, /about's
// counters are the previous ones at once; without a memo the callers wait
// for one shared scan.
func TestLibraryLintCachedServesStaleDuringRescan(t *testing.T) {
	resetLintMemo()
	t.Cleanup(resetLintMemo)
	origAlbums, origArtists, origNow := dupAlbumScanFn, lintArtistScanFn, lintMemoNow
	t.Cleanup(func() { dupAlbumScanFn, lintArtistScanFn, lintMemoNow = origAlbums, origArtists, origNow })
	t.Setenv("MEILI_URL", "http://127.0.0.1:1") // genres facet: refused at once, 0 rare
	clock := time.Unix(1_700_000_000, 0)
	lintMemoNow = func() time.Time { return clock }
	gate := make(chan struct{})
	noYear := 2
	dupAlbumScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		<-gate
		if off > 0 {
			return nil, 3
		}
		docs := []map[string]interface{}{{"id": "lb-1", "year": "2024"}}
		for i := 0; i < noYear; i++ {
			docs = append(docs, map[string]interface{}{"id": "lb-x", "year": ""})
		}
		return docs, len(docs)
	}
	lintArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		if off > 0 {
			return nil, 2
		}
		return []map[string]interface{}{{"name": "AC-DC"}, {"name": "AC/DC"}}, 2
	}
	call := func() chan libraryLint {
		ch := make(chan libraryLint, 1)
		go func() { ch <- libraryLintCached() }()
		return ch
	}
	first := call()
	time.Sleep(20 * time.Millisecond)
	gate <- struct{}{}
	if out := <-first; out.AlbumsNoYear != 2 || out.ArtistGroups != 1 {
		t.Fatalf("first scan: %+v", out)
	}
	// Stale: the rescan blocks, a concurrent caller gets the old counters now.
	clock = clock.Add(lintMemoTTL + time.Second)
	noYear = 5
	rescan := call()
	time.Sleep(20 * time.Millisecond)
	select {
	case out := <-call():
		if out.AlbumsNoYear != 2 {
			t.Fatalf("during the rescan: %+v, want the previous counters", out)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("libraryLintCached blocked on the rescan")
	}
	gate <- struct{}{}
	if out := <-rescan; out.AlbumsNoYear != 5 {
		t.Fatalf("rescan: %+v", out)
	}
	if out := libraryLintCached(); out.AlbumsNoYear != 5 {
		t.Fatalf("after the rescan: %+v", out)
	}
}
