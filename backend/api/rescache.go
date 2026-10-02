package api

import (
	"bytes"
	"container/list"
	"context"
	"encoding/json"
	"log"
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
//
// CacheResponseSWR adds stale-while-revalidate (audit PF3-2): an expired entry
// is kept for a grace window and served at once with X-Ytm-Cache: STALE while
// one background refresh per key (singleflight) replaces it.

const (
	resCacheMaxEntries = 500
	resCacheMaxBody    = 2 << 20 // 2 MiB per entry: bigger bodies are served but not cached
)

type resCacheEntry struct {
	key         string
	body        []byte
	contentType string
	expires     time.Time
	staleUntil  time.Time // >= expires; the entry may be served STALE until then
	elem        *list.Element
}

type responseCache struct {
	mu      sync.Mutex
	entries map[string]*resCacheEntry
	lru     *list.List // front = most recently used
	max     int
	now     func() time.Time

	refreshing map[string]struct{} // keys with a background refresh in flight
	bg         sync.WaitGroup      // background refreshes (tests wait on it)
}

func newResponseCache(max int) *responseCache {
	return &responseCache{entries: map[string]*resCacheEntry{}, lru: list.New(), max: max, now: time.Now, refreshing: map[string]struct{}{}}
}

// get returns a fresh entry only.
func (rc *responseCache) get(key string) (*resCacheEntry, bool) {
	e, fresh, ok := rc.lookup(key)
	if !ok || !fresh {
		return nil, false
	}
	return e, true
}

// lookup returns the entry if it is fresh or still inside its grace window
// (fresh=false). Entries past the grace window are evicted.
func (rc *responseCache) lookup(key string) (e *resCacheEntry, fresh bool, ok bool) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	e, ok = rc.entries[key]
	if !ok {
		return nil, false, false
	}
	now := rc.now()
	if now.After(e.staleUntil) {
		rc.lru.Remove(e.elem)
		delete(rc.entries, key)
		return nil, false, false
	}
	rc.lru.MoveToFront(e.elem)
	return e, !now.After(e.expires), true
}

func (rc *responseCache) set(key string, body []byte, contentType string, ttl time.Duration) {
	rc.setWithGrace(key, body, contentType, ttl, 0)
}

func (rc *responseCache) setWithGrace(key string, body []byte, contentType string, ttl, grace time.Duration) {
	if len(body) > resCacheMaxBody || ttl <= 0 {
		return
	}
	if grace < 0 {
		grace = 0
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	expires := rc.now().Add(ttl)
	if e, ok := rc.entries[key]; ok {
		e.body, e.contentType, e.expires, e.staleUntil = body, contentType, expires, expires.Add(grace)
		rc.lru.MoveToFront(e.elem)
		return
	}
	e := &resCacheEntry{key: key, body: body, contentType: contentType, expires: expires, staleUntil: expires.Add(grace)}
	e.elem = rc.lru.PushFront(e)
	rc.entries[key] = e
	for rc.lru.Len() > rc.max {
		last := rc.lru.Back()
		rc.lru.Remove(last)
		delete(rc.entries, last.Value.(*resCacheEntry).key)
	}
}

// beginRefresh claims the single background refresh slot for key.
func (rc *responseCache) beginRefresh(key string) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if _, busy := rc.refreshing[key]; busy {
		return false
	}
	rc.refreshing[key] = struct{}{}
	return true
}

