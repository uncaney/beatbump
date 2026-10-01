package api

// ST2 "À propos / État": size of the self-hosted library + the server build.
//
//   GET /api/v1/stats/library -> {tracks, albums, artists, lastAdded, version}
//
// Counts come from the Meili indexes (one 1-hit query each, the total is the
// estimate Meili returns); lastAdded is the dateAdded of the most recent
// track, RFC 3339 UTC when it parses as a timestamp (seconds or ms), else
// the raw value ("" when the index is empty or Meili is down).

import (
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
	Tracks    int    `json:"tracks"`
	Albums    int    `json:"albums"`
	Artists   int    `json:"artists"`
	LastAdded string `json:"lastAdded"`
	Version   string `json:"version"`
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
	out := libraryStats{Version: currentVersion()}
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
