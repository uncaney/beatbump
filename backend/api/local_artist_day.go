package api

// c44a B7-1 "Un artiste jamais ecoute par jour": one local artist per UTC
// day, chosen among the artists with >= artistDayMinAlbums albums. For a
// NAMED profile the artist is one the profile never played (no play row
// names it, by artist name or artist id); for an anonymous profile (or
// without a profile cookie) the pick is made over the whole library, the
// same for everyone that day.
//
//	GET /api/v1/local/artist-of-the-day[?date=YYYY-MM-DD]
//	  -> {"artist": <artist card>, "name": "Daft Punk", "albumCount": 3,
//	      "trackCount": 31, "scope": "profile" | "library",
//	      "reason": "du jour" | "all_played",
//	      "date": "2026-10-02", "expires": "2026-10-03T00:00:00Z"}
//	  -> {"artist": null, "reason": "empty", "scope": ..., "date": ..., "expires": ...}
//
// The pick follows the album of the day (local_album_day.go): the seed is
// FNV-1a("YYYY-MM-DD") modulo the artist count, an offset into the artists
// index in a stable order (name:asc); from there the first artist with
// enough albums that the profile never played wins, scanning forward and
// wrapping, at most artistDayMaxScan docs. Yesterday's artist (the persisted
// pick of the day before, same scope) is skipped when another candidate
// exists. When every candidate of the scan was played (reason "all_played")
// the library pick of the day is answered instead, so the card never goes
// blank for a heavy listener.
//
// Persistence (like L12-7): the pick is stored the first time it is made,
// settings row "artist-of-day:<date>" for the library scope and
// "artist-of-day:<date>:<profile>" for a named profile, so it survives
// restarts and acquisitions that move the index order. A pick made while a
// Meili window failed is neither persisted nor memoised. ?date= is bounded
// to today +/- artistDayDateRange days. The last artistDayMemoMax answers
// are kept in an LRU memo keyed by (date, profile).

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm/clause"
)

const (
	artistDayMinAlbums = 2
	artistDayWindow    = 100
	artistDayMaxScan   = 1000
	artistDayMemoMax   = 32
	// artistDayDateRange bounds ?date= around today (days).
	artistDayDateRange = 366
	// artistDayKeep: persisted picks older than this many days are pruned.
	artistDayKeep = 400
	// artistDaySettingPrefix + "YYYY-MM-DD"[ + ":" + profile] is the settings key of a pick.
	artistDaySettingPrefix = "artist-of-day:"
	// artistDayReasonKey carries the reason inside the persisted doc.
	artistDayReasonKey = "dayReason"
	artistDayReasonOK  = "du jour"
	artistDayReasonAll = "all_played"
)

// artistDocAttrs is what the card needs from an artists doc.
var artistDocAttrs = []string{"id", "name", "albumCount", "trackCount"}

// artistDayEligible: a local artist (la- id) with enough albums.
func artistDayEligible(doc map[string]interface{}) bool {
	return strings.HasPrefix(mstr(doc, "id"), "la-") && mstr(doc, "name") != "" && mint(doc, "albumCount") >= artistDayMinAlbums
}

