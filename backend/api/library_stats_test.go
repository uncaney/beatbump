package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ST2: stats/library counts the three Meili indexes and reports the newest
// track's dateAdded plus the build version.
func TestLibraryStats(t *testing.T) {
	var sorts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/indexes/"), "/search")
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if s, ok := body["sort"].([]interface{}); ok && len(s) > 0 {
			sorts = append(sorts, index+":"+s[0].(string))
		}
		if lim := stubInt(body["limit"]); lim != 1 {
			t.Errorf("%s: limit %d, want 1", index, lim)
		}
		resp := map[string]interface{}{"hits": []interface{}{}, "estimatedTotalHits": 0}
		switch index {
		case "tracks":
			resp = map[string]interface{}{"hits": []interface{}{map[string]interface{}{"dateAdded": 1759300000.0}}, "estimatedTotalHits": 12345}
		case "albums":
			resp["estimatedTotalHits"] = 987
		case "artists":
			resp["estimatedTotalHits"] = 321
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	SetVersion("c29d-test")

	c, rec := ctxFor(http.MethodGet, "/api/v1/stats/library", "", nil)
	if err := LibraryStatsHandler(c); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var out libraryStats
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Tracks != 12345 || out.Albums != 987 || out.Artists != 321 {
		t.Fatalf("counts %+v", out)
	}
	if out.LastAdded != "2025-10-01T06:26:40Z" {
		t.Fatalf("lastAdded %q", out.LastAdded)
	}
	if out.Version != "c29d-test" {
		t.Fatalf("version %q", out.Version)
	}
	if strings.Join(sorts, ",") != "tracks:dateAdded:desc" {
		t.Fatalf("only the tracks query is sorted (newest first), got %v", sorts)
	}
}

func TestLibraryStatsMeiliDown(t *testing.T) {
	t.Setenv("MEILI_URL", "http://127.0.0.1:1") // nothing listens
	SetVersion("")
	c, rec := ctxFor(http.MethodGet, "/api/v1/stats/library", "", nil)
	if err := LibraryStatsHandler(c); err != nil {
		t.Fatal(err)
	}
	var out libraryStats
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != http.StatusOK || out.Tracks != 0 || out.LastAdded != "" || out.Version != "dev" {
		t.Fatalf("status %d out %+v, want zeros + dev", rec.Code, out)
	}
}

func TestResolveVersionAndDateAdded(t *testing.T) {
	for _, tc := range []struct{ ld, env, want string }{
		{"", "", "dev"}, {"dev", "", "dev"}, {"dev", "2026.10.01", "2026.10.01"},
		{"abc123", "2026.10.01", "abc123"}, {" v1 ", "", "v1"},
	} {
		if got := ResolveVersion(tc.ld, tc.env); got != tc.want {
			t.Errorf("ResolveVersion(%q,%q) = %q, want %q", tc.ld, tc.env, got, tc.want)
		}
	}
	for v, want := range map[interface{}]string{
		1759300000.0:    "2025-10-01T06:26:40Z",
		1759300000123.0: "2025-10-01T06:26:40Z",
		"2026-09-30":    "2026-09-30",
		0.0:             "",
		nil:             "",
	} {
		if got := formatDateAdded(v); got != want {
			t.Errorf("formatDateAdded(%v) = %q, want %q", v, got, want)
		}
	}
}
