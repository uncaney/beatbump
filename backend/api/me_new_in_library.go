package api

// EQ3 "Nouveautés de tes artistes" (c29b): local albums recently added to
// the library by artists the profile cares about. Local only: nothing is
// acquired here, the row only surfaces what the library already holds.
//
//	GET /api/v1/me/new-in-library?days=30&limit=12
//
// "Your artists" = the profile's follows (me/follows: la- ids or YouTube
// UC… ids, with the artist name) + its top 20 artists by plays, all time
// (the me/stats/top?by=artists aggregation). An album matches when its
// artistId is a followed id, or its albumArtist (case-insensitive, or its
// derived la- id) is a followed / top artist name. Albums are read newest
// first (dateAdded desc, epoch seconds) and the scan stops at the cutoff,
// bounded by newInLibraryScanCap.

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

const (
	newInLibraryDefDays  = 30
	newInLibraryMaxDays  = 365
	newInLibraryTopN     = 20
	newInLibraryPage     = 200
	newInLibraryScanCap  = 1000
	newInLibraryDefLimit = 12
	newInLibraryMaxLimit = 50
)

// newInLibraryDays parses ?days= (default 30, clamped to 1..365).
func newInLibraryDays(c echo.Context) int {
	n, err := strconv.Atoi(strings.TrimSpace(c.QueryParam("days")))
	if err != nil || n <= 0 {
		return newInLibraryDefDays
	}
	if n > newInLibraryMaxDays {
		return newInLibraryMaxDays
	}
	return n
}

// artistSet is who the profile cares about: artist ids (la-… / UC…) and
// lower-cased names.
type artistSet struct {
	ids   map[string]bool
	names map[string]bool
}

func (a artistSet) empty() bool { return len(a.ids) == 0 && len(a.names) == 0 }

// matchesAlbum reports whether an albums-index doc belongs to one of the
// profile's artists.
func (a artistSet) matchesAlbum(doc map[string]interface{}) bool {
	if aid := mstr(doc, "artistId"); aid != "" && a.ids[aid] {
		return true
	}
	aa := strings.ToLower(strings.TrimSpace(mstr(doc, "albumArtist")))
	if aa == "" {
		return false
	}
	return a.names[aa] || a.ids[artistID(aa)]
}

// profileArtists folds the follows and the all-time top artists of a
// profile into an artistSet.
func profileArtists(pid string) artistSet {
	set := artistSet{ids: map[string]bool{}, names: map[string]bool{}}
	add := func(id, name string) {
		if id = strings.TrimSpace(id); id != "" {
			set.ids[id] = true
		}
		if name = strings.ToLower(strings.TrimSpace(name)); name != "" {
			set.names[name] = true
			set.ids[artistID(name)] = true
		}
	}
	var fol []db.Follow
	db.DB.Where("profile_id = ?", pid).Find(&fol)
	for _, f := range fol {
		add(f.ArtistID, f.Name)
	}
	for _, e := range aggregateBy(windowRows(pid, 0), "artists", newInLibraryTopN) {
		add(e.ArtistID, e.Title)
	}
	return set
}

// albumDateAdded reads the epoch-seconds dateAdded of an albums doc.
func albumDateAdded(doc map[string]interface{}) int64 {
	if v, ok := doc["dateAdded"].(float64); ok {
		return int64(v)
	}
	return 0
}

// newAlbumsFor scans the albums index newest first and keeps the albums
// of `set` added since `cutoff`, up to limit.
func newAlbumsFor(set artistSet, cutoff time.Time, limit int) []IListItemRenderer {
	items := make([]IListItemRenderer, 0, limit)
	cut := cutoff.Unix()
	for off := 0; off < newInLibraryScanCap && len(items) < limit; off += newInLibraryPage {
		hits, _ := meiliBrowse("albums", map[string]interface{}{
			"q": "", "offset": off, "limit": newInLibraryPage, "sort": []string{"dateAdded:desc"},
			"attributesToRetrieve": []string{"id", "album", "albumArtist", "artistId", "year", "coverLid", "trackCount", "dateAdded"},
		})
		if len(hits) == 0 {
			break
		}
		stop := false
		for _, a := range hits {
			if albumDateAdded(a) < cut {
				stop = true
				break
			}
			if mstr(a, "id") == "" || mstr(a, "album") == "" || !set.matchesAlbum(a) {
				continue
			}
			items = append(items, localAlbumItem(a))
			if len(items) >= limit {
				break
			}
		}
		if stop || len(hits) < newInLibraryPage {
			break
		}
	}
	return items
}

// MeNewInLibraryHandler: GET /api/v1/me/new-in-library?days=30&limit=12.
func MeNewInLibraryHandler(c echo.Context) error {
	pid := profileID(c)
	days := newInLibraryDays(c)
	limit := clampLimit(c, newInLibraryDefLimit, newInLibraryMaxLimit)
	set := profileArtists(pid)
	if set.empty() {
		return c.JSON(http.StatusOK, map[string]interface{}{"items": []IListItemRenderer{}, "days": days})
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	items := newAlbumsFor(set, cutoff, limit)
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "days": days})
}
