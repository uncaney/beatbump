package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/_youtube/api"
	"beatbump-server/backend/_youtube/api/auth"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/labstack/echo/v4"
	"net/http"
	"net/url"
	"strings"
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
	authObj := (c.(*auth.AuthContext)).AuthContext
	//authorization := headers.Get("Authorization")
	if videoId == "" {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Missing required param: videoId"))
	}

	var responseBytes []byte
	var err error
	if authObj.AuthType == auth.AUTH_TYPE_OAUTH {
		responseBytes, err = callPlayerAPI(api.IOS_MUSIC, videoId, playlistId, authObj)
	} else if authObj.AuthType == auth.AUTH_TYPE_COOKIES {
		responseBytes, err = callPlayerAPI(api.WEB_CREATOR, videoId, playlistId, authObj)
	} else {
		responseBytes, err = callPlayerAPI(api.IOS_MUSIC, videoId, playlistId, authObj)
		//return c.String(http.StatusInternalServerError, "Missing auth - need to use Oauth or supply cookies")
	}

	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	var playerResponse _youtube.PlayerResponse
	err = json.Unmarshal(responseBytes, &playerResponse)
	if err != nil {
		return errors.New(fmt.Sprintf("Error building API request: %s", err))
	}

	if playerResponse.PlayabilityStatus.Status != "OK" {
		return errors.New(fmt.Sprintf("PLayability status is not OK: %s", playerResponse.PlayabilityStatus.Status))
	}

	if len(playerResponse.StreamingData.AdaptiveFormats) == 0 {
		return errors.New(fmt.Sprintf("Error building API request: %s", playerResponse.PlayabilityStatus.Status))
	}

	for i := 0; i < len(playerResponse.StreamingData.AdaptiveFormats); i++ {
		format := &playerResponse.StreamingData.AdaptiveFormats[i]
		/*if !strings.Contains(format.MimeType, "audio") {
			continue
		}*/
		streamUrl := format.URL

		if streamUrl == "" {
			signatureCipher := format.SignatureCipher
			streamUrl, err = api.DecipherSignatureCipher(videoId, signatureCipher)
		} else {
			resultUrl, err := url.Parse(streamUrl)
			if err != nil {
				continue
			}
			resultUrl, err = api.DecipherNsig(resultUrl, videoId)
			streamUrl = resultUrl.String()
		}

		if err != nil {
			continue
		}
		format.URL = strings.Clone(streamUrl)
	}

	return c.JSON(http.StatusOK, playerResponse)
}

func callPlayerAPI(clientInfo api.ClientInfo, videoId string, playlistId string, authObj *auth.Auth) ([]byte, error) {

	responseBytes, err := api.Player(videoId, playlistId, clientInfo, nil, authObj)

	if err != nil {
		return nil, errors.New(fmt.Sprintf("Error building API request: %s", err))
	}

	return responseBytes, err
}
