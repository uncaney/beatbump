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
// L12-7 (audit logic v12): the pick of a date is PERSISTED (settings row
// "album-of-day:<date>", the album doc as JSON) the first time it is made, so
// it survives restarts, promotions and acquisitions that move the index
// order; the previous-day skip reads the persisted previous day when there is
// one. A pick made while a Meili window failed is neither persisted nor
// memoised. ?date= is bounded to today +/- albumDayDateRange days. The
// answers of the last albumDayMemoMax dates are kept in an LRU memo.
// Acquisition dates are not used anywhere: they are mostly the June 2026
// migration.

import (
	"encoding/json"
	"hash/fnv"
	"net/http"
	"strings"
	"sync"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm/clause"
)

const (
	albumDayMinTracks = 4
	albumDayWindow    = 50
	albumDayMaxScan   = 600
	albumDayMemoMax   = 8
	albumDayChain     = 3
	// albumDayDateRange bounds ?date= around today (days).
	albumDayDateRange = 366
	// albumDayKeep: persisted picks older than this many days are pruned.
	albumDayKeep = 400
	// albumDaySettingPrefix + "YYYY-MM-DD" is the settings key of a pick.
	albumDaySettingPrefix = "album-of-day:"
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
	doc, _ := pickAlbumOfDayOK(date, total, fetch, skip)
	return doc
}

// pickAlbumOfDayOK is pickAlbumOfDay plus ok=false when a window came back
// empty (Meili slow or down): such a pick must not be kept for the day.
func pickAlbumOfDayOK(date string, total int, fetch func(off, lim int) []map[string]interface{}, skip string) (map[string]interface{}, bool) {
	if total <= 0 {
		return nil, true
	}
	start := int(albumDaySeed(date) % uint64(total))
	scanned := 0
	off := start
	ok := true
	for scanned < albumDayMaxScan && scanned < total {
		lim := albumDayWindow
		if off+lim > total {
			lim = total - off
		}
		docs := fetch(off, lim)
		if lim > 0 && len(docs) == 0 {
			ok = false
		}
		for _, d := range docs {
			if albumDayEligible(d) && mstr(d, "id") != skip {
				return d, ok
			}
		}
		scanned += lim
		off += lim
		if off >= total {
			off = 0
		}
	}
	return nil, ok
}

// albumOfDayChained resolves the album of `day`: the chain starts
// albumDayChain days earlier with a free pick, and each day skips the album
// of the day before it.
func albumOfDayChained(day time.Time, total int, fetch func(off, lim int) []map[string]interface{}) map[string]interface{} {
	doc, _ := albumOfDayResolve(day, total, fetch, nil)
	return doc
}

// albumOfDayResolve is the chain with persisted days: a day of the chain
// that already has a stored pick (`stored(date)`, "" when none) uses it
// instead of recomputing, so today's skip is the album really shown
// yesterday. ok is false when one of the computed picks hit a failed window.
func albumOfDayResolve(day time.Time, total int, fetch func(off, lim int) []map[string]interface{}, stored func(date string) string) (map[string]interface{}, bool) {
	var doc map[string]interface{}
	prev := ""
	ok := true
	for i := albumDayChain; i >= 0; i-- {
		date := day.AddDate(0, 0, -i).Format("2006-01-02")
		if i > 0 && stored != nil {
			if id := stored(date); id != "" {
				prev = id
				continue
			}
		}
		var dayOK bool
		doc, dayOK = pickAlbumOfDayOK(date, total, fetch, prev)
		ok = ok && dayOK
		prev = mstr(doc, "id")
	}
	return doc, ok
}

var (
	albumDayMu    sync.Mutex
	albumDayMemo  = map[string]map[string]interface{}{}
	albumDayOrder []string // LRU order of albumDayMemo keys, oldest first
	// albumDayNow is swapped by tests.
	albumDayNow = time.Now
)

func resetAlbumDayMemo() {
	albumDayMu.Lock()
	defer albumDayMu.Unlock()
	albumDayMemo = map[string]map[string]interface{}{}
	albumDayOrder = nil
}

// albumDayMemoGet reads the memo and marks `date` as recently used.
func albumDayMemoGet(date string) (map[string]interface{}, bool) {
	albumDayMu.Lock()
	defer albumDayMu.Unlock()
	v, ok := albumDayMemo[date]
	if ok {
		albumDayTouch(date)
	}
	return v, ok
}

