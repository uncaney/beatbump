package api

// Lyrics via lrclib.net (universal synced/plain lyrics, no auth). Works for ANY
// track — local or YouTube — since we match by title+artist(+album+duration).
// The frontend passes the current track's metadata; for a lid we can also resolve
// it from Meili.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/labstack/echo/v4"
)

type lrclibResp struct {
	TrackName    string `json:"trackName"`
	ArtistName   string `json:"artistName"`
	PlainLyrics  string `json:"plainLyrics"`
	SyncedLyrics string `json:"syncedLyrics"`
}

func httpGetInto(u string, v interface{}) int {
	resp, err := (&http.Client{Timeout: 9 * time.Second}).Get(u)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		b, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(b, v)
	} else {
		io.Copy(io.Discard, resp.Body)
	}
	return resp.StatusCode
}

func LyricsHandler(c echo.Context) error {
	title := c.QueryParam("title")
	artist := c.QueryParam("artist")
	album := c.QueryParam("album")
	dur := c.QueryParam("duration")
	// Resolve from the local index when only a lid is known.
	if title == "" {
		if vid := c.QueryParam("videoId"); isLid(vid) {
			if h := meiliByLid(vid); h != nil {
				title = mstr(h, "title")
				artist = mArtist(h)
				album = mstr(h, "album")
			}
		}
	}
	if title == "" {
		return c.JSON(http.StatusOK, map[string]interface{}{"found": false})
	}
	var r lrclibResp
	q := url.Values{"track_name": {title}, "artist_name": {artist}}
	if album != "" {
		q.Set("album_name", album)
	}
	if dur != "" {
		q.Set("duration", dur)
	}
	code := httpGetInto("https://lrclib.net/api/get?"+q.Encode(), &r)
	if code != 200 || (r.PlainLyrics == "" && r.SyncedLyrics == "") {
		var list []lrclibResp
		httpGetInto("https://lrclib.net/api/search?"+url.Values{"track_name": {title}, "artist_name": {artist}}.Encode(), &list)
		if len(list) > 0 {
			r = list[0]
		}
	}
	if r.PlainLyrics == "" && r.SyncedLyrics == "" {
		return c.JSON(http.StatusOK, map[string]interface{}{"found": false, "title": title, "artist": artist})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"found": true, "synced": r.SyncedLyrics, "plain": r.PlainLyrics,
		"trackName": r.TrackName, "artistName": r.ArtistName, "source": "lrclib",
	})
}
