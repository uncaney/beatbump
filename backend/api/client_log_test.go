package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// adminHdr is the operator header accepted by GET client-log in tests.
func adminHdr(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

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
	t.Setenv("YTM_ADMIN_TOKEN", "op-token")
	ua := map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"}
	for i := 0; i < 3; i++ {
		body := fmt.Sprintf(`{"kind":"error","message":"boom %d","stack":"at x","url":"https://music.ekaii.fr/home?x=1#frag"}`, i)
		c, rec := ctxFor(http.MethodPost, "/api/v1/client-log", body, ua)
		if err := ClientLogPostHandler(c); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/client-log?limit=2", "", adminHdr("op-token"))
	if err := ClientLogGetHandler(c); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
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
	// L8-17: pathname only (no query, no fragment, no host).
	if e.Message != "boom 2" || e.Kind != "error" || e.Stack != "at x" || e.URL != "/home" || e.UA != "Mozilla/5.0 Chrome/128" || e.At == 0 {
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

// L8-2: GET is operator only. 404 while YTM_ADMIN_TOKEN is unset (the
// endpoint does not exist), 401 without / with a wrong bearer, 200 with it.
func TestClientLogGetRequiresAdminToken(t *testing.T) {
	resetClientLog()
	t.Cleanup(resetClientLog)
	clientLog.push(clientLogEntry{Kind: "error", Message: "secret path", URL: "/search/private"})

	t.Setenv("YTM_ADMIN_TOKEN", "")
	for _, hdr := range []map[string]string{nil, adminHdr("anything")} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/client-log", "", hdr)
		_ = ClientLogGetHandler(c)
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "secret path") {
			t.Fatalf("unset token, hdr %v: status %d body %s, want 404 without entries", hdr, rec.Code, rec.Body.String())
		}
	}

	t.Setenv("YTM_ADMIN_TOKEN", "op-token")
	for _, hdr := range []map[string]string{
		nil,
		adminHdr("wrong"),
		adminHdr("op-token-longer"),
		{"Authorization": "op-token"},
		{"Authorization": "Basic b3AtdG9rZW4="},
	} {
		c, rec := ctxFor(http.MethodGet, "/api/v1/client-log", "", hdr)
		_ = ClientLogGetHandler(c)
		if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "secret path") {
			t.Fatalf("hdr %v: status %d body %s, want 401 without entries", hdr, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("hdr %v: no WWW-Authenticate", hdr)
		}
	}
	c, rec := ctxFor(http.MethodGet, "/api/v1/client-log", "", adminHdr("op-token"))
	_ = ClientLogGetHandler(c)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "secret path") {
		t.Fatalf("right token: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control %q", rec.Header().Get("Cache-Control"))
	}
}

