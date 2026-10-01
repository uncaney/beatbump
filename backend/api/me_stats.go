package api

// S1 "Ton mois": per-profile listening stats over a time window, computed from
// PlayEvent rows (profile-scoped, so never behind CacheResponse).
//
//   GET /api/v1/me/stats/top?days=30&by=tracks|artists|albums&limit=20
//   GET /api/v1/me/stats/summary?days=30&tz=120
//
// Album is read from the stored item JSON (item.album.text) when the row's
// Album column is empty (rows written before S2 landed), so old history still
// aggregates. Track length comes from item.length ("m:ss"); refs without a
// length are estimated at 3.5 min and the summary is flagged estimated:true.

import (
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

// estimatedTrackMinutes is used for plays whose item carries no length.
const estimatedTrackMinutes = 3.5

// harnessRequest reports whether a history POST comes from the e2e harness
// (Playwright HeadlessChrome or an explicit X-Ytm-Harness: 1 header). Such
// plays are not recorded unless YTM_STATS_INCLUDE_HARNESS=1.
func harnessRequest(r *http.Request) bool {
	if os.Getenv("YTM_STATS_INCLUDE_HARNESS") == "1" {
		return false
	}
	if r.Header.Get("X-Ytm-Harness") == "1" {
		return true
	}
	return strings.Contains(r.UserAgent(), "HeadlessChrome")
}

// statsDays parses ?days= (default 30, clamped to 1..3650). days=0 or "all"
// means no lower bound.
func statsDays(c echo.Context) int {
	raw := strings.TrimSpace(c.QueryParam("days"))
	if raw == "" {
		return 30
	}
	if raw == "all" || raw == "0" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 30
	}
	if n > 3650 {
		n = 3650
	}
	return n
}

// playRow is one distinct ref within the window with its play count.
type playRow struct {
	Ref    string
	Data   string
	Title  string
	Artist string
	Cnt    int
}

// windowRows returns one row per ref played by the profile in the window.
// `data` is the stored item of the ref's MOST RECENT play (deterministic):
// max(data) picked the lexicographically greatest JSON, so an old variant
// without length/album could win over the current one (audit v3 G10).
func windowRows(pid string, days int) []playRow {
	var rows []playRow
	latestData := "(SELECT p2.data FROM play_events p2 WHERE p2.profile_id = play_events.profile_id AND p2.ref = play_events.ref ORDER BY p2.played_at DESC, p2.id DESC LIMIT 1)"
	q := db.DB.Model(&db.PlayEvent{}).
		Select("ref, "+latestData+" as data, max(title) as title, max(artist) as artist, count(*) as cnt").
		Where("profile_id = ?", pid)
	if days > 0 {
		q = q.Where("played_at >= ?", time.Now().Add(-time.Duration(days)*24*time.Hour))
	}
	q.Group("ref").Order("cnt desc").Scan(&rows)
	return rows
}

// itemAlbum reads item.album.text from a stored item JSON ("" when absent).
func itemAlbum(data string) string {
	if data == "" {
		return ""
	}
	var m struct {
		Album *struct {
			Text string `json:"text"`
		} `json:"album"`
	}
	if json.Unmarshal([]byte(data), &m) != nil || m.Album == nil {
		return ""
	}
	return strings.TrimSpace(m.Album.Text)
}

// playArtist reads (artist name, artist id) from a stored item JSON.
func playArtist(data string) (string, string) {
	if data == "" {
		return "", ""
	}
	var m struct {
		ArtistInfo struct {
			Artist []struct {
				Text     string `json:"text"`
				BrowseID string `json:"browseId"`
			} `json:"artist"`
		} `json:"artistInfo"`
	}
	if json.Unmarshal([]byte(data), &m) != nil || len(m.ArtistInfo.Artist) == 0 {
		return "", ""
	}
	return strings.TrimSpace(m.ArtistInfo.Artist[0].Text), m.ArtistInfo.Artist[0].BrowseID
}

// itemLengthSec parses item.length ("m:ss" or "h:mm:ss") from a stored item
// JSON; 0 when absent or unparseable.
func itemLengthSec(data string) int {
	if data == "" {
		return 0
	}
	var m struct {
		Length string `json:"length"`
	}
	if json.Unmarshal([]byte(data), &m) != nil {
		return 0
	}
	return parseClock(m.Length)
}

// parseClock converts "3:45" / "1:02:03" to seconds (0 if malformed).
func parseClock(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0
	}
	total := 0
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n < 0 {
			return 0
		}
		total = total*60 + n
	}
	return total
}

// topEntry is one line of a top list. Item (the stored JSON) is only set for
// tracks so the UI can render the row with <Listing> and play it.
type topEntry struct {
	Key      string          `json:"key"`
	Title    string          `json:"title"`
	Artist   string          `json:"artist,omitempty"`
	ArtistID string          `json:"artistId,omitempty"`
	Count    int             `json:"count"`
	Item     json.RawMessage `json:"item,omitempty"`
}

