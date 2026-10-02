package api

// Same-origin audio: the SvelteKit front is served by this Go backend, and
// every audio/cover URL it receives must be RELATIVE to this origin. The bridge
// (ytm-cache) and the legacy defaults used to emit absolute URLs on
// ytify.ekaii.fr / invidious.ekaii.fr; those hosts sit behind a cookie-gated
// PoW wall without CORS, so a cross-origin fetch() from the app fails.
//
// Two pieces:
//   - RewriteAudioURL: pure function mapping known public bases to a relative
//     path (configurable via AUDIO_PUBLIC_BASES), applied to every stream/cover
//     URL returned to the front.
//   - Streaming reverse proxies (GET/HEAD) for /localf, /vp, /cover
//     (-> COMPANION_URL) and /aud/* (-> IVVP_URL), Range passthrough, no
//     buffering, no global client timeout.

import (
	"container/list"
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

// defaultAudioPublicBases is the built-in "public absolute base -> relative
// path" table. Overridable/extendable with AUDIO_PUBLIC_BASES
// ("https://host/path=/path,https://host2/other=/other").
const defaultAudioPublicBases = "https://ytify.ekaii.fr/localf=/localf," +
	"https://ytify.ekaii.fr/vp=/vp," +
	"https://ytify.ekaii.fr/cover=/cover," +
	"https://invidious.ekaii.fr/aud=/aud"

type audioBase struct {
	prefix string // absolute public base, no trailing slash
	rel    string // relative replacement, leading slash, no trailing slash
}

// parseAudioPublicBases parses the AUDIO_PUBLIC_BASES format. Malformed
// entries are skipped. Result is sorted longest-prefix-first so a more
// specific base always wins over a shorter one.
func parseAudioPublicBases(spec string) []audioBase {
	var out []audioBase
	for _, ent := range strings.Split(spec, ",") {
		ent = strings.TrimSpace(ent)
		if ent == "" {
			continue
		}
		eq := strings.LastIndex(ent, "=")
		if eq <= 0 || eq == len(ent)-1 {
			continue
		}
		prefix := strings.TrimRight(strings.TrimSpace(ent[:eq]), "/")
		rel := strings.TrimRight(strings.TrimSpace(ent[eq+1:]), "/")
		if prefix == "" || !strings.HasPrefix(rel, "/") {
			continue
		}
		if !strings.HasPrefix(prefix, "http://") && !strings.HasPrefix(prefix, "https://") {
			continue
		}
		out = append(out, audioBase{prefix: prefix, rel: rel})
	}
	sort.SliceStable(out, func(i, j int) bool { return len(out[i].prefix) > len(out[j].prefix) })
	return out
}

var (
	audioBasesMu     sync.Mutex
	audioBasesSpec   string
	audioBasesParsed []audioBase
)

// audioPublicBases returns the active base table. The env is re-read on every
// call (cheap) so tests can flip it with t.Setenv; parsing is cached per spec.
func audioPublicBases() []audioBase {
	spec := os.Getenv("AUDIO_PUBLIC_BASES")
	if strings.TrimSpace(spec) == "" {
		spec = defaultAudioPublicBases
	}
	audioBasesMu.Lock()
	defer audioBasesMu.Unlock()
	if spec != audioBasesSpec || audioBasesParsed == nil {
		audioBasesSpec = spec
		audioBasesParsed = parseAudioPublicBases(spec)
	}
	return audioBasesParsed
}

// RewriteAudioURL maps an absolute audio/cover URL on a known public base to
// the equivalent same-origin relative URL, preserving the remainder of the
// path and the query string. Unknown URLs (and already-relative ones) are
// returned unchanged. A base only matches on a path boundary: with base
// ".../localf", ".../localf?p=x" and ".../localf/x" match, ".../localfoo"
// does not.
func RewriteAudioURL(u string) string {
	if u == "" || u[0] == '/' {
		return u
	}
	for _, b := range audioPublicBases() {
		if !strings.HasPrefix(u, b.prefix) {
			continue
		}
		rest := u[len(b.prefix):]
		if rest == "" || rest[0] == '?' || rest[0] == '/' || rest[0] == '#' {
			return b.rel + rest
		}
	}
	return u
}

// ---------------------------------------------------------------------------
// Streaming reverse proxies
// ---------------------------------------------------------------------------

// audioTransport is shared by all audio proxies: no overall request timeout
// (an audio stream may last many minutes), but bounded dial + header wait so
// a dead upstream fails fast instead of hanging the player.
var audioTransport http.RoundTripper = &http.Transport{
	Proxy: nil, // upstreams are docker-internal; never go through an egress proxy
	DialContext: (&net.Dialer{
		Timeout:   15 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	ForceAttemptHTTP2:     false,
	MaxIdleConns:          64,
	MaxIdleConnsPerHost:   16,
	IdleConnTimeout:       90 * time.Second,
	ResponseHeaderTimeout: 60 * time.Second,
	DisableCompression:    true, // audio bytes must pass through untouched
}

var (
	audioProxiesMu sync.Mutex
	audioProxies   = map[string]*httputil.ReverseProxy{}
)

// coverProxyPath is the cover route; coverCacheControl is stamped on its 200s
// (K2): one week, immutable, shared caches allowed (a cover carries no profile).
const (
	coverProxyPath    = "/cover"
	coverCacheControl = "public, max-age=604800, immutable"
	// PF3-1: a lid without embedded art answers 404 and used to be asked
	// again on every view (0.5-6 s upstream each time); it may gain art when
	// the file is retagged, hence one hour only.
	coverMissCacheControl = "public, max-age=3600"
)

// PF5-7: a /cover 404 (lid without embedded art) costs the bridge a full
// audio file open every time (p50 917 ms, p90 8 s in the audit v5 journal)
// and the browser's max-age=3600 above only spares the one device that
// already paid it. The proxy now remembers each 404 lid for coverMissTTL
// and answers the next clients itself (X-Ytm-Cache: HIT, no bridge call);
// a 200 for the lid (file retagged) or InvalidateCoverMiss forgets it at
// once. Bounded LRU, so a lid enumeration cannot grow it.
const (
	coverMissTTL        = time.Hour
	coverMissMaxEntries = 4096
)

// missMemo remembers keys for a TTL, LRU-bounded.
type missMemo struct {
	mu   sync.Mutex
	ttl  time.Duration
	max  int
	now  func() time.Time
	seen map[string]*list.Element // key -> element holding *missEntry
	lru  *list.List               // front = most recently added
}

type missEntry struct {
	key   string
	until time.Time
}

func newMissMemo(max int, ttl time.Duration) *missMemo {
	return &missMemo{ttl: ttl, max: max, now: time.Now, seen: map[string]*list.Element{}, lru: list.New()}
}

// has reports whether key is memoised and not expired (an expired key is
// dropped on the way).
func (m *missMemo) has(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	el, ok := m.seen[key]
	if !ok {
		return false
	}
	if m.now().After(el.Value.(*missEntry).until) {
		m.lru.Remove(el)
		delete(m.seen, key)
		return false
	}
	return true
}

// add memoises key for the TTL (re-adding refreshes it), evicting the
// oldest keys past max.
func (m *missMemo) add(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	until := m.now().Add(m.ttl)
	if el, ok := m.seen[key]; ok {
		el.Value.(*missEntry).until = until
		m.lru.MoveToFront(el)
		return
	}
	m.seen[key] = m.lru.PushFront(&missEntry{key: key, until: until})
	for m.lru.Len() > m.max {
		last := m.lru.Back()
		m.lru.Remove(last)
		delete(m.seen, last.Value.(*missEntry).key)
	}
}

func (m *missMemo) forget(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if el, ok := m.seen[key]; ok {
		m.lru.Remove(el)
		delete(m.seen, key)
	}
}

func (m *missMemo) len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.seen)
}

var coverMisses = newMissMemo(coverMissMaxEntries, coverMissTTL)

// InvalidateCoverMiss forgets a memoised /cover 404 for lid (the track was
// retagged or replaced), so the next request asks the bridge again.
func InvalidateCoverMiss(lid string) { coverMisses.forget(lid) }

// coverMissAnswer answers a memoised /cover 404 without the bridge.
func coverMissAnswer(c echo.Context) error {
	h := c.Response().Header()
	h.Set("Cache-Control", coverMissCacheControl)
	h.Set("X-Ytm-Cache", "HIT")
	return c.NoContent(http.StatusNotFound)
}

// audioProxyFor returns a (cached) streaming reverse proxy for an upstream
// base URL such as "http://ytm-cache:8789" or "http://iv-vp:5007". The
// incoming request path is appended to the base path; query and Range are
// forwarded as-is.
func audioProxyFor(base string) (*httputil.ReverseProxy, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return nil, errors.New("audio proxy upstream not configured")
	}
	target, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	if target.Scheme == "" || target.Host == "" {
		return nil, errors.New("audio proxy upstream must be an absolute http(s) URL: " + base)
	}

	audioProxiesMu.Lock()
	defer audioProxiesMu.Unlock()
	if p, ok := audioProxies[base]; ok {
		return p, nil
	}

	basePath := strings.TrimRight(target.Path, "/")
	p := &httputil.ReverseProxy{
		Transport:     audioTransport,
		FlushInterval: -1, // flush every write: no buffering of audio bytes
		Rewrite: func(pr *httputil.ProxyRequest) {
			in := pr.In
			out := pr.Out
			out.URL.Scheme = target.Scheme
			out.URL.Host = target.Host
			out.URL.Path = basePath + in.URL.Path
			if in.URL.RawPath != "" {
				out.URL.RawPath = basePath + in.URL.RawPath
			} else {
				out.URL.RawPath = ""
			}
			out.URL.RawQuery = in.URL.RawQuery
			out.Host = target.Host
			// The app's own session cookies are meaningless (and private) for
			// the upstream audio services: never forward them.
			out.Header.Del("Cookie")
			out.Header.Del("Authorization")
			pr.SetXForwarded()
		},
		// K2: a cover is addressed by a stable lid, so a 200 can live a week in
		// the browser / SW cache (22 x ~500 ms per home load before), a 404
		// one hour (PF3-1) and, PF5-7, is memoised here so the next client
		// never reaches the bridge for it (a 200 forgets the memo). Audio
		// streams keep the upstream headers untouched (signed URLs, Range).
		ModifyResponse: func(resp *http.Response) error {
			if resp.Request != nil && resp.Request.URL.Path == basePath+coverProxyPath {
				lid := resp.Request.URL.Query().Get("lid")
				switch resp.StatusCode {
				case http.StatusOK:
					resp.Header.Set("Cache-Control", coverCacheControl)
					if lid != "" {
						coverMisses.forget(lid)
					}
				case http.StatusNotFound:
					resp.Header.Set("Cache-Control", coverMissCacheControl)
					resp.Header.Set("X-Ytm-Cache", "MISS")
					if lid != "" {
						coverMisses.add(lid)
					}
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				// client went away (seek / next track): not an error worth logging
				return
			}
			log.Printf("audioproxy: %s %s -> %s: %v", r.Method, r.URL.Path, base, err)
			status := http.StatusBadGateway
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				status = http.StatusGatewayTimeout
			}
			w.WriteHeader(status)
		},
	}
	audioProxies[base] = p
	return p, nil
}

