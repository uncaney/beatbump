package api

// AP3: Open Graph preview of shared links, for link-preview robots only.
// WhatsApp, Signal, Telegram, Facebook, Twitter/X, Discord, Slack and LinkedIn
// fetch a shared /listen?id=, /release?id= or /playlist/<id> URL without
// running JavaScript: the SPA shell gave them "Beatbump" and no image. Those
// user agents now get a minimal HTML page with og:title / og:description /
// og:image / og:url (+ twitter:card) and a link to the SPA URL. Browsers,
// curl and every other client keep the unchanged SPA shell.

import (
	"beatbump-server/backend/_youtube"
	"beatbump-server/backend/_youtube/api"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
)

const (
	ogSiteName      = "music.ekaii.fr"
	ogFallbackDesc  = "Écoute sur music.ekaii.fr"
	ogCacheTTL      = 10 * time.Minute
	ogUAClassParam  = "_ogua" // cache-key component: the UA class, never the full UA
	ogUAClassRobots = "robot"
)

// ogResolveTimeout bounds every metadata lookup (Meili or YouTube).
var ogResolveTimeout = 2 * time.Second

// ogRobotRe matches the link-preview fetchers. Browsers and curl never match.
var ogRobotRe = regexp.MustCompile(`(?i)(whatsapp|signal|telegrambot|facebookexternalhit|facebookcatalog|facebot|twitterbot|discordbot|slackbot|slack-imgproxy|linkedinbot)`)

// IsPreviewRobot reports whether ua is a link-preview robot.
func IsPreviewRobot(ua string) bool { return ogRobotRe.MatchString(ua) }

// ogMeta is what a preview card shows. image is absolute or root-relative.
type ogMeta struct {
	Title       string
	Description string
	Image       string
}

// ogKind classifies a preview path: "track", "album", "playlist" or "" (not previewed).
func ogKind(p string) (kind, playlistID string) {
	switch {
	case p == "/listen" || p == "/listen/" || p == "/watch" || p == "/watch/":
		return "track", ""
	case p == "/release" || p == "/release/":
		return "album", ""
	case strings.HasPrefix(p, "/playlist/"):
		id := strings.Trim(strings.TrimPrefix(p, "/playlist/"), "/")
		if id == "" || strings.Contains(id, "/") {
			return "", ""
		}
		return "playlist", id
	}
	return "", ""
}

// ogTrackID mirrors the /listen loader: id, else v, else videoId.
func ogTrackID(q url.Values) string {
	for _, k := range []string{"id", "v", "videoId"} {
		if v := q.Get(k); v != "" {
			return v
		}
	}
	return ""
}

// Resolvers (variables for tests). Each returns nil when the id is unknown.
var (
	ogResolveTrackFn    = ogResolveTrack
	ogResolveAlbumFn    = ogResolveAlbum
	ogResolvePlaylistFn = ogResolvePlaylist
)

func ogResolveTrack(id string) *ogMeta {
	if isLid(id) {
		h := meiliByLid(id)
		if h == nil || mstr(h, "title") == "" {
			return nil
		}
		return &ogMeta{Title: mstr(h, "title"), Description: ogByline(mArtist(h), mstr(h, "album")), Image: coverURL(trackCoverLid(h))}
	}
	if !ytVideoRe.MatchString(id) {
		return nil
	}
	// Same upstream call as player.json (no acquisition: that lives in the handler).
	b, err := callPlayerAPI(api.IOS_MUSIC, id, "")
	if err != nil {
		return nil
	}
	var pr _youtube.PlayerResponse
	if json.Unmarshal(b, &pr) != nil || pr.VideoDetails.Title == "" {
		return nil
	}
	img := "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"
	if th := pr.VideoDetails.Thumbnail.Thumbnails; len(th) > 0 && th[len(th)-1].URL != "" {
		img = th[len(th)-1].URL
	}
	return &ogMeta{Title: pr.VideoDetails.Title, Description: ogByline(pr.VideoDetails.Author, ""), Image: img}
}

