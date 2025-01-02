package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/_youtube/api"
	"encoding/json"
	"fmt"
	"github.com/labstack/echo/v4"
	"net/http"
	"net/url"
)

func GetSearchSuggstionsHandler(c echo.Context) error {

	urlQuery := c.Request().URL.Query()
	query := urlQuery.Get("q")

	if query == "" {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Missing required param: query"))
	}

	queryUnescape, err := url.QueryUnescape(query)

	var responseBytes []byte

	responseBytes, err = api.GetSearchSuggestions(queryUnescape, api.WebMusic)

	if err != nil {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	var searchSuggerstionsResponse _youtube.SearchSuggestions
	err = json.Unmarshal(responseBytes, &searchSuggerstionsResponse)
	if err != nil {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	var response []TypeAhead = make([]TypeAhead, 0)

	if len(searchSuggerstionsResponse.Contents) == 0 {
		return c.JSON(http.StatusOK, response)
	}

	if len(searchSuggerstionsResponse.Contents[0].SearchSuggestionsSectionRenderer.Contents) == 0 {
		return c.JSON(http.StatusOK, response)
	}

	for i, sg := range searchSuggerstionsResponse.Contents[0].SearchSuggestionsSectionRenderer.Contents {
		currSG := TypeAhead{}
		currSG.Query = sg.SearchSuggestionRenderer.NavigationEndpoint.SearchEndpoint.Query
		currSG.Id = i
		response = append(response, currSG)
	}

	return c.JSON(http.StatusOK, response)
}

type TypeAhead struct {
	Query string `json:"query"`
	Id    int    `json:"id"`
}
