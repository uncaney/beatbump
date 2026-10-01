package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

func TestRewriteAudioURL(t *testing.T) {
	t.Setenv("AUDIO_PUBLIC_BASES", "")
	cases := []struct {
		name, in, want string
	}{
		{"localf with query", "https://ytify.ekaii.fr/localf?p=%2Fmusic%2Fa%20b.flac", "/localf?p=%2Fmusic%2Fa%20b.flac"},
		{"vp with query", "https://ytify.ekaii.fr/vp?u=https%3A%2F%2Frr1.googlevideo.com%2Fx&e=1", "/vp?u=https%3A%2F%2Frr1.googlevideo.com%2Fx&e=1"},
		{"cover with query", "https://ytify.ekaii.fr/cover?lid=0123456789a", "/cover?lid=0123456789a"},
		{"aud with path", "https://invidious.ekaii.fr/aud/dQw4w9WgXcQ", "/aud/dQw4w9WgXcQ"},
		{"aud with path and query", "https://invidious.ekaii.fr/aud/dQw4w9WgXcQ?itag=140", "/aud/dQw4w9WgXcQ?itag=140"},
		{"bare base", "https://ytify.ekaii.fr/localf", "/localf"},
		{"prefix on non-boundary is untouched", "https://ytify.ekaii.fr/localfoo?p=x", "https://ytify.ekaii.fr/localfoo?p=x"},
		{"unknown host untouched", "https://rr1---sn.googlevideo.com/videoplayback?a=1", "https://rr1---sn.googlevideo.com/videoplayback?a=1"},
		{"unknown path on known host untouched", "https://ytify.ekaii.fr/api/x", "https://ytify.ekaii.fr/api/x"},
		{"already relative untouched", "/localf?p=x", "/localf?p=x"},
		{"empty", "", ""},
		{"http scheme is not https base", "http://ytify.ekaii.fr/localf?p=x", "http://ytify.ekaii.fr/localf?p=x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RewriteAudioURL(tc.in); got != tc.want {
				t.Fatalf("RewriteAudioURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRewriteAudioURL_CustomBases(t *testing.T) {
	t.Setenv("AUDIO_PUBLIC_BASES", " https://media.example.org/files/ = /localf , http://iv.internal/aud=/aud,broken,=/x,nohttp/a=/b")
	cases := map[string]string{
		"https://media.example.org/files?p=a":   "/localf?p=a",
		"https://media.example.org/files/x?p=a": "/localf/x?p=a",
		"http://iv.internal/aud/abc":            "/aud/abc",
		// defaults are replaced, not merged, when the env is set
		"https://ytify.ekaii.fr/localf?p=a": "https://ytify.ekaii.fr/localf?p=a",
	}
	for in, want := range cases {
		if got := RewriteAudioURL(in); got != want {
			t.Errorf("RewriteAudioURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRewriteAudioURL_LongestPrefixWins(t *testing.T) {
	t.Setenv("AUDIO_PUBLIC_BASES", "https://h.example/a=/short,https://h.example/a/b=/long")
	if got := RewriteAudioURL("https://h.example/a/b/c?x=1"); got != "/long/c?x=1" {
		t.Fatalf("got %q, want /long/c?x=1", got)
	}
	if got := RewriteAudioURL("https://h.example/a/z"); got != "/short/z" {
		t.Fatalf("got %q, want /short/z", got)
	}
}

func TestLocalfAndCoverURLDefaultsAreRelative(t *testing.T) {
	t.Setenv("LOCALF_BASE", "")
	t.Setenv("COVER_BASE", "")
	t.Setenv("AUDIO_PUBLIC_BASES", "")
	if got := localfURL("/music/a b.flac"); got != "/localf?p=%2Fmusic%2Fa+b.flac" {
		t.Fatalf("localfURL = %q", got)
	}
	if got := coverURL("0123456789a"); got != "/cover?lid=0123456789a" {
		t.Fatalf("coverURL = %q", got)
	}
	// A legacy absolute LOCALF_BASE still yields a same-origin URL.
	t.Setenv("LOCALF_BASE", "https://ytify.ekaii.fr/localf")
	if got := localfURL("/x.mp3"); got != "/localf?p=%2Fx.mp3" {
		t.Fatalf("localfURL(legacy base) = %q", got)
	}
}

// fakeUpstream records the last request it saw and serves a 206 for ranged
// requests, 200 otherwise, with the headers the real bridge emits.
type fakeUpstream struct {
	lastMethod, lastPath, lastQuery, lastRange, lastCookie string
	body                                                   string
}

func (f *fakeUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.lastMethod = r.Method
	f.lastPath = r.URL.Path
	f.lastQuery = r.URL.RawQuery
	f.lastRange = r.Header.Get("Range")
	f.lastCookie = r.Header.Get("Cookie")
	h := w.Header()
	h.Set("Content-Type", "audio/mpeg")
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "private, max-age=3600")
	h.Set("Content-Disposition", `inline; filename="a.mp3"`)
	h.Set("X-Ytm-Source", "local")
	if f.lastRange == "bytes=2-5" {
		h.Set("Content-Range", "bytes 2-5/10")
		h.Set("Content-Length", "4")
		w.WriteHeader(http.StatusPartialContent)
		if r.Method != http.MethodHead {
			_, _ = w.Write([]byte(f.body[2:6]))
		}
		return
	}
	h.Set("Content-Length", "10")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(f.body))
	}
}

func newAudioTestApp(t *testing.T) *echo.Echo {
	t.Helper()
	e := echo.New()
	RegisterAudioProxyRoutes(e)
	return e
}

func TestAudioProxy_LocalfRangePassthrough(t *testing.T) {
	up := &fakeUpstream{body: "0123456789"}
	srv := httptest.NewServer(up)
	defer srv.Close()
	t.Setenv("COMPANION_URL", srv.URL+"/") // trailing slash must be tolerated

	e := newAudioTestApp(t)

	req := httptest.NewRequest(http.MethodGet, "/localf?p=%2Fmusic%2Fa%20b.mp3&x=1", nil)
	req.Header.Set("Range", "bytes=2-5")
	req.Header.Set("Cookie", "bb_session=secret")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, body=%q", rec.Code, rec.Body.String())
	}
	if up.lastMethod != http.MethodGet || up.lastPath != "/localf" || up.lastQuery != "p=%2Fmusic%2Fa%20b.mp3&x=1" {
		t.Fatalf("upstream saw %s %s?%s", up.lastMethod, up.lastPath, up.lastQuery)
	}
	if up.lastRange != "bytes=2-5" {
		t.Fatalf("Range not forwarded: %q", up.lastRange)
	}
	if up.lastCookie != "" {
		t.Fatalf("app cookie leaked upstream: %q", up.lastCookie)
	}
	for k, want := range map[string]string{
		"Content-Type":        "audio/mpeg",
		"Content-Length":      "4",
		"Content-Range":       "bytes 2-5/10",
		"Accept-Ranges":       "bytes",
		"Content-Disposition": `inline; filename="a.mp3"`,
		"Cache-Control":       "private, max-age=3600",
		"X-Ytm-Source":        "local",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("header %s = %q, want %q", k, got, want)
		}
	}
	if rec.Body.String() != "2345" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestAudioProxy_HeadAndFullGet(t *testing.T) {
	up := &fakeUpstream{body: "0123456789"}
	srv := httptest.NewServer(up)
	defer srv.Close()
	t.Setenv("COMPANION_URL", srv.URL)
	e := newAudioTestApp(t)

	for _, p := range []string{"/vp?u=https%3A%2F%2Frr1---sn-abc.googlevideo.com%2Fvideoplayback%3Fid%3D1", "/cover?lid=abc"} {
		req := httptest.NewRequest(http.MethodHead, p, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || up.lastMethod != http.MethodHead {
			t.Fatalf("HEAD %s: status=%d upstream method=%s", p, rec.Code, up.lastMethod)
		}
		if rec.Header().Get("Content-Length") != "10" || rec.Body.Len() != 0 {
			t.Fatalf("HEAD %s: CL=%q bodylen=%d", p, rec.Header().Get("Content-Length"), rec.Body.Len())
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/localf?p=x", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "0123456789" {
		t.Fatalf("GET: status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestAudioProxy_AudRoute(t *testing.T) {
	up := &fakeUpstream{body: "0123456789"}
	srv := httptest.NewServer(up)
	defer srv.Close()
	t.Setenv("IVVP_URL", srv.URL)
	e := newAudioTestApp(t)

	req := httptest.NewRequest(http.MethodGet, "/aud/dQw4w9WgXcQ?itag=140", nil)
	req.Header.Set("Range", "bytes=2-5")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "2345" {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if up.lastPath != "/aud/dQw4w9WgXcQ" || up.lastQuery != "itag=140" || up.lastRange != "bytes=2-5" {
		t.Fatalf("upstream saw %s?%s range=%q", up.lastPath, up.lastQuery, up.lastRange)
	}
}

func TestAudioProxy_Upstream404AndUnconfigured(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("nope"))
	}))
	defer srv.Close()
	t.Setenv("COMPANION_URL", srv.URL)
	e := newAudioTestApp(t)

	req := httptest.NewRequest(http.MethodGet, "/localf?p=missing", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || rec.Body.String() != "nope" {
		t.Fatalf("404 passthrough: status=%d body=%q", rec.Code, rec.Body.String())
	}

	t.Setenv("COMPANION_URL", "")
	rec = httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/localf?p=x", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured: status=%d", rec.Code)
	}
}

// TestAudioProxy_Streams proves bytes reach the client before the upstream
// has finished the response (FlushInterval -1, no buffering): the upstream
// writes a first chunk, then blocks until the test has read it.
func TestAudioProxy_Streams(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "part1")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-time.After(10 * time.Second):
		}
		_, _ = io.WriteString(w, "part2")
	}))
	defer upstream.Close()
	t.Setenv("COMPANION_URL", upstream.URL)

	app := httptest.NewServer(newAudioTestApp(t))
	defer app.Close()

	resp, err := http.Get(app.URL + "/localf?p=stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}

	first := make([]byte, 5)
	done := make(chan error, 1)
	go func() { _, err := io.ReadFull(resp.Body, first); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first chunk was not streamed before upstream completed (buffering?)")
	}
	if string(first) != "part1" {
		t.Fatalf("first chunk = %q", first)
	}
	close(release)
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(rest)) != "part2" {
		t.Fatalf("rest = %q", rest)
	}
}

