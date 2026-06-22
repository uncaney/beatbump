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

// discographyVideoIds resolves a YT artist → albums → track videoIds (capped).
func discographyVideoIds(artistID string, maxAlbums int) []string {
	if maxAlbums <= 0 {
		maxAlbums = 40
	}
	art := selfGet("/api/v1/artist/" + artistID)
	if art == nil {
		return nil
	}
	var browseIds, videoIds []string
	collectKey(art, "browseId", &browseIds)
	collectKey(art, "videoId", &videoIds) // top-songs shelf
	albums := uniqStrings(browseIds, func(s string) bool { return len(s) > 5 && s[:5] == "MPREb" })
	for i, alb := range albums {
		if i >= maxAlbums {
			break
		}
		a := selfGet("/api/v1/main.json?browseId=" + alb)
		collectKey(a, "videoId", &videoIds)
		time.Sleep(250 * time.Millisecond) // be gentle on companion
	}
	return uniqStrings(videoIds, func(s string) bool { return ytVideoRe.MatchString(s) })
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

// runAcquire enqueues a discography to Yubal (rate-limited) + records jobs.
func runAcquire(profileID, artistID, name string, limit int) int {
	if _, busy := acquiring.LoadOrStore(artistID, true); busy {
		return 0
	}
	defer acquiring.Delete(artistID)
	vids := discographyVideoIds(artistID, 40)
	enq := 0
	for _, vid := range vids {
		if limit > 0 && enq >= limit {
			break
		}
		if enqueueYubal(vid) {
			db.DB.Create(&db.AcquireJob{ProfileID: profileID, ArtistID: artistID, ArtistName: name, VideoID: vid, Status: "enqueued", CreatedAt: time.Now()})
			enq++
		}
		time.Sleep(500 * time.Millisecond) // slow, polite acquisition
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
