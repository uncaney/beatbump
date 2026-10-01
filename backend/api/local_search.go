package api

// Local library integration: Meili-backed helpers, id recipe (mirrors the Python
// indexer exactly), item builders, the "Your Library" search shelf, and local
// playback (lid). Local entities are addressed by prefixed ids so the existing
// frontend pages/links resolve: track=lid(11hex), artist=la-…, album=lb-….

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ---- id recipe (MUST match indexer: norm = lowercase + collapse whitespace) ----
func normName(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }

func artistID(name string) string {
	h := sha1.Sum([]byte(normName(name)))
	return "la-" + hex.EncodeToString(h[:])[:12]
}

func albumID(albumArtist, album string) string {
	h := sha1.Sum([]byte(normName(albumArtist) + "\x00" + normName(album)))
	return "lb-" + hex.EncodeToString(h[:])[:12]
}

// localAlbumRef is the album browseId carried by local song items:
// "<albumID>.<base64url(albumArtist\x00album)>". The prefix is the canonical
// lb- id (what the albums index + offline grouping use); the suffix lets
// buildLocalAlbum rebuild the page from the tracks index when the indexer never
// emitted an album doc for that (albumArtist, album) pair (yubal ytm/ paths,
// singles) -- a bare sha1 cannot be reversed to the key (F2). base64url + "."
// keep the id URL-safe without encoding (Listing/release pass it raw).
func localAlbumRef(albumArtist, album string) string {
	hint := base64.RawURLEncoding.EncodeToString([]byte(albumArtist + "\x00" + album))
	return albumID(albumArtist, album) + "." + hint
}

// parseLocalAlbumRef splits a browseId into its canonical lb- id and the
// (albumArtist, album) hint when present; bare "lb-…" ids return empty hints.
func parseLocalAlbumRef(ref string) (id, albumArtist, album string) {
	id = ref
	i := strings.IndexByte(ref, '.')
	if i < 0 {
		return id, "", ""
	}
	id = ref[:i]
	raw, err := base64.RawURLEncoding.DecodeString(ref[i+1:])
	if err != nil {
		return id, "", ""
	}
	parts := strings.SplitN(string(raw), "\x00", 2)
	if len(parts) != 2 {
		return id, "", ""
	}
	return id, parts[0], parts[1]
}

func isLid(s string) bool {
	if len(s) != 11 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func isLocalArtist(s string) bool { return len(s) >= 3 && s[:3] == "la-" }
func isLocalAlbum(s string) bool  { return len(s) >= 3 && s[:3] == "lb-" }

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// localfURL / coverURL emit SAME-ORIGIN relative URLs by default (/localf,
// /cover), reverse-proxied by this backend to the ytm-cache bridge (see
// audioproxy.go). A legacy absolute LOCALF_BASE/COVER_BASE on a known public
// host is rewritten to relative as well.
func localfURL(path string) string {
	return RewriteAudioURL(envOr("LOCALF_BASE", "/localf") + "?p=" + url.QueryEscape(path))
}

func coverURL(lid string) string {
	return RewriteAudioURL(envOr("COVER_BASE", "/cover") + "?lid=" + lid)
}

func escapeMeili(s string) string {
	return strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(s)
}

// ---- meili helpers ----
func meiliReq(method, path string, body interface{}) (map[string]interface{}, error) {
	mu := os.Getenv("MEILI_URL")
	if mu == "" {
		return nil, fmt.Errorf("no meili url")
	}
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader([]byte{})
	}
	req, err := http.NewRequest(method, mu+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if k := os.Getenv("MEILI_KEY"); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	resp, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("meili %d", resp.StatusCode)
	}
	var out map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&out)
	return out, nil
}

func meiliSearchIndex(index string, payload map[string]interface{}) []map[string]interface{} {
	out, err := meiliReq("POST", "/indexes/"+index+"/search", payload)
	if err != nil || out == nil {
		return nil
	}
	raw, _ := out["hits"].([]interface{})
	res := make([]map[string]interface{}, 0, len(raw))
	for _, h := range raw {
		if m, ok := h.(map[string]interface{}); ok {
			res = append(res, m)
		}
	}
	return res
}

