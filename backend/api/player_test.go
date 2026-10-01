package api

import (
	"beatbump-server/backend/_youtube"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- fake companion ---------------------------------------------------------

const testVideoId = "Wa9ZKvptpUs"

// playerFixture builds a minimal InnerTube player response.
func playerFixture(status, reason string, withFormats bool) map[string]interface{} {
	ps := map[string]interface{}{"status": status}
	if reason != "" {
		ps["reason"] = reason
	}
	sd := map[string]interface{}{"expiresInSeconds": "21600", "formats": []interface{}{}, "adaptiveFormats": []interface{}{}}
	if withFormats {
		sd["adaptiveFormats"] = []interface{}{map[string]interface{}{
			"itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 128000,
			"url": "https://rr1---sn-test.googlevideo.com/videoplayback?id=" + testVideoId,
		}}
	}
	return map[string]interface{}{
		"playabilityStatus": ps,
		"videoDetails":      map[string]interface{}{"videoId": testVideoId, "title": "T", "author": "A", "lengthSeconds": "200"},
		"streamingData":     sd,
	}
}

// stubAutoCache replaces the auto-cache hook for the duration of the test:
// counts calls, never touches the network.
func stubAutoCache(t *testing.T) *int32 {
	t.Helper()
	var calls int32
	prev := autoCacheOnPlayFn
	autoCacheOnPlayFn = func(string, string, _youtube.PlayerResponse) { atomic.AddInt32(&calls, 1) }
	t.Cleanup(func() { autoCacheOnPlayFn = prev })
	return &calls
}

func callPlayer(t *testing.T, rawQuery string, headers map[string]string) (*httptest.ResponseRecorder, error) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/player.json?"+rawQuery, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	return rec, PlayerEndpointHandler(c)
}

func decodeErr(t *testing.T, rec *httptest.ResponseRecorder) PlayerError {
	t.Helper()
	assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var pe PlayerError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &pe), "error body must be JSON: %s", rec.Body.String())
	return pe
}

func companionJSON(t *testing.T, body interface{}, check func(r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if check != nil {
			check(r)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}
}

// --- tests ---------------------------------------------------------------------

func TestPlayerSuccessKeepsShape(t *testing.T) {
	var gotPath, gotVideoId string
	srv := httptest.NewServer(companionJSON(t, playerFixture("OK", "", true), func(r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		_ = json.Unmarshal(b, &m)
		gotVideoId, _ = m["videoId"].(string)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("COMPANION_URL", srv.URL+"/") // trailing slash must be tolerated
	calls := stubAutoCache(t)

	rec, err := callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "/companion/youtubei/v1/player", gotPath)
	assert.Equal(t, testVideoId, gotVideoId)

	var got map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	ps := got["playabilityStatus"].(map[string]interface{})
	assert.Equal(t, "OK", ps["status"])
	_, hasReason := ps["reason"]
	assert.False(t, hasReason, "success payload must not grow a reason field")
	af := got["streamingData"].(map[string]interface{})["adaptiveFormats"].([]interface{})
	require.Len(t, af, 1)
	assert.Contains(t, af[0].(map[string]interface{})["url"], "googlevideo.com/videoplayback")
	assert.Equal(t, int32(1), atomic.LoadInt32(calls), "a real play triggers auto-cache")
}

func TestPlayerUnplayableIs404JSON(t *testing.T) {
	cases := []struct {
		status, reason, wantReason string
	}{
		{"UNPLAYABLE", "Video unavailable", "Video unavailable"},
		{"LOGIN_REQUIRED", "", "This track requires a signed-in account"},
		{"ERROR", "This video is not available in your country", "This video is not available in your country"},
		{"AGE_VERIFICATION_REQUIRED", "", "This track is age-restricted"},
	}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			var hits int32
			srv := httptest.NewServer(companionJSON(t, playerFixture(tc.status, tc.reason, false), func(*http.Request) { atomic.AddInt32(&hits, 1) }))
			t.Cleanup(srv.Close)
			t.Setenv("COMPANION_URL", srv.URL)
			calls := stubAutoCache(t)

			rec, err := callPlayer(t, "videoId="+testVideoId, nil)
			require.NoError(t, err)
			assert.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
			pe := decodeErr(t, rec)
			assert.Equal(t, PlayerError{Error: "unplayable", Status: tc.status, Reason: tc.wantReason, VideoID: testVideoId}, pe)
			assert.Equal(t, int32(1), atomic.LoadInt32(&hits), "non-OK status is final: the bridge already ran its fallback, no second call")
			assert.Equal(t, int32(0), atomic.LoadInt32(calls), "no auto-cache on an unplayable track")
		})
	}
}

