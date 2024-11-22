package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/api/auth"
	"encoding/json"
	"fmt"
	"github.com/labstack/echo/v4"
	"net/http"
)

func TrendingEndpointHandler(c echo.Context) error {
	browseId := c.Param("browseId")
	if browseId == "" {
		browseId = "FEmusic_explore"
	}
	var responseBytes []byte
	var err error

	authObj := (c.(*auth.AuthContext)).AuthContext
	responseBytes, err = _youtube.Browse(browseId, _youtube.PageType_MusicPageTypePlaylist, "", nil, nil, nil, _youtube.WebMusic, authObj)

	if err != nil {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	/*if category == "" {

		var exploreResponse _youtube.Explore
		err = json.Unmarshal(responseBytes, &exploreResponse)
		if err != nil {
			return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
		}

		r := parseExplore(exploreResponse)
		return c.JSON(http.StatusOK, r)
	} else {*/
	var homeResponse _youtube.HomeResponse
	err = json.Unmarshal(responseBytes, &homeResponse)
	if err != nil {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	r := ParseHome(homeResponse)

	return c.JSON(http.StatusOK, r)
	//}
}
