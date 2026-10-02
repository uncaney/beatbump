package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const URL_BASE = "https://music.youtube.com/youtubei/v1/"

const DEBUG = false

var companionBaseURL string
var companionAPIKey string

func init() {
	companionBaseURL = os.Getenv("COMPANION_URL")
	companionAPIKey = os.Getenv("COMPANION_SECRET_KEY")
}

// ErrCompanionNotConfigured: COMPANION_URL is empty; a deployment bug, not an
// upstream failure.
var ErrCompanionNotConfigured = errors.New("companion base URL not configured (COMPANION_URL)")

// UpstreamStatusError is returned when the upstream (companion bridge or
// YouTube) answered with a non-200 HTTP status. Callers can errors.As on it to
// distinguish "upstream answered badly" from "upstream unreachable".
type UpstreamStatusError struct {
	StatusCode int
	Status     string
	Body       string // truncated response body, for logs / reason
}

func (e *UpstreamStatusError) Error() string {
	return "upstream status " + e.Status
}

// companionURL returns the companion base URL without a trailing slash.
// COMPANION_URL is re-read on every call so tests (t.Setenv) and runtime
// reconfiguration work; the init-time value is only a fallback.
func companionURL() string {
	u := os.Getenv("COMPANION_URL")
	if u == "" {
		u = companionBaseURL
	}
	return strings.TrimRight(u, "/")
}

// httpClientTimeout is the hard ceiling for any single InnerTube / companion
// call made through getHttpClient() (previously unbounded: a hung upstream
// pinned the Echo handler forever). Per-endpoint budgets (see PlayerTimeout)
// use request contexts below this ceiling.
const httpClientTimeout = 120 * time.Second

// defaultPlayerTimeout is the budget for one player resolution through the
// bridge. PF5-3: it was 90 s, sized on the bridge's own chain (companion
// 45 s, then the logged-in iv-vp fallback up to 75 s), so a walled video
// held the SPA for 30 s and more without ever failing (two 200s at 30.2 s
// and 33.6 s in audit v5, and the browser gave up at 30 s anyway). 20 s now:
// past it the handler answers the existing 504 TIMEOUT (player.go) and the
// SPA can tell the user instead of hanging; the bridge keeps working on the
// late success, which the next play picks up. PLAYER_TIMEOUT_SECONDS still
// overrides it (an operator can restore 90 for a slow iv-vp).
const defaultPlayerTimeout = 20 * time.Second

// PlayerTimeout returns the player call budget, overridable with
// PLAYER_TIMEOUT_SECONDS (integer seconds, > 0).
func PlayerTimeout() time.Duration {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("PLAYER_TIMEOUT_SECONDS"))); err == nil && v > 0 {
		return time.Duration(v) * time.Second
	}
	return defaultPlayerTimeout
}

func Browse(browseId string, pageType PageType, params string,
	visitorData *string, itct *string, ctoken *string, client ClientInfo) ([]byte, error) {

	urlAddress := URL_BASE + "browse" + "?prettyPrint=false"
	innertubeContext := prepareInnertubeContext(client, visitorData)

	data := innertubeRequest{
		Context: innertubeContext,
	}
	if (itct == nil || *itct == "") && ctoken != nil {
		data = innertubeRequest{
			//RequestAttributes: additionalRequestAttributes,
			Continuation: ctoken,
			Context:      innertubeContext,
			//ContentCheckOK: true,
			//RacyCheckOk:    true,
			BrowseEndpointContextMusicConfig: &BrowseEndpointContextMusicConfig{
				PageType: string(pageType),
			},
		}
	} else if itct != nil && ctoken != nil {
		urlAddress = handleContinuation(urlAddress, *itct, *ctoken)
	} else {

		data = innertubeRequest{
			//RequestAttributes: additionalRequestAttributes,
			BrowseID: browseId,
			Context:  innertubeContext,
			//ContentCheckOK: true,
			//RacyCheckOk:    true,
			// BrowseEndpointContextMusicConfig: &BrowseEndpointContextMusicConfig{
			// 	PageType: string(pageType),
			// },
		}
	}

	if ctoken != nil {
		data.Continuation = ctoken
	}

	if params != "" {
		data.Params = params
	}
	resp, err := callAPI(urlAddress, data, client)
	if err != nil {
		return nil, err
	}
	return resp, nil

}

