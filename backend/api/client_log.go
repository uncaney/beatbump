package api

// ST3 client error reporting: the SPA POSTs its uncaught errors, unhandled
// rejections and media errors here; an operator reads the newest ones back.
//
//   POST /api/v1/client-log  {kind, message, stack?, url?, ua?}  (max 4 KB)
//   GET  /api/v1/client-log?limit=50  -> {entries: [...newest first]}
//
// Entries live in a process-wide ring of clientLogCapacity (FIFO, oldest
// dropped). Nothing profile-related is stored: no cookie, no IP, only the
// fields the client sent (clipped) and the server receive time. Harness
// requests (Playwright, X-Ytm-Harness) are ignored unless
// YTM_STATS_INCLUDE_HARNESS=1, like me/history and me/nowplaying.
//
// L8-2 / L8-17 hardening:
//   - GET needs `Authorization: Bearer <YTM_ADMIN_TOKEN>`: 401 without or
//     with a wrong token, 404 when the variable is not set (the endpoint
//     then does not exist for anyone; the SPA never calls it).
//   - POST is rate limited per client IP (token bucket, clientLogPostBurst
//     per clientLogPostWindow, 429 beyond) so a loop cannot flush the ring.
//   - Only the URL pathname is kept (query string and fragment dropped:
//     `/search/<query>` stays, `?id=`/`#...` go) and the message is clipped
//     to clientLogMaxMessage (500) characters.

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// clientLogCapacity is the size of the ring.
const clientLogCapacity = 500

// clientLogMaxBody is the request body limit (413 above).
const clientLogMaxBody = 4 * 1024

// clientLogMaxMessage is the stored message length (L8-17).
const clientLogMaxMessage = 500

// clientLogMaxURL is the stored pathname length.
const clientLogMaxURL = 256

// clientLogPostBurst POSTs per clientLogPostWindow and per client IP; the
// bucket refills continuously (burst = bucket size).
const (
	clientLogPostBurst  = 30
	clientLogPostWindow = time.Minute
)

// clientLogEntry is one stored report.
type clientLogEntry struct {
	At      int64  `json:"at"` // unix ms, server receive time
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Stack   string `json:"stack,omitempty"`
	URL     string `json:"url,omitempty"`
	UA      string `json:"ua,omitempty"`
}

// clientLogRing is a bounded FIFO of entries.
type clientLogRing struct {
	mu    sync.Mutex
	buf   []clientLogEntry
	start int // index of the oldest entry
	n     int // stored entries
}

func newClientLogRing(capacity int) *clientLogRing {
	if capacity <= 0 {
		capacity = 1
	}
	return &clientLogRing{buf: make([]clientLogEntry, capacity)}
}

// push stores e, dropping the oldest entry when the ring is full.
func (r *clientLogRing) push(e clientLogEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	capacity := len(r.buf)
	if r.n < capacity {
		r.buf[(r.start+r.n)%capacity] = e
		r.n++
		return
	}
	r.buf[r.start] = e
	r.start = (r.start + 1) % capacity
}

// newest returns up to limit entries, newest first.
func (r *clientLogRing) newest(limit int) []clientLogEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit <= 0 || limit > r.n {
		limit = r.n
	}
	out := make([]clientLogEntry, 0, limit)
	capacity := len(r.buf)
	for i := 0; i < limit; i++ {
		out = append(out, r.buf[(r.start+r.n-1-i)%capacity])
	}
	return out
}

func (r *clientLogRing) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.n
}

var clientLog = newClientLogRing(clientLogCapacity)

// resetClientLog empties the ring and the rate limiter (tests).
func resetClientLog() {
	clientLog = newClientLogRing(clientLogCapacity)
	clientLogLimiter = newIPLimiter(clientLogPostBurst, clientLogPostWindow)
}

// ---- per-IP token bucket ----

// ipLimiter is a bounded map of token buckets keyed by client IP. A bucket
// holds `burst` tokens and refills `burst` tokens per `window`; a request
// takes one token. Full (idle) buckets are swept when the map grows past
// ipLimiterMaxKeys so an address scan cannot grow it for ever.
type ipLimiter struct {
	mu      sync.Mutex
	burst   float64
	rate    float64 // tokens per nanosecond
	buckets map[string]*ipBucket
	now     func() time.Time
}

type ipBucket struct {
	tokens float64
	last   time.Time
}

const ipLimiterMaxKeys = 4096

func newIPLimiter(burst int, window time.Duration) *ipLimiter {
	return &ipLimiter{
		burst:   float64(burst),
		rate:    float64(burst) / float64(window),
		buckets: map[string]*ipBucket{},
		now:     time.Now,
	}
}

