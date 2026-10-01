package api

// Per-profile server state: favorites, follows, playlists. Profile identity is an
// anonymous device cookie (bbp). All handlers send the same cookie back via
// credentials:'same-origin'. Items are stored with their full JSON so the UI can
// re-render them with the normal <Listing> component without re-fetching.

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

func randID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// hasProfileCookie reports whether the request carried a bbp profile cookie
// (profileID mints a fresh random id for every request without one).
func hasProfileCookie(c echo.Context) bool {
	ck, err := c.Cookie("bbp")
	return err == nil && ck.Value != ""
}

func profileID(c echo.Context) string {
	if ck, err := c.Cookie("bbp"); err == nil && ck.Value != "" {
		return ck.Value
	}
	id := randID()
	setProfileCookie(c, id)
	return id
}

func setProfileCookie(c echo.Context, id string) {
	c.SetCookie(&http.Cookie{
		Name: "bbp", Value: id, Path: "/",
		MaxAge: 60 * 60 * 24 * 3650, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
}

// ---- named profiles (lightweight login: same name = same library anywhere) ----
func MeLoginHandler(c echo.Context) error {
	var b struct {
		Name string `json:"name"`
	}
	_ = decodeBody(c, &b)
	name := strings.TrimSpace(b.Name)
	if name == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "name required"})
	}
	h := sha1.Sum([]byte(strings.ToLower(name)))
	id := "u-" + hex.EncodeToString(h[:])[:16]
	// 39A: the anonymous profile this device used so far (if any) is moved
	// onto the named one. Never from a named profile (two people), never for
	// the e2e harness (unless YTM_STATS_INCLUDE_HARNESS=1).
	from := ""
	if ck, err := c.Cookie("bbp"); err == nil {
		from = ck.Value
	}
	merge := !harnessRequest(c.Request()) && mergeableSource(from, id)
	moved, err := loginAndMerge(from, id, name, merge)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "login failed"})
	}
	setProfileCookie(c, id)
	return c.JSON(http.StatusOK, map[string]interface{}{"id": id, "name": name, "migrated": moved})
}

func MeWhoamiHandler(c echo.Context) error {
	pid := profileID(c)
	name := ""
	var p db.Profile
	if err := db.DB.Where("id = ?", pid).First(&p).Error; err == nil {
		name = p.Name
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"id": pid, "name": name})
}