func handleContinuation(url string, itct string, ctoken string) string {
	url += "&itct=" + itct
	url += "&continuation=" + ctoken
	url += "&ctoken=" + ctoken
	url += "&type=next"
	return url
}

func GetSearchSuggestions(query string, client ClientInfo) ([]byte, error) {
	innertubeContext := prepareInnertubeContext(client, nil)

	url := URL_BASE + "music/get_search_suggestions" + "?prettyPrint=false"

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		Context: innertubeContext,
		Input:   strPtr(query),
	}

	resp, err := callAPI(url, data, client)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func Search(query string, filter string, itct *string, ctoken *string, client ClientInfo) ([]byte, error) {
	innertubeContext := prepareInnertubeContext(client, nil)

	url := URL_BASE + "search" + "?prettyPrint=false"

	if itct != nil && ctoken != nil {
		url = handleContinuation(url, *itct, *ctoken)
	}

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		Context:  innertubeContext,
		BrowseID: "",
		Query:    query,
		/*user: {
			lockedSafetyMode: locals.preferences.Restricted,
		},*/
		//Continuation: continuationMap,
		//ContentCheckOK: true,
		//RacyCheckOk:    true,
		//Params: reqParams,
		/*PlaybackContext: &playbackContext{
			ContentPlaybackContext: contentPlaybackContext{
				// SignatureTimestamp: sts,
				HTML5Preference: "HTML5_PREF_WANTS",
			},
		},*/
	}

	if filter != "" {
		data.Params = filter
	}

	resp, err := callAPI(url, data, client)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func GetQueue(videoId string, playlistId string, client ClientInfo) ([]byte, error) {

	url := URL_BASE + "/music/get_queue" + "?prettyPrint=false"

	innertubeContext := prepareInnertubeContext(client, nil)

	//reqParams, err := createRequestParams(params)

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		VideoID:        videoId,
		Context:        innertubeContext,
		ContentCheckOK: true,
		RacyCheckOk:    true,
		PlaylistId:     playlistId,
		/*EnablePersistentPlaylistPanel: true,
		  IsAudioOnly:                   true,
		  TunerSettingValue:             "AUTOMIX_SETTING_NORMAL",*/
		/*PlaybackContext: &playbackContext{
			ContentPlaybackContext: contentPlaybackContext{
				// SignatureTimestamp: sts,
				HTML5Preference: "HTML5_PREF_WANTS",
			},
		},*/
	}

	resp, err := callAPI(url, data, client)
	if err != nil {
		return nil, err
	}
	return resp, nil

}

func Next(videoId string, playlistId string, client ClientInfo, params Params) ([]byte, error) {

	url := URL_BASE + "next" + "?prettyPrint=false"

	innertubeContext := prepareInnertubeContext(client, strPtr(params["visitorData"]))

	//reqParams, err := createRequestParams(params)

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		VideoID: videoId,
		Context: innertubeContext,
		// ContentCheckOK:                true,
		// RacyCheckOk:                   true,
		PlaylistId:                    playlistId,
		EnablePersistentPlaylistPanel: true,
		IsAudioOnly:                   true,
		TunerSettingValue:             "AUTOMIX_SETTING_NORMAL",
		//PlaylistSetVideoId:            params["playlistSetVideoId"],
		Params: "wAEB",

		/*PlaybackContext: &playbackContext{
		    ContentPlaybackContext: contentPlaybackContext{
		        // SignatureTimestamp: sts,
		        HTML5Preference: "HTML5_PREF_WANTS",
		    },
		},*/
	}

	resp, err := callAPI(url, data, client)
	if err != nil {
		return nil, err
	}
	return resp, nil

}

