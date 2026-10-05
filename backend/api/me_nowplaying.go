package api

// C2 multi-device resume: one NowPlaying row per profile holds the last C1
// resume state (slim queue + index + position) pushed by whichever device
// played last, so another device of the same profile can offer "Reprendre
// depuis <appareil>".
//
// 40A "Continuer ici": a PUT carrying `takenBy` (= its own deviceId) takes the
// playback over. While the take is live (the taker pushed or took less than
// nowPlayingTakeGuard ago), a plain PUT from any OTHER device is refused with
// 409 {"error":"taken","takenBy","deviceName"}: that device pauses and stops
// pushing until its user presses play again, which sends a PUT with its own
// `takenBy` (a take back).

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// nowPlayingMaxPayload bounds the stored resume state (slim rows only).
const nowPlayingMaxPayload = 64 * 1024

// nowPlayingMaxBody leaves room for the envelope (device id/name, position).
const nowPlayingMaxBody = nowPlayingMaxPayload + 4*1024

// nowPlayingTakeGuard: how long a take protects the row without news from
// the taker (it pushes every 15 s while playing). Past it, any device writes
// again (a take from yesterday must not pause today's listening).
const nowPlayingTakeGuard = 10 * time.Minute

type nowPlayingBody struct {
	DeviceID   string          `json:"deviceId"`
	DeviceName string          `json:"deviceName"`
	Position   float64         `json:"position"`
	Payload    json.RawMessage `json:"payload"`
	// TakenBy, when set, must equal DeviceID: this device takes the playback
	// over. TakenAt (client clock) is accepted but the server clock is stored.
	TakenBy string `json:"takenBy,omitempty"`
	TakenAt int64  `json:"takenAt,omitempty"`
}

type nowPlayingOut struct {
	DeviceID   string          `json:"deviceId"`
	DeviceName string          `json:"deviceName"`
	Position   float64         `json:"position"`
	Payload    json.RawMessage `json:"payload"`
	UpdatedAt  int64           `json:"updatedAt"`         // unix ms
	TakenBy    string          `json:"takenBy,omitempty"` // 40A
	TakenAt    int64           `json:"takenAt,omitempty"` // unix ms
	// Now is the server clock at the answer (unix ms): the client compares
	// TakenAt / UpdatedAt to it, never to its own clock (L12-9).
	Now int64 `json:"now"`
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

// errNowPlayingTaken: the row is held by another device's live take.
var errNowPlayingTaken = errors.New("taken")

// takeLive reports whether row's take still protects it from other devices.
func takeLive(row *db.NowPlaying, now time.Time) bool {
	if row == nil || row.TakenBy == nil || *row.TakenBy == "" {
		return false
	}
	last := row.UpdatedAt
	if row.TakenAt != nil && row.TakenAt.After(last) {
		last = *row.TakenAt
	}
	return now.Sub(last) < nowPlayingTakeGuard
}

// MeNowPlayingPutHandler: PUT /api/v1/me/nowplaying, upsert of the profile row.
// 413 above 64 KB, 400 on bad JSON / missing payload / takenBy for another
// device, 409 when another device took the playback over (40A),
// {"ignored":true} for harness requests (unless YTM_STATS_INCLUDE_HARNESS=1).
func MeNowPlayingPutHandler(c echo.Context) error {
	raw, err := io.ReadAll(io.LimitReader(c.Request().Body, nowPlayingMaxBody+1))
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad body"})
	}
	if len(raw) > nowPlayingMaxBody {
		return c.JSON(http.StatusRequestEntityTooLarge, map[string]string{"error": "too large"})
	}
	var b nowPlayingBody
	if err := json.Unmarshal(raw, &b); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad json"})
	}
	p := bytes.TrimSpace(b.Payload)
	if len(p) == 0 || p[0] != '{' {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "payload must be an object"})
	}
	if len(p) > nowPlayingMaxPayload {
		return c.JSON(http.StatusRequestEntityTooLarge, map[string]string{"error": "payload too large"})
	}
	if b.DeviceID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "deviceId required"})
	}
	deviceID := clip(b.DeviceID, 64)
	take := strings.TrimSpace(b.TakenBy) != ""
	if take && clip(b.TakenBy, 64) != deviceID {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "takenBy must be this deviceId"})
	}
	if b.Position < 0 || b.Position != b.Position {
		b.Position = 0
	}
	if harnessRequest(c.Request()) {
		return c.JSON(http.StatusOK, map[string]interface{}{"ignored": true})
	}
	pid := profileID(c)
	now := time.Now()
	row := db.NowPlaying{
		ProfileID:  pid,
		DeviceID:   deviceID,
		DeviceName: clip(b.DeviceName, 64),
		Payload:    string(p),
		Position:   b.Position,
		UpdatedAt:  now,
	}
	var holder db.NowPlaying
	err = db.DB.Transaction(func(tx *gorm.DB) error {
		var cur db.NowPlaying
		if err := tx.Where("profile_id = ?", pid).Limit(1).Find(&cur).Error; err != nil {
			return err
		}
		switch {
		case take:
			row.TakenBy, row.TakenAt = &deviceID, &now
		case cur.ProfileID != "" && takeLive(&cur, now) && *cur.TakenBy != deviceID:
			holder = cur
			return errNowPlayingTaken
		case cur.ProfileID != "" && takeLive(&cur, now):
			// The taker's own pushes keep its take.
			row.TakenBy, row.TakenAt = cur.TakenBy, cur.TakenAt
		}
		return tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&row).Error
	})
	if errors.Is(err, errNowPlayingTaken) {
		var at int64
		if holder.TakenAt != nil {
			at = holder.TakenAt.UnixMilli()
		}
		return c.JSON(http.StatusConflict, map[string]interface{}{
			"error":      "taken",
			"takenBy":    *holder.TakenBy,
			"deviceName": holder.DeviceName,
			"takenAt":    at,
			"now":        now.UnixMilli(),
		})
	}
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "store failed"})
	}
	out := map[string]interface{}{"ok": true, "updatedAt": row.UpdatedAt.UnixMilli()}
	if row.TakenBy != nil {
		out["takenBy"] = *row.TakenBy
		out["takenAt"] = row.TakenAt.UnixMilli()
	}
	return c.JSON(http.StatusOK, out)
}

// MeNowPlayingGetHandler: GET /api/v1/me/nowplaying, 204 No Content when the
// profile has no resume state yet. A fresh profile asks on every load: a 404
// there printed a red "Failed to load resource" line in the browser console of
// every new user although nothing was wrong (getNowPlaying reads both as null).
func MeNowPlayingGetHandler(c echo.Context) error {
	pid := profileID(c)
	var row db.NowPlaying
	if err := db.DB.Where("profile_id = ?", pid).First(&row).Error; err != nil {
		return c.NoContent(http.StatusNoContent)
	}
	out := nowPlayingOut{
		DeviceID:   row.DeviceID,
		DeviceName: row.DeviceName,
		Position:   row.Position,
		Payload:    json.RawMessage(row.Payload),
		UpdatedAt:  row.UpdatedAt.UnixMilli(),
		Now:        time.Now().UnixMilli(),
	}
	if row.TakenBy != nil && *row.TakenBy != "" {
		out.TakenBy = *row.TakenBy
		if row.TakenAt != nil {
			out.TakenAt = row.TakenAt.UnixMilli()
		}
	}
	return c.JSON(http.StatusOK, out)
}
