package api

// Per-profile server state: favorites, follows, playlists. Profile identity is an
// anonymous device cookie (bbp). All handlers send the same cookie back via
// credentials:'same-origin'. Items are stored with their full JSON so the UI can
// re-render them with the normal <Listing> component without re-fetching.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

func randID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func profileID(c echo.Context) string {
	if ck, err := c.Cookie("bbp"); err == nil && ck.Value != "" {
		return ck.Value
	}
	id := randID()
	c.SetCookie(&http.Cookie{
		Name: "bbp", Value: id, Path: "/",
		MaxAge: 60 * 60 * 24 * 3650, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	return id
}

// itemMeta derives (kind, ref, title, artist, thumbnail) from a loose item map.
func itemMeta(m map[string]interface{}) (kind, ref, title, artist, thumb string) {
	title = mstr(m, "title")
	if th, ok := m["thumbnails"].([]interface{}); ok && len(th) > 0 {
		if t0, ok := th[0].(map[string]interface{}); ok {
			thumb = mstr(t0, "url")
		}
	}
	if ai, ok := m["artistInfo"].(map[string]interface{}); ok {
		if arr, ok := ai["artist"].([]interface{}); ok && len(arr) > 0 {
			if a0, ok := arr[0].(map[string]interface{}); ok {
				artist = mstr(a0, "text")
			}
		}
	}
	if artist == "" {
		if sub, ok := m["subtitle"].([]interface{}); ok && len(sub) > 0 {
			if s0, ok := sub[0].(map[string]interface{}); ok {
				artist = mstr(s0, "text")
			}
		}
	}
	var epType, epBrowse string
	if ep, ok := m["endpoint"].(map[string]interface{}); ok {
		epType = mstr(ep, "pageType")
		epBrowse = mstr(ep, "browseId")
	}
	typ := mstr(m, "type")
	switch {
	case strings.Contains(epType, "ARTIST") || typ == "artist":
		kind = "artist"
		ref = epBrowse
	case strings.Contains(epType, "ALBUM") || typ == "album" || typ == "albums":
		kind = "album"
		ref = epBrowse
	default:
		kind = "song"
		ref = mstr(m, "videoId")
	}
	if ref == "" {
		ref = mstr(m, "browseId")
	}
	return
}

func decodeBody(c echo.Context, v interface{}) error {
	return json.NewDecoder(c.Request().Body).Decode(v)
}

// ---- favorites ----
func MeFavoritesHandler(c echo.Context) error {
	pid := profileID(c)
	q := db.DB.Where("profile_id = ?", pid)
	if kind := c.QueryParam("kind"); kind != "" {
		q = q.Where("kind = ?", kind)
	}
	var favs []db.Favorite
	q.Order("created_at desc").Find(&favs)
	items := make([]json.RawMessage, 0, len(favs))
	for _, f := range favs {
		if f.Data != "" {
			items = append(items, json.RawMessage(f.Data))
		}
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"favorites": favs, "items": items})
}

func MeAddFavoriteHandler(c echo.Context) error {
	pid := profileID(c)
	var m map[string]interface{}
	if err := decodeBody(c, &m); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad body"})
	}
	kind, ref, title, artist, thumb := itemMeta(m)
	if ref == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no ref"})
	}
	raw, _ := json.Marshal(m)
	fav := db.Favorite{ProfileID: pid, Kind: kind, Ref: ref, Title: title, Artist: artist, Thumbnail: thumb, Data: string(raw), CreatedAt: time.Now()}
	db.DB.Where("profile_id = ? AND kind = ? AND ref = ?", pid, kind, ref).Assign(fav).FirstOrCreate(&fav)
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true, "ref": ref, "kind": kind})
}

func MeDeleteFavoriteHandler(c echo.Context) error {
	pid := profileID(c)
	ref := c.QueryParam("ref")
	if ref == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no ref"})
	}
	q := db.DB.Where("profile_id = ? AND ref = ?", pid, ref)
	if kind := c.QueryParam("kind"); kind != "" {
		q = q.Where("kind = ?", kind)
	}
	q.Delete(&db.Favorite{})
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}

// ---- follows ----
func MeFollowsHandler(c echo.Context) error {
	pid := profileID(c)
	if aid := c.QueryParam("artistId"); aid != "" {
		var n int64
		db.DB.Model(&db.Follow{}).Where("profile_id = ? AND artist_id = ?", pid, aid).Count(&n)
		return c.JSON(http.StatusOK, map[string]interface{}{"following": n > 0})
	}
	var fol []db.Follow
	db.DB.Where("profile_id = ?", pid).Order("created_at desc").Find(&fol)
	return c.JSON(http.StatusOK, map[string]interface{}{"follows": fol})
}