// Player resolves a videoId through the companion bridge
// (COMPANION_URL/companion/youtubei/v1/player). The bridge already applies
// the logged-in iv-vp fallback when the anonymous companion answers a
// non-playable status, so callers must NOT re-call on a non-OK
// playabilityStatus: the answer is final for this resolution.
//
// Errors: ErrCompanionNotConfigured (deployment bug), *UpstreamStatusError
// (bridge answered non-200), a timeout error (context.DeadlineExceeded /
// net.Error.Timeout after PlayerTimeout()), or a transport error.
func Player(videoId string, playlistId string, client ClientInfo, params Params) ([]byte, error) {
	base := companionURL()
	if base == "" {
		return nil, ErrCompanionNotConfigured
	}
	playerUrl := base + "/companion/youtubei/v1/player"
	innertubeContext := prepareInnertubeContext(client, nil)

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		VideoID:        videoId,
		Context:        innertubeContext, //innertubeContext,
		ContentCheckOK: true,
		RacyCheckOk:    true,
		//Params:         reqParams,
		PlaylistId: playlistId,

		PlaybackContext: &playbackContext{
			ContentPlaybackContext: contentPlaybackContext{
				//SignatureTimestamp: str,
				HTML5Preference: "HTML5_PREF_WANTS",
				//Referer:            "https://www.youtube.com/watch?v=" + videoId,
			},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), PlayerTimeout())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, playerUrl, nil)
	if err != nil {
		return nil, err
	}
	return doRequest(client, req, &data)
}

func DownloadWebpage(urlAddress string, clientInfo ClientInfo) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, urlAddress, nil)
	if err != nil {
		return nil, err
	}
	return doRequest(clientInfo, req, nil)
}

func callAPI(urlAddress string, requestPayload innertubeRequest, clientInfo ClientInfo) ([]byte, error) {

	req, err := http.NewRequest(http.MethodPost, urlAddress, nil)

	if err != nil {
		return nil, err
	}
	return doRequest(clientInfo, req, &requestPayload)
}

func doRequest(clientInfo ClientInfo, req *http.Request, requestPayload *innertubeRequest) ([]byte, error) {
	return doRequestClient(getHttpClient(), clientInfo, req, requestPayload)
}

func doRequestClient(client http.Client, clientInfo ClientInfo, req *http.Request, requestPayload *innertubeRequest) ([]byte, error) {

	urlAddress := req.URL.String()

	if strings.Contains(urlAddress, "companion") {
		req.Header.Set("Authorization", "Bearer "+companionAPIKey)
	}

	if clientInfo.userAgent != "" {
		req.Header.Set("User-Agent", clientInfo.userAgent)
	} else {
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.19 Safari/537.36")
	}
	if req.Method == http.MethodPost {
		req.Header.Set("X-Youtube-Client-Name", clientInfo.ClientId)
		req.Header.Set("X-Youtube-Client-Version", clientInfo.ClientVersion)
		req.Header.Set("Origin", "https://music.youtube.com")
		req.Header.Set("X-Origin", "https://music.youtube.com")
		req.Header.Set("Content-Type", "application/json")

		payload, err := json.Marshal(requestPayload)
		if err != nil {
			return nil, err
		}

		req.Body = io.NopCloser(bytes.NewBuffer(payload))
	}
	req.Header.Set("Accept-Language", "en-us,en;q=0.5")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9")
	req.Header.Set("accept-encoding", "gzip, deflate")
	req.Header.Set("referer", "https://music.youtube.com")

	resp, err := client.Do(req)

	if err != nil {
		return nil, err
	}

	defer resp.Body.Close()
	// Check that the server actually sent compressed data
	var reader io.ReadCloser
	switch resp.Header.Get("Content-Encoding") {
	case "gzip":
		reader, _ = gzip.NewReader(resp.Body)
		defer reader.Close()
	default:
		reader = resp.Body
	}

	respBytes, err := io.ReadAll(reader)

	if resp.StatusCode != http.StatusOK {
		body := string(respBytes)
		if len(body) > 512 {
			body = body[:512]
		}
		// Log method/URL only: a full request dump would write the Authorization
		// bearer and cookies into the container logs on every upstream error.
		log.Printf("API call failed with status %d: %s %s\n  %s", resp.StatusCode, req.Method, req.URL.String(), body)
		return nil, &UpstreamStatusError{StatusCode: resp.StatusCode, Status: resp.Status, Body: body}
	}

	return respBytes, nil
}

