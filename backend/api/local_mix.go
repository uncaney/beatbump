package api

// D1 decade and genre mixes (c29b): up to 40 owned tracks sampled across a
// slice of the library, plus the list of slices worth a card.
//
//	GET /api/v1/local/mix?decade=1990        -> {"items":[...40 songs], "decade":1990, "albums":N}
//	GET /api/v1/local/mix?genre=Rock         -> {"items":[...40 songs], "genre":"Rock", "albums":N}
//	GET /api/v1/local/mix?decade=1990&genre=Rock -> {"items":[...], "decade":1990, "genre":"Rock", "albums":N}   (c39b B6-2)
//	GET /api/v1/local/mix?year=1997          -> {"items":[...40 songs], "year":1997, "albums":N}             (c39b B6-3)
//	GET /api/v1/local/mixes                  -> {"decades":[{"decade":1990,"albums":52}], "genres":[{"name":"Rock","count":1234,"albums":48}],
//	                                             "years":[{"year":1997,"albums":31}], "crossovers":[{"decade":1990,"genre":"Rock","count":420,"albums":22}]}
//
// At least one of decade / year / genre is required, decade and year are
// exclusive (400 otherwise); genre combines with either: the filters are
// ANDed, "(year IN [...]) AND (genre = "Rock")". A slice holding
// fewer than mixMinAlbums distinct albums answers {"items":[],"reason":"too_small"}:
// a mix over 3 albums is an album, not a mix.
//
// Audit L8-6: a genre card is listed only when its mix can play, i.e. the
// genre has >= mixGenreMin tracks AND its survey finds >= mixMinAlbums
// distinct albums (same threshold as the mix itself: a 200-track soundtrack
// genre spread over 3 albums used to get a card that always answered
// too_small). The album count is part of the card. The threshold is kept at
// 15 for genres on purpose: relaxing it to 5 would list mixes that are 40
// tracks of 5 albums, which is what the "not a mix" rule rejects.
//
// Audit L8-9: /local/mix is NOT response-cached (the 40-track sample must be
// fresh on every tap); what is memoised in-process for mixSurveyTTL is the
// deterministic part, mixSurvey(filter) -> (total, albums), in a bounded map
// (mixSurveyMemoMax filters). /local/mixes stays behind main.go's 5 min
// response cache and primes that memo for every listed genre.
//
// Meili facts this relies on (ytm-meili settings, 2026-10): the tracks index
// filters on `genre` and `year`; `year` is stored as a STRING ("1994"), so a
// numeric range (`year >= 1990`) matches nothing and the decade filter is an
// explicit `year IN [1990,...,1999]` list (Meili matches a numeric literal
// against the string value). The albums index is NOT filterable on year, so
// the decade cards come from one bounded scan of the albums index (id + year
// only, pages of mixAlbumPage). The cards listing is cheap enough for the
// 5 min response cache main.go wraps it in.
//
// c39b: the same albums scan counts albums per release year; `years` lists
// the mixYearMax years with the most albums (>= mixMinAlbums each), newest
// first. Release year, not acquisition date: dateAdded is mostly the June
// 2026 migration. `crossovers` lists up to mixCrossMax (decade, genre) pairs
// with >= mixMinAlbums albums: one genre facet per listed decade ranks the
// pairs by tracks, the mixCrossCandidates best are surveyed (memoised like
// every survey) and at most mixCrossPerKey cards share a decade or a genre
// while others are left. The list itself is memoised mixSurveyTTL. The genre
// facet reads Meili's top-100 values per decade, as the genre cards do.

