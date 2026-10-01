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
