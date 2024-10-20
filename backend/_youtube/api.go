package _youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/oauth2"
	"io"
	"net"
	"net/http"
)

const URL_BASE = "https://music.youtube.com/youtubei/v1/"

const DEBUG = false

func Browse(token *oauth2.Token, browseId string, pageType PageType, params string, visitorData *string, itct *string, ctoken *string, client ClientInfo) ([]byte, error) {

	url := URL_BASE + "browse" + "?prettyPrint=false&key=" + client.ClientKey

	if itct != nil && ctoken != nil {
		url = handleContinuation(url, *itct, *ctoken)
	}

	innertubeContext := prepareInnertubeContext(client, visitorData)
	//playlistUrl := "https://music.youtube.com/playlist?list=" + ""
	//innertubeContext.Client.OriginalUrl = &playlistUrl

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		BrowseID:       browseId,
		Context:        innertubeContext,
		ContentCheckOK: true,
		RacyCheckOk:    true,
		BrowseEndpointContextMusicConfig: &BrowseEndpointContextMusicConfig{
			PageType: string(pageType),
		},
		User: &User{
			LockedSafetyMode: false,
		},
	}

	if params != "" {
		data.Params = params
	}
	resp, err := callAPI(url, data, client.userAgent, token)
	if err != nil {
		return nil, err
	}
	return resp, nil

}

func handleContinuation(url string, itct string, ctoken string) string {
	url += "&sp=EgWKAQIIAWoKEAMQBBAKEAkQBQ%3D%3D&"
	url += "&continuation=" + ctoken
	url += "&ctoken=" + itct
	url += "&type=next"
	return url
}

func GetSearchSuggestions(query string, client ClientInfo) ([]byte, error) {
	innertubeContext := prepareInnertubeContext(client, nil)

	url := URL_BASE + "music/get_search_suggestions" + "?prettyPrint=false&key=" + WebMusic.ClientKey

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		Context:  innertubeContext,
		BrowseID: "",
		Input:    strPtr(query),
	}

	resp, err := callAPI(url, data, client.userAgent, nil)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func Search(query string, filter string, itct *string, ctoken *string, client ClientInfo) ([]byte, error) {
	innertubeContext := prepareInnertubeContext(client, nil)

	url := URL_BASE + "search" + "?prettyPrint=false&key=" + WebMusic.ClientKey

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

	url := URL_BASE + "/music/get_queue" + "?prettyPrint=false&key=" + client.ClientKey

	innertubeContext := prepareInnertubeContext(client, nil)

	//reqParams, err := createRequestParams(params)

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		VideoID:                       videoId,
		Context:                       innertubeContext,
		ContentCheckOK:                true,
		RacyCheckOk:                   true,
		PlaylistId:                    playlistId,
		EnablePersistentPlaylistPanel: true,
		IsAudioOnly:                   true,
		TunerSettingValue:             "AUTOMIX_SETTING_NORMAL",
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

func Next(videoId string, playlistId string, client ClientInfo, params Params) ([]byte, error) {

	url := URL_BASE + "next" + "?prettyPrint=false&key=" + client.ClientKey

	innertubeContext := prepareInnertubeContext(client, strPtr(params["visitorData"]))

	//reqParams, err := createRequestParams(params)

	data := innertubeRequest{
		//RequestAttributes: additionalRequestAttributes,
		VideoID:                       videoId,
		Context:                       innertubeContext,
		ContentCheckOK:                true,
		RacyCheckOk:                   true,
		PlaylistId:                    playlistId,
		EnablePersistentPlaylistPanel: true,
		IsAudioOnly:                   true,
		TunerSettingValue:             "AUTOMIX_SETTING_NORMAL",
		PlaylistSetVideoId:            params["playlistSetVideoId"],
		Params:                        params["params"],
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

func Player(token *oauth2.Token, videoId string, playlistId string, client ClientInfo, params Params) ([]byte, error) {

	url := URL_BASE + "player" + "?prettyPrint=false&key=" + client.ClientKey

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
		PlaybackContext: &playbackContext{
			ContentPlaybackContext: contentPlaybackContext{
				// SignatureTimestamp: sts,
				HTML5Preference: "HTML5_PREF_WANTS",
			},
		},
		/*ServiceIntegrityDimensions: &ServiceIntegrityDimensions{
			PoToken: "51217476",
		},*/
	}

	resp, err := callAPI(url, data, client.userAgent, token)
	if err != nil {
		return nil, err
	}

	return resp, nil

}

func callAPI(url string, requestPayload innertubeRequest, userAgent string, token *oauth2.Token) ([]byte, error) {
	payload, err := json.Marshal(requestPayload)
	if err != nil {
		return nil, err
	}

	//log.Debug().Msg("Request Body:" + string(payload))
	if requestPayload.Params == "" {
		requestPayload.Params = "CgIQBg"
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}

	if requestPayload.Context.Client.OriginalUrl != nil {
		req.Header.Set("referer", *requestPayload.Context.Client.OriginalUrl)
	}
	if token != nil {
		req.Header.Set("Authorization", token.TokenType+" "+token.AccessToken)
	}
	//req.Header.Set("X-Youtube-Client-Name", "3")
	//req.Header.Set("X-Youtube-Client-Version", client.ClientVersion)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	//req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Origin", "https://music.youtube.com")
	//req.Header.Set("Sec-Fetch-Mode", "navigate")

	myDialer := net.Dialer{}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return myDialer.DialContext(ctx, "tcp4", addr)
	}

	client := http.Client{
		Transport: transport,
	}

	resp, err := client.Do(req)

	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, errors.New(resp.Status)
	}

	respBytes, err := io.ReadAll(resp.Body)

	if DEBUG {
		fmt.Println(url)
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
		HL: "en",
		GL: "US",
		//TimeZone:          "UTC",
		ClientName:    clientInfo.ClientName,
		ClientVersion: clientInfo.ClientVersion,
		//BrowserName:    strPtr("firefox"),
		//BrowserVersion: strPtr("127.0"),
		//DeviceMake:     strPtr("apple"),
		TimeZone:    "America/Los_Angeles",
		Platform:    strPtr("DESKTOP"),
		OriginalUrl: strPtr("https://music.youtube.com/"),
		//AndroidSDKVersion: clientInfo.androidVersion,
		//UserAgent:         clientInfo.userAgent,
	}
	if visitorData != nil {
		client.VisitorData = *visitorData
	}
	return inntertubeContext{
		Client: client,
	}
}

func strPtr(s string) *string {
	return &s
}

type BrowseEndpointContextMusicConfig struct {
	PageType string `json:"pageType"`
}