import (
	"math/rand"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

const (
	mixSize            = 40  // tracks per mix
	mixMinAlbums       = 15  // distinct albums a slice needs before it is a mix
	mixGenreMin        = 200 // tracks a genre needs before it gets a card
	mixAlbumPage       = 1000
	mixAlbumPages      = 12 // albums index maxTotalHits is 12000
	mixSurveyLimit     = 1000
	mixPerWindow       = 4
	mixDecadeMinY      = 1900
	mixDecadeMaxY      = 2090
	mixSurveyTTL       = 5 * time.Minute // L8-9: in-process memo of mixSurvey
	mixSurveyMemoMax   = 256             // filters kept (decades + genres << this)
	mixGenreSurveyPar  = 4               // concurrent genre surveys in /local/mixes
	mixYearMax         = 8               // c39b: year cards
	mixCrossMax        = 6               // c39b: crossover cards
	mixCrossCandidates = 18              // pairs surveyed for the crossovers
	mixCrossPerKey     = 2               // first-pass cap per decade / per genre
)

var mixTrackAttrs = []string{"lid", "title", "artist", "albumArtist", "track", "durationSec", "album"}

// parseDecade validates ?decade= (a 4-digit year that is a multiple of 10).
func parseDecade(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if len(raw) != 4 {
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n%10 != 0 || n < mixDecadeMinY || n > mixDecadeMaxY {
		return 0, false
	}
	return n, true
}

// decadeFilter builds the explicit year list filter for a decade.
func decadeFilter(decade int) string {
	years := make([]string, 0, 10)
	for y := decade; y < decade+10; y++ {
		years = append(years, strconv.Itoa(y))
	}
	return "year IN [" + strings.Join(years, ",") + "]"
}

// parseYear validates ?year= (a 4-digit release year).
func parseYear(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if len(raw) != 4 {
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < mixDecadeMinY || n > mixDecadeMaxY+9 {
		return 0, false
	}
	return n, true
}

// yearFilter is the one-year list filter (`year` is a string field: a
// numeric equality or range matches nothing, an IN list does).
func yearFilter(year int) string {
	return "year IN [" + strconv.Itoa(year) + "]"
}

// mixFilter ANDs the slice filters; a single one is returned as is (the
// survey memo keys of the one-param mixes do not change).
func mixFilter(parts ...string) string {
	if len(parts) == 1 {
		return parts[0]
	}
	wrapped := make([]string, len(parts))
	for i, p := range parts {
		wrapped[i] = "(" + p + ")"
	}
	return strings.Join(wrapped, " AND ")
}

// genreFilter is the exact-match genre filter LocalSongsHandler uses.
func genreFilter(genre string) string {
	return "genre = \"" + escapeMeili(genre) + "\""
}

// decadeOf maps a year string ("1994", "1994-03-01", 1994.0) to its decade
// (1990); 0 when the value carries no 4-digit year.
func decadeOf(year string) int {
	n := yearOf(year)
	return n - n%10
}

// yearOf maps a year string ("1994", "1994-03-01") to its year; 0 when the
// value carries no 4-digit year in range.
func yearOf(year string) int {
	year = strings.TrimSpace(year)
	if len(year) < 4 {
		return 0
	}
	n, err := strconv.Atoi(year[:4])
	if err != nil || n < mixDecadeMinY || n > mixDecadeMaxY+9 {
		return 0
	}
	return n
}

// mixSurvey answers how big a slice is: the (estimated) track total and the
// number of distinct albums among its first mixSurveyLimit tracks (exact when
// the slice is smaller than that; a 1000-track slice with fewer than 15
// albums does not exist in practice).
func mixSurvey(filter string) (total, albums int) {
	out, err := meiliReq("POST", "/indexes/tracks/search", map[string]interface{}{
		"q": "", "filter": filter, "limit": mixSurveyLimit,
		"attributesToRetrieve": []string{"album", "albumArtist", "artist"},
	})
	if err != nil || out == nil {
		return 0, 0
	}
	if v, ok := out["estimatedTotalHits"].(float64); ok {
		total = int(v)
	}
	raw, _ := out["hits"].([]interface{})
	seen := map[string]bool{}
	for _, h := range raw {
		m, ok := h.(map[string]interface{})
		if !ok {
			continue
		}
		if id, _, _ := trackAlbumKey(m); id != "" {
			seen[id] = true
		}
	}
	if len(raw) > total {
		total = len(raw)
	}
	return total, len(seen)
}

// mixSurveyEntry is one memoised survey (L8-9).
type mixSurveyEntry struct {
	total, albums int
	at            time.Time
}

var (
	mixSurveyMu   sync.Mutex
	mixSurveyMemo = map[string]mixSurveyEntry{}
	// mixSurveyNow is swapped by tests to age the memo.
	mixSurveyNow = time.Now
)

// mixSurveyCached is mixSurvey behind a mixSurveyTTL memo keyed by filter.
// An empty answer (Meili down or unknown slice: 0 tracks, 0 albums) is not
// kept, so a transient failure never pins "too_small" for 5 minutes. The map
// is bounded: past mixSurveyMemoMax entries the expired ones go first, then
// the whole map is dropped (a few dozen filters exist in practice).
func mixSurveyCached(filter string) (total, albums int) {
	now := mixSurveyNow()
	mixSurveyMu.Lock()
	if e, ok := mixSurveyMemo[filter]; ok && now.Sub(e.at) < mixSurveyTTL {
		mixSurveyMu.Unlock()
		return e.total, e.albums
	}
	mixSurveyMu.Unlock()
	total, albums = mixSurvey(filter)
	if total == 0 && albums == 0 {
		return
	}
	mixSurveyMu.Lock()
	defer mixSurveyMu.Unlock()
	if len(mixSurveyMemo) >= mixSurveyMemoMax {
		for k, e := range mixSurveyMemo {
			if now.Sub(e.at) >= mixSurveyTTL {
				delete(mixSurveyMemo, k)
			}
		}
		if len(mixSurveyMemo) >= mixSurveyMemoMax {
			mixSurveyMemo = map[string]mixSurveyEntry{}
		}
	}
	mixSurveyMemo[filter] = mixSurveyEntry{total: total, albums: albums, at: now}
	return
}

// resetMixSurveyMemo drops every memoised survey (tests).
func resetMixSurveyMemo() {
	mixSurveyMu.Lock()
	defer mixSurveyMu.Unlock()
	mixSurveyMemo = map[string]mixSurveyEntry{}
}

// mixSample is randomLibrarySample over a filtered slice: n/mixPerWindow
// small windows at random offsets inside the slice (total tracks known from
// the survey), fetched concurrently, merged in window order, deduped by lid.
// Spread over many offsets so a decade mix is not 40 tracks of 3 albums.
func mixSample(filter string, total, n int) []IListItemRenderer {
	if total <= 0 {
		return []IListItemRenderer{}
	}
	// c41b B6-19: draw a few more than n, then keep one copy per
	// normalised (artist, title) (collapseLibraryDuplicates): the lidarr and
	// soulseek copies of one album no longer give the same song twice.
	final := n
	n = dupOversample(n)
	windows := n / mixPerWindow
	if windows < 1 {
		windows = 1
	}
	maxOff := total - mixPerWindow
	if maxOff < 0 {
		maxOff = 0
	}
	pages := make([][]map[string]interface{}, windows)
	var wg sync.WaitGroup
	for w := 0; w < windows; w++ {
		off := 0
		if maxOff > 0 {
			off = rand.Intn(maxOff + 1)
		}
		wg.Add(1)
		go func(i, off int) {
			defer wg.Done()
			pages[i] = meiliSearchIndex("tracks", map[string]interface{}{
				"q": "", "filter": filter, "offset": off, "limit": mixPerWindow, "sort": []string{"dateAdded:desc"},
				"attributesToRetrieve": mixTrackAttrs,
			})
		}(w, off)
	}
	wg.Wait()
	seen := map[string]bool{}
	var hits []map[string]interface{}
	for _, page := range pages {
		for _, h := range page {
			lid := mstr(h, "lid")
			if lid == "" || seen[lid] {
				continue
			}
			seen[lid] = true
			hits = append(hits, h)
		}
	}
	hits = collapseLibraryDuplicates(hits)
	// Small slices: the random windows overlap and leave the mix short; top
	// it up from the head of the slice (still deduped) so a 60-track genre
	// gives a full 40 and not 25.
	if len(hits) < final && total > len(hits) {
		more := meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "filter": filter, "offset": 0, "limit": n * 2, "sort": []string{"dateAdded:desc"},
			"attributesToRetrieve": mixTrackAttrs,
		})
		for _, h := range more {
			lid := mstr(h, "lid")
			if lid == "" || seen[lid] {
				continue
			}
			seen[lid] = true
			hits = append(hits, h)
		}
		hits = collapseLibraryDuplicates(hits)
	}
	if len(hits) > final {
		hits = hits[:final]
	}
	rand.Shuffle(len(hits), func(i, j int) { hits[i], hits[j] = hits[j], hits[i] })
	return localSongItemsWithCovers(hits)
}

// LocalMixHandler: GET /api/v1/local/mix?decade=1990 | ?year=1997 | ?genre=Rock,
// genre combinable with decade or year.
func LocalMixHandler(c echo.Context) error {
	rawDecade := strings.TrimSpace(c.QueryParam("decade"))
	rawYear := strings.TrimSpace(c.QueryParam("year"))
	genre := strings.TrimSpace(c.QueryParam("genre"))
	bad := func(reason string) error {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": reason})
	}
	if rawDecade == "" && rawYear == "" && genre == "" {
		return bad("one of decade, year or genre is required")
	}
	if rawDecade != "" && rawYear != "" {
		return bad("decade and year are exclusive")
	}
	resp := map[string]interface{}{}
	var parts []string
	if rawDecade != "" {
		decade, ok := parseDecade(rawDecade)
		if !ok {
			return bad("decade must be a 4-digit year ending in 0: " + rawDecade)
		}
		parts = append(parts, decadeFilter(decade))
		resp["decade"] = decade
	}
	if rawYear != "" {
		year, ok := parseYear(rawYear)
		if !ok {
			return bad("year must be a 4-digit year: " + rawYear)
		}
		parts = append(parts, yearFilter(year))
		resp["year"] = year
	}
	if genre != "" {
		parts = append(parts, genreFilter(genre))
		resp["genre"] = genre
	}
	filter := mixFilter(parts...)
	total, albums := mixSurveyCached(filter)
	resp["albums"] = albums
	if albums < mixMinAlbums {
		resp["items"] = []IListItemRenderer{}
		resp["reason"] = "too_small"
		return c.JSON(http.StatusOK, resp)
	}
	// c40b B6-10: exclude= / personal=1 (the queue continuation) leave refs
	// out; the sample is drawn larger so the mix stays full.
	ex := requestExclusions(c)
	if ex.empty() {
		resp["items"] = mixSample(filter, total, mixSize)
		return c.JSON(http.StatusOK, resp)
	}
	extra := len(ex.refs)
	if extra > mixSize {
		extra = mixSize
	}
	items := itemsWithout(mixSample(filter, total, mixSize+extra), ex)
	if len(items) > mixSize {
		items = items[:mixSize]
	}
	resp["items"] = items
	return c.JSON(http.StatusOK, resp)
}

// decadeCard / genreCard are the /local/mixes rows.
type decadeCard struct {
	Decade int `json:"decade"`
	Albums int `json:"albums"`
}

type genreCard struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Albums int    `json:"albums"`
}