func meiliGetDoc(index, id string) map[string]interface{} {
	out, err := meiliReq("GET", "/indexes/"+index+"/documents/"+id, nil)
	if err != nil {
		return nil
	}
	return out
}

func meiliByLid(lid string) map[string]interface{} {
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": "", "filter": "lid = \"" + lid + "\"", "limit": 1,
		"attributesToRetrieve": []string{"title", "artist", "albumArtist", "album", "genre", "path", "durationSec", "lid", "track"},
	})
	if len(hits) == 0 {
		return nil
	}
	return hits[0]
}

func mstr(m map[string]interface{}, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

func mint(m map[string]interface{}, k string) int {
	if v, ok := m[k].(float64); ok {
		return int(v)
	}
	return 0
}

func mArtist(m map[string]interface{}) string {
	if a := mstr(m, "artist"); a != "" {
		return a
	}
	return mstr(m, "albumArtist")
}

// ---- item builders ----
// localSongItem builds a song item for a track hit. The thumbnail follows the
// album-cover rule (trackCoverLid, local_covers.go): the album's coverLid when
// known, else the track's own lid. Batch callers should go through
// localSongItemsWithCovers (one albums query per list); on its own this costs
// at most one memoised document GET per distinct album.
func localSongItem(h map[string]interface{}) IListItemRenderer {
	lid := mstr(h, "lid")
	artist := mArtist(h)
	vid := lid
	item := IListItemRenderer{
		Title:      mstr(h, "title"),
		Subtitle:   []Artist{{Text: artist, BrowseId: artistID(artist), PageType: "MUSIC_PAGE_TYPE_ARTIST"}},
		VideoId:    &vid,
		Type:       "song",
		Index:      mint(h, "track"),
		Thumbnails: []Thumbnail{{URL: coverURL(trackCoverLid(h)), Width: 226, Height: 226}},
	}
	if dur := mint(h, "durationSec"); dur > 0 {
		item.Length = fmt.Sprintf("%d:%02d", dur/60, dur%60)
	}
	item.ArtistInfo.Artist = []Artist{{Text: artist, BrowseId: artistID(artist)}}
	// Album metadata so the offline page can group local tracks by album (lane A3):
	// the Meili doc carries album + albumArtist; browseId matches localAlbumItem (lb-...).
	if album := mstr(h, "album"); album != "" {
		aa := mstr(h, "albumArtist")
		if aa == "" {
			aa = artist
		}
		item.Album = &Artist{Text: album, BrowseId: localAlbumRef(aa, album), PageType: "MUSIC_PAGE_TYPE_ALBUM"}
	}
	return item
}

func localAlbumItem(a map[string]interface{}) IListItemRenderer {
	lb := mstr(a, "id")
	aa := mstr(a, "albumArtist")
	return IListItemRenderer{
		Title:      mstr(a, "album"),
		Subtitle:   []Artist{{Text: aa, BrowseId: artistID(aa), PageType: "MUSIC_PAGE_TYPE_ARTIST"}},
		Endpoint:   &Endpoint{BrowseId: lb, PageType: "MUSIC_PAGE_TYPE_ALBUM"},
		BrowseId:   lb,
		Type:       "album",
		Thumbnails: []Thumbnail{{URL: coverURL(mstr(a, "coverLid")), Width: 226, Height: 226}},
	}
}

// ---- "Your Library" search shelf ----
// localShelf builds the owned-library shelf for a search. It follows the search
// filter so the shelf never shows song hits under an Albums / Artists filter
// (audit-features-v2 F1):
//
//	"" / all / songs      -> track hits (localSongItem, playable lids)
//	albums                -> albums-index hits (localAlbumItem, lb- ids -> /release?id=lb-…)
//	artists               -> artists-index hits (localArtistItem, la- ids -> /artist/la-…)
//	anything else         -> no local shelf (playlists, videos: the library has none)
func localShelf(query, filter string) *MusicShelf {
	if query == "" {
		return nil
	}
	var contents []IListItemRenderer
	switch filter {
	case "", "all", "songs":
		hits := meiliSearchIndex("tracks", map[string]interface{}{
			"q": query, "limit": 12,
			"attributesToRetrieve": []string{"title", "artist", "albumArtist", "lid", "track", "durationSec", "album"},
		})
		contents = append(contents, localSongItemsWithCovers(hits)...)
	case "albums":
		hits := meiliSearchIndex("albums", map[string]interface{}{
			"q": query, "limit": 12,
			"attributesToRetrieve": []string{"id", "album", "albumArtist", "year", "coverLid"},
		})
		for _, a := range hits {
			if !isLocalAlbum(mstr(a, "id")) {
				continue
			}
			contents = append(contents, localAlbumItem(a))
		}
	case "artists":
		hits := meiliSearchIndex("artists", map[string]interface{}{
			"q": query, "limit": 12,
			"attributesToRetrieve": []string{"id", "name"},
		})
		covers := artistCovers(hits)
		for _, a := range hits {
			id := mstr(a, "id")
			if !isLocalArtist(id) {
				continue
			}
			contents = append(contents, localArtistItem(a, covers[id]))
		}
	default:
		return nil
	}
	if len(contents) == 0 {
		return nil
	}
	shelf := &MusicShelf{}
	shelf.Header.Title = "Your Library"
	shelf.Local = true
	shelf.Contents = contents
	return shelf
}

// ---- local playback (lid) ----
func LocalPlayer(lid string) map[string]interface{} {
	h := meiliByLid(lid)
	if h == nil {
		return nil
	}
	dur := mint(h, "durationSec")
	return map[string]interface{}{
		"playabilityStatus": map[string]interface{}{"status": "OK"},
		"videoDetails": map[string]interface{}{
			"videoId": lid, "title": mstr(h, "title"), "author": mArtist(h),
			"lengthSeconds": fmt.Sprintf("%d", dur), "musicVideoType": "MUSIC_VIDEO_TYPE_ATV",
		},
		"streamingData": map[string]interface{}{
			"expiresInSeconds": "21600", "formats": []interface{}{},
			"adaptiveFormats": []map[string]interface{}{{
				"itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 128000,
				"url": localfURL(mstr(h, "path")), "audioQuality": "AUDIO_QUALITY_MEDIUM",
				"audioSampleRate": "44100", "audioChannels": 2,
				"approxDurationMs": fmt.Sprintf("%d", dur*1000),
			}},
		},
	}
}

// lidItem builds a queue Item for a local track hit (must carry lid+title+artist).
func lidItem(h map[string]interface{}) Item {
	l := mstr(h, "lid")
	dur := mint(h, "durationSec")
	artist := mArtist(h)
	item := Item{
		Title: mstr(h, "title"), VideoID: l,
		Subtitle:   []Artist{{Text: artist, BrowseId: artistID(artist)}},
		Thumbnails: []Thumbnail{{URL: coverURL(trackCoverLid(h))}},
		Length:     fmt.Sprintf("%d:%02d", dur/60, dur%60),
	}
	item.ArtistInfo.Artist = []Artist{{Text: artist, BrowseId: artistID(artist)}}
	return item
}

// localRadio builds an endless-feeling recommendation queue for a local seed track
// entirely from the owned library: same-artist tracks + same-genre tracks, shuffled,
// deduped, capped. (Radio-by-default for tracks that may not exist on YouTube at all.)
// radioPool gathers candidate library tracks related to a seed (same artist +
// same genre, padded with a random library window). Shared by radio-by-default
// (LocalNext) and the personalized "Made for you" mix.
func radioPool(seed map[string]interface{}, seedLid string) []map[string]interface{} {
	artist := mArtist(seed)
	genre := mstr(seed, "genre")
	pool := []map[string]interface{}{}
	attrs := []string{"lid", "title", "artist", "albumArtist", "track", "durationSec", "album"}
	if artist != "" {
		pool = append(pool, meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "filter": "albumArtist = \"" + escapeMeili(artist) + "\" AND lid != \"" + seedLid + "\"",
			"limit": 50, "attributesToRetrieve": attrs,
		})...)
	}
	if genre != "" {
		pool = append(pool, meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "filter": "genre = \"" + escapeMeili(genre) + "\"",
			"limit": 80, "attributesToRetrieve": attrs,
		})...)
	}
	// Fallback so the mix/radio is always substantial even for an obscure seed
	// (lone artist + no genre): pad with a random window of the owned library.
	if len(pool) < 20 {
		off := 0
		if rand.Intn(2) == 1 {
			off = rand.Intn(40000)
		}
		pool = append(pool, meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "offset": off, "limit": 60, "sort": []string{"dateAdded:desc"},
			"attributesToRetrieve": attrs,
		})...)
	}
	// Prime the album-cover memo for the whole pool in one query, so the
	// per-item builders downstream (lidItem in localRadio, localSongItem in
	// me/mix) never fall back to one document GET per album.
	albumCovers(pool)
	return pool
}