func getHttpClient() http.Client {

	myDialer := net.Dialer{}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return myDialer.DialContext(ctx, "tcp4", addr)
	}
	client := http.Client{
		Transport: transport,
		Timeout:   httpClientTimeout,
	}

	return client
}

// getResidentialHttpClient returns an http.Client whose upstream egresses
// through the residential gost proxy (env RESIDENTIAL_PROXY, default
// http://gost:8888). Used for background auto-cache lookups so they do not
// hit YouTube from the datacenter IP and trip rate-limits.
func getResidentialHttpClient() http.Client {
	myDialer := net.Dialer{}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return myDialer.DialContext(ctx, "tcp4", addr)
	}
	proxy := os.Getenv("RESIDENTIAL_PROXY")
	if proxy == "" {
		proxy = "http://gost:8888"
	}
	if u, err := url.Parse(proxy); err == nil {
		transport.Proxy = http.ProxyURL(u)
	}
	return http.Client{Transport: transport}
}

// NextResidential is Next() but egresses through the residential proxy.
func NextResidential(videoId string, playlistId string, client ClientInfo, params Params) ([]byte, error) {
	urlAddress := URL_BASE + "next" + "?prettyPrint=false"
	innertubeContext := prepareInnertubeContext(client, strPtr(params["visitorData"]))
	data := innertubeRequest{
		VideoID:                       videoId,
		Context:                       innertubeContext,
		PlaylistId:                    playlistId,
		EnablePersistentPlaylistPanel: true,
		IsAudioOnly:                   true,
		TunerSettingValue:             "AUTOMIX_SETTING_NORMAL",
		Params:                        "wAEB",
	}
	req, err := http.NewRequest(http.MethodPost, urlAddress, nil)
	if err != nil {
		return nil, err
	}
	return doRequestClient(getResidentialHttpClient(), client, req, &data)
}

func prepareInnertubeContext(clientInfo ClientInfo, visitorData *string) inntertubeContext {
	client := innertubeClient{
		//	HL:            "en",
		//	GL:            "US",
		ClientName:    clientInfo.ClientName,
		ClientVersion: clientInfo.ClientVersion,
		//	TimeZone:      "UTC",
	}
	if clientInfo.DeviceModel != "" {
		client.DeviceModel = clientInfo.DeviceModel
	}
	if clientInfo.DeviceMake != "" {
		client.DeviceMake = clientInfo.DeviceMake
	}
	if clientInfo.OsVersion != "" {
		client.OsVersion = clientInfo.OsVersion
	}
	if clientInfo.OsName != "" {
		client.OsName = clientInfo.OsName
	}
	if clientInfo.DeviceMake != "" {
		client.DeviceMake = clientInfo.DeviceMake
	}
	if clientInfo.AndroidSdkVersion != 0 {
		client.AndroidSDKVersion = clientInfo.AndroidSdkVersion
	}
	if visitorData != nil {
		escape := url.QueryEscape(*visitorData)
		client.VisitorData = escape
	}
	return inntertubeContext{
		Client: client,
		User:   map[string]string{
			//	"lockedSafetyMode": "false",
		},
		//Request: map[string]string{
		//	"useSsl": "true",
		//},
	}
}

func strPtr(s string) *string {
	return &s
}
