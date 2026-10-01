package api

// 41A (B6-22) "Décennies écoutées" and "Ton année", per profile (bbp cookie):
//
//	GET /api/v1/me/stats/decades?days=365 -> {days, decades: [{decade, minutes, plays}], localPlays, matchedPlays, plays}
//	GET /api/v1/me/stats/year?year=2026&tz=120 -> {year, months: [12], plays, minutes, topArtist, topAlbum, distinctAlbums, newArtists, ...}
//
// Decades use the RELEASE year of local tracks (Meili tracks index, `year`
// field, looked up by lid); YouTube plays and local tracks without a year are
// skipped (counted in plays but not in matchedPlays). "Ton année" months and
// the year bounds are in the viewer's local time (?tz=, as streaks); a "new
// artist" is one whose first play by this profile falls inside that year.

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
)

// decadeLookupChunk bounds one Meili `lid IN [...]` filter.
const decadeLookupChunk = 200

// localTrackYears maps local lids to their release year (0 / absent when the
// index has none). Missing Meili = empty map (the endpoint answers no decade).
func localTrackYears(lids []string) map[string]int {
	out := map[string]int{}
	for i := 0; i < len(lids); i += decadeLookupChunk {
		end := i + decadeLookupChunk
		if end > len(lids) {
			end = len(lids)
		}
		quoted := make([]string, 0, end-i)
		for _, l := range lids[i:end] {
			quoted = append(quoted, "\""+escapeMeili(l)+"\"")
		}
		hits := meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "filter": "lid IN [" + strings.Join(quoted, ",") + "]", "limit": end - i,
			"attributesToRetrieve": []string{"lid", "year"},
		})
		for _, h := range hits {
			lid := mstr(h, "lid")
			if lid == "" {
				continue
			}
			var y int
			switch v := h["year"].(type) {
			case string:
				y = yearOf(v)
			case float64:
				y = yearOf(strconv.Itoa(int(v)))
			}
			if y > 0 {
				out[lid] = y
			}
		}
	}
	return out
}

type decadeRow struct {
	Decade  int     `json:"decade"`
	Minutes float64 `json:"minutes"`
	Plays   int     `json:"plays"`
}

type decadesResp struct {
	Days         int         `json:"days"`
	Decades      []decadeRow `json:"decades"` // oldest decade first
	Plays        int         `json:"plays"`
	LocalPlays   int         `json:"localPlays"`
	MatchedPlays int         `json:"matchedPlays"`
}

// computeDecades folds plays into minutes per release decade.
func computeDecades(evs []statEvent, mins map[string]float64, years map[string]int) decadesResp {
	out := decadesResp{Decades: []decadeRow{}}
	idx := map[int]int{}
	for _, e := range evs {
		out.Plays++
		if e.Source != "local" {
			continue
		}
		out.LocalPlays++
		y := years[e.Ref]
		if y <= 0 {
			continue
		}
		out.MatchedPlays++
		d := y - y%10
		i, ok := idx[d]
		if !ok {
			i = len(out.Decades)
			idx[d] = i
			out.Decades = append(out.Decades, decadeRow{Decade: d})
		}
		out.Decades[i].Plays++
		out.Decades[i].Minutes += playMinutes(mins, e.Ref)
	}
	for i := range out.Decades {
		out.Decades[i].Minutes = round1(out.Decades[i].Minutes)
	}
	sort.Slice(out.Decades, func(i, j int) bool { return out.Decades[i].Decade < out.Decades[j].Decade })
	return out
}

// MeDecadesHandler: GET /api/v1/me/stats/decades?days=365 (days=0: all time).
func MeDecadesHandler(c echo.Context) error {
	pid := profileID(c)
	days := 365
	if strings.TrimSpace(c.QueryParam("days")) != "" {
		days = statsDays(c)
	}
	var since time.Time
	if days > 0 {
		since = time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	}
	evs := profileEvents(pid, since)
	seen := map[string]bool{}
	var lids []string
	for _, e := range evs {
		if e.Source == "local" && !seen[e.Ref] {
			seen[e.Ref] = true
			lids = append(lids, e.Ref)
		}
	}
	out := computeDecades(evs, refMinutes(windowRows(pid, days)), localTrackYears(lids))
	out.Days = days
	return c.JSON(http.StatusOK, out)
}