func localRadio(seed map[string]interface{}, seedLid string) []Item {
	pool := radioPool(seed, seedLid)
	rand.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	seen := map[string]bool{seedLid: true}
	out := make([]Item, 0, 24)
	for _, h := range pool {
		l := mstr(h, "lid")
		if l == "" || seen[l] {
			continue
		}
		seen[l] = true
		out = append(out, lidItem(h))
		if len(out) >= 24 {
			break
		}
	}
	return out
}

// randomLibrarySample returns localSongItems from a random library window
// (cold-start fallback for the mix when there's no listening history yet).
// randomLibrarySample returns n tracks spread over many albums: the index is sorted
// by dateAdded, so one contiguous window of 40 tracks covered 3 or 4 albums and the
// "Pour toi" row (one card per album) ended up with 3 cards (audit UX v5 regression 1).
// We read small windows at `sampleWindows` random offsets instead.
func randomLibrarySample(n int) []IListItemRenderer {
	const perWindow = 4
	windows := n / perWindow
	if windows < 1 {
		windows = 1
	}
	seen := map[string]bool{}
	var hits []map[string]interface{}
	for w := 0; w < windows && len(hits) < n; w++ {
		off := rand.Intn(40000)
		page := meiliSearchIndex("tracks", map[string]interface{}{
			"q": "", "offset": off, "limit": perWindow, "sort": []string{"dateAdded:desc"},
			"attributesToRetrieve": []string{"lid", "title", "artist", "albumArtist", "track", "durationSec", "album"},
		})
		for _, h := range page {
			lid := mstr(h, "lid")
			if lid == "" || seen[lid] {
				continue
			}
			seen[lid] = true
			hits = append(hits, h)
		}
	}
	return localSongItemsWithCovers(hits)
}