func MeLogoutHandler(c echo.Context) error {
	setProfileCookie(c, randID()) // fresh anonymous profile
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
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

// ---- history item slimming (K13) ----
// A play event used to store the whole item the front sent (1-2 KB of
// YouTube tracking blobs each) and events=1&limit=200 replayed all of it.
// Same DROP_KEYS as app/src/lib/historyOutbox.ts minus musicVideoType
// (L21: ListItem.svelte passes item.musicVideoType as config.type to
// initAutoMixSession when a history row is replayed, 3 bytes), applied
// server side at write (new events) and at read (events stored before).
var historyDropKeys = []string{"loggingContext", "clickTrackingParams", "playerParams", "playlistSetVideoId", "itct", "params", "autoMixList"}

// historyMaxThumbnails: the smallest (list rows and homeRows read [0]) and
// the largest (Fullscreen.svelte reads thumbnails.at(-1): cover, blurred
// backdrop, media session). YouTube lists thumbnails in ascending size.
const historyMaxThumbnails = 2

// slimHistoryItem drops the replay-useless keys in place and keeps only the
// first and the last thumbnails (L19: keeping the two FIRST ones left a
// 120 px cover stretched over the fullscreen player when replaying from the
// history or a "Reprendre" card).
func slimHistoryItem(m map[string]interface{}) {
	for _, k := range historyDropKeys {
		delete(m, k)
	}
	if th, ok := m["thumbnails"].([]interface{}); ok && len(th) > historyMaxThumbnails {
		m["thumbnails"] = []interface{}{th[0], th[len(th)-1]}
	}
}

// slimStoredItem applies slimHistoryItem to a stored item JSON. Rows that
// cannot carry anything to drop are returned as-is without parsing.
func slimStoredItem(data string) json.RawMessage {
	needs := strings.Contains(data, `"thumbnails"`)
	for _, k := range historyDropKeys {
		if needs {
			break
		}
		needs = strings.Contains(data, `"`+k+`"`)
	}
	if !needs {
		return json.RawMessage(data)
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(data), &m); err != nil {
		return json.RawMessage(data)
	}
	slimHistoryItem(m)
	out, err := json.Marshal(m)
	if err != nil {
		return json.RawMessage(data)
	}
	return out
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
	invalidateMixCache(pid)
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
	invalidateMixCache(pid)
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
	// S1/S2: e2e harness plays (Playwright HeadlessChrome / X-Ytm-Harness: 1)
	// never enter the history unless YTM_STATS_INCLUDE_HARNESS=1.
	if harnessRequest(c.Request()) {
		return c.JSON(http.StatusOK, map[string]interface{}{"ignored": true})
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
	// O9: a play replayed from the client outbox carries its own playedAt
	// (and, I11, the client clock at send time: "clientSentAt").
	now := time.Now()
	_, clientStamped := m["playedAt"]
	playedAt := stampPlayedAt(m["playedAt"], m["clientSentAt"], now)
	delete(m, "playedAt")
	delete(m, "clientSentAt")
	slimHistoryItem(m) // K13: never store the tracking blobs
	// I10: an outbox replay (several tabs, or a lost response then a retry)
	// sends the same (ref, playedAt) again: idempotent within playDedupeWindow.
	if clientStamped && playAlreadyRecorded(pid, ref, playedAt) {
		return c.JSON(http.StatusOK, map[string]interface{}{"ok": true, "duplicate": true})
	}
	raw, _ := json.Marshal(m)
	ev := db.PlayEvent{ProfileID: pid, Ref: ref, Title: title, Artist: artist, ArtistID: artistID, Album: itemAlbum(string(raw)), Source: source, Data: string(raw), PlayedAt: playedAt}
	db.DB.Create(&ev)
	invalidateMixCache(pid)
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true})
}

// playDedupeWindow: a client-stamped play whose (profile, ref) already has an
// event this close to its playedAt is a replay, not a new play (I10).
const playDedupeWindow = 60 * time.Second

func playAlreadyRecorded(pid, ref string, playedAt time.Time) bool {
	var n int64
	db.DB.Model(&db.PlayEvent{}).
		Where("profile_id = ? AND ref = ? AND played_at > ? AND played_at < ?", pid, ref, playedAt.Add(-playDedupeWindow), playedAt.Add(playDedupeWindow)).
		Count(&n)
	return n > 0
}

// maxClientPlayAge bounds how old a client-provided playedAt may be (O9).
const maxClientPlayAge = 7 * 24 * time.Hour

// clientPlayedAt returns the client's playedAt (epoch milliseconds as a JSON
// number or numeric string, or an RFC 3339 string) when it lies within the
// last 7 days and not in the future; otherwise the server time `now`.
func clientPlayedAt(v interface{}, now time.Time) time.Time {
	t, ok := parseClientTime(v)
	if !ok || t.After(now) || now.Sub(t) > maxClientPlayAge {
		return now
	}
	return t
}

// parseClientTime reads epoch milliseconds (JSON number or numeric string)
// or an RFC 3339 string.
func parseClientTime(v interface{}) (time.Time, bool) {
	switch x := v.(type) {
	case float64:
		return time.UnixMilli(int64(x)), true
	case string:
		if ms, err := strconv.ParseInt(x, 10, 64); err == nil {
			return time.UnixMilli(ms), true
		}
		if p, err := time.Parse(time.RFC3339, x); err == nil {
			return p, true
		}
	}
	return time.Time{}, false
}

// maxClockSkew: a client clock further than this from the server clock is
// not trusted as is (I11).
const maxClockSkew = 5 * time.Minute