func (rc *responseCache) endRefresh(key string) {
	rc.mu.Lock()
	delete(rc.refreshing, key)
	rc.mu.Unlock()
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

// perProfileRelated reports whether a local/related request BUILDS from the
// caller's profile (the favorites seed) and so must never be served from
// the shared cache. exclude= and personal=1 need no bypass: both are
// exclusions, applied after the cache (relatedCacheWith). L14-3: personal=1
// used to bypass too, and the only client sending exclude= (the
// continuation, localContinuation.ts) always sends personal=1, so the L13-9
// spare pool was never read by anyone.
func perProfileRelated(c echo.Context) bool {
	return c.QueryParam("seed") == "favorites"
}

// LocalRelatedCached is the registered handler for GET /api/v1/local/related.
func LocalRelatedCached(ttl time.Duration) echo.HandlerFunc {
	return relatedCacheWith(apiResponseCache, ttl, LocalRelatedHandler)
}

// relatedAnswer is the cached base answer of local/related (see
// LocalRelatedHandler: items + spare + cap) and what the client receives
// (items only, Spare and Cap left out).
type relatedAnswer struct {
	Items []Item `json:"items"`
	Spare []Item `json:"spare,omitempty"`
	Cap   int    `json:"cap,omitempty"`
	Seed  string `json:"seed,omitempty"`
	Name  string `json:"name,omitempty"`
}

// relatedCacheWith (L13-9) serves local/related from the shared cache keyed
// WITHOUT exclude=: every continuation request of a seed (the client sends
// the queue it just played as exclude=, a different list each time) used to
// be its own cache entry, so the cache fragmented and rarely hit. Now the
// base answer (no exclude=, with its spare candidates: relatedSpareHeader)
// is cached once per seed; the request's exclusions are applied to the
// cached items after the hit and the list is refilled from the spare up to
// the cap. L14-3: the profile exclusions of personal=1 (requestExclusions:
// twice-skipped refs, plays of the last 3 h) take the same path: the inner
// request carries neither exclude= nor personal= nor the cookie, so the
// base answer is profile-free and one entry per seed serves every profile.
// When the exclusions eat past the spare (a long listening session on one
// radio), the answer is rebuilt live from the full pool (BYPASS) rather
// than served short. The favorites seed (perProfileRelated) bypasses.
//
// Headers (L14-11): only X-Ytm-Cache crosses from the inner answer to the
// client. A Set-Cookie the inner handler would put on c2 is dropped on
// purpose: the base answer is profile-free and shared by every profile, so a
// cookie minted while computing it must never be replayed to the next
// caller. No related handler sets one today (favoriteTracks(profileID) is on
// the bypass path); a handler that needs to must set it on the OUTER
// context, which this wrapper does not expose: add it here explicitly.
func relatedCacheWith(rc *responseCache, ttl time.Duration, next echo.HandlerFunc) echo.HandlerFunc {
	cached := cacheResponseUnlessWith(rc, ttl, perProfileRelated, next)
	return func(c echo.Context) error {
		if perProfileRelated(c) {
			return cached(c)
		}
		ex := requestExclusions(c)
		req := c.Request()
		u := *req.URL
		q := u.Query()
		q.Del("exclude")
		q.Del("personal")
		u.RawQuery = q.Encode()
		r2 := req.Clone(req.Context())
		r2.URL = &u
		r2.RequestURI = u.RequestURI()
		r2.Header.Del(echo.HeaderCookie) // the base answer never sees the profile
		r2.Header.Set(relatedSpareHeader, "1")
		e := c.Echo()
		if e == nil {
			e = echo.New()
		}
		bw := &bufferWriter{header: http.Header{}}
		c2 := e.NewContext(r2, bw)
		c2.SetPath(c.Path())
		if err := cached(c2); err != nil {
			return err
		}
		h := c.Response().Header()
		// Only the cache status crosses; a Set-Cookie stays in bw (see above).
		if v := bw.header.Get("X-Ytm-Cache"); v != "" {
			h.Set("X-Ytm-Cache", v)
		}
		ct := bw.header.Get(echo.HeaderContentType)
		if bw.status != http.StatusOK {
			return c.Blob(bw.status, ct, bw.buf.Bytes())
		}
		var ans relatedAnswer
		if err := json.Unmarshal(bw.buf.Bytes(), &ans); err != nil {
			return c.Blob(http.StatusOK, ct, bw.buf.Bytes())
		}
		out := applyRelatedExclusions(ans, ex)
		if relatedAnswerShort(ans, out) {
			// The exclusions ate past the spare: the full pool minus the
			// exclusions (the pre-L13-9 path) rather than a short list.
			h.Set("X-Ytm-Cache", "BYPASS")
			return next(c)
		}
		return c.JSON(http.StatusOK, out)
	}
}

// relatedAnswerShort: the base answer held a full cap of candidates but
// the exclusions left fewer than the cap. A base shorter than its cap is a
// small pool, not a short answer.
func relatedAnswerShort(base, out relatedAnswer) bool {
	cap := base.Cap
	if cap <= 0 {
		cap = len(base.Items)
	}
	return len(base.Items) >= cap && len(out.Items) < cap
}

// applyRelatedExclusions drops the excluded songs from a base answer and
// refills from its spare up to the cap (the base item count when the
// answer carries no cap); Spare and Cap are cleared for the client.
func applyRelatedExclusions(ans relatedAnswer, ex *exclusions) relatedAnswer {
	cap := ans.Cap
	if cap <= 0 {
		cap = len(ans.Items)
	}
	out := make([]Item, 0, cap)
	for _, it := range append(ans.Items, ans.Spare...) {
		if len(out) >= cap {
			break
		}
		artist := ""
		if len(it.Subtitle) > 0 {
			artist = it.Subtitle[0].Text
		}
		if ex.song(it.VideoID, it.Title, artist) {
			continue
		}
		out = append(out, it)
	}
	ans.Items, ans.Spare, ans.Cap = out, nil, 0
	return ans
}

func cacheResponseWith(rc *responseCache, ttl time.Duration, next echo.HandlerFunc) echo.HandlerFunc {
	return cacheResponseSWRWith(rc, ttl, 0, next)
}

// CacheResponseSWR is CacheResponse with stale-while-revalidate: once ttl has
// passed the entry is still served (X-Ytm-Cache: STALE) for up to grace while
// a single background refresh per key re-runs the handler.
func CacheResponseSWR(ttl, grace time.Duration, next echo.HandlerFunc) echo.HandlerFunc {
	return cacheResponseSWRWith(apiResponseCache, ttl, grace, next)
}

// swrRefreshTimeout bounds one background refresh.
const swrRefreshTimeout = 30 * time.Second

// bufferWriter is a minimal http.ResponseWriter for background refreshes.
type bufferWriter struct {
	header http.Header
	status int
	buf    bytes.Buffer
}

func (w *bufferWriter) Header() http.Header { return w.header }
func (w *bufferWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
}
func (w *bufferWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if w.buf.Len()+len(p) <= resCacheMaxBody {
		w.buf.Write(p)
	}
	return len(p), nil
}

// refreshInBackground re-runs next for the request behind c, detached from
// the client connection, and stores a 200 answer. At most one per key.
func refreshInBackground(rc *responseCache, key string, c echo.Context, ttl, grace time.Duration, next echo.HandlerFunc) {
	if !rc.beginRefresh(key) {
		return
	}
	req := c.Request()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(req.Context()), swrRefreshTimeout)
	r2 := req.Clone(ctx)
	e := c.Echo()
	if e == nil {
		e = echo.New()
	}
	path, names, values := c.Path(), append([]string(nil), c.ParamNames()...), append([]string(nil), c.ParamValues()...)
	rc.bg.Add(1)
	go func() {
		defer rc.bg.Done()
		defer rc.endRefresh(key)
		defer cancel()
		// Audit L10-1: the refresh runs outside Echo's request path, so a handler
		// panic (YouTube answering 200 without tabs, nil deref in a parser) would
		// kill the whole server instead of one request. Keep serving the stale entry.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[rescache] refresh of %s panicked: %v", key, r)
			}
		}()
		bw := &bufferWriter{header: http.Header{}}
		c2 := e.NewContext(r2, bw)
		c2.SetPath(path)
		c2.SetParamNames(names...)
		c2.SetParamValues(values...)
		if err := next(c2); err != nil || bw.status != http.StatusOK || bw.buf.Len() == 0 {
			return // keep serving the stale entry until its grace runs out
		}
		rc.setWithGrace(key, append([]byte(nil), bw.buf.Bytes()...), bw.header.Get(echo.HeaderContentType), ttl, grace)
	}()
}

func cacheResponseSWRWith(rc *responseCache, ttl, grace time.Duration, next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := c.Request()
		if !responseCacheEnabled() || req.Method != http.MethodGet {
			c.Response().Header().Set("X-Ytm-Cache", "BYPASS")
			return next(c)
		}
		key := responseCacheKey(req)
		if e, fresh, ok := rc.lookup(key); ok {
			h := c.Response().Header()
			if fresh {
				h.Set("X-Ytm-Cache", "HIT")
			} else {
				h.Set("X-Ytm-Cache", "STALE")
				refreshInBackground(rc, key, c, ttl, grace, next)
			}
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
			rc.setWithGrace(key, append([]byte(nil), cw.buf.Bytes()...), c.Response().Header().Get(echo.HeaderContentType), ttl, grace)
		}
		return err
	}
}