// ---- resolve a local track to its YouTube videoId (for a RELEVANT radio) ----
// Only 8/54k tracks store a videoId, so we search YT Music by "artist title" at
// play time and cache the result. Lets LocalNext seed the real YT radio.
var lidYTCache sync.Map

func searchYTSong(q string) string {
	res := selfGet("/api/v1/search.json?q=" + url.QueryEscape(q) + "&filter=songs")
	var vids []string
	collectKey(res, "videoId", &vids)
	for _, v := range vids {
		if ytVideoRe.MatchString(v) && !isLid(v) {
			return v
		}
	}
	return ""
}

func resolveLidToYT(lid string) string {
	if v, ok := lidYTCache.Load(lid); ok {
		return v.(string)
	}
	y := ""
	if h := meiliByLid(lid); h != nil {
		if vid := mstr(h, "videoId"); ytVideoRe.MatchString(vid) && !isLid(vid) {
			y = vid
		} else {
			y = searchYTSong(strings.TrimSpace(mArtist(h) + " " + mstr(h, "title")))
		}
	}
	lidYTCache.Store(lid, y)
	return y
}

// localSeedItem builds the owned-copy queue item for a lid (plays from /localf).
func localSeedItem(lid string) Item {
	if h := meiliByLid(lid); h != nil {
		return lidItem(h)
	}
	return Item{Title: lid, VideoID: lid}
}

