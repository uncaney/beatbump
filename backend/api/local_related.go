package api

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

// LocalRelatedHandler answers GET /api/v1/local/related with owned-library
// tracks related to the current one ("Dans ta bibliothèque" in the Related tab).
// Seed: ?lid=<11 hex> (local track) or ?title=&artist= (a YouTube track is
// matched against the index by its metadata). The pool is the radio pool
// (same artist, same genre, library sample), shuffled, seed excluded.
func LocalRelatedHandler(c echo.Context) error {
	lid := strings.TrimSpace(c.QueryParam("lid"))
	title := strings.TrimSpace(c.QueryParam("title"))
	artist := strings.TrimSpace(c.QueryParam("artist"))
	var seed map[string]interface{}
	if isLid(lid) {
		seed = meiliByLid(lid)
	} else if title != "" {
		seed = meiliSeedByMetadata(title, artist)
		if seed != nil {
			lid = mstr(seed, "lid")
		}
	}
	if seed == nil {
		return c.JSON(http.StatusNotFound, map[string]interface{}{"error": "not_found", "items": []Item{}})
	}
	items := localRadio(seed, lid)
	if len(items) > 20 {
		items = items[:20]
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "seed": lid})
}

// meiliSeedByMetadata finds the owned track that best matches a title/artist
// pair (first full-text hit whose title matches case-insensitively).
func meiliSeedByMetadata(title, artist string) map[string]interface{} {
	q := strings.TrimSpace(title + " " + artist)
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": q, "limit": 5,
		"attributesToRetrieve": []string{"title", "artist", "albumArtist", "album", "genre", "path", "durationSec", "lid", "track"},
	})
	want := strings.ToLower(title)
	for _, h := range hits {
		if strings.ToLower(mstr(h, "title")) == want && mstr(h, "lid") != "" {
			return h
		}
	}
	for _, h := range hits {
		if mstr(h, "lid") != "" && strings.Contains(strings.ToLower(mstr(h, "title")), want) {
			return h
		}
	}
	return nil
}