// stampPlayedAt decides when a posted play happened (I11).
//   - Outbox replay (clientSentAt = the client clock when it sent the
//     replay): the gap to the server clock is the client skew. Beyond
//     maxClockSkew the playedAt is moved onto the server clock (shifted by
//     the skew), then clientPlayedAt applies (older than 7 days or in the
//     future: server time).
//   - Direct POST (no clientSentAt): the play is happening now. A client
//     playedAt more than maxClockSkew away from the server clock is a wrong
//     clock (or an old client replaying without the marker): server time.
func stampPlayedAt(playedAt, clientSentAt interface{}, now time.Time) time.Time {
	t, ok := parseClientTime(playedAt)
	if !ok {
		return now
	}
	if sent, ok := parseClientTime(clientSentAt); ok {
		skew := now.Sub(sent)
		if skew > maxClockSkew || skew < -maxClockSkew {
			t = t.Add(skew)
		}
		return clientPlayedAt(float64(t.UnixMilli()), now)
	}
	if d := now.Sub(t); d > maxClockSkew || d < -maxClockSkew {
		return now
	}
	return clientPlayedAt(float64(t.UnixMilli()), now)
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
			items = append(items, slimStoredItem(r.Data))
		}
	}
	return items
}

// recently played, one row per ref, most-recent first. I18: `events=1`
// returns one row per play instead (the last `limit` plays, most recent
// first, a ref played on two days appears on both), for /library/recent's
// by-day view and "Rejouer cette journée".
func MeRecentHandler(c echo.Context) error {
	pid := profileID(c)
	n := clampLimit(c, 50, 200)
	if c.QueryParam("events") == "1" {
		return meRecentEvents(c, pid, n)
	}
	var rows []struct {
		Ref  string
		Data string
	}
	db.DB.Model(&db.PlayEvent{}).
		Select("ref, max(data) as data, max(played_at) as played_at").
		Where("profile_id = ?", pid).
		Group("ref").Order("played_at desc").Limit(n).Scan(&rows)
	items := rehydrate(rows)
	// S3: last play time of each item (epoch ms, aligned with items) so
	// /library/recent can group the history by day.
	refs := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.Data != "" {
			refs = append(refs, r.Ref)
		}
	}
	last := map[string]int64{}
	if len(refs) > 0 {
		var evs []db.PlayEvent
		db.DB.Select("ref, played_at").Where("profile_id = ? AND ref IN ?", pid, refs).Find(&evs)
		for _, e := range evs {
			if ms := e.PlayedAt.UnixMilli(); ms > last[e.Ref] {
				last[e.Ref] = ms
			}
		}
	}
	playedAt := make([]int64, len(refs))
	for i, ref := range refs {
		playedAt[i] = last[ref]
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "playedAt": playedAt})
}

// meRecentEvents: the last n plays (one row per event), items aligned with
// playedAt (epoch ms), one bounded query.
func meRecentEvents(c echo.Context, pid string, n int) error {
	var evs []db.PlayEvent
	db.DB.Select("ref, data, played_at").
		Where("profile_id = ? AND data <> ''", pid).
		Order("played_at desc").Limit(n).Find(&evs)
	items := make([]json.RawMessage, 0, len(evs))
	playedAt := make([]int64, 0, len(evs))
	for _, e := range evs {
		if e.Data == "" {
			continue
		}
		items = append(items, slimStoredItem(e.Data))
		playedAt = append(playedAt, e.PlayedAt.UnixMilli())
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"items": items, "playedAt": playedAt, "events": true})
}

// ---- me/mix per-profile cache (K4) ----
// me/mix costs up to 25 Meili calls and is requested on every home load. The
// answer only changes when the profile plays or (un)favourites something, so
// it is kept 60 s per profile id and dropped by MeRecordPlayHandler and the
// favourite handlers. Header X-Ytm-Mix-Cache: HIT|MISS|BYPASS (YTM_API_CACHE=0).
const (
	mixCacheTTL         = 60 * time.Second
	mixCacheMaxProfiles = 2000 // hard bound on memory: beyond it the map is flushed
)

type mixCacheEntry struct {
	body    []byte
	expires time.Time
}

var (
	mixCacheMu  sync.Mutex
	mixCache    = map[string]mixCacheEntry{}
	mixCacheNow = time.Now
)

func mixCacheGet(pid string) ([]byte, bool) {
	mixCacheMu.Lock()
	defer mixCacheMu.Unlock()
	e, ok := mixCache[pid]
	if !ok {
		return nil, false
	}
	if mixCacheNow().After(e.expires) {
		delete(mixCache, pid)
		return nil, false
	}
	return e.body, true
}

