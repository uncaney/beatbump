package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// B8-22: GET /api/v1/local/lint answers the three /about counters, reusing
// the duplicates handler's bounded albums scan (dupAlbumScanFn) and the
// genres handler's facet (genreTrackCounts, a network call: stubbed here),
// plus its own bounded artists scan (lintArtistScanFn) grouped by matchNorm.
func TestLocalLintHandler(t *testing.T) {
	resetLintMemo()
	t.Cleanup(resetLintMemo)

	origAlbums, origArtists := dupAlbumScanFn, lintArtistScanFn
	t.Cleanup(func() { dupAlbumScanFn, lintArtistScanFn = origAlbums, origArtists })

	// 5 albums: 2 with no usable year (empty, garbage), 3 with a real one.
	dupAlbumScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		if off > 0 {
			return nil, 5
		}
		return []map[string]interface{}{
			{"id": "lb-1", "year": "2024"},
			{"id": "lb-2", "year": ""},
			{"id": "lb-3", "year": "Unknown"},
			{"id": "lb-4", "year": "2010"},
			{"id": "lb-5", "year": "1999"},
		}, 5
	}
	// 6 artist names: one "feat." group of 2 ("Ed Sheeran" / "Ed Sheeran feat.
	// Camila Cabello" both normalise without the feat. tail), one case/accent
	// group of 2 ("Alt-J" / "alt‐J"), and two singletons.
	lintArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		if off > 0 {
			return nil, 6
		}
		return []map[string]interface{}{
			{"name": "Ed Sheeran"},
			{"name": "Ed Sheeran feat. Camila Cabello"},
			{"name": "Alt-J"},
			{"name": "alt‐J"},
			{"name": "Daft Punk"},
			{"name": "Gorillaz"},
		}, 6
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only genreTrackCounts (tracks facet) reaches the network in this test.
		resp := map[string]interface{}{
			"hits": []interface{}{},
			"facetDistribution": map[string]interface{}{
				"genre": map[string]interface{}{
					"Rock":  10.0,
					"Indie": 1.0, // rare: 1 track
					"Lofi":  1.0, // rare: 1 track
				},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)

	resp := getJSON(t, LocalLintHandler, "/api/v1/local/lint")
	if got := resp["albumsNoYear"].(float64); got != 2 {
		t.Fatalf("albumsNoYear = %v, want 2", got)
	}
	if got := resp["genresRare"].(float64); got != 2 {
		t.Fatalf("genresRare = %v, want 2", got)
	}
	if got := resp["artistGroups"].(float64); got != 2 {
		t.Fatalf("artistGroups = %v, want 2", got)
	}
}

// The three sub-scans used directly: yearOf / matchNorm / normalizeGenres
// are exercised elsewhere; this only checks the grouping and counting glue.
func TestScanArtistCloseGroups(t *testing.T) {
	orig := lintArtistScanFn
	t.Cleanup(func() { lintArtistScanFn = orig })
	lintArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		if off > 0 {
			return nil, 4
		}
		return []map[string]interface{}{
			{"name": "AC-DC"},
			{"name": "AC/DC"},
			{"name": "Solo Artist"},
			{"name": ""}, // blank names are skipped
		}, 4
	}
	n, ok := scanArtistCloseGroups()
	if !ok || n != 1 {
		t.Fatalf("scanArtistCloseGroups = %d, %v, want 1, true", n, ok)
	}
}

func TestScanAlbumsNoYearMeiliDown(t *testing.T) {
	resetNoYearAlbumsMemo()
	t.Cleanup(resetNoYearAlbumsMemo)
	orig := dupAlbumScanFn
	t.Cleanup(func() { dupAlbumScanFn = orig })
	dupAlbumScanFn = func(off, lim int) ([]map[string]interface{}, int) { return nil, 0 }
	if docs, ok := scanNoYearAlbumDocs(); ok || len(docs) != 0 {
		t.Fatalf("scanNoYearAlbumDocs = %d, %v, want 0, false", len(docs), ok)
	}
	// Nothing memoised: the cached reader says so too.
	if docs, ok := noYearAlbumsCached(); ok || len(docs) != 0 {
		t.Fatalf("noYearAlbumsCached = %d, %v, want 0, false", len(docs), ok)
	}
}

// L14-4: /about's counter and ?filter=no-year read the same memoised scan
// (one scan serves both, the counter equals the list's total).
func TestNoYearCounterAndFilterShareOneScan(t *testing.T) {
	resetLintMemo()
	t.Cleanup(resetLintMemo)
	useTestDB(t)
	orig, origArtists := dupAlbumScanFn, lintArtistScanFn
	t.Cleanup(func() { dupAlbumScanFn, lintArtistScanFn = orig, origArtists })
	scans := 0
	dupAlbumScanFn = func(off, lim int) ([]map[string]interface{}, int) {
		if off == 0 {
			scans++
		}
		if off > 0 {
			return nil, 4
		}
		return []map[string]interface{}{
			{"id": "lb-1", "album": "Zeta", "albumArtist": "A", "artistId": "la-a", "year": "2024", "dateAdded": 4000.0},
			{"id": "lb-2", "album": "Blank", "albumArtist": "B", "artistId": "la-b", "year": "", "dateAdded": 3000.0},
			{"id": "lb-3", "album": "Garbage", "albumArtist": "A", "artistId": "la-a", "year": "Unknown", "dateAdded": 2000.0},
			{"id": "lb-4", "album": "Missing", "albumArtist": "C", "artistId": "la-c", "dateAdded": 1000.0},
		}, 4
	}
	lintArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) { return nil, 0 }
	t.Setenv("MEILI_URL", "http://127.0.0.1:1") // genres facet refused at once

	lint := getJSON(t, LocalLintHandler, "/api/v1/local/lint")
	list := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=no-year")
	if lint["albumsNoYear"].(float64) != 3 || list["total"].(float64) != 3 {
		t.Fatalf("counter %v, list total %v, want 3 / 3", lint["albumsNoYear"], list["total"])
	}
	if got := albumTitles(list); len(got) != 3 || got[0] != "Blank" || got[1] != "Garbage" || got[2] != "Missing" {
		t.Fatalf("no-year list: %v", got)
	}
	byArtist := getJSON(t, LocalAlbumsHandler, "/api/v1/local/albums?filter=no-year&artistId=la-a")
	if got := albumTitles(byArtist); len(got) != 1 || got[0] != "Garbage" || byArtist["total"].(float64) != 1 {
		t.Fatalf("no-year for one artist: %v", got)
	}
	if scans != 1 {
		t.Fatalf("%d album scans, want 1 (shared memo)", scans)
	}
}
