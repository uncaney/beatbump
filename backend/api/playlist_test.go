package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

// F3: playlist ids without the VL browse prefix (shared links, next.json
// playlistId, OLAK album ids) made the upstream answer 400 -> 500 to the client.
func TestNormalizePlaylistBrowseID(t *testing.T) {
	cases := map[string]string{
		"":                                     "",
		"  ":                                   "",
		"VLPLciALUPf8sIJlvH350O8PWh4UbSbOffSJ": "VLPLciALUPf8sIJlvH350O8PWh4UbSbOffSJ",
		"PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf":   "VLPLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
		"RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs": "VLRDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs",
		"OLAK5uy_lJ8xWqfWgT8ZtBCqWdTzgYw1Bqy2Z3Zz0":   "VLOLAK5uy_lJ8xWqfWgT8ZtBCqWdTzgYw1Bqy2Z3Zz0",
		"VLOLAK5uy_lJ8xWqfWgT8ZtBCqWdTzgYw1Bqy2Z3Zz0": "VLOLAK5uy_lJ8xWqfWgT8ZtBCqWdTzgYw1Bqy2Z3Zz0",
		"MPREb_abc":         "MPREb_abc",
		"RDAMVM9bZkp7q19f0": "RDAMVM9bZkp7q19f0",
	}
	for in, want := range cases {
		assert.Equal(t, want, normalizePlaylistBrowseID(in), "input %q", in)
	}
}

func TestPlaylistEndpoint_MissingList(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/playlist.json", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	assert.NoError(t, PlaylistEndpointHandler(c))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	var body map[string]string
	assert.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "bad_request", body["error"])
}

func TestGetPlaylist(t *testing.T) {
	// Playlist ID provided by the user
	playlistID := "VLPLciALUPf8sIJlvH350O8PWh4UbSbOffSJ"

	// Initial call to GetPlaylist
	response, err := GetPlaylist(playlistID, "", "")
	if !assert.NoError(t, err) {
		return
	}

	totalTracks := len(response.Tracks)
	assert.NotEmpty(t, response.Tracks, "Playlist should have tracks")
	t.Logf("Fetched %d tracks in initial request", len(response.Tracks))

	// Loop for continuations
	token, itct := extractContinuationInfo(response.Continuations)

	pageCount := 1
	maxPages := 10 // Limit to avoid infinite loops

	for token != "" && pageCount < maxPages {
		t.Logf("Fetching page %d with token: %s", pageCount+1, token)

		contResponse, err := GetPlaylist(playlistID, token, itct)
		if !assert.NoError(t, err) {
			break
		}

		fetched := len(contResponse.Tracks)
		totalTracks += fetched
		t.Logf("Fetched %d tracks in page %d", fetched, pageCount+1)

		if fetched == 0 {
			t.Log("No more tracks returned, stopping.")
			break
		}

		token, itct = extractContinuationInfo(contResponse.Continuations)
		pageCount++
	}

	t.Logf("Total tracks fetched: %d", totalTracks)
}

func extractContinuationInfo(continuations interface{}) (string, string) {
	if continuations == nil {
		return "", ""
	}
	importJson, _ := json.Marshal(continuations)
	var contMap map[string]interface{}
	if err := json.Unmarshal(importJson, &contMap); err != nil {
		return "", ""
	}

	var token, itct string

	if t, ok := contMap["token"].(string); ok {
		token = t
	} else if nextContData, ok := contMap["nextContinuationData"].(map[string]interface{}); ok {
		if t, ok := nextContData["continuation"].(string); ok {
			token = t
		}
		if c, ok := nextContData["clickTrackingParams"].(string); ok {
			itct = c
		}
	} else if continuationsArr, ok := contMap["continuations"].([]interface{}); ok {
		if len(continuationsArr) > 0 {
			if firstCont, ok := continuationsArr[0].(map[string]interface{}); ok {
				if t, ok := firstCont["continuation"].(string); ok {
					token = t
				}
				if c, ok := firstCont["clickTrackingParams"].(string); ok {
					itct = c
				}
			}
		}
	} else if t, ok := contMap["continuation"].(string); ok {
		token = t
		if c, ok := contMap["clickTrackingParams"].(string); ok {
			itct = c
		}
	}

	return token, itct
}
