package api

import (
	"beatbump-server/backend/_youtube"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

func loadSearchFixture(t *testing.T) _youtube.SearchResponse {
	t.Helper()
	f, err := os.Open("testdata/search_daft_punk_response.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	var sr _youtube.SearchResponse
	if err := json.Unmarshal(raw, &sr); err != nil {
		t.Fatal(err)
	}
	return sr
}

// PF3-3 (K11): "daft punk" used to answer 680 KB raw, 640 KB of it the raw
// YouTube response echoed under "response". The slim body must stay under
// the SW ytm-api cap (300 KB) with margin, and keep what the front reads.
func TestSearchPayloadSlimFixture(t *testing.T) {
	sr := loadSearchFixture(t)
	local := &MusicShelf{}
	local.Header.Title = "Dans ta bibliothèque"
	payload, err := searchPayload(sr, "", func() *MusicShelf { return local })
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) >= 250_000 {
		t.Fatalf("search.json body is %d bytes, want < 250000", len(raw))
	}
	body := string(raw)
	for _, k := range []string{`"response"`, `"loggingContext"`, `"menuRenderer"`, `"trackingParams"`} {
		if strings.Contains(body, k) {
			t.Fatalf("slim body still carries %s", k)
		}
	}
	var out struct {
		Results []struct {
			Header   map[string]interface{}   `json:"header"`
			Contents []map[string]interface{} `json:"contents"`
		} `json:"results"`
		Continuation map[string]interface{} `json:"continuation"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	// The continuation keeps its clickTrackingParams: paginate() sends it as itct.
	if out.Continuation["continuation"] == nil {
		t.Fatalf("continuation lost: %v", out.Continuation)
	}
	if len(out.Results) < 2 { // the flat "Results" shelf + the local one
		t.Fatalf("only %d shelves", len(out.Results))
	}
	if last := out.Results[len(out.Results)-1]; last.Header["title"] != "Dans ta bibliothèque" {
		t.Fatalf("local shelf not appended last: %v", last.Header)
	}
	songs, withThumb := 0, 0
	for _, sh := range out.Results {
		for _, it := range sh.Contents {
			if th, ok := it["thumbnails"].([]interface{}); ok && len(th) > 0 {
				withThumb++
				if len(th) > 2 {
					t.Fatalf("item keeps %d thumbnails", len(th))
				}
			}
			if v, _ := it["clickTrackingParams"].(string); v != "" {
				t.Fatalf("item keeps clickTrackingParams: %v", it)
			}
			if v, _ := it["videoId"].(string); v != "" {
				songs++
				if _, ok := it["title"]; !ok {
					t.Fatalf("song without title: %v", it)
				}
			}
		}
	}
	if songs < 5 || withThumb < 5 {
		t.Fatalf("songs=%d withThumb=%d", songs, withThumb)
	}
	t.Logf("slim search.json: %d bytes, %d shelves, %d playable rows", len(raw), len(out.Results), songs)
}

func TestSlimSearchItemsKeepsFirstAndLastThumbnail(t *testing.T) {
	items := []IListItemRenderer{{Thumbnails: []Thumbnail{{URL: "s"}, {URL: "m"}, {URL: "l"}}}, {Thumbnails: []Thumbnail{{URL: "only"}}}}
	slimSearchItems(items)
	if len(items[0].Thumbnails) != 2 || items[0].Thumbnails[0].URL != "s" || items[0].Thumbnails[1].URL != "l" {
		t.Fatalf("thumbnails: %+v", items[0].Thumbnails)
	}
	if len(items[1].Thumbnails) != 1 {
		t.Fatalf("single thumbnail altered: %+v", items[1].Thumbnails)
	}
}

// The correction now only travels as "correction": the original query comes
// from the endpoint first (as the former front extractor did).
func TestExtractCorrectionPrefersEndpointQuery(t *testing.T) {
	raw := `{"contents":{"tabbedSearchResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[
	 {"itemSectionRenderer":{"contents":[{"showingResultsForRenderer":{
	   "showingResultsFor":{"runs":[{"text":"Résultats pour "}]},
	   "correctedQuery":{"runs":[{"text":"daft punk"}]},
	   "searchInsteadFor":{"runs":[{"text":"Rechercher plutôt "}]},
	   "originalQuery":{"runs":[{"text":"daft pnk (runs)"}]},
	   "originalQueryEndpoint":{"searchEndpoint":{"query":"daft pnk"}}}}]}}]}}}}]}}}`
	var sr _youtube.SearchResponse
	if err := json.Unmarshal([]byte(raw), &sr); err != nil {
		t.Fatal(err)
	}
	c := extractCorrection(sr)
	if c == nil || c.CorrectedQuery != "daft punk" || c.OriginalQuery != "daft pnk" || c.ShowingResultsFor != "Résultats pour " {
		t.Fatalf("correction: %+v", c)
	}
}