func ogResolveAlbum(id string) *ogMeta {
	var page map[string]interface{}
	if isLocalAlbum(id) {
		p, ok := buildLocalAlbum(id)
		if !ok {
			return nil
		}
		page = p
	} else {
		if id == "" || strings.ContainsAny(id, "/?&#") {
			return nil
		}
		b, err := api.Browse(id, api.PageType_MusicPageTypeAlbum, "", nil, nil, nil, api.WebMusic)
		if err != nil {
			return nil
		}
		var ar _youtube.AlbumResponse
		if json.Unmarshal(b, &ar) != nil {
			return nil
		}
		page = parseAlbum(ar) // may panic on an odd response: recovered by ogResolve
	}
	items, _ := page["items"].(map[string]interface{})
	ri, _ := items["releaseInfo"].(map[string]interface{})
	title, _ := ri["title"].(string)
	if title == "" {
		return nil
	}
	artist := ""
	if as, ok := ri["artist"].([]map[string]interface{}); ok && len(as) > 0 {
		artist, _ = as[0]["name"].(string)
	}
	img := ""
	if th, ok := ri["thumbnails"].([]Thumbnail); ok && len(th) > 0 {
		img = ogBigThumb(th[len(th)-1].URL)
	}
	return &ogMeta{Title: title, Description: ogByline(artist, "Album"), Image: img}
}

func ogResolvePlaylist(id string) *ogMeta {
	if strings.ContainsAny(id, "/?&#") {
		return nil
	}
	r, err := GetPlaylist(normalizePlaylistBrowseID(id), "", "")
	if err != nil {
		return nil
	}
	ts, _ := r.Header["title"].([]string)
	title := strings.TrimSpace(strings.Join(ts, ""))
	if title == "" {
		return nil
	}
	sub, _ := r.Header["subtitle"].([]string)
	img := ""
	if th, ok := r.Header["thumbnails"].([]Thumbnail); ok && len(th) > 0 {
		img = ogBigThumb(th[len(th)-1].URL)
	}
	desc := strings.TrimSpace(strings.Join(sub, ""))
	if desc == "" {
		desc = "Playlist"
	}
	return &ogMeta{Title: title, Description: desc + " · " + ogSiteName, Image: img}
}

var ogThumbSizeRe = regexp.MustCompile(`=w\d+-h\d+`)

// ogBigThumb asks googleusercontent for a 544 px square (same rewrite as the SPA).
func ogBigThumb(u string) string { return ogThumbSizeRe.ReplaceAllString(u, "=w544-h544") }

func ogByline(artist, extra string) string {
	parts := []string{}
	if artist != "" {
		parts = append(parts, artist)
	}
	if extra != "" {
		parts = append(parts, extra)
	}
	parts = append(parts, ogSiteName)
	return strings.Join(parts, " · ")
}

// ogResolve runs fn under ogResolveTimeout; a panic, a timeout or an unknown id
// yields nil (the caller then renders the plain fallback card).
func ogResolve(fn func(string) *ogMeta, id string) *ogMeta {
	ch := make(chan *ogMeta, 1)
	go func() {
		defer func() {
			if recover() != nil {
				ch <- nil
			}
		}()
		ch <- fn(id)
	}()
	select {
	case m := <-ch:
		return m
	case <-time.After(ogResolveTimeout):
		return nil
	}
}

// ogAbs makes a root-relative URL absolute against the request origin.
func ogAbs(origin, u string) string {
	if u == "" || strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	if strings.HasPrefix(u, "//") {
		return "https:" + u
	}
	if !strings.HasPrefix(u, "/") {
		u = "/" + u
	}
	return origin + u
}

// ogCanonical is the SPA URL of the shared item (canonical query, no _ogua).
func ogCanonical(kind, id, playlistID string) string {
	switch kind {
	case "track":
		return "/listen?id=" + url.QueryEscape(id)
	case "album":
		return "/release?id=" + url.QueryEscape(id)
	case "playlist":
		return "/playlist/" + url.PathEscape(playlistID)
	}
	return "/"
}

var ogTypes = map[string]string{"track": "music.song", "album": "music.album", "playlist": "music.playlist"}

