package _youtube

import (
	"beatbump-server/backend/api/auth"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"
)

const URL_BASE = "https://music.youtube.com/youtubei/v1/"

const DEBUG = false

func Browse(browseId string, pageType PageType, params string,
	visitorData *string, itct *string, ctoken *string, client ClientInfo, authObj *auth.Auth) ([]byte, error) {

	urlAddress := URL_BASE + "browse" + "?prettyPrint=false"
	innertubeContext := prepareInnertubeContext(client, visitorData)
	//playlistUrl := "https://music.youtube.com/playlist?list=" + ""
	//innertubeContext.Client.OriginalUrl = &playlistUrl
	data := innertubeRequest{
		Context: innertubeContext,
	}
	if itct != nil && ctoken != nil {
		urlAddress = handleContinuation(urlAddress, *itct, *ctoken)
	} else {

		data = innertubeRequest{
			//RequestAttributes: additionalRequestAttributes,
			BrowseID: browseId,
			Context:  innertubeContext,
			//ContentCheckOK: true,
			//RacyCheckOk:    true,
			BrowseEndpointContextMusicConfig: &BrowseEndpointContextMusicConfig{
				PageType: string(pageType),
			},
		}
	}

	if params != "" {
		data.Params = params
	}
	resp, err := callAPI(urlAddress, data, client.userAgent, authObj)
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

	resp, err := callAPI(url, data, client.userAgent, nil)
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

	resp, err := callAPI(url, data, client.userAgent, nil)
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

	resp, err := callAPI(url, data, client.userAgent, nil)
	if err != nil {
		return nil, err
	}
	return resp, nil

}

func Next(videoId string, playlistId string, client ClientInfo, params Params, authObj *auth.Auth) ([]byte, error) {

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

	resp, err := callAPI(url, data, client.userAgent, authObj)
	if err != nil {
		return nil, err
	}
	return resp, nil

}

func Player(videoId string, playlistId string, client ClientInfo, params Params, authObj *auth.Auth) ([]byte, error) {

	url := URL_BASE + "player" + "?prettyPrint=false"

	innertubeContext := prepareInnertubeContext(client, nil)

	reqParams, err := createRequestParams(params)

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		VideoID:        videoId,
		Context:        innertubeContext,
		ContentCheckOK: true,
		RacyCheckOk:    true,
		Params:         reqParams,
		PlaylistId:     playlistId,
		/*PlaybackContext: &playbackContext{
			ContentPlaybackContext: contentPlaybackContext{
				// SignatureTimestamp: sts,
				HTML5Preference: "HTML5_PREF_WANTS",
			},
		},*/
		/*ServiceIntegrityDimensions: &ServiceIntegrityDimensions{
			PoToken: "51217476",
		},*/
	}

	resp, err := callAPI(url, data, client.userAgent, authObj)
	if err != nil {
		return nil, err
	}

	return resp, nil

}

