package api

// BI3: CSV export of the profile's listening history.
//
//   GET /api/v1/me/stats/export.csv
//
// Same profile resolution as me/stats/recent (bbp cookie). One line per
// play event, newest first, capped at exportCSVMaxRows. RFC 4180: CRLF line
// ends, fields quoted when they hold a comma, a quote or a line break
// (encoding/csv), served as an attachment named ecoutes.csv.

import (
	"encoding/csv"
	"net/http"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

// exportCSVMaxRows bounds the export (a var so tests can lower it).
var exportCSVMaxRows = 10000

// exportCSVHeader is the first line of the file.
var exportCSVHeader = []string{"playedAt", "title", "artist", "album", "source"}

// exportRow maps one PlayEvent to its CSV fields. Artist and album fall back
// to the stored item JSON for rows written before those columns existed
// (same rule as the stats aggregates).
func exportRow(e db.PlayEvent) []string {
	artist := e.Artist
	if artist == "" {
		artist, _ = playArtist(e.Data)
	}
	album := e.Album
	if album == "" {
		album = itemAlbum(e.Data)
	}
	return []string{e.PlayedAt.UTC().Format(time.RFC3339), e.Title, artist, album, e.Source}
}

// MeStatsExportCSVHandler: GET /api/v1/me/stats/export.csv.
func MeStatsExportCSVHandler(c echo.Context) error {
	pid := profileID(c)
	var evs []db.PlayEvent
	db.DB.Select("title, artist, album, source, data, played_at").
		Where("profile_id = ?", pid).
		Order("played_at desc, id desc").Limit(exportCSVMaxRows).Find(&evs)

	h := c.Response().Header()
	h.Set(echo.HeaderContentType, "text/csv; charset=utf-8")
	h.Set("Content-Disposition", `attachment; filename="ecoutes.csv"`)
	h.Set("Cache-Control", "no-store")
	c.Response().WriteHeader(http.StatusOK)

	w := csv.NewWriter(c.Response())
	w.UseCRLF = true
	if err := w.Write(exportCSVHeader); err != nil {
		return err
	}
	for _, e := range evs {
		if err := w.Write(exportRow(e)); err != nil {
			return err
		}
	}
	w.Flush()
	return w.Error()
}