// L8-2: POST is limited per client IP: clientLogPostBurst in a window, 429
// beyond (Retry-After), another IP unaffected, the bucket refills with time.
func TestClientLogPostRateLimited(t *testing.T) {
	resetClientLog()
	t.Cleanup(resetClientLog)
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	clientLogLimiter.now = func() time.Time { return now }
	post := func(ip string) int {
		c, rec := ctxFor(http.MethodPost, "/api/v1/client-log", `{"kind":"error","message":"flood"}`,
			map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128", "X-Real-IP": ip})
		_ = ClientLogPostHandler(c)
		if rec.Code == http.StatusTooManyRequests && rec.Header().Get("Retry-After") == "" {
			t.Fatalf("429 without Retry-After")
		}
		return rec.Code
	}
	for i := 0; i < clientLogPostBurst; i++ {
		if code := post("203.0.113.9"); code != http.StatusOK {
			t.Fatalf("post %d: status %d, want 200", i+1, code)
		}
	}
	if code := post("203.0.113.9"); code != http.StatusTooManyRequests {
		t.Fatalf("post %d: status %d, want 429", clientLogPostBurst+1, code)
	}
	if clientLog.len() != clientLogPostBurst {
		t.Fatalf("stored %d, want %d (the 429 one is not stored)", clientLog.len(), clientLogPostBurst)
	}
	if code := post("203.0.113.10"); code != http.StatusOK {
		t.Fatalf("other IP: status %d, want 200", code)
	}
	// A whole window later the bucket is full again.
	now = now.Add(clientLogPostWindow)
	if code := post("203.0.113.9"); code != http.StatusOK {
		t.Fatalf("after refill: status %d, want 200", code)
	}
	// Drain it (29 left), then half a window refills half a burst: 15 more
	// accepted, the 16th refused.
	for i := 0; i < clientLogPostBurst-1; i++ {
		if code := post("203.0.113.9"); code != http.StatusOK {
			t.Fatalf("drain %d: status %d", i, code)
		}
	}
	now = now.Add(clientLogPostWindow / 2)
	ok := 0
	for i := 0; i < clientLogPostBurst; i++ {
		if post("203.0.113.9") == http.StatusOK {
			ok++
		}
	}
	if ok != clientLogPostBurst/2 {
		t.Fatalf("after half a window: %d accepted, want %d", ok, clientLogPostBurst/2)
	}
}

// The per-IP map stays bounded: a scan of many addresses sweeps idle buckets.
func TestIPLimiterBounded(t *testing.T) {
	l := newIPLimiter(3, time.Minute)
	now := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < ipLimiterMaxKeys+100; i++ {
		if !l.allow(fmt.Sprintf("10.0.%d.%d", i/256, i%256)) {
			t.Fatalf("first request of ip %d refused", i)
		}
	}
	if n := len(l.buckets); n > ipLimiterMaxKeys {
		t.Fatalf("buckets %d, want <= %d", n, ipLimiterMaxKeys)
	}
	l.allow("x")
	l.allow("x")
	l.allow("x")
	if l.allow("x") {
		t.Fatalf("4th request in the window must be refused")
	}
	now = now.Add(20 * time.Second) // 1 token back
	if !l.allow("x") || l.allow("x") {
		t.Fatalf("partial refill: exactly one more request")
	}
}

// L8-17: only the pathname of the page is stored, the message is clipped to 500.
func TestClientLogPathnameAndMessageClip(t *testing.T) {
	for in, want := range map[string]string{
		"https://music.ekaii.fr/search/abba?filter=songs#top": "/search/abba",
		"https://music.ekaii.fr/listen?id=dQw4w9WgXcQ":        "/listen",
		"https://music.ekaii.fr":                              "/",
		"/library/albums?sort=album:asc":                      "/library/albums",
		"  /home  ":                                           "/home",
		"":                                                    "",
		"%zz":                                                 "",
		"/" + strings.Repeat("p", 400):                        "/" + strings.Repeat("p", clientLogMaxURL-1),
	} {
		if got := clientLogPathname(in); got != want {
			t.Errorf("clientLogPathname(%q) = %q, want %q", in, got, want)
		}
	}

	resetClientLog()
	t.Cleanup(resetClientLog)
	t.Setenv("YTM_ADMIN_TOKEN", "op-token")
	ua := map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128"}
	body := `{"kind":"error","message":"` + strings.Repeat("m", 900) + `","url":"https://music.ekaii.fr/listen?id=dQw4w9WgXcQ&t=3#x"}`
	c, rec := ctxFor(http.MethodPost, "/api/v1/client-log", body, ua)
	_ = ClientLogPostHandler(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	c, rec = ctxFor(http.MethodGet, "/api/v1/client-log?limit=1", "", adminHdr("op-token"))
	_ = ClientLogGetHandler(c)
	var out struct {
		Entries []clientLogEntry `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Entries) != 1 {
		t.Fatalf("body %s (%v)", rec.Body.String(), err)
	}
	e := out.Entries[0]
	if e.URL != "/listen" {
		t.Fatalf("url %q, want /listen", e.URL)
	}
	if len(e.Message) != clientLogMaxMessage {
		t.Fatalf("message length %d, want %d", len(e.Message), clientLogMaxMessage)
	}
	if strings.Contains(rec.Body.String(), "dQw4w9WgXcQ") {
		t.Fatalf("query string stored: %s", rec.Body.String())
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
// Every POST comes from its own IP so the per-IP limit does not interfere.
func TestClientLogHandlerCapacity(t *testing.T) {
	resetClientLog()
	t.Cleanup(resetClientLog)
	for i := 0; i < clientLogCapacity+20; i++ {
		hdr := map[string]string{"User-Agent": "Mozilla/5.0 Chrome/128", "X-Real-IP": fmt.Sprintf("10.1.%d.%d", i/256, i%256)}
		c, rec := ctxFor(http.MethodPost, "/api/v1/client-log", fmt.Sprintf(`{"kind":"k","message":"m%d"}`, i), hdr)
		_ = ClientLogPostHandler(c)
		if rec.Code != http.StatusOK {
			t.Fatalf("post %d: status %d", i, rec.Code)
		}
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
