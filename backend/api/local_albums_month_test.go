package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// c44a B7-2: GET /local/albums?filter=added-month[&month=YYYY-MM]. Albums
// newest first: 5 in September 2026, 2 in August, 4 in July, 3 in June (the
// migration month) and 1 in May.
func newMonthStub(t *testing.T) *neverPlayedStub {
	t.Helper()
	at := func(y int, m time.Month, d int) float64 {
		return float64(time.Date(y, m, d, 12, 0, 0, 0, time.UTC).Unix())
	}
	resetAddedMonthMemo()
	t.Cleanup(resetAddedMonthMemo)
	stub := &neverPlayedStub{}
	add := func(month string, y int, m time.Month, days ...int) {
		for i, d := range days {
			id := fmt.Sprintf("lb-%s-%d", strings.ReplaceAll(month, "-", ""), i)
			stub.albums = append(stub.albums, map[string]interface{}{
				"id": id, "album": fmt.Sprintf("%s %d", month, i), "albumArtist": "Artist " + month, "coverLid": "lid" + id,
				"dateAdded": at(y, m, d), "year": "2020", "trackCount": 10.0,
			})
		}
	}
	add("2026-09", 2026, time.September, 28, 20, 15, 9, 2)
	add("2026-08", 2026, time.August, 30, 1)
	add("2026-07", 2026, time.July, 31, 20, 10, 3)
	add("2026-06", 2026, time.June, 25, 15, 5)
	add("2026-05", 2026, time.May, 1)
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)
	t.Setenv("MEILI_URL", srv.URL)
	return stub
}

func monthStatus(t *testing.T, target string) (int, map[string]interface{}) {
	t.Helper()
	c, rec := ctxFor(http.MethodGet, target, "", nil)
	if err := LocalAlbumsHandler(c); err != nil {
		t.Fatalf("%s: %v", target, err)
	}
	var out map[string]interface{}
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestLocalAlbumsFilterAddedMonthBound(t *testing.T) {
	newMonthStub(t)
	addedMonthNow = func() time.Time { return time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { addedMonthNow = time.Now })
	// Before the migration bound: refused with the reason.
	for _, m := range []string{"2026-06", "2026-01", "2025-12", "1970-01"} {
		code, out := monthStatus(t, "/api/v1/local/albums?filter=added-month&month="+m)
		if code != http.StatusBadRequest || !strings.Contains(mstr(out, "reason"), "2026-07") || !strings.Contains(mstr(out, "reason"), "migration") {
			t.Fatalf("month=%s: %d %v (want 400 with the migration reason)", m, code, out)
		}
	}
	// Malformed or future months.
	for _, m := range []string{"2026-9", "2026-13", "202609", "septembre", "2026-11", "2027-01"} {
		if code, out := monthStatus(t, "/api/v1/local/albums?filter=added-month&month="+m); code != http.StatusBadRequest {
			t.Fatalf("month=%s: %d %v (want 400)", m, code, out)
		}
	}
	// The bound itself answers.
	code, out := monthStatus(t, "/api/v1/local/albums?filter=added-month&month=2026-07")
	if code != http.StatusOK || out["total"].(float64) != 4 || out["month"] != "2026-07" || out["filter"] != "added-month" {
		t.Fatalf("month=2026-07: %d %v", code, out)
	}
	if got := albumTitles(out); len(got) != 4 || got[0] != "2026-07 0" || got[3] != "2026-07 3" {
		t.Fatalf("month=2026-07 newest first: %v", got)
	}
	// The current (empty) month is a 200 with no items.
	if code, out := monthStatus(t, "/api/v1/local/albums?filter=added-month&month=2026-10"); code != http.StatusOK || out["total"].(float64) != 0 || len(albumTitles(out)) != 0 {
		t.Fatalf("month=2026-10: %d %v", code, out)
	}
	// Counts never include the months before the bound.
	months, _ := out["months"].(map[string]interface{})
	if months["2026-09"] != 5.0 || months["2026-08"] != 2.0 || months["2026-07"] != 4.0 {
		t.Fatalf("months = %v", months)
	}
	if _, ok := months["2026-06"]; ok {
		t.Fatalf("June (migration month) counted: %v", months)
	}
	if out["minMonth"] != "2026-07" {
		t.Fatalf("minMonth = %v", out["minMonth"])
	}
}

func TestLocalAlbumsFilterAddedMonthPickAndPaging(t *testing.T) {
	newMonthStub(t)
	addedMonthNow = func() time.Time { return time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { addedMonthNow = time.Now })
	// No month: October has 0 albums, August only 2 -> September (5).
	code, out := monthStatus(t, "/api/v1/local/albums?filter=added-month&limit=2")
	if code != http.StatusOK || out["month"] != "2026-09" || out["reason"] != "fallback" || out["total"].(float64) != 5 {
		t.Fatalf("no month: %d %v", code, out)
	}
	if got := albumTitles(out); len(got) != 2 || got[0] != "2026-09 0" || got[1] != "2026-09 1" {
		t.Fatalf("limit=2: %v", got)
	}
	_, page := monthStatus(t, "/api/v1/local/albums?filter=added-month&month=2026-09&offset=4&limit=2")
	if got := albumTitles(page); len(got) != 1 || got[0] != "2026-09 4" || page["total"].(float64) != 5 {
		t.Fatalf("offset=4 limit=2: %v total %v", got, page["total"])
	}
	// Another sort applies in Go.
	_, sorted := monthStatus(t, "/api/v1/local/albums?filter=added-month&month=2026-09&sort=album:asc")
	if got := albumTitles(sorted); len(got) != 5 || got[0] != "2026-09 0" || got[4] != "2026-09 4" || sorted["sort"] != "album:asc" {
		t.Fatalf("sort=album:asc: %v", got)
	}
	// Inside a month that is full enough, the current month wins.
	addedMonthNow = func() time.Time { return time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC) }
	_, cur := monthStatus(t, "/api/v1/local/albums?filter=added-month")
	if cur["month"] != "2026-09" || cur["reason"] != nil || cur["total"].(float64) != 5 {
		t.Fatalf("current month: %v", cur)
	}
	// Future months are refused relative to the current date.
	if code, _ := monthStatus(t, "/api/v1/local/albums?filter=added-month&month=2026-10"); code != http.StatusBadRequest {
		t.Fatalf("2026-10 in September: %d (want 400)", code)
	}
	// August has 2 (< 4): July (4) is the latest full month.
	addedMonthNow = func() time.Time { return time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC) }
	if _, aug := monthStatus(t, "/api/v1/local/albums?filter=added-month"); aug["month"] != "2026-07" || aug["reason"] != "fallback" || aug["total"].(float64) != 4 {
		t.Fatalf("August: %v", aug)
	}
	// July holds 4: the current month, no reason.
	addedMonthNow = func() time.Time { return time.Date(2026, 7, 31, 23, 0, 0, 0, time.UTC) }
	if _, jul := monthStatus(t, "/api/v1/local/albums?filter=added-month"); jul["month"] != "2026-07" || jul["reason"] != nil || jul["total"].(float64) != 4 {
		t.Fatalf("July: %v", jul)
	}
	// The pure pick.
	if m, r := addedMonthPick(map[string]int{"2026-07": 4, "2026-08": 1}, "2026-08"); m != "2026-07" || r != "fallback" {
		t.Fatalf("pick fallback = %s %s", m, r)
	}
	if m, r := addedMonthPick(map[string]int{"2026-07": 3}, "2026-08"); m != "2026-08" || r != "thin" {
		t.Fatalf("pick thin = %s %s", m, r)
	}
	if m, r := addedMonthPick(map[string]int{"2026-08": 4, "2026-09": 9}, "2026-08"); m != "2026-08" || r != "" {
		t.Fatalf("pick current = %s %s", m, r)
	}
}

