package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// ST3: the ring is bounded (oldest dropped) and reads back newest first.
func TestClientLogRingBoundedFIFO(t *testing.T) {
	r := newClientLogRing(5)
	if got := r.newest(10); len(got) != 0 {
		t.Fatalf("empty ring returned %v", got)
	}
	for i := 1; i <= 7; i++ {
		r.push(clientLogEntry{Message: fmt.Sprintf("m%d", i)})
	}
	if r.len() != 5 {
		t.Fatalf("len %d, want 5", r.len())
	}
	var msgs []string
	for _, e := range r.newest(50) {
		msgs = append(msgs, e.Message)
	}
	if strings.Join(msgs, ",") != "m7,m6,m5,m4,m3" {
		t.Fatalf("newest = %v, want m7..m3 (m1, m2 dropped)", msgs)
	}
	if got := r.newest(2); len(got) != 2 || got[0].Message != "m7" || got[1].Message != "m6" {
		t.Fatalf("newest(2) = %v", got)
	}
}

func TestClientLogPostAndGet(t *testing.T) {
	resetClientLog()
	t.Cleanup(resetClientLog)
	ua := map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"}
	for i := 0; i < 3; i++ {
		body := fmt.Sprintf(`{"kind":"error","message":"boom %d","stack":"at x","url":"https://music.ekaii.fr/home"}`, i)
		c, rec := ctxFor(http.MethodPost, "/api/v1/client-log", body, ua)
		if err := ClientLogPostHandler(c); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/client-log?limit=2", "", nil)
	if err := ClientLogGetHandler(c); err != nil {
		t.Fatal(err)
	}
	var out struct {
		Entries []clientLogEntry `json:"entries"`
		Total   int              `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Total != 3 || len(out.Entries) != 2 {
		t.Fatalf("total %d entries %d, want 3 / 2", out.Total, len(out.Entries))
	}
	e := out.Entries[0]
	if e.Message != "boom 2" || e.Kind != "error" || e.Stack != "at x" || e.URL != "https://music.ekaii.fr/home" || e.UA != "Mozilla/5.0 Chrome/128" || e.At == 0 {
		t.Fatalf("entry %+v", e)
	}
	if out.Entries[1].Message != "boom 1" {
		t.Fatalf("second entry %+v, want boom 1", out.Entries[1])
	}
	// No profile data: the stored entry has no cookie / profile field.
	if strings.Contains(rec.Body.String(), "p-test") || strings.Contains(rec.Body.String(), "profile") {
		t.Fatalf("profile data leaked into the log: %s", rec.Body.String())
	}
}

func TestClientLogPostRejects(t *testing.T) {
	resetClientLog()
	t.Cleanup(resetClientLog)
	ua := map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"}
	big := `{"kind":"error","message":"` + strings.Repeat("x", clientLogMaxBody) + `"}`
	c, rec := ctxFor(http.MethodPost, "/api/v1/client-log", big, ua)
	_ = ClientLogPostHandler(c)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over 4 KB: status %d, want 413", rec.Code)
	}
	for _, body := range []string{`not json`, `{"kind":"","message":"x"}`, `{"kind":"error","message":""}`} {
		c, rec := ctxFor(http.MethodPost, "/api/v1/client-log", body, ua)
		_ = ClientLogPostHandler(c)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%q: status %d, want 400", body, rec.Code)
		}
	}
	// Harness requests are acknowledged but not stored.
	c, rec = ctxFor(http.MethodPost, "/api/v1/client-log", `{"kind":"error","message":"harness"}`, map[string]string{"User-Agent": "HeadlessChrome/128"})
	_ = ClientLogPostHandler(c)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ignored":true`) {
		t.Fatalf("harness: status %d body %s", rec.Code, rec.Body.String())
	}
	if clientLog.len() != 0 {
		t.Fatalf("stored %d entries, want 0", clientLog.len())
	}
	t.Setenv("YTM_STATS_INCLUDE_HARNESS", "1")
	c, _ = ctxFor(http.MethodPost, "/api/v1/client-log", `{"kind":"error","message":"harness"}`, map[string]string{"User-Agent": "HeadlessChrome/128"})
	_ = ClientLogPostHandler(c)
	if clientLog.len() != 1 {
		t.Fatalf("with YTM_STATS_INCLUDE_HARNESS=1 stored %d, want 1", clientLog.len())
	}
}

// Ring at full capacity through the handler: 500 kept, the first ones gone.
func TestClientLogHandlerCapacity(t *testing.T) {
	resetClientLog()
	t.Cleanup(resetClientLog)
	ua := map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"}
	for i := 0; i < clientLogCapacity+20; i++ {
		c, _ := ctxFor(http.MethodPost, "/api/v1/client-log", fmt.Sprintf(`{"kind":"k","message":"m%d"}`, i), ua)
		_ = ClientLogPostHandler(c)
	}
	if clientLog.len() != clientLogCapacity {
		t.Fatalf("len %d, want %d", clientLog.len(), clientLogCapacity)
	}
	got := clientLog.newest(1)
	if got[0].Message != fmt.Sprintf("m%d", clientLogCapacity+19) {
		t.Fatalf("newest %q", got[0].Message)
	}
	all := clientLog.newest(clientLogCapacity)
	if all[len(all)-1].Message != "m20" {
		t.Fatalf("oldest kept %q, want m20", all[len(all)-1].Message)
	}
}
