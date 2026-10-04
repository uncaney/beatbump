package api

// Decision 8 (program/DECISIONS-PAUL.md): a server side cap on the
// acquisitions a profile may request per UTC day, 20 by default
// (YTM_ACQUIRE_DAILY_CAP, 0 = no cap). One acquisition is one album or one
// playlist / radio queue newly requested by a play (autoCacheOnPlay), or one
// track of a discography pull (runAcquire: follow of a YouTube artist, POST
// me/acquire). Past the cap, plays are still served (the stream does not
// depend on the acquisition) but nothing more is enqueued to yubal, and the
// explicit POST me/acquire answers 429 {"error":"quota","reason":...}.
//
// The counter is the existing acquire_jobs table (db.AcquireJob): the
// discography pull already wrote one row per track there, the play driven
// acquisitions now write one row per charge (status "autocache"), so the count
// survives restarts and GET me/acquire lists everything the profile asked for.
// Anonymous profiles are one per bbp cookie; a request without any cookie is
// pooled under "anon" (no cookie is minted by a play).

import (
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"beatbump-server/backend/db"

	"github.com/labstack/echo/v4"
)

const acquireDailyCapDefault = 20

// acquireQuotaReason is the French message of the 429 (cap substituted).
const acquireQuotaReason = "Limite de %d acquisitions par jour atteinte, reessaie demain"

// acquireNow is the clock of the cap (a seam for the midnight test).
var acquireNow = time.Now

// acquireMu serialises check-and-charge so two concurrent plays cannot both
// take the last slot of the day.
var acquireMu sync.Mutex

// acquireDailyCap reads YTM_ACQUIRE_DAILY_CAP: default 20, 0 disables the cap,
// an unreadable or negative value falls back to the default.
func acquireDailyCap() int {
	raw := strings.TrimSpace(os.Getenv("YTM_ACQUIRE_DAILY_CAP"))
	if raw == "" {
		return acquireDailyCapDefault
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return acquireDailyCapDefault
	}
	return n
}

// acquireDayStart is 00:00 UTC of the day of t.
func acquireDayStart(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// acquireProfileKey is the profile the cap is charged to: the bbp cookie
// profile (named, or one anonymous id per cookie), "anon" without a cookie.
// Unlike profileID it never mints a cookie: player.json is not a /me route.
func acquireProfileKey(c echo.Context) string {
	if hasProfileCookie(c) {
		return profileID(c)
	}
	return "anon"
}

// acquireUsedToday counts the acquisitions the profile requested since 00:00 UTC.
func acquireUsedToday(pid string) int {
	if db.DB == nil {
		return 0
	}
	var n int64
	db.DB.Model(&db.AcquireJob{}).
		Where("profile_id = ? AND created_at >= ?", pid, acquireDayStart(acquireNow())).
		Count(&n)
	return int(n)
}

// acquireAllowance is how many acquisitions the profile may still request
// today (math.MaxInt32 when the cap is off).
func acquireAllowance(pid string) int {
	cap := acquireDailyCap()
	if cap == 0 {
		return math.MaxInt32
	}
	left := cap - acquireUsedToday(pid)
	if left < 0 {
		left = 0
	}
	return left
}

// acquireTryCharge records one acquisition request of the profile if the day's
// allowance is not exhausted, and reports whether it was. The row is written
// before the enqueue (it counts the request, not yubal's outcome).
func acquireTryCharge(pid, status, artistID, artistName, videoID string) bool {
	acquireMu.Lock()
	defer acquireMu.Unlock()
	if acquireAllowance(pid) <= 0 {
		return false
	}
	if db.DB != nil {
		db.DB.Create(&db.AcquireJob{
			ProfileID: pid, ArtistID: artistID, ArtistName: artistName, VideoID: videoID,
			Status: status, CreatedAt: acquireNow(),
		})
	}
	return true
}

// acquireQuotaResponse is the 429 of an explicit acquisition past the cap.
func acquireQuotaResponse(c echo.Context) error {
	cap := acquireDailyCap()
	return c.JSON(http.StatusTooManyRequests, map[string]interface{}{
		"error":  "quota",
		"reason": fmt.Sprintf(acquireQuotaReason, cap),
		"cap":    cap,
	})
}

// acquisitionsToday counts the acquisition requests of every profile since
// 00:00 UTC (stats/library `acquisitionsToday`, read by ops/weekly.sh).
func acquisitionsToday() int {
	if db.DB == nil {
		return 0
	}
	var n int64
	db.DB.Model(&db.AcquireJob{}).Where("created_at >= ?", acquireDayStart(acquireNow())).Count(&n)
	return int(n)
}