func callAPI(urlAddress string, requestPayload innertubeRequest, userAgent string, authbj *auth.Auth) ([]byte, error) {
	payload, err := json.Marshal(requestPayload)
	if err != nil {
		return nil, err
	}

	//log.Debug().Msg("Request Body:" + string(payload))
	if requestPayload.Params == "" {
		requestPayload.Params = "CgIQBg"
	}

	req, err := http.NewRequest(http.MethodPost, urlAddress, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}

	myDialer := net.Dialer{}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return myDialer.DialContext(ctx, "tcp4", addr)
	}
	client := http.Client{
		Transport: transport,
	}

	if requestPayload.Context.Client.OriginalUrl != nil {
		req.Header.Set("referer", *requestPayload.Context.Client.OriginalUrl)
	}

	if strings.Contains(urlAddress, "player") && authbj != nil {
		if authbj.AuthType == auth.AUTH_TYPE_COOKIES && authbj.CookieHeader != "" {

			cookies, err := parseCookieString(authbj.CookieHeader)
			if err != nil {
				fmt.Println("Error parsing cookies:", err)
				return nil, err
			}
			var cookiesList []*http.Cookie
			for key, value := range cookies {

				cookie := &http.Cookie{
					Name:    key,
					Value:   value,
					Path:    "/",
					Domain:  ".youtube.com",
					Expires: time.Now().Add(5 * time.Minute),
					Secure:  true,
				}
				cookiesList = append(cookiesList, cookie)

				if key == "SAPISID" {
					authorization := getAuthorization(value)
					req.Header.Set("Authorization", authorization)
					//req.Header.Set("X-Origin", "https://music.youtube.com")
					//req.Header.Set("X-Goog-AuthUser", "0")
					//req.Header.Set("X-Youtube-Bootstrap-Logged-In", "0")
					//req.Header.Set("X-YouTube-Client-Name", "67")
					//req.Header.Set("X-YouTube-Client-Version", WebMusic.ClientVersion)
					if requestPayload.Context.Client.VisitorData != "" {
						req.Header.Set("X-Goog-Visitor-Id", requestPayload.Context.Client.VisitorData)
					}
					req.Header.Set("X-Goog-PageId", "undefined")
					//fmt.Printf("SAPISID: %s", authorization)
				}
			}
			jar, err := cookiejar.New(nil)
			u, _ := url.Parse("https://www.youtube.com/")
			jar.SetCookies(u, cookiesList)
			client.Jar = jar
		} else if authbj.AuthType == auth.AUTH_TYPE_OAUTH && authbj.OauthToken != nil {
			req.Header.Set("Authorization", authbj.OauthToken.TokenType+" "+authbj.OauthToken.AccessToken)
		}
	}

	req.Header.Set("accept-encoding", "gzip, deflate")
	req.Header.Set("content-encoding", "gzip")
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Host", "music.youtube.com")
	req.Header.Set("Origin", "https://music.youtube.com")

	//req.Header.Set("Host", "www.youtube.com")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.5")
	req.Header.Set("Content-Type", "application/json")
	//	req.Header.Set("X-Origin", "https://music.youtube.com")

	//

	resp, err := client.Do(req)

	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusBadRequest {
		req.Header.Del("Authorization")
		resp, err = client.Do(req)
		if err != nil {
			return nil, err
		}
	}

	if resp.StatusCode != http.StatusOK {
		fmt.Printf("got non 200 response %d", resp.StatusCode)
		return nil, errors.New(resp.Status)
	}

	defer resp.Body.Close()
	// Check that the server actually sent compressed data
	var reader io.ReadCloser
	switch resp.Header.Get("Content-Encoding") {
	case "gzip":
		reader, err = gzip.NewReader(resp.Body)
		defer reader.Close()
	default:
		reader = resp.Body
	}

	respBytes, err := io.ReadAll(reader)

	if DEBUG {
		fmt.Println(urlAddress)
		fmt.Println(string(payload))
		buffer := new(bytes.Buffer)
		if err := json.Compact(buffer, respBytes); err != nil {
			fmt.Println(err)
		}
		fmt.Println(buffer.String())
	}

	return respBytes, nil
}

func createRequestParams(params Params) (string, error) {
	reqParams := "2AMB"
	if params != nil {
		paramBytes, err := json.Marshal(params)
		if err != nil {
			return "", err
		}
		reqParams = string(paramBytes)
	}
	return reqParams, nil
}

func prepareInnertubeContext(clientInfo ClientInfo, visitorData *string) inntertubeContext {
	client := innertubeClient{
		HL:             "en",
		GL:             "US",
		ClientName:     clientInfo.ClientName,
		ClientVersion:  clientInfo.ClientVersion,
		BrowserName:    strPtr("firefox"),
		BrowserVersion: strPtr("127.0"),
		DeviceMake:     strPtr("apple"),
		TimeZone:       "America/Los_Angeles",
		Platform:       strPtr("DESKTOP"),
		OriginalUrl:    strPtr("https://music.youtube.com/"),
		//AndroidSDKVersion: clientInfo.androidVersion,
		UserAgent: clientInfo.userAgent,
	}
	if visitorData != nil {
		escape := url.QueryEscape(*visitorData)
		client.VisitorData = escape
	}
	return inntertubeContext{
		Client: client,
		User: map[string]string{
			"lockedSafetyMode": "false",
		},
	}
}

func strPtr(s string) *string {
	return &s
}

type BrowseEndpointContextMusicConfig struct {
	PageType string `json:"pageType"`
}

// ParseCookieString parses a cookie string into a map of key-value pairs.
func parseCookieString(cookieStr string) (map[string]string, error) {
	cookies := make(map[string]string)

	// Split the cookie string by ';' to get individual components
	pairs := strings.Split(cookieStr, ";")

	for _, pair := range pairs {
		// Trim any leading/trailing whitespace
		pair = strings.TrimSpace(pair)

		// Split the pair by '=' to separate name and value
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) == 2 {
			cookies[parts[0]] = parts[1]
		} else {
			// If there's no '=', treat the pair as a flag
			cookies[parts[0]] = ""
		}
	}

	return cookies, nil
}

func getAuthorization(auth string) string {
	ts := time.Now().Unix()
	hash := sha1.Sum([]byte(fmt.Sprintf("%d %s %s", ts, auth, "https://music.youtube.com")))
	return fmt.Sprintf("SAPISIDHASH %d_%x", ts, hash[:])
}
