package api

import (
	"bytes"
	"container/list"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// Short in-memory response cache for the read-mostly, user-independent JSON
// endpoints (home, explore, trending, artist, album, search). Every call used
// to hit YouTube upstream (home ~0.35 s, search ~0.47 s, artist ~0.4 s with
// 1 s outliers); the same page opened twice within the TTL now costs nothing.
//
// Only 200 responses are stored. Key = path + sorted query string. Entries are
// capped (LRU eviction) and bounded in size. Disabled with YTM_API_CACHE=0.
// Cached routes answer X-Ytm-Cache: HIT|MISS|BYPASS.

const (
	resCacheMaxEntries = 500
	resCacheMaxBody    = 2 << 20 // 2 MiB per entry: bigger bodies are served but not cached
)

type resCacheEntry struct {
	key         string
	body        []byte
	contentType string
	expires     time.Time
	elem        *list.Element
}

type responseCache struct {
	mu      sync.Mutex
	entries map[string]*resCacheEntry
	lru     *list.List // front = most recently used
	max     int
	now     func() time.Time
}

func newResponseCache(max int) *responseCache {
	return &responseCache{entries: map[string]*resCacheEntry{}, lru: list.New(), max: max, now: time.Now}
}

func (rc *responseCache) get(key string) (*resCacheEntry, bool) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	e, ok := rc.entries[key]
	if !ok {
		return nil, false
	}
	if rc.now().After(e.expires) {
		rc.lru.Remove(e.elem)
		delete(rc.entries, key)
		return nil, false
	}
	rc.lru.MoveToFront(e.elem)
	return e, true
}

func (rc *responseCache) set(key string, body []byte, contentType string, ttl time.Duration) {
	if len(body) > resCacheMaxBody || ttl <= 0 {
		return
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if e, ok := rc.entries[key]; ok {
		e.body, e.contentType, e.expires = body, contentType, rc.now().Add(ttl)
		rc.lru.MoveToFront(e.elem)
		return
	}
	e := &resCacheEntry{key: key, body: body, contentType: contentType, expires: rc.now().Add(ttl)}
	e.elem = rc.lru.PushFront(e)
	rc.entries[key] = e
	for rc.lru.Len() > rc.max {
		last := rc.lru.Back()
		rc.lru.Remove(last)
		delete(rc.entries, last.Value.(*resCacheEntry).key)
	}
}

func (rc *responseCache) len() int {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return len(rc.entries)
}

var apiResponseCache = newResponseCache(resCacheMaxEntries)

func responseCacheEnabled() bool {
	return os.Getenv("YTM_API_CACHE") != "0"
}

// responseCacheKey normalises the query (sorted, encoded) so param order does
// not fragment the cache.
func responseCacheKey(r *http.Request) string {
	q := r.URL.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(r.URL.Path)
	for i, k := range keys {
		if i == 0 {
			b.WriteByte('?')
		} else {
			b.WriteByte('&')
		}
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(strings.Join(vals, ","))
	}
	return b.String()
}

// cachingWriter captures the handler's response so a 200 can be stored.
type cachingWriter struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (w *cachingWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *cachingWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if w.status == http.StatusOK && w.buf.Len()+len(p) <= resCacheMaxBody {
		w.buf.Write(p)
	}
	return w.ResponseWriter.Write(p)
}

// CacheResponse wraps a GET handler with the TTL response cache.
func CacheResponse(ttl time.Duration, next echo.HandlerFunc) echo.HandlerFunc {
	return cacheResponseWith(apiResponseCache, ttl, next)
}

// CacheResponseUnless is CacheResponse with an escape hatch: when skip(c) is
// true the request goes straight to next (X-Ytm-Cache: BYPASS) and is never
// stored. Used for endpoints that are shared-cacheable except for a per-profile
// variant (audit L8-1: local/related?seed=favorites leaked one profile's radio
// to every other profile for 5 minutes).
func CacheResponseUnless(ttl time.Duration, skip func(echo.Context) bool, next echo.HandlerFunc) echo.HandlerFunc {
	return cacheResponseUnlessWith(apiResponseCache, ttl, skip, next)
}

func cacheResponseUnlessWith(rc *responseCache, ttl time.Duration, skip func(echo.Context) bool, next echo.HandlerFunc) echo.HandlerFunc {
	cached := cacheResponseWith(rc, ttl, next)
	return func(c echo.Context) error {
		if skip(c) {
			c.Response().Header().Set("X-Ytm-Cache", "BYPASS")
			return next(c)
		}
		return cached(c)
	}
}

// perProfileRelated reports whether a local/related request depends on the
// caller's profile (favorites seed) and so must never be served from the
// shared cache.
func perProfileRelated(c echo.Context) bool {
	return c.QueryParam("seed") == "favorites"
}

// LocalRelatedCached is the registered handler for GET /api/v1/local/related.
func LocalRelatedCached(ttl time.Duration) echo.HandlerFunc {
	return CacheResponseUnless(ttl, perProfileRelated, LocalRelatedHandler)
}

func cacheResponseWith(rc *responseCache, ttl time.Duration, next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := c.Request()
		if !responseCacheEnabled() || req.Method != http.MethodGet {
			c.Response().Header().Set("X-Ytm-Cache", "BYPASS")
			return next(c)
		}
		key := responseCacheKey(req)
		if e, ok := rc.get(key); ok {
			h := c.Response().Header()
			h.Set("X-Ytm-Cache", "HIT")
			if e.contentType != "" {
				h.Set(echo.HeaderContentType, e.contentType)
			}
			return c.Blob(http.StatusOK, e.contentType, e.body)
		}
		c.Response().Header().Set("X-Ytm-Cache", "MISS")
		cw := &cachingWriter{ResponseWriter: c.Response().Writer}
		c.Response().Writer = cw
		err := next(c)
		if err == nil && cw.status == http.StatusOK && cw.buf.Len() > 0 {
			rc.set(key, append([]byte(nil), cw.buf.Bytes()...), c.Response().Header().Get(echo.HeaderContentType), ttl)
		}
		return err
	}
}
