package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/_youtube/api"
	"encoding/json"
	"fmt"
	"github.com/labstack/echo/v4"
	"net/http"
	"net/url"
	"strings"
)

var searchFilters = map[string]string{
	"all":                 "",
	"songs":               "EgWKAQIIAWoQEAoQBBAJEAUQAxAVEBAQEQ%3D%3D",
	"videos":              "EgWKAQIQAWoQEAoQBBAJEAUQAxAVEBAQEQ%3D%3D",
	"albums":              "EgWKAQIYAWoQEAoQBBAJEAUQAxAVEBAQEQ%3D%3D",
	"artists":             "EgWKAQIgAWoQEAoQBBAJEAUQAxAVEBAQEQ%3D%3D",
	"community_playlists": "EgeKAQQoAEABahAQChAEEAkQBRADEBUQEBAR",
	"featured_playlists":  "EgeKAQQoADgBagwQDhAKEAMQBBAJEAU%3D",
	"all_playlists":       "EgWKAQIoAWoKEAMQBBAKEAUQCQ%3D%3D",
}

func SearchEndpointHandler(c echo.Context) error {
	urlQuery := c.Request().URL.Query()
	query := urlQuery.Get("q")
	filter := urlQuery.Get("filter")
	filterId := ""
	if filter != "all" && filter != "" {
		filterId = searchFilters[filter]
	}

	ctoken := urlQuery.Get("ctoken")
	itct := urlQuery.Get("itct")

	if query == "" && itct == "" && ctoken == "" {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Missing required params"))
	}

	queryUnescape, err := url.QueryUnescape(query)

	var responseBytes []byte
	if itct != "" && ctoken != "" {
		responseBytes, err = api.Search(queryUnescape, filterId, &itct, &ctoken, api.WebMusic)
	} else {
		responseBytes, err = api.Search(queryUnescape, filterId, nil, nil, api.WebMusic)
	}

	if err != nil {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	var searchResponse _youtube.SearchResponse
	err = json.Unmarshal(responseBytes, &searchResponse)
	if err != nil {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	var regularResponse []MusicShelf
	var continuationResponse []IListItemRenderer
	var continuation _youtube.NextContinuationData
	var responseType *string = nil
	// continuation mode
	if len(searchResponse.ContinuationContents.MusicShelfContinuation.Continuations) != 0 {
		searchContinuationContent := searchResponse.ContinuationContents.MusicShelfContinuation
		continuationResponse, err = parseContinuationResponse(searchContinuationContent.Content, filter)
		if len(searchContinuationContent.Continuations) == 1 {
			continuation = searchContinuationContent.Continuations[0].NextContinuationData
		}

		responseType = stringPtr("next")

	} else if len(searchResponse.Content.TabbedSearchResultsRenderer.Tabs) != 0 {
		searchContent := searchResponse.Content.TabbedSearchResultsRenderer.Tabs[0].TabRenderer.Content.SectionListRenderer.SectionListRendererContents
		regularResponse, err = parseResponse(searchContent)
		if len(searchContent) == 1 && len(searchContent[0].MusicShelfRenderer.Continuations) != 0 {
			continuation = searchContent[0].MusicShelfRenderer.Continuations[0].NextContinuationData
		}
	} else {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	if err != nil {
		return c.String(http.StatusInternalServerError, fmt.Sprintf("Error building API request: %s", err))
	}

	// K11: 605 KB raw search.json parsed on the main thread; the tracking blobs
	// of every item are never read by the front (historyOutbox drops them too).
	slimSearchItems(continuationResponse)
	for i := range regularResponse {
		slimSearchItems(regularResponse[i].Contents)
	}

	if continuationResponse != nil {
		r := struct {
			ContinuationResults []IListItemRenderer            `json:"results"`
			Response            _youtube.SearchResponse        `json:"response"`
			Continuation        *_youtube.NextContinuationData `json:"continuation,omitempty"`
			Type                *string                        `json:"type,omitempty"`
		}{
			ContinuationResults: continuationResponse,
			Response:            searchResponse,
			Continuation:        &continuation,
			Type:                responseType,
		}
		return c.JSON(http.StatusOK, r)
	} else {
		// YouTube shelves first; the owned-library shelf goes LAST (append) and
		// follows the filter (albums / artists hits, none for playlists).
		if ls := localShelf(queryUnescape, filter); ls != nil {
			regularResponse = append(regularResponse, *ls)
		}
		correction := extractCorrection(searchResponse)
		r := struct {
			Results      []MusicShelf                   `json:"results"`
			Response     _youtube.SearchResponse        `json:"response"`
			Continuation *_youtube.NextContinuationData `json:"continuation,omitempty"`
			Type         *string                        `json:"type,omitempty"`
			Correction   *SearchCorrection              `json:"correction,omitempty"`
		}{
			Results:      regularResponse,
			Response:     searchResponse,
			Continuation: &continuation,
			Type:         responseType,
			Correction:   correction,
		}
		return c.JSON(http.StatusOK, r)
	}

}

func parseContinuationResponse(content []_youtube.MusicShelfContinuationContent, filter string) ([]IListItemRenderer, error) {

	response := make([]IListItemRenderer, 0, len(content))
	for _, entry := range content {
		item := parseMusicResponsiveListItemRenderer(entry.MusicResponsiveListItemRenderer)
		item.Type = filter
		response = append(response, item)
	}

	return response, nil
}

func parseResponse(content []_youtube.SectionListRendererContents) ([]MusicShelf, error) {
	response := make([]MusicShelf, 0, len(content))
	var flatResultsShelf *MusicShelf

	for _, shelf := range content {
		if shelf.MusicShelfRenderer != nil {
			currShelf := MusicShelf{}
			title := ""
			if len(shelf.MusicShelfRenderer.Title.Runs) != 0 {
				title = shelf.MusicShelfRenderer.Title.Runs[0].Text
			}

			currShelf.Header.Title = title
			currShelf.Contents = make([]IListItemRenderer, 0, len(shelf.MusicShelfRenderer.Contents))
			for _, entry := range shelf.MusicShelfRenderer.Contents {
				item := parseMusicResponsiveListItemRenderer(entry.MusicResponsiveListItemRenderer)

				entryTitle := strings.ToLower(strings.ReplaceAll(title, " ", "_"))
				item.Type = entryTitle
				if entryTitle == "top_result" && item.Endpoint != nil {
					if strings.Contains(item.Endpoint.PageType, "SINGLE") ||
						strings.Contains(item.Endpoint.PageType, "ALBUM") {
						item.Type = "albums"
					}
				}

				currShelf.Contents = append(currShelf.Contents, item)
			}

			response = append(response, currShelf)
		} else if shelf.ItemSectionRenderer != nil {
			if flatResultsShelf == nil {
				flatResultsShelf = &MusicShelf{}
				flatResultsShelf.Header.Title = "Results"
				flatResultsShelf.Contents = make([]IListItemRenderer, 0)
			}
			for _, entry := range shelf.ItemSectionRenderer.Contents {
				if entry.MusicResponsiveListItemRenderer != nil {
					item := parseMusicResponsiveListItemRenderer(*entry.MusicResponsiveListItemRenderer)
					// Try to determine type or fallback to results
					item.Type = "results"
					if item.Endpoint != nil {
						if strings.Contains(item.Endpoint.PageType, "SINGLE") || strings.Contains(item.Endpoint.PageType, "ALBUM") {
							item.Type = "albums"
						} else if strings.Contains(item.Endpoint.PageType, "ARTIST") {
							item.Type = "artists"
						} else if strings.Contains(item.Endpoint.PageType, "PLAYLIST") {
							item.Type = "playlists"
						}
					}
					flatResultsShelf.Contents = append(flatResultsShelf.Contents, item)
				}
			}
		}
	}

	if flatResultsShelf != nil && len(flatResultsShelf.Contents) > 0 {
		response = append(response, *flatResultsShelf)
	}

	return response, nil
}

// slimSearchItems drops, in place, the two YouTube tracking blobs of search
// results (K11): loggingContext and clickTrackingParams. Everything the front
// reads from a search row stays: videoId, playlistId, title, subtitle,
// thumbnails, artistInfo, explicit, endpoint, length, musicVideoType, type,
// playlistSetVideoId, itct, params and playerParams. playerParams is short
// and needed (L20): ListItem.svelte passes it to getSrc / initAutoMixSession
// (config.playerParams), sessionList.ts sends it as next.json `params` and
// compares it to APIParams.lt100 to decide playlistSetVideoId, player.ts
// puts it on player.json (OMV / age-restricted variants) and resumeState
// KEEP_KEYS persists it.
func slimSearchItems(items []IListItemRenderer) {
	for i := range items {
		items[i].LoggingContext = nil
		items[i].ClickTrackingParams = ""
	}
}

// SearchCorrection surfaces YT Music's spelling-correction hints (already parsed
// into ShowingResultsForRenderer but never previously exposed to the client).
type SearchCorrection struct {
	CorrectedQuery    string `json:"correctedQuery,omitempty"`
	ShowingResultsFor string `json:"showingResultsFor,omitempty"`
	SearchInsteadFor  string `json:"searchInsteadFor,omitempty"`
	OriginalQuery     string `json:"originalQuery,omitempty"`
}

// extractCorrection walks the first search tab's section list for a
// ShowingResultsForRenderer and flattens its runs into a typed correction.
func extractCorrection(sr _youtube.SearchResponse) *SearchCorrection {
	tabs := sr.Content.TabbedSearchResultsRenderer.Tabs
	if len(tabs) == 0 {
		return nil
	}
	contents := tabs[0].TabRenderer.Content.SectionListRenderer.SectionListRendererContents
	for _, sec := range contents {
		if sec.ItemSectionRenderer == nil {
			continue
		}
		for _, e := range sec.ItemSectionRenderer.Contents {
			srr := e.ShowingResultsForRenderer
			var corrected, showing, instead, original string
			for _, r := range srr.CorrectedQuery.Runs {
				corrected += r.Text
			}
			for _, r := range srr.ShowingResultsFor.Runs {
				showing += r.Text
			}
			for _, r := range srr.SearchInsteadFor.Runs {
				instead += r.Text
			}
			for _, r := range srr.OriginalQuery.Runs {
				original += r.Text
			}
			if corrected != "" || showing != "" || instead != "" || original != "" {
				return &SearchCorrection{
					CorrectedQuery:    corrected,
					ShowingResultsFor: showing,
					SearchInsteadFor:  instead,
					OriginalQuery:     original,
				}
			}
		}
	}
	return nil
}