func serveAudioProxy(c echo.Context, upstream string) error {
	p, err := audioProxyFor(upstream)
	if err != nil {
		return c.String(http.StatusServiceUnavailable, "audio proxy not configured: "+err.Error())
	}
	p.ServeHTTP(c.Response(), c.Request())
	return nil
}

// AudioCompanionProxyHandler proxies /localf, /vp and /cover (same path, same
// query, Range passthrough) to the ytm-cache bridge at COMPANION_URL.
func AudioCompanionProxyHandler(c echo.Context) error {
	if err := validateAudioProxyRequest(c.Request().URL.Path, c.Request().URL.Query()); err != nil {
		return c.String(http.StatusBadRequest, "bad request: "+err.Error())
	}
	// PF5-7: a lid known to have no art is answered here, GET and HEAD alike.
	if c.Request().URL.Path == coverProxyPath {
		if lid := c.QueryParam("lid"); lid != "" && coverMisses.has(lid) {
			return coverMissAnswer(c)
		}
	}
	return serveAudioProxy(c, os.Getenv("COMPANION_URL"))
}

// AudioIVVPProxyHandler proxies /aud/<videoId> (Range passthrough) to the
// iv-vp fallback at IVVP_URL (default http://iv-vp:5007).
func AudioIVVPProxyHandler(c echo.Context) error {
	if err := ValidateAudPath(c.Param("*")); err != nil {
		return c.String(http.StatusBadRequest, "bad request: "+err.Error())
	}
	return serveAudioProxy(c, envOr("IVVP_URL", "http://iv-vp:5007"))
}

// RegisterAudioProxyRoutes wires the same-origin audio routes (GET + HEAD).
var audioCompanionPaths = []string{"/localf", "/vp", "/cover"}

// IsAudioProxyPath reports whether p is served by the audio reverse proxies. Used by the
// SPA static middleware Skipper: the Echo IgnoreBase option strips the last URL segment
// when it equals the base of the matched route, so /localf, /vp and /cover would collapse
// to the build root and be answered with index.html instead of reaching the proxy handlers.
func IsAudioProxyPath(p string) bool {
	for _, base := range audioCompanionPaths {
		if p == base {
			return true
		}
	}
	return len(p) > 5 && p[:5] == "/aud/"
}

func RegisterAudioProxyRoutes(e *echo.Echo) {
	for _, p := range audioCompanionPaths {
		e.GET(p, AudioCompanionProxyHandler)
		e.HEAD(p, AudioCompanionProxyHandler)
	}
	e.GET("/aud/*", AudioIVVPProxyHandler)
	e.HEAD("/aud/*", AudioIVVPProxyHandler)
}
