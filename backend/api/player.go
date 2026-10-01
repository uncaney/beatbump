package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/_youtube/api"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/labstack/echo/v4"
)

// PlayerError is the structured error payload of /api/v1/player.json.
//
// Contract (HTTP status -> Error -> Status):
//
//	400 bad_request  BAD_REQUEST       missing/malformed videoId
//	404 unplayable   <playability>     YouTube says the content cannot be played
//	                                   (UNPLAYABLE, LOGIN_REQUIRED, ERROR, AGE_VERIFICATION_REQUIRED,
//	                                   CONTENT_CHECK_REQUIRED, ...) or NO_STREAMS when
//	                                   the status is OK but no adaptive format came back
//	502 upstream     UNREACHABLE       companion bridge cannot be reached (dial/reset)
//	                 BAD_STATUS        companion bridge answered a non-200 HTTP status
//	                 INVALID_RESPONSE  companion bridge answered non-JSON / unparsable JSON
//	504 timeout      TIMEOUT           no answer within the player budget (api.PlayerTimeout)
//	500 internal     INTERNAL          a bug or a deployment error on this backend
//
// Reason is always a human-readable sentence the front can display as-is.
// The success payload (200) is unchanged: the raw InnerTube player response.
type PlayerError struct {
	Error   string `json:"error"`
	Status  string `json:"status"`
	Reason  string `json:"reason"`
	VideoID string `json:"videoId"`
}

// Error kinds (PlayerError.Error).
const (
	PlayerErrBadRequest = "bad_request"
	PlayerErrUnplayable = "unplayable"
	PlayerErrUpstream   = "upstream"
	PlayerErrTimeout    = "timeout"
	PlayerErrInternal   = "internal"
)

// autoCacheOnPlayFn is the auto-cache trigger; a variable so tests can
// observe whether a request counted as a play or as a prefetch.
var autoCacheOnPlayFn = autoCacheOnPlay

// isPrefetchRequest reports whether the request is a next-track warm-up
// (X-Ytm-Prefetch header or ?prefetch=1): served identically, but it must not
// trigger server-side acquisition.
func isPrefetchRequest(c echo.Context) bool {
	return c.Request().Header.Get("X-Ytm-Prefetch") != "" || c.QueryParam("prefetch") == "1"
}

func playerErrorResponse(c echo.Context, code int, kind, status, reason, videoId string) error {
	if reason == "" {
		reason = "Playback is not available for this track"
	}
	c.Response().Header().Set("Cache-Control", "no-store")
	log.Printf("[player] %s -> %d %s/%s: %s", videoId, code, kind, status, reason)
	return c.JSON(code, PlayerError{Error: kind, Status: status, Reason: reason, VideoID: videoId})
}

// classifyPlayerCallError maps an api.Player error to (HTTP code, kind,
// status, reason).
func classifyPlayerCallError(err error) (int, string, string, string) {
	var upstream *api.UpstreamStatusError
	var netErr net.Error
	switch {
	case errors.Is(err, api.ErrCompanionNotConfigured):
		return http.StatusInternalServerError, PlayerErrInternal, "INTERNAL", "Player backend is not configured (companion URL missing)"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return http.StatusGatewayTimeout, PlayerErrTimeout, "TIMEOUT",
			fmt.Sprintf("The player service did not answer within %s", api.PlayerTimeout())
	case errors.As(err, &upstream):
		return http.StatusBadGateway, PlayerErrUpstream, "BAD_STATUS",
			fmt.Sprintf("The player service answered HTTP %d", upstream.StatusCode)
	default:
		return http.StatusBadGateway, PlayerErrUpstream, "UNREACHABLE", "The player service cannot be reached"
	}
}

// unplayableReason builds the displayable reason for a non-OK playability
// status, preferring YouTube's own text.
func unplayableReason(status, reason string) string {
	if reason != "" {
		return reason
	}
	switch status {
	case "LOGIN_REQUIRED":
		return "This track requires a signed-in account"
	case "AGE_VERIFICATION_REQUIRED", "AGE_CHECK_REQUIRED":
		return "This track is age-restricted"
	case "CONTENT_CHECK_REQUIRED":
		return "This track requires a content check"
	case "ERROR", "UNPLAYABLE":
		return "This track is unavailable"
	}
	return "This track cannot be played (" + status + ")"
}

