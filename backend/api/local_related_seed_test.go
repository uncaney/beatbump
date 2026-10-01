package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

// EQ1: ?seed=album:<id>|artist:<id>|favorites builds a flat radio queue
// (localRelatedSeedHandler / radioFromSeedTracks), max 30 tracks, max 2 per
// album, seeded by the album/artist/favourites' own tracks and extended via
// radioPool.
func TestLocalRelatedSeedAlbum(t *testing.T) {
	stub := newShelfStub(t)
	discoID := albumID("Daft Punk", "Discovery")
	stub.hits["albums"] = []map[string]interface{}{
		{"id": discoID, "album": "Discovery", "albumArtist": "Daft Punk", "year": "2001", "coverLid": "e182ccc85ad"},
	}
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
		{"lid": "a1b2c3d4e5f", "title": "Aerodynamic", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 2.0, "durationSec": 212.0},
		{"lid": "b1b2c3d4e5f", "title": "Get Lucky", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Random Access Memories", "genre": "House", "track": 8.0, "durationSec": 369.0},
	}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/related?seed=album:"+discoID, nil)
	rec := httptest.NewRecorder()
	if err := LocalRelatedHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []map[string]interface{} `json:"items"`
		Name  string                   `json:"name"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Name != "Discovery" {
		t.Fatalf("name = %q, want Discovery", body.Name)
	}
	if len(body.Items) == 0 || len(body.Items) > 30 {
		t.Fatalf("items = %d, want 1..30", len(body.Items))
	}
}

// radioFromSeedTracks itself: capped at `limit`, at most `maxPerAlbum` tracks
// from the same album (checked directly - the queue Item the HTTP handler
// returns carries no album id to assert against).
func TestRadioFromSeedTracksCapsPerAlbum(t *testing.T) {
	resetAlbumCoverMemo()
	tracks := []map[string]interface{}{}
	for i := 0; i < 6; i++ {
		tracks = append(tracks, map[string]interface{}{
			"lid": fmt.Sprintf("%011x", i+1), "title": fmt.Sprintf("T%d", i), "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": float64(i), "durationSec": 200.0,
		})
	}
	out := radioFromSeedTracks(tracks, 30, 2)
	if len(out) != 2 {
		t.Fatalf("got %d items, want 2 (max per album)", len(out))
	}
}

func TestLocalRelatedSeedArtist(t *testing.T) {
	stub := newShelfStub(t)
	stub.hits["artists"] = []map[string]interface{}{{"id": artistID("Daft Punk"), "name": "Daft Punk"}}
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
	}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/related?seed=artist:"+artistID("Daft Punk"), nil)
	rec := httptest.NewRecorder()
	if err := LocalRelatedHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Name != "Daft Punk" {
		t.Fatalf("name = %q, want Daft Punk", body.Name)
	}
}

func TestLocalRelatedSeedFavorites(t *testing.T) {
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.Favorite{}); err != nil {
		t.Fatalf("migrate favorites: %v", err)
	}
	stub := newShelfStub(t)
	stub.hits["tracks"] = []map[string]interface{}{
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "genre": "House", "track": 1.0, "durationSec": 320.0},
	}
	db.DB.Create(&db.Favorite{ProfileID: "p1", Kind: "song", Ref: "e182ccc85ad", Title: "One More Time", CreatedAt: time.Now()})

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/related?seed=favorites", nil)
	req.AddCookie(&http.Cookie{Name: "bbp", Value: "p1"})
	rec := httptest.NewRecorder()
	if err := LocalRelatedHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []map[string]interface{} `json:"items"`
		Name  string                   `json:"name"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Name != "Favoris" || len(body.Items) == 0 {
		t.Fatalf("name=%q items=%d", body.Name, len(body.Items))
	}
}

func TestLocalRelatedSeedUnknownAndNotFound(t *testing.T) {
	_ = newShelfStub(t)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/related?seed=bogus", nil)
	rec := httptest.NewRecorder()
	_ = LocalRelatedHandler(e.NewContext(req, rec))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown seed: status = %d, want 400", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/local/related?seed=album:lb-doesnotexist", nil)
	rec = httptest.NewRecorder()
	_ = LocalRelatedHandler(e.NewContext(req, rec))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown album: status = %d, want 404", rec.Code)
	}
}
