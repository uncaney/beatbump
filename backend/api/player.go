package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/api/auth"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/labstack/echo/v4"
)

type PlayerAPIResponse struct {
	// Define your response structure based on the actual data fields
}

func PlayerEndpointHandler(c echo.Context) error {
	url := c.Request().URL
	query := url.Query()
	videoId := query.Get("videoId")
	playlistId := query.Get("playlistId")
	//playerParams := query.Get("playerParams")
	authObj := (c.(*auth.AuthContext)).AuthContext
	//authorization := headers.Get("Authorization")
	if videoId == "" {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Missing required param: videoId"))
	}

	//playerResponse, err := callPlayerAPI(_youtube.WebMusic, videoId, playlistId, authObj)
	//playerResponse, err = callPlayerAPI(_youtube.IOS, videoId, playlistId, authObj)
	playerResponse, err := callPlayerAPI(_youtube.IOS_MUSIC, videoId, playlistId, authObj)

	//try IOS_MUSIC as fallback
	if err != nil {
		playerResponse, err = callPlayerAPI(_youtube.WebMusic, videoId, playlistId, authObj)
	}

	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, playerResponse)
}

func callPlayerAPI(clientInfo _youtube.ClientInfo, videoId string, playlistId string, authObj *auth.Auth) (map[string]interface{}, error) {

	responseBytes, err := _youtube.Player(videoId, playlistId, clientInfo, nil, authObj)

	if err != nil {
		return nil, errors.New(fmt.Sprintf("Error building API request: %s", err))
	}

	var playerResponse map[string]interface{}
	err = json.Unmarshal(responseBytes, &playerResponse)
	if err != nil {
		return nil, errors.New(fmt.Sprintf("Error building API request: %s", err))
	}

	playabilityStatus := playerResponse["playabilityStatus"]
	if playabilityStatus != nil && playabilityStatus != "" {
		playabilityStatusMap := playabilityStatus.(map[string]interface{})

		if playabilityStatusMap["status"] != "OK" {
			return nil, errors.New(fmt.Sprintf("Error building API request: %s", playabilityStatusMap["status"]))
		}
	}
	return playerResponse, nil
}
