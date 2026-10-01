package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

func TestIsPreviewRobot(t *testing.T) {
	for ua, want := range map[string]bool{
		"WhatsApp/2.23.20.0 A":             true,
		"Mozilla/5.0 (compatible; Signal)": true,
		"TelegramBot (like TwitterBot)":    true,
		"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)": true,
		"Twitterbot/1.0": true,
		"Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)": true,
		"Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)":        true,
		"LinkedInBot/1.0 (compatible; Mozilla/5.0)":                         true,
		"curl/8.5.0": false,
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36":                   false,
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1": false,
		"": false,
	} {
		if got := IsPreviewRobot(ua); got != want {
			t.Errorf("IsPreviewRobot(%q) = %v, want %v", ua, got, want)
		}
	}
}

func ogTestServer(t *testing.T) *echo.Echo {
	t.Helper()
	apiResponseCache = newResponseCache(resCacheMaxEntries)
	ot, oa, op, oto := ogResolveTrackFn, ogResolveAlbumFn, ogResolvePlaylistFn, ogResolveTimeout
	t.Cleanup(func() {
		ogResolveTrackFn, ogResolveAlbumFn, ogResolvePlaylistFn, ogResolveTimeout = ot, oa, op, oto
		apiResponseCache = newResponseCache(resCacheMaxEntries)
	})
	ogResolveTrackFn = func(id string) *ogMeta {
		switch id {
		case "0123456789a":
			return &ogMeta{Title: "One More Time", Description: "Daft Punk · music.ekaii.fr", Image: "/cover?lid=0123456789a"}
		case "slowslowslo":
			time.Sleep(time.Second)
			return &ogMeta{Title: "late"}
		case "panicpanicp":
			panic("odd upstream")
		}
		return nil
	}
	ogResolveAlbumFn = func(id string) *ogMeta {
		if id == "lb-0123456789ab" {
			return &ogMeta{Title: `Discovery <"Deluxe">`, Description: "Daft Punk · Album · music.ekaii.fr", Image: "https://lh3.googleusercontent.com/x=w544-h544"}
		}
		return nil
	}
	ogResolvePlaylistFn = func(id string) *ogMeta {
		if id == "PLabc" {
			return &ogMeta{Title: "Ma playlist", Description: "Playlist · music.ekaii.fr"}
		}
		return nil
	}
	e := echo.New()
	e.Use(OGPreview())
	e.GET("/*", func(c echo.Context) error { return c.HTML(http.StatusOK, "<html>shell</html>") })
	return e
}

func ogGet(e *echo.Echo, path, ua string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "music.example"
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestOGPreviewRobotGetsCard(t *testing.T) {
	e := ogTestServer(t)
	rec := ogGet(e, "/listen?id=0123456789a", "WhatsApp/2.23.20.0")
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, `<meta property="og:title" content="One More Time">`) {
		t.Fatalf("robot: code %d body %s", rec.Code, body)
	}
	for _, want := range []string{
		`<meta property="og:image" content="https://music.example/cover?lid=0123456789a">`,
		`<meta property="og:url" content="https://music.example/listen?id=0123456789a">`,
		`<meta name="twitter:card" content="summary_large_image">`,
		`<meta property="og:description" content="Daft Punk · music.ekaii.fr">`,
		`<a href="https://music.example/listen?id=0123456789a">`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("robot card misses %s", want)
		}
	}
	if strings.Contains(body, "_ogua") {
		t.Errorf("UA class leaked into the card: %s", body)
	}
	if rec.Header().Get("X-Ytm-Cache") != "MISS" {
		t.Errorf("first robot fetch: X-Ytm-Cache %q", rec.Header().Get("X-Ytm-Cache"))
	}
	// Another robot (other full UA, same class) is served from the cache.
	rec = ogGet(e, "/listen?id=0123456789a", "TelegramBot (like TwitterBot)")
	if rec.Header().Get("X-Ytm-Cache") != "HIT" || !strings.Contains(rec.Body.String(), "One More Time") {
		t.Errorf("second robot fetch not cached: %q", rec.Header().Get("X-Ytm-Cache"))
	}
}

func TestOGPreviewHumansKeepShell(t *testing.T) {
	e := ogTestServer(t)
	// Warm the robot cache first: humans must still get the shell.
	ogGet(e, "/listen?id=0123456789a", "Twitterbot/1.0")
	for _, ua := range []string{"", "curl/8.5.0", "Mozilla/5.0 (X11; Linux x86_64) Chrome/129.0 Safari/537.36"} {
		for _, p := range []string{"/listen?id=0123456789a", "/release?id=lb-0123456789ab", "/playlist/PLabc"} {
			rec := ogGet(e, p, ua)
			if rec.Body.String() != "<html>shell</html>" {
				t.Errorf("UA %q %s: got %s", ua, p, rec.Body.String())
			}
		}
	}
	// Non-preview paths are untouched even for robots.
	if rec := ogGet(e, "/home", "WhatsApp/2"); rec.Body.String() != "<html>shell</html>" {
		t.Errorf("robot /home: %s", rec.Body.String())
	}
}

func TestOGPreviewAlbumPlaylistAndEscaping(t *testing.T) {
	e := ogTestServer(t)
	body := ogGet(e, "/release?id=lb-0123456789ab", "Discordbot/2.0").Body.String()
	if !strings.Contains(body, `<meta property="og:title" content="Discovery &lt;&#34;Deluxe&#34;&gt;">`) ||
		!strings.Contains(body, `content="music.album"`) ||
		!strings.Contains(body, `<meta property="og:url" content="https://music.example/release?id=lb-0123456789ab">`) {
		t.Errorf("album card: %s", body)
	}
	body = ogGet(e, "/playlist/PLabc", "Slackbot-LinkExpanding 1.0").Body.String()
	if !strings.Contains(body, `<meta property="og:title" content="Ma playlist">`) ||
		!strings.Contains(body, `<meta property="og:url" content="https://music.example/playlist/PLabc">`) ||
		!strings.Contains(body, `<meta property="og:image" content="https://music.example/logo.png">`) {
		t.Errorf("playlist card: %s", body)
	}
}

func TestOGPreviewFallbacks(t *testing.T) {
	e := ogTestServer(t)
	ogResolveTimeout = 50 * time.Millisecond
	for _, p := range []string{"/listen?id=nope", "/listen", "/release?id=MPREb_unknown", "/playlist/zzz", "/listen?id=slowslowslo", "/listen?id=panicpanicp"} {
		rec := ogGet(e, p, "facebookexternalhit/1.1")
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `<meta property="og:title" content="music.ekaii.fr">`) {
			t.Errorf("%s: code %d body %s", p, rec.Code, rec.Body.String())
		}
	}
}

func TestOGBigThumb(t *testing.T) {
	if got := ogBigThumb("https://lh3.googleusercontent.com/abc=w60-h60-l90-rj"); got != "https://lh3.googleusercontent.com/abc=w544-h544-l90-rj" {
		t.Errorf("ogBigThumb = %s", got)
	}
}