// aggregateBy folds per-ref rows into tracks / artists / albums entries,
// sorted by count desc (ties: title asc), truncated to limit.
func aggregateBy(rows []playRow, by string, limit int) []topEntry {
	var out []topEntry
	switch by {
	case "artists":
		idx := map[string]int{}
		for _, r := range rows {
			name, id := r.Artist, ""
			if a, aid := playArtist(r.Data); a != "" {
				if name == "" {
					name = a
				}
				id = aid
			}
			if name == "" {
				continue
			}
			k := strings.ToLower(name)
			if i, ok := idx[k]; ok {
				out[i].Count += r.Cnt
				if out[i].ArtistID == "" {
					out[i].ArtistID = id
				}
				continue
			}
			idx[k] = len(out)
			out = append(out, topEntry{Key: name, Title: name, ArtistID: id, Count: r.Cnt})
		}
	case "albums":
		idx := map[string]int{}
		for _, r := range rows {
			album := itemAlbum(r.Data)
			if album == "" {
				continue
			}
			artist := r.Artist
			if a, _ := playArtist(r.Data); artist == "" {
				artist = a
			}
			k := strings.ToLower(album) + "\x00" + strings.ToLower(artist)
			if i, ok := idx[k]; ok {
				out[i].Count += r.Cnt
				continue
			}
			idx[k] = len(out)
			out = append(out, topEntry{Key: album, Title: album, Artist: artist, Count: r.Cnt})
		}
	default: // tracks
		for _, r := range rows {
			e := topEntry{Key: r.Ref, Title: r.Title, Artist: r.Artist, Count: r.Cnt}
			if r.Data != "" {
				e.Item = json.RawMessage(r.Data)
			}
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	if out == nil {
		out = []topEntry{}
	}
	return out
}

// MeTopHandler: most played over ?days= (default 30), grouped by ?by=
// tracks (default) | artists | albums. The tracks response keeps the legacy
// "items" + "counts" keys (used by /library/recent) and adds "rows".
func MeTopHandler(c echo.Context) error {
	pid := profileID(c)
	n := clampLimit(c, 50, 200)
	days := statsDays(c)
	by := strings.ToLower(strings.TrimSpace(c.QueryParam("by")))
	switch by {
	case "artist", "artists":
		by = "artists"
	case "album", "albums":
		by = "albums"
	default:
		by = "tracks"
	}
	rows := aggregateBy(windowRows(pid, days), by, n)
	resp := map[string]interface{}{"by": by, "days": days, "rows": rows}
	if by == "tracks" {
		items := make([]json.RawMessage, 0, len(rows))
		counts := make([]map[string]interface{}, 0, len(rows))
		for _, r := range rows {
			if len(r.Item) > 0 {
				items = append(items, r.Item)
			}
			counts = append(counts, map[string]interface{}{"ref": r.Key, "title": r.Title, "count": r.Count})
		}
		resp["items"] = items
		resp["counts"] = counts
	}
	return c.JSON(http.StatusOK, resp)
}

// statsSummary is the payload of me/stats/summary.
type statsSummary struct {
	Days            int     `json:"days"`
	Plays           int     `json:"plays"`
	Minutes         float64 `json:"minutes"`
	Estimated       bool    `json:"estimated"`
	DistinctTracks  int     `json:"distinctTracks"`
	DistinctArtists int     `json:"distinctArtists"`
	TopHour         int     `json:"topHour"` // -1 when there are no plays
	Local           int     `json:"local"`
	YouTube         int     `json:"youtube"`
	Hours           [24]int `json:"hours"`
}

// summarize folds per-ref rows plus the raw play timestamps into a summary.
// tzOffsetMin shifts timestamps into the viewer's local time for the hour
// histogram (JS: -new Date().getTimezoneOffset()).
func summarize(rows []playRow, playedAt []time.Time, sources []string, tzOffsetMin int) statsSummary {
	s := statsSummary{TopHour: -1}
	artists := map[string]bool{}
	for _, r := range rows {
		s.Plays += r.Cnt
		s.DistinctTracks++
		name := r.Artist
		if name == "" {
			name, _ = playArtist(r.Data)
		}
		if name != "" {
			artists[strings.ToLower(name)] = true
		}
		if sec := itemLengthSec(r.Data); sec > 0 {
			s.Minutes += float64(r.Cnt) * float64(sec) / 60
		} else {
			s.Minutes += float64(r.Cnt) * estimatedTrackMinutes
			s.Estimated = true
		}
	}
	s.DistinctArtists = len(artists)
	s.Minutes = float64(int(s.Minutes*10+0.5)) / 10
	loc := time.FixedZone("viewer", tzOffsetMin*60)
	for _, t := range playedAt {
		s.Hours[t.In(loc).Hour()]++
	}
	best := 0
	for h, n := range s.Hours {
		if n > best {
			best, s.TopHour = n, h
		}
	}
	for _, src := range sources {
		if src == "local" {
			s.Local++
		} else {
			s.YouTube++
		}
	}
	return s
}

// MeStatsSummaryHandler: GET /api/v1/me/stats/summary?days=30&tz=<minutes>.
func MeStatsSummaryHandler(c echo.Context) error {
	pid := profileID(c)
	days := statsDays(c)
	tz, _ := strconv.Atoi(c.QueryParam("tz"))
	if tz < -14*60 || tz > 14*60 {
		tz = 0
	}
	rows := windowRows(pid, days)
	var evs []struct {
		PlayedAt time.Time
		Source   string
	}
	q := db.DB.Model(&db.PlayEvent{}).Select("played_at, source").Where("profile_id = ?", pid)
	if days > 0 {
		q = q.Where("played_at >= ?", time.Now().Add(-time.Duration(days)*24*time.Hour))
	}
	q.Scan(&evs)
	ts := make([]time.Time, 0, len(evs))
	srcs := make([]string, 0, len(evs))
	for _, e := range evs {
		ts = append(ts, e.PlayedAt)
		srcs = append(srcs, e.Source)
	}
	s := summarize(rows, ts, srcs, tz)
	s.Days = days
	return c.JSON(http.StatusOK, s)
}
