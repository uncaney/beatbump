package api

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/_youtube/api"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNext(t *testing.T) {
	// Playlist ID provided by the user
	videoId := "FcRBUd_gJBg"
	paramsMap := map[string]string{}
	responseBytes, err := api.Next(videoId, "RDAMVM"+videoId, api.WebMusic, paramsMap)

	var nextResponse _youtube.NextResponse
	err = json.Unmarshal(responseBytes, &nextResponse)

	parsedResponse := ParseNextBody(nextResponse)
	assert.NoError(t, err)
	assert.NotEmpty(t, parsedResponse)

}

// loadNextFixture reads a captured WEB_REMIX `next` response (tab contents
// trimmed to 2 queue items) into the typed struct.
func loadNextFixture(t *testing.T, name string) _youtube.NextResponse {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var nr _youtube.NextResponse
	if err := json.Unmarshal(raw, &nr); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return nr
}

// Upstream layout since 2025-09: ["Up next","Lyrics","Comments","Related"];
// the Related browseId must be found although it is no longer at tabs[2].
func TestParseNextBodyRelatedTabFourTabs(t *testing.T) {
	nr := loadNextFixture(t, "next_web_remix_four_tabs.json")
	tabs := nr.Contents.SingleColumnMusicWatchNextResultsRenderer.TabbedRenderer.WatchNextTabbedResultsRenderer.Tabs
	if assert.Len(t, tabs, 4) {
		assert.Equal(t, "Comments", tabs[2].TabRenderer.Title, "fixture: tabs[2] is the Comments tab")
		assert.Empty(t, tabs[2].TabRenderer.Endpoint.BrowseEndpoint.BrowseId, "fixture: tabs[2] has no browseId")
	}

	parsed := ParseNextBody(nr)
	assert.Equal(t, "MPTRt_BdOtXdMbwGj", parsed.Related.BrowseID)
	assert.Equal(t, relatedTabPageType,
		parsed.Related.BrowseEndpointContextSupportedConfigs.BrowseEndpointContextMusicConfig.PageType)
	assert.Equal(t, "RDAMVM9bZkp7q19f0", parsed.CurrentMixID)
	assert.Len(t, parsed.Results, 2)
	assert.Equal(t, "9bZkp7q19f0", parsed.Results[0].VideoID)
}

// Legacy layout ["Up next","Lyrics","Related"] (Related at tabs[2]) keeps working.
func TestParseNextBodyRelatedTabLegacyThreeTabs(t *testing.T) {
	nr := loadNextFixture(t, "next_web_remix_four_tabs.json")
	tabs := &nr.Contents.SingleColumnMusicWatchNextResultsRenderer.TabbedRenderer.WatchNextTabbedResultsRenderer.Tabs
	*tabs = append((*tabs)[:2], (*tabs)[3:]...) // drop "Comments"
	assert.Len(t, *tabs, 3)
	assert.Equal(t, "Related", (*tabs)[2].TabRenderer.Title)

	parsed := ParseNextBody(nr)
	assert.Equal(t, "MPTRt_BdOtXdMbwGj", parsed.Related.BrowseID)
	assert.Len(t, parsed.Results, 2)
}

// No Related tab at all: results are still returned, browseId stays empty
// (the front hides the tab in that case), and a 1-tab response no longer
// yields an empty payload.
func TestParseNextBodyNoRelatedTab(t *testing.T) {
	nr := loadNextFixture(t, "next_web_remix_four_tabs.json")
	tabs := &nr.Contents.SingleColumnMusicWatchNextResultsRenderer.TabbedRenderer.WatchNextTabbedResultsRenderer.Tabs
	*tabs = (*tabs)[:1]

	parsed := ParseNextBody(nr)
	assert.Equal(t, "", parsed.Related.BrowseID)
	assert.Len(t, parsed.Results, 2)
}