// yearCard / crossoverCard are the c39b /local/mixes rows.
type yearCard struct {
	Year   int `json:"year"`
	Albums int `json:"albums"`
}

type crossoverCard struct {
	Decade int    `json:"decade"`
	Genre  string `json:"genre"`
	Count  int    `json:"count"`
	Albums int    `json:"albums"`
}

// albumYearCounts scans the albums index (id + year, pages of mixAlbumPage,
// at most mixAlbumPages) and counts distinct albums per decade and per year.
func albumYearCounts() (decades map[int]int, years map[int]int) {
	counts := map[int]int{}
	years = map[int]int{}
	seen := map[string]bool{}
	for page := 0; page < mixAlbumPages; page++ {
		hits := meiliSearchIndex("albums", map[string]interface{}{
			"q": "", "offset": page * mixAlbumPage, "limit": mixAlbumPage, "sort": []string{"year:desc"},
			"attributesToRetrieve": []string{"id", "year"},
		})
		for _, a := range hits {
			id := mstr(a, "id")
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			if y := yearOf(mnumStr(a, "year")); y != 0 {
				counts[y-y%10]++
				years[y]++
			}
		}
		if len(hits) < mixAlbumPage {
			break
		}
	}
	return counts, years
}

// yearCards: the mixYearMax years with the most albums (>= mixMinAlbums),
// newest first.
func yearCards(years map[int]int) []yearCard {
	out := make([]yearCard, 0, len(years))
	for y, n := range years {
		if n >= mixMinAlbums {
			out = append(out, yearCard{Year: y, Albums: n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Albums != out[j].Albums {
			return out[i].Albums > out[j].Albums
		}
		return out[i].Year > out[j].Year
	})
	if len(out) > mixYearMax {
		out = out[:mixYearMax]
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Year > out[j].Year })
	return out
}

// genreTrackCounts is the facet LocalGenresHandler reads (top-100 genre
// values, free-text field), name -> track count.
func genreTrackCounts() map[string]int {
	counts := map[string]int{}
	out, err := meiliReq("POST", "/indexes/tracks/search", map[string]interface{}{
		"q": "", "limit": 0, "facets": []string{"genre"},
	})
	if err != nil || out == nil {
		return counts
	}
	fd, _ := out["facetDistribution"].(map[string]interface{})
	g, _ := fd["genre"].(map[string]interface{})
	for name, cnt := range g {
		if strings.TrimSpace(name) == "" {
			continue
		}
		counts[name] = mintFloat(cnt)
	}
	return counts
}

// genreCandidates lists the genres with at least mixGenreMin tracks.
func genreCandidates(genres map[string]int) []string {
	out := make([]string, 0, len(genres))
	for name, n := range genres {
		if n >= mixGenreMin {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// genreAlbumCounts surveys each candidate genre (mixSurveyCached, at most
// mixGenreSurveyPar at a time) and returns name -> distinct albums (L8-6).
func genreAlbumCounts(names []string) map[string]int {
	out := make(map[string]int, len(names))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, mixGenreSurveyPar)
	for _, name := range names {
		wg.Add(1)
		sem <- struct{}{}
		go func(name string) {
			defer wg.Done()
			defer func() { <-sem }()
			_, albums := mixSurveyCached(genreFilter(name))
			mu.Lock()
			out[name] = albums
			mu.Unlock()
		}(name)
	}
	wg.Wait()
	return out
}

// mixCards folds the raw counts into the card lists: decades with at least
// mixMinAlbums albums (newest first), genres with at least mixGenreMin tracks
// AND at least mixMinAlbums distinct albums (genreAlbums, L8-6: every listed
// card can play), most tracks first, name as tie-break.
func mixCards(decades map[int]int, genres map[string]int, genreAlbums map[string]int) ([]decadeCard, []genreCard) {
	dc := make([]decadeCard, 0, len(decades))
	for d, n := range decades {
		if n >= mixMinAlbums {
			dc = append(dc, decadeCard{Decade: d, Albums: n})
		}
	}
	sort.Slice(dc, func(i, j int) bool { return dc[i].Decade > dc[j].Decade })
	gc := make([]genreCard, 0, len(genres))
	for name, n := range genres {
		if n >= mixGenreMin && genreAlbums[name] >= mixMinAlbums {
			gc = append(gc, genreCard{Name: name, Count: n, Albums: genreAlbums[name]})
		}
	}
	sort.Slice(gc, func(i, j int) bool {
		if gc[i].Count != gc[j].Count {
			return gc[i].Count > gc[j].Count
		}
		return strings.ToLower(gc[i].Name) < strings.ToLower(gc[j].Name)
	})
	return dc, gc
}

// genreCountsIn is the genre facet (name -> tracks) inside one slice filter.
func genreCountsIn(filter string) map[string]int {
	counts := map[string]int{}
	out, err := meiliReq("POST", "/indexes/tracks/search", map[string]interface{}{
		"q": "", "filter": filter, "limit": 0, "facets": []string{"genre"},
	})
	if err != nil || out == nil {
		return counts
	}
	fd, _ := out["facetDistribution"].(map[string]interface{})
	g, _ := fd["genre"].(map[string]interface{})
	for name, cnt := range g {
		if strings.TrimSpace(name) != "" {
			counts[name] = mintFloat(cnt)
		}
	}
	return counts
}

// crossFilter is the filter of a (decade, genre) mix, the very string the
// handler builds for ?decade=&genre= (shared survey memo).
func crossFilter(decade int, genre string) string {
	return mixFilter(decadeFilter(decade), genreFilter(genre))
}

// crossoverCandidates ranks the (decade, genre) pairs by tracks (then newer
// decade, then name) and keeps the `max` best with at least mixMinAlbums
// tracks (fewer tracks cannot span 15 albums).
func crossoverCandidates(perDecade map[int]map[string]int, max int) []crossoverCard {
	var out []crossoverCard
	for d, genres := range perDecade {
		for g, n := range genres {
			if n >= mixMinAlbums {
				out = append(out, crossoverCard{Decade: d, Genre: g, Count: n})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if out[i].Decade != out[j].Decade {
			return out[i].Decade > out[j].Decade
		}
		return strings.ToLower(out[i].Genre) < strings.ToLower(out[j].Genre)
	})
	if len(out) > max {
		out = out[:max]
	}
	return out
}

// pickCrossovers keeps the surveyed pairs with >= mixMinAlbums albums, most
// albums first, at most mixCrossMax: a first pass allows mixCrossPerKey
// cards per decade and per genre, a second pass fills from the rest.
func pickCrossovers(cands []crossoverCard) []crossoverCard {
	ok := make([]crossoverCard, 0, len(cands))
	for _, c := range cands {
		if c.Albums >= mixMinAlbums {
			ok = append(ok, c)
		}
	}
	sort.SliceStable(ok, func(i, j int) bool {
		if ok[i].Albums != ok[j].Albums {
			return ok[i].Albums > ok[j].Albums
		}
		return ok[i].Count > ok[j].Count
	})
	out := make([]crossoverCard, 0, mixCrossMax)
	used := make([]bool, len(ok))
	perDecade, perGenre := map[int]int{}, map[string]int{}
	for i, c := range ok {
		if len(out) >= mixCrossMax {
			break
		}
		if perDecade[c.Decade] >= mixCrossPerKey || perGenre[c.Genre] >= mixCrossPerKey {
			continue
		}
		perDecade[c.Decade]++
		perGenre[c.Genre]++
		used[i] = true
		out = append(out, c)
	}
	for i, c := range ok {
		if len(out) >= mixCrossMax {
			break
		}
		if !used[i] {
			out = append(out, c)
		}
	}
	return out
}

var (
	crossMu   sync.Mutex
	crossMemo []crossoverCard
	crossAt   time.Time
)

func resetCrossoverMemo() {
	crossMu.Lock()
	defer crossMu.Unlock()
	crossMemo, crossAt = nil, time.Time{}
}

// crossoverCards builds (or reads from its mixSurveyTTL memo) the crossover
// cards over the listed decades. An empty list is not memoised.
func crossoverCards(decades []decadeCard) []crossoverCard {
	now := mixSurveyNow()
	crossMu.Lock()
	if crossMemo != nil && now.Sub(crossAt) < mixSurveyTTL {
		out := crossMemo
		crossMu.Unlock()
		return out
	}
	crossMu.Unlock()
	perDecade := make(map[int]map[string]int, len(decades))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, mixGenreSurveyPar)
	for _, d := range decades {
		wg.Add(1)
		sem <- struct{}{}
		go func(decade int) {
			defer wg.Done()
			defer func() { <-sem }()
			counts := genreCountsIn(decadeFilter(decade))
			mu.Lock()
			perDecade[decade] = counts
			mu.Unlock()
		}(d.Decade)
	}
	wg.Wait()
	cands := crossoverCandidates(perDecade, mixCrossCandidates)
	for i := range cands {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			_, cands[i].Albums = mixSurveyCached(crossFilter(cands[i].Decade, cands[i].Genre))
		}(i)
	}
	wg.Wait()
	out := pickCrossovers(cands)
	if len(out) > 0 {
		crossMu.Lock()
		crossMemo, crossAt = out, now
		crossMu.Unlock()
	}
	return out
}

// LocalMixesHandler: GET /api/v1/local/mixes (the cards).
func LocalMixesHandler(c echo.Context) error {
	var decades, years map[int]int
	var genres map[string]int
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); decades, years = albumYearCounts() }()
	go func() { defer wg.Done(); genres = genreTrackCounts() }()
	wg.Wait()
	dc, gc := mixCards(decades, genres, genreAlbumCounts(genreCandidates(genres)))
	return c.JSON(http.StatusOK, map[string]interface{}{
		"decades": dc, "genres": gc, "years": yearCards(years), "crossovers": crossoverCards(dc),
	})
}
