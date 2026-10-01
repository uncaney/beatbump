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

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// clientLogCapacity is the size of the ring.
const clientLogCapacity = 500

// clientLogMaxBody is the request body limit (413 above).
const clientLogMaxBody = 4 * 1024

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

// resetClientLog empties the ring (tests).
func resetClientLog() { clientLog = newClientLogRing(clientLogCapacity) }

type clientLogBody struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
	URL     string `json:"url"`
	UA      string `json:"ua"`
}

// ClientLogPostHandler: POST /api/v1/client-log.
func ClientLogPostHandler(c echo.Context) error {
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
	b.Message = clip(b.Message, 1024)
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
		URL:     clip(b.URL, 512),
		UA:      clip(strings.TrimSpace(ua), 256),
	})
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}

// ClientLogGetHandler: GET /api/v1/client-log?limit=50 (1..500), newest first.
func ClientLogGetHandler(c echo.Context) error {
	n := clampLimit(c, 50, clientLogCapacity)
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.JSON(http.StatusOK, map[string]interface{}{
		"entries": clientLog.newest(n),
		"total":   clientLog.len(),
	})
}