func PlayerEndpointHandler(c echo.Context) error {
	requestUrl := c.Request().URL
	query := requestUrl.Query()
	videoId := query.Get("videoId")
	playlistId := query.Get("playlistId")
	//playerParams := query.Get("playerParams")
	if videoId == "" {
		return playerErrorResponse(c, http.StatusBadRequest, PlayerErrBadRequest, "BAD_REQUEST", "Missing required param: videoId", videoId)
	}
	if !ytVideoRe.MatchString(videoId) {
		return playerErrorResponse(c, http.StatusBadRequest, PlayerErrBadRequest, "BAD_REQUEST", "Malformed videoId", videoId)
	}
	if isLid(videoId) {
		if r := LocalPlayer(videoId); r != nil {
			return c.JSON(http.StatusOK, r)
		}
	}

	// One call: the bridge already runs the logged-in iv-vp fallback whenever
	// the anonymous companion answers a non-playable status, so a non-OK
	// playabilityStatus here is final. Only a transport failure (bridge
	// restarting, connection reset) is retried, once.
	responseBytes, err := callPlayerAPI(api.IOS_MUSIC, videoId, playlistId)
	if err != nil {
		if code, _, status, _ := classifyPlayerCallError(err); code == http.StatusBadGateway && status == "UNREACHABLE" {
			time.Sleep(playerRetryDelay)
			responseBytes, err = callPlayerAPI(api.IOS_MUSIC, videoId, playlistId)
		}
	}
	if err != nil {
		code, kind, status, reason := classifyPlayerCallError(err)
		return playerErrorResponse(c, code, kind, status, reason, videoId)
	}

	var playerResponse _youtube.PlayerResponse
	if err := json.Unmarshal(responseBytes, &playerResponse); err != nil {
		return playerErrorResponse(c, http.StatusBadGateway, PlayerErrUpstream, "INVALID_RESPONSE",
			"The player service returned an unreadable response", videoId)
	}

	ps := playerResponse.PlayabilityStatus
	if ps.Status != "OK" {
		status := ps.Status
		if status == "" {
			// JSON without any playabilityStatus is not a player response at all.
			return playerErrorResponse(c, http.StatusBadGateway, PlayerErrUpstream, "INVALID_RESPONSE",
				"The player service returned an unexpected response", videoId)
		}
		return playerErrorResponse(c, http.StatusNotFound, PlayerErrUnplayable, status, unplayableReason(status, ps.Reason), videoId)
	}

	if len(playerResponse.StreamingData.AdaptiveFormats) == 0 {
		return playerErrorResponse(c, http.StatusNotFound, PlayerErrUnplayable, "NO_STREAMS",
			"No playable stream was returned for this track", videoId)
	}

	//258/251/22/256/140/250/18/249/139
	for i := 0; i < len(playerResponse.StreamingData.AdaptiveFormats); i++ {
		format := &playerResponse.StreamingData.AdaptiveFormats[i]
		/*if !strings.Contains(format.MimeType, "audio") {
			continue
		}*/
		streamUrl := format.URL

		// Same-origin audio: known public bases (ytify/invidious) become
		// relative paths proxied by this backend (see audioproxy.go).
		format.URL = RewriteAudioURL(strings.Clone(streamUrl))
	}
	for i := 0; i < len(playerResponse.StreamingData.Formats); i++ {
		format := &playerResponse.StreamingData.Formats[i]
		format.URL = RewriteAudioURL(format.URL)
	}
	preferIVVPAudio(&playerResponse, videoId)

	// Auto-cache on play: enqueue this track (+ its album + queue lookahead)
	// into the owned library. Fire-and-forget; never delays the JSON response.
	// Prefetch requests (next track warm-up) must not trigger server side acquisition.
	if !isPrefetchRequest(c) {
		autoCacheOnPlayFn(videoId, playlistId, playerResponse)
	}

	return c.JSON(http.StatusOK, playerResponse)
}

// playerRetryDelay is the pause before the single transport-level retry of the
// companion call (a variable so tests keep fast).
var playerRetryDelay = 300 * time.Millisecond

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
		owned := cachedOwnsTrack(videoId, title, author)

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

// ---- owned verdict memo (K14) ----
// autoCacheOnPlay asked Meili 1-2 searches per lookahead track on every
// player.json of a radio (up to 20 tracks); the same tracks come back on
// every replay. The verdict is memoised per videoId for ownedVerdictTTL.
const ownedVerdictTTL = time.Hour

// ownedVerdictMaxEntries: above this many memoised videoIds, an insert purges
// the expired entries (L22: the map was never purged, one entry per played
// or looked-ahead videoId until restart).
const ownedVerdictMaxEntries = 5000

type ownedVerdict struct {
	owned bool
	at    time.Time
}