func ogPage(m ogMeta, kind, pageURL string) string {
	e := html.EscapeString
	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"fr\"><head><meta charset=\"utf-8\">\n")
	fmt.Fprintf(&b, "<title>%s</title>\n", e(m.Title))
	fmt.Fprintf(&b, "<meta name=\"description\" content=\"%s\">\n", e(m.Description))
	fmt.Fprintf(&b, "<link rel=\"canonical\" href=\"%s\">\n", e(pageURL))
	fmt.Fprintf(&b, "<meta property=\"og:site_name\" content=\"%s\">\n", ogSiteName)
	ogType := ogTypes[kind]
	if ogType == "" {
		ogType = "website"
	}
	fmt.Fprintf(&b, "<meta property=\"og:type\" content=\"%s\">\n", ogType)
	fmt.Fprintf(&b, "<meta property=\"og:title\" content=\"%s\">\n", e(m.Title))
	fmt.Fprintf(&b, "<meta property=\"og:description\" content=\"%s\">\n", e(m.Description))
	if m.Image != "" {
		fmt.Fprintf(&b, "<meta property=\"og:image\" content=\"%s\">\n", e(m.Image))
		fmt.Fprintf(&b, "<meta name=\"twitter:image\" content=\"%s\">\n", e(m.Image))
	}
	fmt.Fprintf(&b, "<meta property=\"og:url\" content=\"%s\">\n", e(pageURL))
	b.WriteString("<meta name=\"twitter:card\" content=\"summary_large_image\">\n")
	fmt.Fprintf(&b, "<meta name=\"twitter:title\" content=\"%s\">\n", e(m.Title))
	fmt.Fprintf(&b, "<meta name=\"twitter:description\" content=\"%s\">\n", e(m.Description))
	b.WriteString("</head><body>\n")
	fmt.Fprintf(&b, "<h1>%s</h1>\n<p>%s</p>\n", e(m.Title), e(m.Description))
	fmt.Fprintf(&b, "<p><a href=\"%s\">Ouvrir sur %s</a></p>\n", e(pageURL), ogSiteName)
	b.WriteString("</body></html>\n")
	return b.String()
}

// ogPreviewHandler renders the card for the request's preview path.
func ogPreviewHandler(c echo.Context) error {
	req := c.Request()
	kind, playlistID := ogKind(req.URL.Path)
	q := req.URL.Query()
	var id string
	var m *ogMeta
	switch kind {
	case "track":
		id = ogTrackID(q)
		if id != "" {
			m = ogResolve(ogResolveTrackFn, id)
		}
	case "album":
		id = q.Get("id")
		if id != "" {
			m = ogResolve(ogResolveAlbumFn, id)
		}
	case "playlist":
		m = ogResolve(ogResolvePlaylistFn, playlistID)
	}
	if m == nil {
		m = &ogMeta{Title: ogSiteName, Description: ogFallbackDesc}
	}
	origin := c.Scheme() + "://" + req.Host
	if m.Image == "" {
		m.Image = "/logo.png"
	}
	m.Image = ogAbs(origin, m.Image)
	pageURL := origin + ogCanonical(kind, id, playlistID)
	c.Response().Header().Set("Cache-Control", "public, max-age=600")
	c.Response().Header().Set("Vary", "User-Agent")
	return c.HTMLBlob(http.StatusOK, []byte(ogPage(*m, kind, pageURL)))
}

// OGPreview is the middleware registered before the SPA shell handlers: a
// GET/HEAD of a preview path by a link-preview robot gets the Open Graph card
// (response-cached ogCacheTTL, keyed by path + query + UA class); everything
// else falls through untouched.
func OGPreview() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		cached := CacheResponse(ogCacheTTL, ogPreviewHandler)
		return func(c echo.Context) error {
			req := c.Request()
			if req.Method != http.MethodGet && req.Method != http.MethodHead {
				return next(c)
			}
			if kind, _ := ogKind(req.URL.Path); kind == "" || !IsPreviewRobot(req.UserAgent()) {
				return next(c)
			}
			if req.Method == http.MethodHead {
				return ogPreviewHandler(c)
			}
			// The cache key is path + sorted query: add the UA class to it.
			q := req.URL.Query()
			q.Set(ogUAClassParam, ogUAClassRobots)
			req.URL.RawQuery = q.Encode()
			return cached(c)
		}
	}
}
