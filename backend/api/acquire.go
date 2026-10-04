package api

// Acquisition engine: when you follow a YouTube artist, slowly download their whole
// discography into the owned library. Reuses the backend's OWN working artist/album
// resolution (self-HTTP through companion + residential proxy) to enumerate tracks,
// then enqueues each to Yubal (which dedups already-owned files). Self-sustaining.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

var ytVideoRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// only one acquisition per artist runs at a time (avoid duplicate floods)
var acquiring sync.Map

func selfGet(path string) map[string]interface{} {
	resp, err := (&http.Client{Timeout: 25 * time.Second}).Get("http://localhost:8080" + path)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var m map[string]interface{}
	_ = json.Unmarshal(b, &m)
	return m
}

// collectKey walks an arbitrary decoded-JSON value and gathers all string values
// stored under the given key (robust to YT's deeply-nested, shifting shapes).
func collectKey(v interface{}, key string, out *[]string) {
	switch t := v.(type) {
	case map[string]interface{}:
		for k, val := range t {
			if k == key {
				if s, ok := val.(string); ok && s != "" {
					*out = append(*out, s)
				}
			}
			collectKey(val, key, out)
		}
	case []interface{}:
		for _, e := range t {
			collectKey(e, key, out)
		}
	}
}

func uniqStrings(in []string, keep func(string) bool) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if seen[s] || !keep(s) {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// resolveYTArtistByName finds a YouTube-Music artist channel id (UC…) for a name.
func resolveYTArtistByName(name string) string {
	res := selfGet("/api/v1/search.json?q=" + url.QueryEscape(name) + "&filter=artists")
	if res == nil {
		res = selfGet("/api/v1/search.json?q=" + url.QueryEscape(name))
	}
	var ids []string
	collectKey(res, "browseId", &ids)
	for _, id := range ids {
		if len(id) >= 2 && id[:2] == "UC" {
			return id
		}
	}
	return ""
}

// selfGetFn / acquireAlbumPause / acquireTrackPause are seams for tests
// (no self-HTTP, no pauses).
var (
	selfGetFn         = selfGet
	acquireAlbumPause = 250 * time.Millisecond // be gentle on companion
	acquireTrackPause = 500 * time.Millisecond // slow, polite acquisition
)

// discographyAlbum is one album of a YT artist with its track videoIds.
type discographyAlbum struct {
	BrowseID string
	VideoIDs []string
}

// discographyAlbums resolves a YT artist -> albums (MPREb..., capped) with
// their tracks, plus the top-songs tracks that belong to none of them.
func discographyAlbums(artistID string, maxAlbums int) (albums []discographyAlbum, singles []string) {
	if maxAlbums <= 0 {
		maxAlbums = 40
	}
	art := selfGetFn("/api/v1/artist/" + artistID)
	if art == nil {
		return nil, nil
	}
	isVid := func(s string) bool { return ytVideoRe.MatchString(s) }
	var browseIds, topIds []string
	collectKey(art, "browseId", &browseIds)
	collectKey(art, "videoId", &topIds) // top-songs shelf
	seen := map[string]bool{}
	ids := uniqStrings(browseIds, func(s string) bool { return len(s) > 5 && s[:5] == "MPREb" })
	for i, alb := range ids {
		if i >= maxAlbums {
			break
		}
		var vids []string
		collectKey(selfGetFn("/api/v1/main.json?browseId="+alb), "videoId", &vids)
		vids = uniqStrings(vids, func(s string) bool { return isVid(s) && !seen[s] })
		for _, v := range vids {
			seen[v] = true
		}
		if len(vids) > 0 {
			albums = append(albums, discographyAlbum{BrowseID: alb, VideoIDs: vids})
		}
		time.Sleep(acquireAlbumPause)
	}
	singles = uniqStrings(topIds, func(s string) bool { return isVid(s) && !seen[s] })
	return albums, singles
}

// discographyVideoIds flattens discographyAlbums (albums first, then singles).
func discographyVideoIds(artistID string, maxAlbums int) []string {
	albums, singles := discographyAlbums(artistID, maxAlbums)
	var out []string
	for _, a := range albums {
		out = append(out, a.VideoIDs...)
	}
	return append(out, singles...)
}

func enqueueYubal(vid string) bool {
	body, _ := json.Marshal(map[string]string{"url": "https://music.youtube.com/watch?v=" + vid})
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Post(
		envOr("YUBAL_URL", "http://yubal:8000")+"/api/jobs", "application/json", bytes.NewReader(body))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode < 400
}

// enqueueYubalURL posts an arbitrary album/playlist url (+ optional max_items)
// to Yubal. A 409 (queue full) is reported as false == silent drop.
func enqueueYubalURL(u string, maxItems int) bool {
	payload := map[string]interface{}{"url": u}
	if maxItems > 0 {
		payload["max_items"] = maxItems
	}
	body, _ := json.Marshal(payload)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Post(
		envOr("YUBAL_URL", "http://yubal:8000")+"/api/jobs", "application/json", bytes.NewReader(body))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode < 400
}

// runAcquire enqueues a discography to Yubal (rate-limited) + records jobs.
// Returns the number of tracks enqueued. Decision 8: the profile's daily cap
// is charged one acquisition per album enqueued (status "album", the row's
// videoId is the album browseId) and one per single track outside any album
// (status "enqueued"); the pull stops for the day once the cap is reached.
func runAcquire(profileID, artistID, name string, limit int) int {
	if _, busy := acquiring.LoadOrStore(artistID, true); busy {
		return 0
	}
	defer acquiring.Delete(artistID)
	albums, singles := discographyAlbums(artistID, 40)
	enq := 0
	enqueueTracks := func(vids []string) bool {
		for _, vid := range vids {
			if limit > 0 && enq >= limit {
				return false
			}
			if enqueueYubal(vid) {
				enq++
			}
			time.Sleep(acquireTrackPause)
		}
		return true
	}
	for _, alb := range albums {
		if limit > 0 && enq >= limit {
			return enq
		}
		if !acquireTryCharge(profileID, "album", artistID, name, alb.BrowseID) {
			return enq
		}
		if !enqueueTracks(alb.VideoIDs) {
			return enq
		}
	}
	for _, vid := range singles {
		if limit > 0 && enq >= limit {
			break
		}
		if !acquireTryCharge(profileID, "enqueued", artistID, name, vid) {
			break
		}
		if enqueueYubal(vid) {
			enq++
		}
		time.Sleep(acquireTrackPause)
	}
	return enq
}

// triggerAcquire is called fire-and-forget on follow of a YT artist.
func triggerAcquire(profileID, artistID, name string) {
	if artistID == "" || isLocalArtist(artistID) || isLocalAlbum(artistID) {
		return // local artists are already owned; nothing to fetch from YT
	}
	go runAcquire(profileID, artistID, name, 0)
}

// POST /api/v1/me/acquire {artistId?,name?,dryRun?,limit?} — manual trigger / dry-run.
func MeAcquireHandler(c echo.Context) error {
	pid := profileID(c)
	var b struct {
		ArtistID  string `json:"artistId"`
		Name      string `json:"name"`
		DryRun    bool   `json:"dryRun"`
		Limit     int    `json:"limit"`
		MaxAlbums int    `json:"maxAlbums"`
	}
	_ = decodeBody(c, &b)
	// Decision 8: an explicit acquisition past the profile's daily cap is
	// refused up front (a dry run only enumerates, it is not charged).
	if !b.DryRun && acquireAllowance(pid) <= 0 {
		return acquireQuotaResponse(c)
	}
	artistID := b.ArtistID
	if artistID == "" || isLocalArtist(artistID) {
		if b.Name == "" {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "need a YouTube artistId or name"})
		}
		artistID = resolveYTArtistByName(b.Name)
	}
	if artistID == "" {
		return c.JSON(http.StatusOK, map[string]interface{}{"found": 0, "note": "no YT artist resolved"})
	}
	if b.DryRun {
		vids := discographyVideoIds(artistID, b.MaxAlbums)
		sample := vids
		if len(sample) > 5 {
			sample = sample[:5]
		}
		return c.JSON(http.StatusOK, map[string]interface{}{"artistId": artistID, "found": len(vids), "sample": sample})
	}
	enq := runAcquire(pid, artistID, b.Name, b.Limit)
	return c.JSON(http.StatusOK, map[string]interface{}{"artistId": artistID, "enqueued": enq})
}

// GET /api/v1/me/acquire — acquisition jobs for this profile.
func MeAcquireStatusHandler(c echo.Context) error {
	pid := profileID(c)
	limit := clampLimit(c, 100, 1000)
	var jobs []db.AcquireJob
	db.DB.Where("profile_id = ?", pid).Order("created_at desc").Limit(limit).Find(&jobs)
	var total int64
	db.DB.Model(&db.AcquireJob{}).Where("profile_id = ?", pid).Count(&total)
	return c.JSON(http.StatusOK, map[string]interface{}{"jobs": jobs, "total": total})
}
