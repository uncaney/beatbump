package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

// BI1: DELETE me/playlists/:id/items?ref=<videoId> removes one track from a
// server playlist (the handler already existed, unused by the front until
// this lane's "Retirer de la playlist" button).
func TestMeDeletePlaylistItemHandler(t *testing.T) {
	useTestDB(t)
	if err := db.DB.AutoMigrate(&db.Playlist{}, &db.PlaylistItem{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pl := db.Playlist{ProfileID: "p1", Name: "Road trip"}
	db.DB.Create(&pl)
	db.DB.Create(&db.PlaylistItem{PlaylistID: pl.ID, Position: 0, Ref: "aaaaaaaaaaa", Title: "A", Data: `{"videoId":"aaaaaaaaaaa"}`})
	db.DB.Create(&db.PlaylistItem{PlaylistID: pl.ID, Position: 1, Ref: "bbbbbbbbbbb", Title: "B", Data: `{"videoId":"bbbbbbbbbbb"}`})

	e := echo.New()
	e.DELETE("/api/v1/me/playlists/:id/items", MeDeletePlaylistItemHandler)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/me/playlists/"+strconv.Itoa(int(pl.ID))+"/items?ref=aaaaaaaaaaa", nil)
	req.AddCookie(&http.Cookie{Name: "bbp", Value: "p1"})
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	var left []db.PlaylistItem
	db.DB.Where("playlist_id = ?", pl.ID).Find(&left)
	if len(left) != 1 || left[0].Ref != "bbbbbbbbbbb" {
		t.Fatalf("left = %+v, want only bbbbbbbbbbb", left)
	}

	// A foreign profile cannot touch this playlist's items.
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/me/playlists/"+strconv.Itoa(int(pl.ID))+"/items?ref=bbbbbbbbbbb", nil)
	req.AddCookie(&http.Cookie{Name: "bbp", Value: "someone-else"})
	rec = httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign profile: status %d, want 404", rec.Code)
	}
}
