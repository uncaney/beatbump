package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/_youtube/api"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

type PlayerAPIResponse struct {
	// Define your response structure based on the actual data fields
}

func PlayerEndpointHandler(c echo.Context) error {
	requestUrl := c.Request().URL
	query := requestUrl.Query()
	videoId := query.Get("videoId")
	playlistId := query.Get("playlistId")
	//playerParams := query.Get("playerParams")
	if videoId == "" {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Missing required param: videoId"))
	}
	if isLid(videoId) {
		if r := LocalPlayer(videoId); r != nil {
			return c.JSON(http.StatusOK, r)
		}
	}

	var responseBytes []byte
	var err error

	responseBytes, err = callPlayerAPI(api.IOS_MUSIC, videoId, playlistId)

	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	var playerResponse _youtube.PlayerResponse
	err = json.Unmarshal(responseBytes, &playerResponse)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, "Unable to parse reeponse: "+err.Error())
	}

	if playerResponse.PlayabilityStatus.Status != "OK" {
		return c.JSON(http.StatusInternalServerError, "Playability status is not OK: "+playerResponse.PlayabilityStatus.Status)
	}

	if len(playerResponse.StreamingData.AdaptiveFormats) == 0 {
		return c.JSON(http.StatusInternalServerError, "Playability status is not OK: "+playerResponse.PlayabilityStatus.Status)
	}

	//258/251/22/256/140/250/18/249/139
	for i := 0; i < len(playerResponse.StreamingData.AdaptiveFormats); i++ {
		format := &playerResponse.StreamingData.AdaptiveFormats[i]
		/*if !strings.Contains(format.MimeType, "audio") {
			continue
		}*/
		streamUrl := format.URL

		format.URL = strings.Clone(streamUrl)
	}

	// Auto-cache on play: enqueue this track (+ its album + queue lookahead)
	// into the owned library. Fire-and-forget; never delays the JSON response.
	autoCacheOnPlay(videoId, playlistId, playerResponse)

	return c.JSON(http.StatusOK, playerResponse)
}

func autoCacheOnPlay(videoId string, playlistId string, playerResponse _youtube.PlayerResponse) {
	go func() {
		defer func() { _ = recover() }()

		if !autoCacheEnabled() {
			return
		}
		// Local (owned) tracks are addressed by lid and already in the library.
		if videoId == "" || isLid(videoId) || !ytVideoRe.MatchString(videoId) {
			return
		}

		// (a) The PLAYED track is enqueued by the ytm-cache bridge during
		// player resolution (it applies the same content-aware owned check),
		// so we do NOT enqueue it here too -- doing both raced and produced
		// duplicate Yubal jobs (P3). We only need the owned verdict to gate
		// the album + lookahead below.
		title := playerResponse.VideoDetails.Title
		author := playerResponse.VideoDetails.Author
		owned := meiliOwnsTrack(videoId, title, author)

		// (b) Resolve + enqueue the whole album this track belongs to --
		// unless we already own this track by content (P2a). Owning the track
		// almost always means the album is already in the library (e.g. a
		// lidarr rip); re-downloading it would create a duplicate album.
		if !owned {
			albumURL := ""
			if strings.HasPrefix(playlistId, "OLAK5uy") {
				// An OLAK5uy playlist IS the album; enqueue it directly.
				albumURL = "https://music.youtube.com/playlist?list=" + playlistId
			} else if a := resolveAlbumURL(videoId); a != "" {
				albumURL = a
			}
			if albumURL != "" && !autoCacheSeen("al:"+albumURL) {
				enqueueYubalURL(albumURL, 0)
			}
		}

		// (c) Look ahead in the queue and pre-cache upcoming tracks.
		//     Finite playlists (VL/OLAK5uy/PL): up to 20. RD*/mix: cap at 3.
		if playlistId == "" || playlistId == "undefined" {
			return
		}
		lookahead := 0
		if isFinitePlaylist(playlistId) {
			lookahead = 20
		} else if isMixPlaylist(playlistId) {
			lookahead = 3
		} else {
			return
		}
		enqueueLookahead(videoId, playlistId, lookahead)
	}()
}