func LocalNext(lid string) *NextEndpointResponse {
	h := meiliByLid(lid)
	if h == nil {
		return nil
	}
	results := append([]Item{lidItem(h)}, localRadio(h, lid)...)
	return &NextEndpointResponse{Results: results, CurrentMixID: "RDAMVM" + lid}
}

// ---------------------------------------------------------------------------
// content-level owned check -- a Go port of the ytm-cache bridge's title_match
// (bridge.py). videoId is present on <1% of the ~55k library docs, so the
// videoId-only owned check was a near no-op; this matches by normalized title
// equality + artist confirmation so already-owned tracks/albums aren't
// re-downloaded. Kept intentionally in lock-step with bridge.norm/title_match.
// ---------------------------------------------------------------------------

var acStopRe = regexp.MustCompile(`(?i)\b(official|video|audio|lyrics?|music|hd|4k|mv|visualizer|remaster(ed)?|explicit|topic|vevo)\b`)
var acFeatRe = regexp.MustCompile(`(?i)\b(feat|ft)\.?\b.*`)
var acNonAlnumRe = regexp.MustCompile(`[^a-z0-9]+`)

// acNorm mirrors bridge.norm: lowercase, drop "feat.<...>", strip YouTube noise
// words (but KEEP version words like remix/live so we never match the wrong cut).
func acNorm(s string) string {
	s = strings.ToLower(s)
	s = acFeatRe.ReplaceAllString(s, " ")
	s = acStopRe.ReplaceAllString(s, " ")
	s = acNonAlnumRe.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}

func acCollapse(s string) string { return strings.ReplaceAll(acNorm(s), " ", "") }

func acTokens(s string) map[string]bool {
	m := map[string]bool{}
	for _, t := range strings.Fields(s) {
		m[t] = true
	}
	return m
}

func acSetEqual(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

// acTitleMatch mirrors bridge.title_match: remove the library track's artist
// tokens from the play title (handles "Artist - Title" prefixes), require the
// remaining title tokens to EQUAL the library title tokens (version-safe), and
// confirm the artist via collapsed-substring (so "MarkRonsonVEVO" still matches).
func acTitleMatch(playTitle, playAuthor string, hit map[string]interface{}) bool {
	libTitle := acTokens(acNorm(mstr(hit, "title")))
	if len(libTitle) == 0 {
		return false
	}
	libArtistTokens := acTokens(acNorm(mstr(hit, "artist")) + " " + acNorm(mstr(hit, "albumArtist")))
	core := map[string]bool{}
	for t := range acTokens(acNorm(playTitle)) {
		if !libArtistTokens[t] {
			core[t] = true
		}
	}
	if !acSetEqual(core, libTitle) {
		return false
	}
	la := acCollapse(mstr(hit, "artist"))
	if la == "" {
		la = acCollapse(mstr(hit, "albumArtist"))
	}
	cand := acCollapse(playAuthor) + acCollapse(playTitle)
	return la != "" && strings.Contains(cand, la)
}

// meiliOwnsTitleArtist reports whether the owned library already holds a
// content-equal copy of (title, artist) -- the same strong match ytm-cache uses
// to serve locally.
func meiliOwnsTitleArtist(title, artist string) bool {
	if strings.TrimSpace(title) == "" {
		return false
	}
	q := strings.TrimSpace(title + " " + artist)
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": q, "limit": 12,
		"attributesToRetrieve": []string{"title", "artist", "albumArtist"},
	})
	for _, h := range hits {
		if acTitleMatch(title, artist, h) {
			return true
		}
	}
	return false
}

// meiliOwnsTrack combines the (rare) videoId check with the content-level check.
func meiliOwnsTrack(videoId, title, artist string) bool {
	if videoId != "" && meiliOwnsVideo(videoId) {
		return true
	}
	return meiliOwnsTitleArtist(title, artist)
}

// itemArtist pulls a best-effort artist string off a queue Item.
func itemArtist(it Item) string {
	if len(it.ArtistInfo.Artist) > 0 && it.ArtistInfo.Artist[0].Text != "" {
		return it.ArtistInfo.Artist[0].Text
	}
	if len(it.Subtitle) > 0 {
		return it.Subtitle[0].Text
	}
	return ""
}