// allow reports whether one more request from ip fits in its bucket.
func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.buckets[ip]
	if b == nil {
		if len(l.buckets) >= ipLimiterMaxKeys {
			l.sweep(now)
		}
		b = &ipBucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	} else {
		b.tokens += float64(now.Sub(b.last)) * l.rate
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweep (under lock) drops every bucket that is full again, i.e. idle for
// at least a window; if none is, the oldest half goes.
func (l *ipLimiter) sweep(now time.Time) {
	for ip, b := range l.buckets {
		if b.tokens+float64(now.Sub(b.last))*l.rate >= l.burst {
			delete(l.buckets, ip)
		}
	}
	if len(l.buckets) < ipLimiterMaxKeys {
		return
	}
	n := len(l.buckets) / 2
	for ip := range l.buckets {
		if n == 0 {
			break
		}
		delete(l.buckets, ip)
		n--
	}
}

var clientLogLimiter = newIPLimiter(clientLogPostBurst, clientLogPostWindow)

// clientLogPathname keeps the path of a reported page URL: an absolute URL
// (`https://host/search/x?y#z`) or a bare path (`/listen?id=..`) both give
// the path only; unparsable input gives "".
func clientLogPathname(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	p := u.Path
	if p == "" && u.Opaque == "" && (u.Scheme != "" || u.Host != "") {
		p = "/"
	}
	return clip(p, clientLogMaxURL)
}

type clientLogBody struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
	URL     string `json:"url"`
	UA      string `json:"ua"`
}

// ClientLogPostHandler: POST /api/v1/client-log.
func ClientLogPostHandler(c echo.Context) error {
	if !clientLogLimiter.allow(c.RealIP()) {
		c.Response().Header().Set("Retry-After", "60")
		return c.JSON(http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
	}
	raw, err := io.ReadAll(io.LimitReader(c.Request().Body, clientLogMaxBody+1))
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad body"})
	}
	if len(raw) > clientLogMaxBody {
		return c.JSON(http.StatusRequestEntityTooLarge, map[string]string{"error": "too large"})
	}
	var b clientLogBody
	if err := json.Unmarshal(raw, &b); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad json"})
	}
	b.Kind = clip(b.Kind, 32)
	b.Message = clip(b.Message, clientLogMaxMessage)
	if b.Kind == "" || b.Message == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "kind and message required"})
	}
	if harnessRequest(c.Request()) {
		return c.JSON(http.StatusOK, map[string]interface{}{"ignored": true})
	}
	ua := b.UA
	if ua == "" {
		ua = c.Request().UserAgent()
	}
	clientLog.push(clientLogEntry{
		At:      time.Now().UnixMilli(),
		Kind:    b.Kind,
		Message: b.Message,
		Stack:   clip(b.Stack, 2048),
		URL:     clientLogPathname(b.URL),
		UA:      clip(strings.TrimSpace(ua), 256),
	})
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}

// clientLogAuthorized checks `Authorization: Bearer <YTM_ADMIN_TOKEN>`
// (constant-time compare). Returns the status to answer when refused
// (404 with no token configured, 401 otherwise) or 0 when allowed.
func clientLogAuthorized(r *http.Request) int {
	want := strings.TrimSpace(os.Getenv("YTM_ADMIN_TOKEN"))
	if want == "" {
		return http.StatusNotFound
	}
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(auth) <= len(prefix) || !strings.EqualFold(auth[:len(prefix)], prefix) {
		return http.StatusUnauthorized
	}
	got := strings.TrimSpace(auth[len(prefix):])
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return http.StatusUnauthorized
	}
	return 0
}

// ClientLogGetHandler: GET /api/v1/client-log?limit=50 (1..500), newest
// first. Operator only (YTM_ADMIN_TOKEN bearer).
func ClientLogGetHandler(c echo.Context) error {
	c.Response().Header().Set("Cache-Control", "no-store")
	if status := clientLogAuthorized(c.Request()); status != 0 {
		if status == http.StatusUnauthorized {
			c.Response().Header().Set("WWW-Authenticate", `Bearer realm="client-log"`)
			return c.JSON(status, map[string]string{"error": "unauthorized"})
		}
		return c.JSON(status, map[string]string{"error": "not_found"})
	}
	n := clampLimit(c, 50, clientLogCapacity)
	return c.JSON(http.StatusOK, map[string]interface{}{
		"entries": clientLog.newest(n),
		"total":   clientLog.len(),
	})
}
