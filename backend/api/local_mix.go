package api

// D1 decade and genre mixes (c29b): up to 40 owned tracks sampled across a
// slice of the library, plus the list of slices worth a card.
//
//	GET /api/v1/local/mix?decade=1990        -> {"items":[...40 songs], "decade":1990, "albums":N}
//	GET /api/v1/local/mix?genre=Rock         -> {"items":[...40 songs], "genre":"Rock", "albums":N}
//	GET /api/v1/local/mixes                  -> {"decades":[{"decade":1990,"albums":52}], "genres":[{"name":"Rock","count":1234,"albums":48}]}
//
// Exactly one of decade / genre is required (400 otherwise). A slice holding
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
	mixSize           = 40  // tracks per mix
	mixMinAlbums      = 15  // distinct albums a slice needs before it is a mix
	mixGenreMin       = 200 // tracks a genre needs before it gets a card
	mixAlbumPage      = 1000
	mixAlbumPages     = 12 // albums index maxTotalHits is 12000
	mixSurveyLimit    = 1000
	mixPerWindow      = 4
	mixDecadeMinY     = 1900
	mixDecadeMaxY     = 2090
	mixSurveyTTL      = 5 * time.Minute // L8-9: in-process memo of mixSurvey
	mixSurveyMemoMax  = 256             // filters kept (decades + genres << this)
	mixGenreSurveyPar = 4               // concurrent genre surveys in /local/mixes
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

// genreFilter is the exact-match genre filter LocalSongsHandler uses.
func genreFilter(genre string) string {
	return "genre = \"" + escapeMeili(genre) + "\""
}

// decadeOf maps a year string ("1994", "1994-03-01", 1994.0) to its decade
// (1990); 0 when the value carries no 4-digit year.
func decadeOf(year string) int {
	year = strings.TrimSpace(year)
	if len(year) < 4 {
		return 0
	}
	n, err := strconv.Atoi(year[:4])
	if err != nil || n < mixDecadeMinY || n > mixDecadeMaxY+9 {
		return 0
	}
	return n - n%10
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
	// Small slices: the random windows overlap and leave the mix short; top
	// it up from the head of the slice (still deduped) so a 60-track genre
	// gives a full 40 and not 25.
	if len(hits) < n && total > len(hits) {
		more := meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "filter": filter, "offset": 0, "limit": n * 2, "sort": []string{"dateAdded:desc"},
			"attributesToRetrieve": mixTrackAttrs,
		})
		for _, h := range more {
			if len(hits) >= n {
				break
			}
			lid := mstr(h, "lid")
			if lid == "" || seen[lid] {
				continue
			}
			seen[lid] = true
			hits = append(hits, h)
		}
	}
	if len(hits) > n {
		hits = hits[:n]
	}
	rand.Shuffle(len(hits), func(i, j int) { hits[i], hits[j] = hits[j], hits[i] })
	return localSongItemsWithCovers(hits)
}

// LocalMixHandler: GET /api/v1/local/mix?decade=1990 | ?genre=Rock.
func LocalMixHandler(c echo.Context) error {
	rawDecade := strings.TrimSpace(c.QueryParam("decade"))
	genre := strings.TrimSpace(c.QueryParam("genre"))
	if (rawDecade == "") == (genre == "") {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "exactly one of decade or genre is required"})
	}
	resp := map[string]interface{}{}
	var filter string
	if rawDecade != "" {
		decade, ok := parseDecade(rawDecade)
		if !ok {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "decade must be a 4-digit year ending in 0: " + rawDecade})
		}
		filter = decadeFilter(decade)
		resp["decade"] = decade
	} else {
		filter = genreFilter(genre)
		resp["genre"] = genre
	}
	total, albums := mixSurveyCached(filter)
	resp["albums"] = albums
	if albums < mixMinAlbums {
		resp["items"] = []IListItemRenderer{}
		resp["reason"] = "too_small"
		return c.JSON(http.StatusOK, resp)
	}
	resp["items"] = mixSample(filter, total, mixSize)
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

// decadeAlbumCounts scans the albums index (id + year, pages of mixAlbumPage,
// at most mixAlbumPages) and counts distinct albums per decade.
func decadeAlbumCounts() map[int]int {
	counts := map[int]int{}
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
			if d := decadeOf(mnumStr(a, "year")); d != 0 {
				counts[d]++
			}
		}
		if len(hits) < mixAlbumPage {
			break
		}
	}
	return counts
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

// LocalMixesHandler: GET /api/v1/local/mixes (the cards).
func LocalMixesHandler(c echo.Context) error {
	var decades map[int]int
	var genres map[string]int
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); decades = decadeAlbumCounts() }()
	go func() { defer wg.Done(); genres = genreTrackCounts() }()
	wg.Wait()
	dc, gc := mixCards(decades, genres, genreAlbumCounts(genreCandidates(genres)))
	return c.JSON(http.StatusOK, map[string]interface{}{"decades": dc, "genres": gc})
}
