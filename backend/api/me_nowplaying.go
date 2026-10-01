package api

// C2 multi-device resume: one NowPlaying row per profile holds the last C1
// resume state (slim queue + index + position) pushed by whichever device
// played last, so another device of the same profile can offer "Reprendre
// depuis <appareil>".

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm/clause"
)

// nowPlayingMaxPayload bounds the stored resume state (slim rows only).
const nowPlayingMaxPayload = 64 * 1024

// nowPlayingMaxBody leaves room for the envelope (device id/name, position).
const nowPlayingMaxBody = nowPlayingMaxPayload + 4*1024

type nowPlayingBody struct {
	DeviceID   string          `json:"deviceId"`
	DeviceName string          `json:"deviceName"`
	Position   float64         `json:"position"`
	Payload    json.RawMessage `json:"payload"`
}

type nowPlayingOut struct {
	DeviceID   string          `json:"deviceId"`
	DeviceName string          `json:"deviceName"`
	Position   float64         `json:"position"`
	Payload    json.RawMessage `json:"payload"`
	UpdatedAt  int64           `json:"updatedAt"` // unix ms
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

// MeNowPlayingPutHandler: PUT /api/v1/me/nowplaying, upsert of the profile row.
// 413 above 64 KB, 400 on bad JSON / missing payload, {"ignored":true} for
// harness requests (unless YTM_STATS_INCLUDE_HARNESS=1).
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
	if b.Position < 0 || b.Position != b.Position {
		b.Position = 0
	}
	if harnessRequest(c.Request()) {
		return c.JSON(http.StatusOK, map[string]interface{}{"ignored": true})
	}
	pid := profileID(c)
	row := db.NowPlaying{
		ProfileID:  pid,
		DeviceID:   clip(b.DeviceID, 64),
		DeviceName: clip(b.DeviceName, 64),
		Payload:    string(p),
		Position:   b.Position,
		UpdatedAt:  time.Now(),
	}
	if err := db.DB.Clauses(clause.OnConflict{UpdateAll: true}).Create(&row).Error; err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "store failed"})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"ok": true, "updatedAt": row.UpdatedAt.UnixMilli()})
}

// MeNowPlayingGetHandler: GET /api/v1/me/nowplaying, 404 when none.
func MeNowPlayingGetHandler(c echo.Context) error {
	pid := profileID(c)
	var row db.NowPlaying
	if err := db.DB.Where("profile_id = ?", pid).First(&row).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "none"})
	}
	return c.JSON(http.StatusOK, nowPlayingOut{
		DeviceID:   row.DeviceID,
		DeviceName: row.DeviceName,
		Position:   row.Position,
		Payload:    json.RawMessage(row.Payload),
		UpdatedAt:  row.UpdatedAt.UnixMilli(),
	})
}