func TestIsAudioProxyPath(t *testing.T) {
	yes := []string{"/localf", "/vp", "/cover", "/aud/dQw4w9WgXcQ"}
	no := []string{"/", "/localfoo", "/aud", "/aud/", "/api/v1/player.json", "/vp2"}
	for _, p := range yes {
		if !IsAudioProxyPath(p) {
			t.Errorf("expected %q to be an audio proxy path", p)
		}
	}
	for _, p := range no {
		if IsAudioProxyPath(p) {
			t.Errorf("expected %q NOT to be an audio proxy path", p)
		}
	}
}

// K2: /cover 200s carry a one-week immutable Cache-Control (a lid is stable);
// every other status / route keeps the upstream headers untouched.
func TestAudioProxy_CoverCacheControl(t *testing.T) {
	up := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, max-age=3600")
		w.Header().Set("Content-Type", "image/jpeg")
		if r.URL.Query().Get("lid") == "missing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("jpg"))
	})
	for _, base := range []string{"", "/bridge"} {
		mux := http.NewServeMux()
		mux.Handle(base+"/", up)
		srv := httptest.NewServer(mux)
		t.Setenv("COMPANION_URL", srv.URL+base)
		e := newAudioTestApp(t)
		get := func(target string) *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
			return rec
		}
		if rec := get("/cover?lid=0123456789a"); rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != coverCacheControl {
			t.Fatalf("base %q: cover 200: status %d cc %q, want 200 %q", base, rec.Code, rec.Header().Get("Cache-Control"), coverCacheControl)
		}
		if rec := get("/cover?lid=missing"); rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "private, max-age=3600" {
			t.Fatalf("base %q: cover 404: status %d cc %q, want upstream header untouched", base, rec.Code, rec.Header().Get("Cache-Control"))
		}
		if rec := get("/localf?p=%2Fa.mp3"); rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "private, max-age=3600" {
			t.Fatalf("base %q: localf: status %d cc %q, want upstream header untouched", base, rec.Code, rec.Header().Get("Cache-Control"))
		}
		srv.Close()
	}
}