var (
	ownedVerdicts     sync.Map         // videoId -> ownedVerdict
	ownedVerdictCount atomic.Int64     // live entries of ownedVerdicts (best effort)
	ownsTrackFn       = meiliOwnsTrack // seam for tests
	ownedNow          = time.Now       // seam for tests
)

// cachedOwnsTrack is meiliOwnsTrack memoised per videoId for one hour.
func cachedOwnsTrack(videoId, title, artist string) bool {
	if videoId == "" {
		return ownsTrackFn(videoId, title, artist)
	}
	now := ownedNow()
	if v, ok := ownedVerdicts.Load(videoId); ok {
		if e, ok := v.(ownedVerdict); ok && now.Sub(e.at) < ownedVerdictTTL {
			return e.owned
		}
	}
	owned := ownsTrackFn(videoId, title, artist)
	if _, replaced := ownedVerdicts.Swap(videoId, ownedVerdict{owned: owned, at: now}); !replaced {
		if ownedVerdictCount.Add(1) > ownedVerdictMaxEntries {
			purgeOwnedVerdicts(now)
		}
	}
	return owned
}

// purgeOwnedVerdicts deletes the entries expired at now and recounts.
func purgeOwnedVerdicts(now time.Time) {
	var live int64
	ownedVerdicts.Range(func(k, v interface{}) bool {
		if e, ok := v.(ownedVerdict); !ok || now.Sub(e.at) >= ownedVerdictTTL {
			ownedVerdicts.Delete(k)
		} else {
			live++
		}
		return true
	})
	ownedVerdictCount.Store(live)
}

// InvalidateOwnedVerdict forgets the memoised verdict of videoId so the next
// play asks Meili again (L22: an acquisition completed at t+2 min left
// owned=false for the rest of the hour, so every replay re-resolved and
// re-enqueued the album). Called by the in-process downloader when a track
// lands in the library (downloader.finalizeTask). Yubal runs as a separate
// service with no completion callback into this server: tracks it acquires
// keep the TTL.
func InvalidateOwnedVerdict(videoId string) {
	if _, loaded := ownedVerdicts.LoadAndDelete(videoId); loaded {
		ownedVerdictCount.Add(-1)
	}
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
		if autoCacheSeen("v:"+vid) || cachedOwnsTrack(vid, it.Title, itemArtist(it)) {
			continue
		}
		enqueueYubal(vid) // 409 -> silent drop
		n++
	}
}

// callPlayerAPI returns api.Player's error unwrapped so the handler can
// classify it (typed upstream error, timeout, configuration).
func callPlayerAPI(clientInfo api.ClientInfo, videoId string, playlistId string) ([]byte, error) {
	return api.Player(videoId, playlistId, clientInfo, nil)
}

// preferIVVPAudio routes the audio of tracks that are not in the library through
// iv-vp (/aud/<videoId>, itag 140 m4a with Range) instead of the gost /vp proxy.
// The companion's googlevideo URLs carry an untransformed "n" parameter, so
// googlevideo throttles /vp to ~18 KB/s (below a 128 kbps stream): the browser
// ends in PIPELINE_ERROR_READ / DEMUXER_ERROR_NO_SUPPORTED_STREAMS. iv-vp
// fetches at full speed (first byte after a few seconds, then cached) and the
// next-track prefetch warms it. Video formats are left untouched. Disable with
// YTM_PREFER_IVVP_AUDIO=0.
func preferIVVPAudio(pr *_youtube.PlayerResponse, videoId string) {
	if os.Getenv("YTM_PREFER_IVVP_AUDIO") == "0" || !ytVideoRe.MatchString(videoId) {
		return
	}
	af := pr.StreamingData.AdaptiveFormats
	kept := af[:0]
	rerouted := false
	for i := range af {
		f := af[i]
		if !strings.HasPrefix(f.MimeType, "audio/") || !strings.HasPrefix(f.URL, "/vp?") {
			kept = append(kept, f)
			continue
		}
		if rerouted {
			continue // one audio entry is enough: every /vp audio maps to the same /aud file
		}
		f.URL = "/aud/" + videoId
		f.Itag = 140
		f.MimeType = "audio/mp4; codecs=\"mp4a.40.2\""
		f.ContentLength = ""
		f.InitRange.Start, f.InitRange.End = "", ""
		f.IndexRange.Start, f.IndexRange.End = "", ""
		kept = append(kept, f)
		rerouted = true
	}
	if rerouted {
		pr.StreamingData.AdaptiveFormats = kept
	}
}
