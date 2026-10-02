package api

// ST2 "À propos / État": size of the self-hosted library + the server build.
//
//   GET /api/v1/stats/library -> {tracks, albums, artists, lastAdded, version, reportEmail?}
//
// Counts come from the Meili indexes (one 1-hit query each, the total is the
// estimate Meili returns); lastAdded is the dateAdded of the most recent
// track, RFC 3339 UTC when it parses as a timestamp (seconds or ms), else
// the raw value ("" when the index is empty or Meili is down).
// F13: reportEmail is the YTM_REPORT_EMAIL env (the /about "Signaler un
// problème" mailto recipient); omitted when unset, and /about then offers
// "Copier le diagnostic" instead of an empty composer.

import (
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// Version is the server build (main.version, set from -ldflags or
// YTM_VERSION); "dev" when neither is given.
var (
	versionMu sync.RWMutex
	version   = "dev"
)

// SetVersion records the build version reported by stats/library.
func SetVersion(v string) {
	versionMu.Lock()
	defer versionMu.Unlock()
	version = ResolveVersion(v, os.Getenv("YTM_VERSION"))
}

// ResolveVersion picks the build version: the linker value when set (and not
// the "dev" default), else the YTM_VERSION environment, else "dev".
func ResolveVersion(ldflag, env string) string {
	if v := strings.TrimSpace(ldflag); v != "" && v != "dev" {
		return v
	}
	if v := strings.TrimSpace(env); v != "" {
		return v
	}
	return "dev"
}

func currentVersion() string {
	versionMu.RLock()
	defer versionMu.RUnlock()
	return version
}

type libraryStats struct {
	Tracks      int    `json:"tracks"`
	Albums      int    `json:"albums"`
	Artists     int    `json:"artists"`
	LastAdded   string `json:"lastAdded"`
	Version     string `json:"version"`
	ReportEmail string `json:"reportEmail,omitempty"`
}

// reportEmail is YTM_REPORT_EMAIL when it looks like one address
// (`local@domain`, no spaces, no line breaks), else "".
func reportEmail(env string) string {
	v := strings.TrimSpace(env)
	at := strings.IndexByte(v, '@')
	if at <= 0 || at == len(v)-1 || strings.ContainsAny(v, " \t\r\n,;<>\"") || strings.Count(v, "@") != 1 {
		return ""
	}
	return v
}

// formatDateAdded renders a Meili dateAdded value: unix seconds / ms numbers
// become RFC 3339 UTC, strings are passed through, anything else is "".
func formatDateAdded(v interface{}) string {
	switch x := v.(type) {
	case float64:
		if x <= 0 {
			return ""
		}
		if x > 1e11 { // milliseconds
			return time.UnixMilli(int64(x)).UTC().Format(time.RFC3339)
		}
		return time.Unix(int64(x), 0).UTC().Format(time.RFC3339)
	case string:
		return strings.TrimSpace(x)
	}
	return ""
}

// countIndex asks Meili for the size of an index (plus its first hit sorted
// by `sort`, for lastAdded).
func countIndex(index string, sort []string, attrs []string) ([]map[string]interface{}, int) {
	payload := map[string]interface{}{"q": "", "offset": 0, "limit": 1, "attributesToRetrieve": attrs}
	if len(sort) > 0 {
		payload["sort"] = sort
	}
	return meiliBrowse(index, payload)
}

// LibraryStatsHandler: GET /api/v1/stats/library.
func LibraryStatsHandler(c echo.Context) error {
	out := libraryStats{Version: currentVersion(), ReportEmail: reportEmail(os.Getenv("YTM_REPORT_EMAIL"))}
	hits, total := countIndex("tracks", []string{"dateAdded:desc"}, []string{"dateAdded"})
	out.Tracks = total
	if len(hits) > 0 {
		out.LastAdded = formatDateAdded(hits[0]["dateAdded"])
	}
	_, out.Albums = countIndex("albums", nil, []string{"id"})
	_, out.Artists = countIndex("artists", nil, []string{"id"})
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.JSON(http.StatusOK, out)
}

// B8-22: GET /api/v1/local/lint, the /about "Bibliothèque" card's three
// counters (LIBRARY-LINT.md, lane c44c): albums without a usable year
// (B8-19's no-year filter), genres with at most one track (the "rare" fold
// of the Genres page, B8-21), and groups of near-duplicate artist names
// (case / accents / "feat." / punctuation only, local_match.go's matchNorm -
// LIBRARY-LINT section 4). The scans are the same bounded, read-only reads
// the duplicates and genres handlers already run (dupAlbumScanFn,
// genreTrackCounts): nothing new is indexed or decided here, memoised
// lintMemoTTL so /about costs one cache read most of the time.
const (
	lintMemoTTL = 10 * time.Minute
	// lintArtistScanCap/-Page bound the artists scan (the library holds
	// ~1900 distinct artists).
	lintArtistScanCap  = 4000
	lintArtistScanPage = 500
)

type libraryLint struct {
	AlbumsNoYear int `json:"albumsNoYear"`
	GenresRare   int `json:"genresRare"`
	ArtistGroups int `json:"artistGroups"`
}

var (
	lintMu      sync.Mutex
	lintMemo    *libraryLint
	lintMemoAt  time.Time
	lintMemoNow = time.Now // swapped by tests
)

// lintArtistScanFn reads one page of the artists index (name only); a
// variable for tests.
var lintArtistScanFn = func(off, lim int) ([]map[string]interface{}, int) {
	return meiliBrowse("artists", map[string]interface{}{
		"q": "", "offset": off, "limit": lim, "sort": []string{"name:asc"},
		"attributesToRetrieve": []string{"name"},
	})
}

// scanAlbumsNoYear reuses the duplicates handler's bounded albums scan
// (dupAlbumScanFn, dupScanCap/dupScanPage: newest-first, covers the whole
// library) and counts the albums with a missing/empty/unparsable year
// (yearOf), same test as B8-19's ?filter=no-year. ok is false when the scan
// read nothing (Meili down): such an answer is not memoised.
func scanAlbumsNoYear() (n int, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("lint: albums scan failed: %v", r)
			n, ok = 0, false
		}
	}()
	var docs []map[string]interface{}
	total, lastFull := 0, false
	for off := 0; off < dupScanCap; off += dupScanPage {
		page, t := dupAlbumScanFn(off, dupScanPage)
		docs = append(docs, page...)
		if t > total {
			total = t
		}
		lastFull = len(page) >= dupScanPage
		if !lastFull || (total > 0 && len(docs) >= total) {
			break
		}
	}
	if len(docs) == 0 {
		return 0, false
	}
	count := 0
	for _, a := range docs {
		if yearOf(mnumStr(a, "year")) == 0 {
			count++
		}
	}
	return count, true
}