// L13-15: the added-month scan is memoised 5 minutes per (q, artistId) in a
// bounded LRU: the second /home costs no Meili page, another query or an
// expired entry rescans, and the map never grows past addedMonthMemoMax.
func TestLocalAlbumsFilterAddedMonthMemo(t *testing.T) {
	stub := newMonthStub(t)
	addedMonthNow = func() time.Time { return time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { addedMonthNow = time.Now })
	base := time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC)
	addedMonthMemoNow = func() time.Time { return base }
	t.Cleanup(func() { addedMonthMemoNow = time.Now })
	code, first := monthStatus(t, "/api/v1/local/albums?filter=added-month")
	if code != http.StatusOK || mstr(first, "month") != "2026-09" {
		t.Fatalf("first: %d %v", code, first)
	}
	calls := stub.albumCalls
	if calls == 0 {
		t.Fatalf("first call did not scan")
	}
	for i := 0; i < 5; i++ {
		code, again := monthStatus(t, "/api/v1/local/albums?filter=added-month&month=2026-07&limit=2")
		if code != http.StatusOK || mstr(again, "month") != "2026-07" || mint(again, "total") != 4 || len(again["items"].([]interface{})) != 2 {
			t.Fatalf("memoised call %d: %d %v", i, code, again)
		}
	}
	if stub.albumCalls != calls {
		t.Fatalf("memoised calls rescanned: %d -> %d", calls, stub.albumCalls)
	}
	// The month chosen follows the clock, not the memo.
	addedMonthNow = func() time.Time { return time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC) }
	if _, out := monthStatus(t, "/api/v1/local/albums?filter=added-month"); mstr(out, "month") != "2026-09" || stub.albumCalls != calls {
		t.Fatalf("pick with the memo: %v (calls %d)", out, stub.albumCalls)
	}
	// Another query is another scan.
	monthStatus(t, "/api/v1/local/albums?filter=added-month&q=x")
	if stub.albumCalls == calls || addedMonthMemoLen() != 2 {
		t.Fatalf("q=x: calls %d len %d", stub.albumCalls, addedMonthMemoLen())
	}
	// Past the TTL the scan runs again.
	calls = stub.albumCalls
	addedMonthMemoNow = func() time.Time { return base.Add(addedMonthMemoTTL + time.Second) }
	monthStatus(t, "/api/v1/local/albums?filter=added-month")
	if stub.albumCalls == calls {
		t.Fatalf("expired memo served")
	}
	// Bounded.
	for i := 0; i < addedMonthMemoMax+10; i++ {
		monthStatus(t, fmt.Sprintf("/api/v1/local/albums?filter=added-month&q=q%d", i))
	}
	if n := addedMonthMemoLen(); n != addedMonthMemoMax {
		t.Fatalf("memo size %d, want %d", n, addedMonthMemoMax)
	}
}