func TestPlayerOKWithoutStreamsIs404(t *testing.T) {
	srv := httptest.NewServer(companionJSON(t, playerFixture("OK", "", false), nil))
	t.Cleanup(srv.Close)
	t.Setenv("COMPANION_URL", srv.URL)
	stubAutoCache(t)

	rec, err := callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusNotFound, rec.Code)
	pe := decodeErr(t, rec)
	assert.Equal(t, "unplayable", pe.Error)
	assert.Equal(t, "NO_STREAMS", pe.Status)
	assert.Equal(t, testVideoId, pe.VideoID)
	assert.NotEmpty(t, pe.Reason)
}

func TestPlayerInvalidResponseIs502(t *testing.T) {
	t.Run("non-json", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, "<html>upstream broke</html>")
		}))
		t.Cleanup(srv.Close)
		t.Setenv("COMPANION_URL", srv.URL)
		stubAutoCache(t)

		rec, err := callPlayer(t, "videoId="+testVideoId, nil)
		require.NoError(t, err)
		assert.Equal(t, http.StatusBadGateway, rec.Code)
		pe := decodeErr(t, rec)
		assert.Equal(t, PlayerError{Error: "upstream", Status: "INVALID_RESPONSE", Reason: pe.Reason, VideoID: testVideoId}, pe)
		assert.NotEmpty(t, pe.Reason)
	})
	t.Run("json-but-not-a-player-response", func(t *testing.T) {
		srv := httptest.NewServer(companionJSON(t, map[string]interface{}{"hello": "world"}, nil))
		t.Cleanup(srv.Close)
		t.Setenv("COMPANION_URL", srv.URL)
		stubAutoCache(t)

		rec, err := callPlayer(t, "videoId="+testVideoId, nil)
		require.NoError(t, err)
		assert.Equal(t, http.StatusBadGateway, rec.Code)
		assert.Equal(t, "INVALID_RESPONSE", decodeErr(t, rec).Status)
	})
	t.Run("upstream-5xx", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "bridge upstream error: boom", http.StatusServiceUnavailable)
		}))
		t.Cleanup(srv.Close)
		t.Setenv("COMPANION_URL", srv.URL)
		stubAutoCache(t)

		rec, err := callPlayer(t, "videoId="+testVideoId, nil)
		require.NoError(t, err)
		assert.Equal(t, http.StatusBadGateway, rec.Code)
		pe := decodeErr(t, rec)
		assert.Equal(t, "upstream", pe.Error)
		assert.Equal(t, "BAD_STATUS", pe.Status)
		assert.Contains(t, pe.Reason, "503")
	})
}

func TestPlayerUnreachableIs502WithOneRetry(t *testing.T) {
	// A server that is closed before the call: connection refused on every attempt.
	srv := httptest.NewServer(http.NotFoundHandler())
	dead := srv.URL
	srv.Close()
	t.Setenv("COMPANION_URL", dead)
	stubAutoCache(t)
	prev := playerRetryDelay
	playerRetryDelay = 5 * time.Millisecond
	t.Cleanup(func() { playerRetryDelay = prev })

	rec, err := callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadGateway, rec.Code)
	pe := decodeErr(t, rec)
	assert.Equal(t, "upstream", pe.Error)
	assert.Equal(t, "UNREACHABLE", pe.Status)

	// Same failure on the first attempt only: the single retry must recover it.
	var n int32
	flaky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&n, 1) == 1 {
			// Hijack and drop the connection: a transport error, not an HTTP status.
			hj, ok := w.(http.Hijacker)
			require.True(t, ok)
			conn, _, err := hj.Hijack()
			require.NoError(t, err)
			_ = conn.Close()
			return
		}
		companionJSON(t, playerFixture("OK", "", true), nil)(w, r)
	}))
	t.Cleanup(flaky.Close)
	t.Setenv("COMPANION_URL", flaky.URL)
	rec, err = callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, int32(2), atomic.LoadInt32(&n), "exactly one retry")
}

func TestPlayerTimeoutIs504(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); srv.Close() })
	t.Setenv("COMPANION_URL", srv.URL)
	t.Setenv("PLAYER_TIMEOUT_SECONDS", "1")
	stubAutoCache(t)

	start := time.Now()
	rec, err := callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	pe := decodeErr(t, rec)
	assert.Equal(t, "timeout", pe.Error)
	assert.Equal(t, "TIMEOUT", pe.Status)
	assert.Equal(t, testVideoId, pe.VideoID)
	assert.Less(t, time.Since(start), 5*time.Second, "timeout must be enforced, not the 120 s ceiling")
}

