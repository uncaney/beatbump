package api

// c39b B6-1 "Album du jour": one local album per UTC day, the same for every
// profile (anonymous included: no history is read), so the home has a useful
// card even on a fresh phone.
//
//	GET /api/v1/local/album-of-day[?date=YYYY-MM-DD]
//	  -> {"album": <album card>, "year": "1997", "trackCount": 12,
//	      "tracks": [<song items>], "reason": "du jour",
//	      "date": "2026-10-01", "expires": "2026-10-02T00:00:00Z"}
//	  -> {"album": null, "reason": "empty", "date": ...} when no album qualifies
//
// The pick is seeded by the date: FNV-1a("YYYY-MM-DD") modulo the album
// count gives an offset into the albums index in a stable order (album:asc);
// from there the first album with >= albumDayMinTracks tracks (trackCount of
// the album doc; a doc without one is skipped) wins, scanning forward and
// wrapping, at most albumDayMaxScan docs. A pick equal to the previous day's
// album is skipped; the previous day is itself resolved over a short chain
// (albumDayChain days back, each skipping its own previous day), so two
// consecutive days show different albums (a residual collision needs a
// seed collision inside the chain window: never seen on 6 800 albums).
// The answer is memoised per date (bounded map) until the date is over: the
// memo key IS the UTC date, so it rolls over at midnight UTC by itself.
// Acquisition dates are not used anywhere: they are mostly the June 2026
// migration.

import (
	"hash/fnv"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

const (
	albumDayMinTracks = 4
	albumDayWindow    = 50
	albumDayMaxScan   = 600
	albumDayMemoMax   = 8
	albumDayChain     = 3
)

// albumDaySeed is the deterministic seed of a date string.
func albumDaySeed(date string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(date))
	return h.Sum64()
}

// albumDayEligible: a local album (lb- id) with enough tracks.
func albumDayEligible(doc map[string]interface{}) bool {
	return isLocalAlbum(mstr(doc, "id")) && mint(doc, "trackCount") >= albumDayMinTracks
}

// pickAlbumOfDay returns the album of `date` among `total` albums read
// through `fetch(offset, limit)` (a stable order), skipping the album id
// `skip`; nil when nothing qualifies within albumDayMaxScan docs.
func pickAlbumOfDay(date string, total int, fetch func(off, lim int) []map[string]interface{}, skip string) map[string]interface{} {
	if total <= 0 {
		return nil
	}
	start := int(albumDaySeed(date) % uint64(total))
	scanned := 0
	off := start
	for scanned < albumDayMaxScan && scanned < total {
		lim := albumDayWindow
		if off+lim > total {
			lim = total - off
		}
		docs := fetch(off, lim)
		for _, d := range docs {
			if albumDayEligible(d) && mstr(d, "id") != skip {
				return d
			}
		}
		scanned += lim
		off += lim
		if off >= total {
			off = 0
		}
	}
	return nil
}

// albumOfDayChained resolves the album of `day`: the chain starts
// albumDayChain days earlier with a free pick, and each day skips the album
// of the day before it.
func albumOfDayChained(day time.Time, total int, fetch func(off, lim int) []map[string]interface{}) map[string]interface{} {
	var doc map[string]interface{}
	prev := ""
	for i := albumDayChain; i >= 0; i-- {
		doc = pickAlbumOfDay(day.AddDate(0, 0, -i).Format("2006-01-02"), total, fetch, prev)
		prev = mstr(doc, "id")
	}
	return doc
}

var (
	albumDayMu   sync.Mutex
	albumDayMemo = map[string]map[string]interface{}{}
	// albumDayNow is swapped by tests.
	albumDayNow = time.Now
)

func resetAlbumDayMemo() {
	albumDayMu.Lock()
	defer albumDayMu.Unlock()
	albumDayMemo = map[string]map[string]interface{}{}
}

// albumDayFetch reads a window of the albums index in the pick's stable order.
func albumDayFetch(off, lim int) []map[string]interface{} {
	return meiliSearchIndex("albums", map[string]interface{}{
		"q": "", "offset": off, "limit": lim, "sort": []string{"album:asc"},
		"attributesToRetrieve": albumDocAttrs,
	})
}

// albumOfDay builds (or reads from the memo) the answer for `date`.
func albumOfDay(date string, day time.Time) map[string]interface{} {
	albumDayMu.Lock()
	if v, ok := albumDayMemo[date]; ok {
		albumDayMu.Unlock()
		return v
	}
	albumDayMu.Unlock()

	_, total := meiliBrowse("albums", map[string]interface{}{"q": "", "limit": 0})
	expires := day.AddDate(0, 0, 1).Format(time.RFC3339)
	doc := albumOfDayChained(day, total, albumDayFetch)
	if doc == nil {
		return map[string]interface{}{"album": nil, "reason": "empty", "date": date, "expires": expires}
	}
	songs := []IListItemRenderer{}
	for _, t := range albumTracks(mstr(doc, "album"), mstr(doc, "albumArtist")) {
		if mstr(t, "lid") != "" {
			songs = append(songs, localSongItem(t))
		}
	}
	resp := map[string]interface{}{
		"album":      localAlbumItem(doc),
		"year":       mnumStr(doc, "year"),
		"trackCount": mint(doc, "trackCount"),
		"tracks":     songs,
		"reason":     "du jour",
		"date":       date,
		"expires":    expires,
	}
	albumDayMu.Lock()
	defer albumDayMu.Unlock()
	if len(albumDayMemo) >= albumDayMemoMax {
		albumDayMemo = map[string]map[string]interface{}{}
	}
	albumDayMemo[date] = resp
	return resp
}

// LocalAlbumOfDayHandler: GET /api/v1/local/album-of-day[?date=YYYY-MM-DD].
func LocalAlbumOfDayHandler(c echo.Context) error {
	now := albumDayNow().UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if raw := strings.TrimSpace(c.QueryParam("date")); raw != "" {
		d, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "date must be YYYY-MM-DD: " + raw})
		}
		day = d
	}
	return c.JSON(http.StatusOK, albumOfDay(day.Format("2006-01-02"), day))
}