// yearResp is the payload of me/stats/year.
type yearResp struct {
	Year            int         `json:"year"`
	TZ              int         `json:"tz"`
	Months          [12]float64 `json:"months"` // minutes, January first
	Plays           int         `json:"plays"`
	Minutes         float64     `json:"minutes"`
	Estimated       bool        `json:"estimated"`
	DistinctTracks  int         `json:"distinctTracks"`
	DistinctArtists int         `json:"distinctArtists"`
	DistinctAlbums  int         `json:"distinctAlbums"`
	TopArtist       *topEntry   `json:"topArtist"` // null without plays
	TopAlbum        *topEntry   `json:"topAlbum"`  // null without an album
	NewArtists      int         `json:"newArtists"`
	NewArtistNames  []string    `json:"newArtistNames"` // up to 5, most played that year first
}

// rowArtist resolves the artist of a per-ref row like aggregateBy does.
func rowArtist(r playRow) string {
	if r.Artist != "" {
		return r.Artist
	}
	a, _ := playArtist(r.Data)
	return a
}

// computeYear folds the whole history (evs, all time, oldest first; rows =
// one per ref with its latest item) into the year view of `year`.
func computeYear(evs []statEvent, rows []playRow, year, tzOffsetMin int) yearResp {
	loc := time.FixedZone("viewer", tzOffsetMin*60)
	from := time.Date(year, 1, 1, 0, 0, 0, 0, loc)
	to := from.AddDate(1, 0, 0)
	out := yearResp{Year: year, TZ: tzOffsetMin, NewArtistNames: []string{}}
	byRef := make(map[string]playRow, len(rows))
	for _, r := range rows {
		byRef[r.Ref] = r
	}
	mins := refMinutes(rows)
	inYear := map[string]int{}
	firstPlay := map[string]time.Time{} // artist key -> first play ever
	artistName := map[string]string{}
	for _, e := range evs {
		if r, ok := byRef[e.Ref]; ok {
			if a := rowArtist(r); a != "" {
				k := strings.ToLower(a)
				if f, seen := firstPlay[k]; !seen || e.PlayedAt.Before(f) {
					firstPlay[k] = e.PlayedAt
				}
				artistName[k] = a
			}
		}
		if e.PlayedAt.Before(from) || !e.PlayedAt.Before(to) {
			continue
		}
		inYear[e.Ref]++
		out.Months[int(e.PlayedAt.In(loc).Month())-1] += playMinutes(mins, e.Ref)
	}
	for i := range out.Months {
		out.Months[i] = round1(out.Months[i])
	}
	yearRows := make([]playRow, 0, len(inYear))
	for ref, n := range inYear {
		r, ok := byRef[ref]
		if !ok {
			r = playRow{Ref: ref}
		}
		r.Cnt = n
		yearRows = append(yearRows, r)
	}
	s := summarize(yearRows, nil, nil, 0)
	out.Plays, out.Minutes, out.Estimated = s.Plays, s.Minutes, s.Estimated
	out.DistinctTracks, out.DistinctArtists, out.DistinctAlbums = s.DistinctTracks, s.DistinctArtists, s.DistinctAlbums
	if top := aggregateBy(yearRows, "artists", 0); len(top) > 0 {
		out.TopArtist = &top[0]
		// new artists, most played this year first (aggregateBy order)
		for _, a := range top {
			k := strings.ToLower(a.Title)
			if f, ok := firstPlay[k]; ok && !f.Before(from) && f.Before(to) {
				out.NewArtists++
				if len(out.NewArtistNames) < 5 {
					out.NewArtistNames = append(out.NewArtistNames, artistName[k])
				}
			}
		}
	}
	if top := aggregateBy(yearRows, "albums", 1); len(top) > 0 {
		out.TopAlbum = &top[0]
	}
	return out
}

// statsYear parses ?year= (2000..this year in the viewer's zone, default this year).
func statsYear(c echo.Context, now time.Time) (int, error) {
	cur := now.Year()
	raw := strings.TrimSpace(c.QueryParam("year"))
	if raw == "" {
		return cur, nil
	}
	y, err := strconv.Atoi(raw)
	if err != nil || y < 2000 || y > cur {
		return 0, fmt.Errorf("year must be 2000..%d", cur)
	}
	return y, nil
}

// MeYearHandler: GET /api/v1/me/stats/year?year=2026&tz=<minutes>.
func MeYearHandler(c echo.Context) error {
	pid := profileID(c)
	tz := statsTZ(c)
	now := time.Now().In(time.FixedZone("viewer", tz*60))
	year, err := statsYear(c, now)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": err.Error()})
	}
	evs := profileEvents(pid, time.Time{}) // all time: "new artists" needs each first play
	return c.JSON(http.StatusOK, computeYear(evs, windowRows(pid, 0), year, tz))
}