func MeAddFollowHandler(c echo.Context) error {
	pid := profileID(c)
	var b struct {
		ArtistID  string `json:"artistId"`
		Name      string `json:"name"`
		Thumbnail string `json:"thumbnail"`
	}
	_ = decodeBody(c, &b)
	if b.ArtistID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no artistId"})
	}
	fol := db.Follow{ProfileID: pid, ArtistID: b.ArtistID, Name: b.Name, Thumbnail: b.Thumbnail, CreatedAt: time.Now()}
	db.DB.Where("profile_id = ? AND artist_id = ?", pid, b.ArtistID).Assign(fol).FirstOrCreate(&fol)
	// Self-sustaining: following a YouTube artist starts a background discography pull.
	triggerAcquire(pid, b.ArtistID, b.Name)
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true, "following": true})
}

func MeDeleteFollowHandler(c echo.Context) error {
	pid := profileID(c)
	aid := c.QueryParam("artistId")
	if aid == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no artistId"})
	}
	db.DB.Where("profile_id = ? AND artist_id = ?", pid, aid).Delete(&db.Follow{})
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true, "following": false})
}

// ---- playlists ----
type playlistOut struct {
	db.Playlist
	Count int64 `json:"count"`
}

func MePlaylistsHandler(c echo.Context) error {
	pid := profileID(c)
	var pls []db.Playlist
	db.DB.Where("profile_id = ?", pid).Order("updated_at desc").Find(&pls)
	out := make([]playlistOut, 0, len(pls))
	for _, p := range pls {
		var n int64
		db.DB.Model(&db.PlaylistItem{}).Where("playlist_id = ?", p.ID).Count(&n)
		out = append(out, playlistOut{p, n})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"playlists": out})
}

func MeCreatePlaylistHandler(c echo.Context) error {
	pid := profileID(c)
	var b struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	_ = decodeBody(c, &b)
	if strings.TrimSpace(b.Name) == "" {
		b.Name = "New Playlist"
	}
	pl := db.Playlist{ProfileID: pid, Name: b.Name, Description: b.Description, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	db.DB.Create(&pl)
	return c.JSON(http.StatusOK, pl)
}

func ownedPlaylist(c echo.Context, pid string) (db.Playlist, bool) {
	id, _ := strconv.Atoi(c.Param("id"))
	var pl db.Playlist
	if err := db.DB.Where("id = ? AND profile_id = ?", id, pid).First(&pl).Error; err != nil {
		return pl, false
	}
	return pl, true
}

func MePlaylistHandler(c echo.Context) error {
	pid := profileID(c)
	pl, ok := ownedPlaylist(c, pid)
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
	}
	var items []db.PlaylistItem
	db.DB.Where("playlist_id = ?", pl.ID).Order("position asc").Find(&items)
	tracks := make([]json.RawMessage, 0, len(items))
	for _, it := range items {
		if it.Data != "" {
			tracks = append(tracks, json.RawMessage(it.Data))
		}
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"playlist": pl, "items": items, "tracks": tracks})
}

func MeAddPlaylistItemHandler(c echo.Context) error {
	pid := profileID(c)
	pl, ok := ownedPlaylist(c, pid)
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
	}
	var m map[string]interface{}
	if err := decodeBody(c, &m); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad body"})
	}
	_, ref, title, artist, thumb := itemMeta(m)
	raw, _ := json.Marshal(m)
	var pos int64
	db.DB.Model(&db.PlaylistItem{}).Where("playlist_id = ?", pl.ID).Count(&pos)
	it := db.PlaylistItem{PlaylistID: pl.ID, Position: int(pos), Ref: ref, Title: title, Artist: artist, Thumbnail: thumb, Data: string(raw), CreatedAt: time.Now()}
	db.DB.Create(&it)
	db.DB.Model(&db.Playlist{}).Where("id = ?", pl.ID).Update("updated_at", time.Now())
	return c.JSON(http.StatusOK, it)
}

func MeDeletePlaylistHandler(c echo.Context) error {
	pid := profileID(c)
	pl, ok := ownedPlaylist(c, pid)
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
	}
	db.DB.Where("playlist_id = ?", pl.ID).Delete(&db.PlaylistItem{})
	db.DB.Delete(&db.Playlist{}, pl.ID)
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}

// ---- play history + stats (taste foundation) ----
func MeRecordPlayHandler(c echo.Context) error {
	pid := profileID(c)
	var m map[string]interface{}
	if err := decodeBody(c, &m); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad body"})
	}
	kind, ref, title, artist, thumb := itemMeta(m)
	_ = kind
	_ = thumb
	if ref == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no ref"})
	}
	artistID := ""
	if ai, ok := m["artistInfo"].(map[string]interface{}); ok {
		if arr, ok := ai["artist"].([]interface{}); ok && len(arr) > 0 {
			if a0, ok := arr[0].(map[string]interface{}); ok {
				artistID = mstr(a0, "browseId")
			}
		}
	}
	source := "youtube"
	if isLid(ref) {
		source = "local"
	}
	raw, _ := json.Marshal(m)
	ev := db.PlayEvent{ProfileID: pid, Ref: ref, Title: title, Artist: artist, ArtistID: artistID, Source: source, Data: string(raw), PlayedAt: time.Now()}
	db.DB.Create(&ev)
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}