// scanGenresRare reuses LocalGenresHandler's own facet + normalizeGenres
// (local_genres.go): a genre with at most one track is the "rare" noise the
// Genres page folds away (B8-21's same count<=1 test).
func scanGenresRare() int {
	entries := normalizeGenres(genreTrackCounts())
	n := 0
	for _, e := range entries {
		if e.Count <= 1 {
			n++
		}
	}
	return n
}

// scanArtistCloseGroups groups the artists index by matchNorm(name) (case,
// accents, "feat."/"&", punctuation - local_match.go, already used to group
// duplicate albums) and counts the groups holding more than one distinct
// name: the near-duplicate artist entries LIBRARY-LINT section 4 lists.
// Bounded by lintArtistScanCap. ok is false when the scan read nothing.
func scanArtistCloseGroups() (n int, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("lint: artists scan failed: %v", r)
			n, ok = 0, false
		}
	}()
	groups := map[string]map[string]bool{}
	total, lastFull, scanned := 0, false, 0
	for off := 0; off < lintArtistScanCap; off += lintArtistScanPage {
		page, t := lintArtistScanFn(off, lintArtistScanPage)
		if t > total {
			total = t
		}
		for _, a := range page {
			name := mstr(a, "name")
			if name == "" {
				continue
			}
			key := matchNorm(name)
			if key == "" {
				continue
			}
			if groups[key] == nil {
				groups[key] = map[string]bool{}
			}
			groups[key][name] = true
		}
		scanned += len(page)
		lastFull = len(page) >= lintArtistScanPage
		if !lastFull || (total > 0 && scanned >= total) {
			break
		}
	}
	if scanned == 0 {
		return 0, false
	}
	count := 0
	for _, names := range groups {
		if len(names) > 1 {
			count++
		}
	}
	return count, true
}

// scanLibraryLint is the full (unmemoised) computation of the three
// counters. ok is false when every scan it needs failed (Meili down): such
// an answer is not memoised.
func scanLibraryLint() (out libraryLint, ok bool) {
	noYear, okYear := scanAlbumsNoYear()
	groups, okGroups := scanArtistCloseGroups()
	if !okYear && !okGroups {
		return libraryLint{}, false
	}
	return libraryLint{AlbumsNoYear: noYear, GenresRare: scanGenresRare(), ArtistGroups: groups}, true
}

// libraryLintCached is scanLibraryLint behind a lintMemoTTL memo.
func libraryLintCached() libraryLint {
	lintMu.Lock()
	defer lintMu.Unlock()
	now := lintMemoNow()
	if lintMemo != nil && now.Sub(lintMemoAt) < lintMemoTTL {
		return *lintMemo
	}
	out, ok := scanLibraryLint()
	if ok {
		lintMemo, lintMemoAt = &out, now
	}
	if lintMemo != nil {
		return *lintMemo
	}
	return out
}

// resetLintMemo empties the lint memo (tests).
func resetLintMemo() {
	lintMu.Lock()
	lintMemo, lintMemoAt = nil, time.Time{}
	lintMu.Unlock()
}

// LocalLintHandler: GET /api/v1/local/lint (B8-22). Read-only; nothing is
// indexed, written or decided here.
func LocalLintHandler(c echo.Context) error {
	out := libraryLintCached()
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.JSON(http.StatusOK, out)
}