// albumDayMemoPut stores an answer, evicting the least recently used date
// beyond albumDayMemoMax (never a wholesale reset: L12-7).
func albumDayMemoPut(date string, resp map[string]interface{}) {
	albumDayMu.Lock()
	defer albumDayMu.Unlock()
	albumDayMemo[date] = resp
	albumDayTouch(date)
	for len(albumDayOrder) > albumDayMemoMax {
		delete(albumDayMemo, albumDayOrder[0])
		albumDayOrder = albumDayOrder[1:]
	}
}

// albumDayTouch moves `date` to the recent end (albumDayMu held).
func albumDayTouch(date string) {
	for i, d := range albumDayOrder {
		if d == date {
			albumDayOrder = append(albumDayOrder[:i], albumDayOrder[i+1:]...)
			break
		}
	}
	albumDayOrder = append(albumDayOrder, date)
}

// albumDayLoad reads the persisted pick of `date` (nil when none, or when
// the database is unavailable). A variable for tests.
var albumDayLoad = func(date string) map[string]interface{} {
	if db.DB == nil {
		return nil
	}
	var row db.Setting
	if err := db.DB.Where("key = ?", albumDaySettingPrefix+date).Limit(1).Find(&row).Error; err != nil || row.Value == "" {
		return nil
	}
	var doc map[string]interface{}
	if json.Unmarshal([]byte(row.Value), &doc) != nil || !isLocalAlbum(mstr(doc, "id")) {
		return nil
	}
	return doc
}

// albumDayStore persists the pick of `date` (first writer wins: an existing
// row is kept, so two replicas racing on the same day agree on the first
// stored album) and prunes picks older than albumDayKeep days. It returns
// the doc actually stored for the date.
var albumDayStore = func(date string, doc map[string]interface{}) map[string]interface{} {
	if db.DB == nil {
		return doc
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return doc
	}
	key := albumDaySettingPrefix + date
	if err := db.DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&db.Setting{Key: key, Value: string(raw)}).Error; err != nil {
		return doc
	}
	if d, err := time.Parse("2006-01-02", date); err == nil {
		cut := albumDaySettingPrefix + d.AddDate(0, 0, -albumDayKeep).Format("2006-01-02")
		db.DB.Where("key LIKE ? AND key < ?", albumDaySettingPrefix+"%", cut).Delete(&db.Setting{})
	}
	if stored := albumDayLoad(date); stored != nil {
		return stored
	}
	return doc
}

// albumDayFetch reads a window of the albums index in the pick's stable order.
func albumDayFetch(off, lim int) []map[string]interface{} {
	return meiliSearchIndex("albums", map[string]interface{}{
		"q": "", "offset": off, "limit": lim, "sort": []string{"album:asc"},
		"attributesToRetrieve": albumDocAttrs,
	})
}

// albumOfDay builds (or reads from the memo / the persisted pick) the
// answer for `date`.
func albumOfDay(date string, day time.Time) map[string]interface{} {
	if v, ok := albumDayMemoGet(date); ok {
		return v
	}
	expires := day.AddDate(0, 0, 1).Format(time.RFC3339)
	doc := albumDayLoad(date)
	if doc == nil {
		_, total := meiliBrowse("albums", map[string]interface{}{"q": "", "limit": 0})
		stored := func(d string) string { return mstr(albumDayLoad(d), "id") }
		picked, ok := albumOfDayResolve(day, total, albumDayFetch, stored)
		if picked == nil {
			return map[string]interface{}{"album": nil, "reason": "empty", "date": date, "expires": expires}
		}
		if !ok {
			// A window failed: answer, but keep nothing for the day.
			return albumDayAnswer(picked, date, expires)
		}
		doc = albumDayStore(date, picked)
	}
	resp := albumDayAnswer(doc, date, expires)
	albumDayMemoPut(date, resp)
	return resp
}

// albumDayAnswer is the JSON answer for an album doc.
func albumDayAnswer(doc map[string]interface{}, date, expires string) map[string]interface{} {
	songs := []IListItemRenderer{}
	for _, t := range albumTracks(mstr(doc, "album"), mstr(doc, "albumArtist")) {
		if mstr(t, "lid") != "" {
			songs = append(songs, localSongItem(t))
		}
	}
	return map[string]interface{}{
		"album":      localAlbumItem(doc),
		"year":       mnumStr(doc, "year"),
		"trackCount": mint(doc, "trackCount"),
		"tracks":     songs,
		"reason":     "du jour",
		"date":       date,
		"expires":    expires,
	}
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
		if diff := d.Sub(day); diff > albumDayDateRange*24*time.Hour || diff < -albumDayDateRange*24*time.Hour {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "date out of range (today +/- 366 days): " + raw})
		}
		day = d
	}
	return c.JSON(http.StatusOK, albumOfDay(day.Format("2006-01-02"), day))
}