func clampLimit(c echo.Context, def, max int) int {
	n, _ := strconv.Atoi(c.QueryParam("limit"))
	if n <= 0 {
		n = def
	}
	if n > max {
		n = max
	}
	return n
}

func rehydrate(rows []struct {
	Ref  string
	Data string
}) []json.RawMessage {
	items := make([]json.RawMessage, 0, len(rows))
	for _, r := range rows {
		if r.Data != "" {
			items = append(items, json.RawMessage(r.Data))
		}
	}
	return items
}

// recently played, one row per ref, most-recent first
func MeRecentHandler(c echo.Context) error {
	pid := profileID(c)
	n := clampLimit(c, 50, 200)
	var rows []struct {
		Ref  string
		Data string
	}
	db.DB.Model(&db.PlayEvent{}).
		Select("ref, max(data) as data, max(played_at) as played_at").
		Where("profile_id = ?", pid).
		Group("ref").Order("played_at desc").Limit(n).Scan(&rows)
	return c.JSON(http.StatusOK, map[string]interface{}{"items": rehydrate(rows)})
}

// most played, count per ref desc
func MeTopHandler(c echo.Context) error {
	pid := profileID(c)
	n := clampLimit(c, 50, 200)
	var rows []struct {
		Ref   string
		Data  string
		Cnt   int
		Title string
	}
	db.DB.Model(&db.PlayEvent{}).
		Select("ref, max(data) as data, count(*) as cnt, max(title) as title").
		Where("profile_id = ?", pid).
		Group("ref").Order("cnt desc").Limit(n).Scan(&rows)
	items := make([]json.RawMessage, 0, len(rows))
	counts := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		if r.Data != "" {
			items = append(items, json.RawMessage(r.Data))
		}
		counts = append(counts, map[string]interface{}{"ref": r.Ref, "title": r.Title, "count": r.Cnt})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "counts": counts})
}

// MeMixHandler — "Made for you": a personalized library mix seeded by the
// profile's most-played + favorited local tracks, expanded via radioPool. Cold
// start (no history) falls back to a random library sample.
func MeMixHandler(c echo.Context) error {
	pid := profileID(c)
	seeds := []string{}
	addSeed := func(refs []string) {
		for _, r := range refs {
			if isLid(r) {
				seeds = append(seeds, r)
			}
		}
	}
	var topRows []struct{ Ref string }
	db.DB.Model(&db.PlayEvent{}).Select("ref").
		Where("profile_id = ? AND source = ?", pid, "local").
		Group("ref").Order("count(*) desc").Limit(5).Scan(&topRows)
	for _, r := range topRows {
		addSeed([]string{r.Ref})
	}
	var favRows []struct{ Ref string }
	db.DB.Model(&db.Favorite{}).Select("ref").
		Where("profile_id = ? AND kind = ?", pid, "song").
		Order("created_at desc").Limit(5).Scan(&favRows)
	for _, r := range favRows {
		addSeed([]string{r.Ref})
	}

	seen := map[string]bool{}
	items := []IListItemRenderer{}
	uniqSeeds := []string{}
	for _, s := range seeds {
		if !seen[s] {
			seen[s] = true
			uniqSeeds = append(uniqSeeds, s)
		}
	}
	seen = map[string]bool{}
	for i, lid := range uniqSeeds {
		if i >= 5 {
			break
		}
		h := meiliByLid(lid)
		if h == nil {
			continue
		}
		if !seen[lid] {
			seen[lid] = true
			items = append(items, localSongItem(h))
		}
		pool := radioPool(h, lid)
		added := 0
		for _, ph := range pool {
			l := mstr(ph, "lid")
			if l == "" || seen[l] {
				continue
			}
			seen[l] = true
			items = append(items, localSongItem(ph))
			if added++; added >= 8 {
				break
			}
		}
	}
	if len(items) == 0 {
		items = randomLibrarySample(40) // cold start
	}
	if len(items) > 40 {
		items = items[:40]
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "seeds": len(uniqSeeds)})
}

func MeDeletePlaylistItemHandler(c echo.Context) error {
	pid := profileID(c)
	pl, ok := ownedPlaylist(c, pid)
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
	}
	ref := c.QueryParam("ref")
	if ref == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no ref"})
	}
	db.DB.Where("playlist_id = ? AND ref = ?", pl.ID, ref).Delete(&db.PlaylistItem{})
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}