// pickArtistOfDayOK returns the artist of `date` among `total` artists read
// through `fetch(offset, limit)` (a stable order), skipping the eligible
// docs `skip` rejects; nil when nothing qualifies within artistDayMaxScan
// docs. ok is false when a window came back empty (Meili slow or down):
// such a pick must not be kept for the day.
func pickArtistOfDayOK(date string, total int, fetch func(off, lim int) []map[string]interface{}, skip func(doc map[string]interface{}) bool) (map[string]interface{}, bool) {
	if total <= 0 {
		return nil, true
	}
	start := int(albumDaySeed(date) % uint64(total))
	scanned := 0
	off := start
	ok := true
	for scanned < artistDayMaxScan && scanned < total {
		lim := artistDayWindow
		if off+lim > total {
			lim = total - off
		}
		docs := fetch(off, lim)
		if lim > 0 && len(docs) == 0 {
			ok = false
		}
		for _, d := range docs {
			if artistDayEligible(d) && (skip == nil || !skip(d)) {
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

// playedArtists folds a profile's play history for the artist checks: every
// distinct artist credit the play rows carry, normalised (playedArtistNames),
// and every artist id.
type playedArtists struct {
	names map[string]bool
	ids   map[string]bool
}

// playedArtistSplitRe turns a "feat." / "ft." / "featuring" credit into a
// plain separator so the featured artist counts as played too.
// L14-9: like matchFeatRe, the marker needs a credit before it, so a play of
// "FT Island" marks "ft island" (and not "island") as played.
var playedArtistSplitRe = regexp.MustCompile(`(\S)\s*[\(\[]?\b(?:feat|ft|featuring)\b\.?\s*`)

// playedArtistNames (L13-7) lists the normalised names a play row's artist
// credit marks as played: the credit as a whole (matchNorm, which already
// drops a "feat." tail), its primary artist (matchPrimaryArtist) and every
// co-credited artist (matchArtistSep). "Daft Punk feat. Pharrell Williams"
// and "Daft Punk & Pharrell Williams" both mark "daft punk" and "pharrell
// williams"; the raw credit used to be compared lower-cased as one string,
// so a featured play left the artist of the day "never played".
func playedArtistNames(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	add := func(n string) {
		if n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	add(matchNorm(raw))
	add(matchPrimaryArtist(raw))
	s := playedArtistSplitRe.ReplaceAllString(matchAccents.Replace(strings.ToLower(raw)), "${1} & ")
	for _, part := range matchArtistSep.Split(s, -1) {
		add(matchNorm(part))
	}
	return out
}

// loadPlayedArtists reads a profile's play_events in one aggregate query.
func loadPlayedArtists(pid string) playedArtists {
	p := playedArtists{names: map[string]bool{}, ids: map[string]bool{}}
	if db.DB == nil {
		return p
	}
	var rows []struct {
		Artist   string
		ArtistID string
	}
	db.DB.Model(&db.PlayEvent{}).Select("artist, artist_id").Where("profile_id = ?", pid).Group("artist, artist_id").Scan(&rows)
	for _, r := range rows {
		for _, n := range playedArtistNames(r.Artist) {
			p.names[n] = true
		}
		if r.ArtistID != "" {
			p.ids[r.ArtistID] = true
		}
	}
	return p
}

// has reports whether a play row names this artist (by id, or by its
// normalised name among the credits played).
func (p playedArtists) has(doc map[string]interface{}) bool {
	if p.ids[mstr(doc, "id")] {
		return true
	}
	n := matchNorm(mstr(doc, "name"))
	return n != "" && p.names[n]
}

// dayMemo is a small LRU of answers keyed by (date, profile).
type dayMemo struct {
	mu    sync.Mutex
	m     map[string]map[string]interface{}
	order []string // oldest first
	max   int
}

func (d *dayMemo) get(key string) (map[string]interface{}, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	v, ok := d.m[key]
	if ok {
		d.touch(key)
	}
	return v, ok
}

func (d *dayMemo) put(key string, v map[string]interface{}) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.m == nil {
		d.m = map[string]map[string]interface{}{}
	}
	d.m[key] = v
	d.touch(key)
	for len(d.order) > d.max {
		delete(d.m, d.order[0])
		d.order = d.order[1:]
	}
}

func (d *dayMemo) touch(key string) {
	for i, k := range d.order {
		if k == key {
			d.order = append(d.order[:i], d.order[i+1:]...)
			break
		}
	}
	d.order = append(d.order, key)
}

func (d *dayMemo) reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.m = map[string]map[string]interface{}{}
	d.order = nil
}

var (
	artistDayMemo = &dayMemo{max: artistDayMemoMax}
	// artistDayNow is swapped by tests.
	artistDayNow = time.Now
)

func resetArtistDayMemo() { artistDayMemo.reset() }

// artistDayKey is the settings / memo key of a (date, profile) pick; pid ""
// is the library scope.
func artistDayKey(date, pid string) string {
	if pid == "" {
		return artistDaySettingPrefix + date
	}
	return artistDaySettingPrefix + date + ":" + pid
}

// artistDayLoad reads the persisted pick under `key` (nil when none, or
// when the database is unavailable). A variable for tests.
var artistDayLoad = func(key string) map[string]interface{} {
	if db.DB == nil {
		return nil
	}
	var row db.Setting
	if err := db.DB.Where("key = ?", key).Limit(1).Find(&row).Error; err != nil || row.Value == "" {
		return nil
	}
	var doc map[string]interface{}
	if json.Unmarshal([]byte(row.Value), &doc) != nil || !artistDayEligible(doc) {
		return nil
	}
	return doc
}

// artistDayStore persists the pick under `key` (first writer wins) and
// prunes picks older than artistDayKeep days. It returns the doc actually
// stored for the key.
var artistDayStore = func(key, date string, doc map[string]interface{}) map[string]interface{} {
	if db.DB == nil {
		return doc
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return doc
	}
	if err := db.DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&db.Setting{Key: key, Value: string(raw)}).Error; err != nil {
		return doc
	}
	if d, err := time.Parse("2006-01-02", date); err == nil {
		cut := artistDaySettingPrefix + d.AddDate(0, 0, -artistDayKeep).Format("2006-01-02")
		db.DB.Where("key LIKE ? AND key < ?", artistDaySettingPrefix+"%", cut).Delete(&db.Setting{})
	}
	if stored := artistDayLoad(key); stored != nil {
		return stored
	}
	return doc
}

// artistDayFetch reads a window of the artists index in the pick's stable order.
func artistDayFetch(off, lim int) []map[string]interface{} {
	return meiliSearchIndex("artists", map[string]interface{}{
		"q": "", "offset": off, "limit": lim, "sort": []string{"name:asc"},
		"attributesToRetrieve": artistDocAttrs,
	})
}

// artistDayTotal counts the artists index.
func artistDayTotal() int {
	_, total := meiliBrowse("artists", map[string]interface{}{"q": "", "limit": 0})
	return total
}

// artistDayResolve computes (or reads back) the artist doc of `date` for
// `pid` ("" = library). The doc carries its reason under artistDayReasonKey.
// ok is false when a computed pick hit a failed Meili window.
func artistDayResolve(date string, day time.Time, pid string) (map[string]interface{}, bool) {
	key := artistDayKey(date, pid)
	if doc := artistDayLoad(key); doc != nil {
		return doc, true
	}
	total := artistDayTotal()
	prev := mstr(artistDayLoad(artistDayKey(day.AddDate(0, 0, -1).Format("2006-01-02"), pid)), "id")
	var played *playedArtists
	if pid != "" {
		p := loadPlayedArtists(pid)
		played = &p
	}
	skipWith := func(skipPrev bool) func(doc map[string]interface{}) bool {
		return func(doc map[string]interface{}) bool {
			if skipPrev && prev != "" && mstr(doc, "id") == prev {
				return true
			}
			return played != nil && played.has(doc)
		}
	}
	doc, ok := pickArtistOfDayOK(date, total, artistDayFetch, skipWith(true))
	if doc == nil && prev != "" {
		// Yesterday's artist is the only candidate left: better than nothing.
		doc, ok = pickArtistOfDayOK(date, total, artistDayFetch, skipWith(false))
	}
	reason := artistDayReasonOK
	if doc == nil && pid != "" {
		// Every artist of the scan was played: the library pick of the day.
		lib, libOK := artistDayResolve(date, day, "")
		if lib == nil {
			return nil, libOK
		}
		doc = map[string]interface{}{}
		for k, v := range lib {
			doc[k] = v
		}
		ok = libOK
		reason = artistDayReasonAll
	}
	if doc == nil {
		return nil, ok
	}
	doc[artistDayReasonKey] = reason
	if !ok {
		return doc, false
	}
	return artistDayStore(key, date, doc), true
}

// artistOfDay builds (or reads from the memo) the answer for (date, pid).
func artistOfDay(date string, day time.Time, pid string) map[string]interface{} {
	key := artistDayKey(date, pid)
	if v, ok := artistDayMemo.get(key); ok {
		return v
	}
	scope := "library"
	if pid != "" {
		scope = "profile"
	}
	expires := day.AddDate(0, 0, 1).Format(time.RFC3339)
	doc, ok := artistDayResolve(date, day, pid)
	if doc == nil {
		return map[string]interface{}{"artist": nil, "reason": "empty", "scope": scope, "date": date, "expires": expires}
	}
	resp := artistDayAnswer(doc, date, expires, scope)
	if ok {
		artistDayMemo.put(key, resp)
	}
	return resp
}

// artistDayAnswer is the JSON answer for an artist doc.
func artistDayAnswer(doc map[string]interface{}, date, expires, scope string) map[string]interface{} {
	reason := mstr(doc, artistDayReasonKey)
	if reason == "" {
		reason = artistDayReasonOK
	}
	covers := artistCovers([]map[string]interface{}{doc})
	return map[string]interface{}{
		"artist":     localArtistItem(doc, covers[mstr(doc, "id")]),
		"name":       mstr(doc, "name"),
		"albumCount": mint(doc, "albumCount"),
		"trackCount": mint(doc, "trackCount"),
		"scope":      scope,
		"reason":     reason,
		"date":       date,
		"expires":    expires,
	}
}

// LocalArtistOfDayHandler: GET /api/v1/local/artist-of-the-day[?date=YYYY-MM-DD].
func LocalArtistOfDayHandler(c echo.Context) error {
	now := artistDayNow().UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if raw := strings.TrimSpace(c.QueryParam("date")); raw != "" {
		d, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "date must be YYYY-MM-DD: " + raw})
		}
		if diff := d.Sub(day); diff > artistDayDateRange*24*time.Hour || diff < -artistDayDateRange*24*time.Hour {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "date out of range (today +/- 366 days): " + raw})
		}
		day = d
	}
	// A request without the bbp cookie gets a fresh random id (profileID):
	// never a named profile, so it is not even looked up.
	pid := ""
	if hasProfileCookie(c) {
		id := profileID(c)
		anon, err := profileAnonymousErr(id)
		if err != nil {
			// The library pick reads no history: the safe answer on a database error.
			log.Printf("artist-of-day profile %q: %v", id, err)
			anon = true
		}
		if !anon {
			pid = id
		}
	}
	return c.JSON(http.StatusOK, artistOfDay(day.Format("2006-01-02"), day, pid))
}