// --- auto-cache toggles + guards -------------------------------------------

// autoCacheEnabled: BEATBUMP_AUTOCACHE (default true). Only "false"/"0"/"no"/
// "off" disables it.
func autoCacheEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("BEATBUMP_AUTOCACHE"))) {
	case "false", "0", "no", "off":
		return false
	}
	return true
}

const autoCacheTTL = 6 * time.Hour

// autoCacheDebounce: key -> last-seen time. In-memory only (best-effort).
var autoCacheDebounce sync.Map

// autoCacheSeen reports whether key was processed within autoCacheTTL, and marks
// it seen otherwise (debounce so replays/loops don't re-enqueue constantly).
func autoCacheSeen(key string) bool {
	now := time.Now()
	if v, ok := autoCacheDebounce.Load(key); ok {
		if t, ok := v.(time.Time); ok && now.Sub(t) < autoCacheTTL {
			return true
		}
	}
	autoCacheDebounce.Store(key, now)
	return false
}

// meiliOwnsVideo reports whether a YT videoId is already in the owned library
// (best-effort: only a subset of tracks carry a videoId, Yubal also dedups).
func meiliOwnsVideo(vid string) bool {
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": "", "filter": "videoId = \"" + vid + "\"", "limit": 1,
		"attributesToRetrieve": []string{"lid"},
	})
	return len(hits) > 0
}

func isFinitePlaylist(pid string) bool {
	return strings.HasPrefix(pid, "VL") ||
		strings.HasPrefix(pid, "OLAK5uy") ||
		strings.HasPrefix(pid, "PL")
}

func isMixPlaylist(pid string) bool { return strings.HasPrefix(pid, "RD") }

// resolveAlbumURL asks Yubal's album resolver for the album that owns videoId.
// Accepts {url} | {playlistId} | {browseId}. Empty on any failure.
func resolveAlbumURL(videoId string) string {
	base := envOr("YUBAL_URL", "http://yubal:8000")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Get(
		base + "/api/resolve/album?videoId=" + url.QueryEscape(videoId))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return ""
	}
	b, _ := io.ReadAll(resp.Body)
	var m map[string]interface{}
	if json.Unmarshal(b, &m) != nil {
		return ""
	}
	// The p18 yubal shim returns {"albumUrl": ...}; older/alt resolvers may
	// use url|playlistId|browseId. Accept all.
	if s, ok := m["albumUrl"].(string); ok && s != "" {
		return s
	}
	if s, ok := m["url"].(string); ok && s != "" {
		return s
	}
	if s, ok := m["playlistId"].(string); ok && s != "" {
		return "https://music.youtube.com/playlist?list=" + s
	}
	if s, ok := m["browseId"].(string); ok && s != "" {
		return "https://music.youtube.com/browse/" + s
	}
	return ""
}

// enqueueLookahead pulls the upcoming queue via the residential-proxied Next and
// enqueues up to `limit` not-yet-owned upcoming tracks (skips current + lids).
func enqueueLookahead(videoId string, playlistId string, limit int) {
	if limit <= 0 {
		return
	}
	rb, err := api.NextResidential(videoId, playlistId, api.WebMusic, map[string]string{})
	if err != nil {
		return
	}
	var nr _youtube.NextResponse
	if json.Unmarshal(rb, &nr) != nil {
		return
	}
	parsed := ParseNextBody(nr)
	n := 0
	for _, it := range parsed.Results {
		if n >= limit {
			break
		}
		vid := it.VideoID
		if vid == "" || vid == videoId || isLid(vid) || !ytVideoRe.MatchString(vid) {
			continue
		}
		if autoCacheSeen("v:"+vid) || meiliOwnsTrack(vid, it.Title, itemArtist(it)) {
			continue
		}
		enqueueYubal(vid) // 409 -> silent drop
		n++
	}
}

func callPlayerAPI(clientInfo api.ClientInfo, videoId string, playlistId string) ([]byte, error) {

	responseBytes, err := api.Player(videoId, playlistId, clientInfo, nil)

	if err != nil {
		return nil, errors.New(fmt.Sprintf("Error building API request: %s", err))
	}

	return responseBytes, err
}