func TestPlayerBadRequestIs400(t *testing.T) {
	stubAutoCache(t)
	rec, err := callPlayer(t, "", nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	pe := decodeErr(t, rec)
	assert.Equal(t, "bad_request", pe.Error)
	assert.Equal(t, "BAD_REQUEST", pe.Status)

	rec, err = callPlayer(t, "videoId=not-a-valid-id", nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, "not-a-valid-id", decodeErr(t, rec).VideoID)
}

func TestPlayerMissingCompanionIs500(t *testing.T) {
	if os.Getenv("COMPANION_URL") != "" {
		t.Skip("COMPANION_URL is set for this run: the init-time fallback would apply")
	}
	t.Setenv("COMPANION_URL", "")
	stubAutoCache(t)

	rec, err := callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	pe := decodeErr(t, rec)
	assert.Equal(t, "internal", pe.Error)
	assert.Equal(t, "INTERNAL", pe.Status)
}

func TestPlayerPrefetchDoesNotAutoCache(t *testing.T) {
	srv := httptest.NewServer(companionJSON(t, playerFixture("OK", "", true), nil))
	t.Cleanup(srv.Close)
	t.Setenv("COMPANION_URL", srv.URL)
	calls := stubAutoCache(t)

	rec, err := callPlayer(t, "videoId="+testVideoId+"&playlistId=RDAMVM"+testVideoId, map[string]string{"X-Ytm-Prefetch": "1"})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code, "prefetch is served like a play")
	assert.Equal(t, int32(0), atomic.LoadInt32(calls), "X-Ytm-Prefetch must not trigger acquisition")

	rec, err = callPlayer(t, "videoId="+testVideoId+"&prefetch=1", nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(0), atomic.LoadInt32(calls), "?prefetch=1 must not trigger acquisition")

	rec, err = callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(1), atomic.LoadInt32(calls), "a plain request is a play")
}

// TestPlayer is the historical end-to-end check against a live companion; it
// stays skipped unless COMPANION_URL points at one.
func TestPlayer(t *testing.T) {
	if os.Getenv("COMPANION_URL") == "" {
		t.Skip("needs a reachable companion (COMPANION_URL)")
	}
	q := make(url.Values)
	q.Set("videoId", "uJdu4Lfy8aI")
	rec, err := callPlayer(t, q.Encode(), nil)
	if assert.NoError(t, err) {
		assert.Equal(t, http.StatusOK, rec.Code)
		fmt.Print(rec.Body.String())
	}
}

func TestSearch(t *testing.T) {
	e := echo.New()
	q := make(url.Values)
	q.Set("q", "depeche mode")

	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if assert.NoError(t, SearchEndpointHandler(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		s := rec.Body.String()
		fmt.Print(s)
	}
}

func TestPlayerNonLocalAudioGoesThroughIVVP(t *testing.T) {
	fx := playerFixture("OK", "", true)
	sd := fx["streamingData"].(map[string]interface{})
	// What the bridge returns for a track that is not in the library: audio rewritten to
	// the gost proxy (/vp?u=<googlevideo>), video left on googlevideo.
	sd["adaptiveFormats"] = []interface{}{
		map[string]interface{}{"itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 160000,
			"url": "/vp?u=https%3A%2F%2Frr1---sn-test.googlevideo.com%2Fvideoplayback%3Fid%3D" + testVideoId + "%26itag%3D251"},
		map[string]interface{}{"itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 128000,
			"url": "/vp?u=https%3A%2F%2Frr1---sn-test.googlevideo.com%2Fvideoplayback%3Fid%3D" + testVideoId + "%26itag%3D140"},
		map[string]interface{}{"itag": 137, "mimeType": "video/mp4; codecs=\"avc1.640028\"", "bitrate": 2000000,
			"url": "https://rr1---sn-test.googlevideo.com/videoplayback?id=" + testVideoId + "&itag=137"},
	}
	srv := httptest.NewServer(companionJSON(t, fx, nil))
	t.Cleanup(srv.Close)
	t.Setenv("COMPANION_URL", srv.URL)
	stubAutoCache(t)

	rec, err := callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	af := got["streamingData"].(map[string]interface{})["adaptiveFormats"].([]interface{})
	require.Len(t, af, 2, "one audio entry (iv-vp) + the untouched video entry")
	audio := af[0].(map[string]interface{})
	assert.Equal(t, "/aud/"+testVideoId, audio["url"])
	assert.Equal(t, float64(140), audio["itag"])
	assert.Contains(t, audio["mimeType"], "audio/mp4")
	video := af[1].(map[string]interface{})
	assert.Contains(t, video["url"], "googlevideo.com/videoplayback")

	// Local-library tracks (/localf) are never rerouted.
	sd["adaptiveFormats"] = []interface{}{map[string]interface{}{"itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "url": "/localf?p=ytm%2Fx.opus"}}
	rec, err = callPlayer(t, "videoId="+testVideoId, nil)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	af = got["streamingData"].(map[string]interface{})["adaptiveFormats"].([]interface{})
	assert.Equal(t, "/localf?p=ytm%2Fx.opus", af[0].(map[string]interface{})["url"])
}
