package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestLocalRelatedBySeedLid(t *testing.T) {
	stub := newShelfStub(t)
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
		{"lid": "a1b2c3d4e5f", "title": "Aerodynamic", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 2.0, "durationSec": 212.0},
		{"lid": "0123456789a", "title": "Lady", "artist": "Modjo", "albumArtist": "Modjo", "album": "Modjo", "genre": "House", "track": 3.0, "durationSec": 300.0},
	}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/related?lid=e182ccc85ad", nil)
	rec := httptest.NewRecorder()
	if err := LocalRelatedHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []map[string]interface{} `json:"items"`
		Seed  string                   `json:"seed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Seed != "e182ccc85ad" || len(body.Items) == 0 {
		t.Fatalf("seed=%q items=%d", body.Seed, len(body.Items))
	}
	for _, it := range body.Items {
		if it["videoId"] == "e182ccc85ad" {
			t.Fatalf("seed must be excluded from its own related list")
		}
	}
}

func TestLocalRelatedByMetadataAndNotFound(t *testing.T) {
	stub := newShelfStub(t)
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
		{"lid": "a1b2c3d4e5f", "title": "Aerodynamic", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 2.0, "durationSec": 212.0},
	}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/related?title=one+more+time&artist=Daft+Punk", nil)
	rec := httptest.NewRecorder()
	_ = LocalRelatedHandler(e.NewContext(req, rec))
	if rec.Code != http.StatusOK {
		t.Fatalf("metadata seed: status %d body %s", rec.Code, rec.Body.String())
	}

	stub.hits["tracks"] = nil
	req = httptest.NewRequest(http.MethodGet, "/api/v1/local/related?lid=ffffffffff0", nil)
	rec = httptest.NewRecorder()
	_ = LocalRelatedHandler(e.NewContext(req, rec))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown seed must be 404, got %d", rec.Code)
	}
}

func TestLocalRelatedOneCardPerAlbumArtistFirst(t *testing.T) {
	stub := newShelfStub(t)
	// The stub answers every tracks query with the same list, so the pool holds
	// each track several times (artist + genre queries): dedupe must cope.
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
		{"lid": "a1b2c3d4e5f", "title": "Aerodynamic", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 2.0, "durationSec": 212.0},
		{"lid": "a1b2c3d4e60", "title": "Digital Love", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 3.0, "durationSec": 301.0},
		{"lid": "b1b2c3d4e5f", "title": "Get Lucky", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Random Access Memories", "genre": "House", "track": 8.0, "durationSec": 369.0},
		{"lid": "c1b2c3d4e5f", "title": "Come Around Again", "artist": "DJ A", "albumArtist": "Various Artists", "album": "A State of Trance Ibiza 2022", "genre": "House", "track": 1.0, "durationSec": 200.0},
		{"lid": "c1b2c3d4e60", "title": "Welcome Home", "artist": "DJ B", "albumArtist": "Various Artists", "album": "A State of Trance Ibiza 2022", "genre": "House", "track": 2.0, "durationSec": 210.0},
		{"lid": "0123456789a", "title": "Lady", "artist": "Modjo", "albumArtist": "Modjo", "album": "Modjo", "genre": "House", "track": 3.0, "durationSec": 300.0},
	}
	seed := stub.hits["tracks"][0]
	for run := 0; run < 20; run++ { // the pool is shuffled: check the invariants many times
		pool := radioPool(seed, "e182ccc85ad")
		items := relatedByAlbum(seed, "e182ccc85ad", pool, 20)
		// Discovery (once, not the seed), RAM, ASOT (once), Modjo.
		if len(items) != 4 {
			t.Fatalf("run %d: want 4 cards (one per album), got %d: %+v", run, len(items), items)
		}
		covers := map[string]bool{}
		for i, it := range items {
			if it.VideoID == "e182ccc85ad" {
				t.Fatalf("seed must be excluded")
			}
			if len(it.Thumbnails) == 0 || covers[it.Thumbnails[0].URL] {
				t.Fatalf("run %d: duplicate or missing cover at %d: %+v", run, i, items)
			}
			covers[it.Thumbnails[0].URL] = true
			isDP := len(it.ArtistInfo.Artist) > 0 && it.ArtistInfo.Artist[0].Text == "Daft Punk"
			if (i < 2) != isDP {
				t.Fatalf("run %d: the two Daft Punk albums must come first: %+v", run, items)
			}
		}
	}
}