func mixCacheSet(pid string, body []byte) {
	mixCacheMu.Lock()
	defer mixCacheMu.Unlock()
	if len(mixCache) >= mixCacheMaxProfiles {
		mixCache = map[string]mixCacheEntry{}
	}
	mixCache[pid] = mixCacheEntry{body: body, expires: mixCacheNow().Add(mixCacheTTL)}
}

// invalidateMixCache drops the cached mix of a profile (new play, favourite
// added or removed: the seeds changed).
func invalidateMixCache(pid string) {
	mixCacheMu.Lock()
	delete(mixCache, pid)
	mixCacheMu.Unlock()
}

// MeMixHandler — "Made for you": a personalized library mix seeded by the
// profile's most-played + favorited local tracks, expanded via radioPool. Cold
// start (no history) falls back to a random library sample.
func MeMixHandler(c echo.Context) error {
	pid := profileID(c)
	if !responseCacheEnabled() {
		c.Response().Header().Set("X-Ytm-Mix-Cache", "BYPASS")
	} else if body, ok := mixCacheGet(pid); ok {
		c.Response().Header().Set("X-Ytm-Mix-Cache", "HIT")
		return c.JSONBlob(http.StatusOK, body)
	} else {
		c.Response().Header().Set("X-Ytm-Mix-Cache", "MISS")
	}
	// c40b B6-10: twice-skipped refs are neither seeds nor items; ex (all the
	// profile exclusions, incl. what was played in the last 3 h: still a
	// fine seed, not an item) keeps them out of the answer.
	now := time.Now()
	skipped := skippedRefs(pid, now)
	ex := profileExclusions(pid, now)
	seeds := []string{}
	addSeed := func(refs []string) {
		for _, r := range refs {
			if isLid(r) && !skipped[r] {
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
	nSeeds := len(uniqSeeds)
	if len(uniqSeeds) > 5 {
		uniqSeeds = uniqSeeds[:5]
	}
	// K4: each seed needs 2-4 Meili round trips (lookup + radio pool); run the
	// seeds concurrently and merge them in seed order (same result as before).
	type seedResult struct {
		hit  map[string]interface{}
		pool []map[string]interface{}
	}
	results := make([]seedResult, len(uniqSeeds))
	var wg sync.WaitGroup
	for i, lid := range uniqSeeds {
		wg.Add(1)
		go func(i int, lid string) {
			defer wg.Done()
			h := meiliByLid(lid)
			if h == nil {
				return
			}
			results[i] = seedResult{hit: h, pool: radioPool(h, lid)}
		}(i, lid)
	}
	wg.Wait()
	seen = map[string]bool{}
	// c41b B6-19: one copy per normalised (artist, title) over the whole mix
	// (seeds included), the suggested album's copy inside each pool.
	preferred := duplicatePreferred()
	seenKey := map[string]bool{}
	freshKey := func(h map[string]interface{}) bool {
		k := dupTrackKey(h)
		if k == "" {
			return true
		}
		if seenKey[k] {
			return false
		}
		seenKey[k] = true
		return true
	}
	for i, lid := range uniqSeeds {
		h := results[i].hit
		if h == nil {
			continue
		}
		if !seen[lid] && !ex[lid] && freshKey(h) {
			seen[lid] = true
			items = append(items, localSongItem(h))
		}
		added := 0
		for _, ph := range collapseDuplicates(results[i].pool, preferred) {
			l := mstr(ph, "lid")
			if l == "" || seen[l] || ex[l] || !freshKey(ph) {
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
		items = itemsWithout(randomLibrarySample(40), ex) // cold start
	}
	if len(items) > 40 {
		items = items[:40]
	}
	body, err := json.Marshal(map[string]interface{}{"items": items, "seeds": nSeeds})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "encode"})
	}
	// An empty mix (Meili down / empty library) is not worth remembering.
	if responseCacheEnabled() && len(items) > 0 {
		mixCacheSet(pid, body)
	}
	return c.JSONBlob(http.StatusOK, body)
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
