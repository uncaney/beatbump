package api

// Local library integration: Meili-backed helpers, id recipe (mirrors the Python
// indexer exactly), item builders, the "Your Library" search shelf, and local
// playback (lid). Local entities are addressed by prefixed ids so the existing
// frontend pages/links resolve: track=lid(11hex), artist=la-…, album=lb-….

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"strings"
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

func localfURL(path string) string {
	return envOr("LOCALF_BASE", "https://ytify.ekaii.fr/localf") + "?p=" + url.QueryEscape(path)
}

func coverURL(lid string) string {
	return envOr("COVER_BASE", "https://ytify.ekaii.fr/cover") + "?lid=" + lid
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
		Thumbnails: []Thumbnail{{URL: coverURL(lid), Width: 226, Height: 226}},
	}
	if dur := mint(h, "durationSec"); dur > 0 {
		item.Length = fmt.Sprintf("%d:%02d", dur/60, dur%60)
	}
	item.ArtistInfo.Artist = []Artist{{Text: artist, BrowseId: artistID(artist)}}
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
func localShelf(query string) *MusicShelf {
	if query == "" {
		return nil
	}
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": query, "limit": 12,
		"attributesToRetrieve": []string{"title", "artist", "albumArtist", "lid", "track", "durationSec"},
	})
	if len(hits) == 0 {
		return nil
	}
	shelf := &MusicShelf{}
	shelf.Header.Title = "Your Library"
	for _, h := range hits {
		if mstr(h, "lid") == "" {
			continue
		}
		shelf.Contents = append(shelf.Contents, localSongItem(h))
	}
	if len(shelf.Contents) == 0 {
		return nil
	}
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
		Thumbnails: []Thumbnail{{URL: coverURL(l)}},
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
	attrs := []string{"lid", "title", "artist", "albumArtist", "track", "durationSec"}
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
func randomLibrarySample(n int) []IListItemRenderer {
	off := rand.Intn(40000)
	hits := meiliSearchIndex("tracks", map[string]interface{}{
		"q": "", "offset": off, "limit": n, "sort": []string{"dateAdded:desc"},
		"attributesToRetrieve": []string{"lid", "title", "artist", "albumArtist", "track", "durationSec"},
	})
	out := make([]IListItemRenderer, 0, len(hits))
	for _, h := range hits {
		if mstr(h, "lid") != "" {
			out = append(out, localSongItem(h))
		}
	}
	return out
}

func LocalNext(lid string) *NextEndpointResponse {
	h := meiliByLid(lid)
	if h == nil {
		return nil
	}
	results := append([]Item{lidItem(h)}, localRadio(h, lid)...)
	return &NextEndpointResponse{Results: results, CurrentMixID: "RDAMVM" + lid}
}
