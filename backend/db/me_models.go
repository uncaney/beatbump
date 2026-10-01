package db

// Server-side user state (favorites / follows / playlists). Keyed by a profile id
// (an anonymous device cookie today; real accounts can reuse the same id later).
// AutoMigrate of these is wired in InitDB (db.go).

import "time"

type Profile struct {
	ID        string    `gorm:"primaryKey" json:"id"` // device-anon id, or u-<hash(name)> after login
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

type Favorite struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProfileID string    `gorm:"uniqueIndex:idx_fav_uniq;index" json:"-"`
	Kind      string    `gorm:"uniqueIndex:idx_fav_uniq" json:"kind"` // song | album | artist
	Ref       string    `gorm:"uniqueIndex:idx_fav_uniq" json:"ref"`  // videoId/lid | lb- | la-
	Title     string    `json:"title"`
	Artist    string    `json:"artist"`
	Thumbnail string    `json:"thumbnail"`
	Data      string    `json:"-"` // full item JSON, replayed to the UI
	CreatedAt time.Time `json:"createdAt"`
}

type Follow struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProfileID string    `gorm:"uniqueIndex:idx_fol_uniq;index" json:"-"`
	ArtistID  string    `gorm:"uniqueIndex:idx_fol_uniq" json:"artistId"` // la- or YT UC…
	Name      string    `json:"name"`
	Thumbnail string    `json:"thumbnail"`
	CreatedAt time.Time `json:"createdAt"`
}

type Playlist struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	ProfileID   string    `gorm:"index" json:"-"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type AcquireJob struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	ProfileID  string    `gorm:"index" json:"-"`
	ArtistID   string    `gorm:"index" json:"artistId"`
	ArtistName string    `json:"artistName"`
	VideoID    string    `json:"videoId"`
	Status     string    `json:"status"` // enqueued | done | error
	CreatedAt  time.Time `json:"createdAt"`
}

type PlayEvent struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProfileID string    `gorm:"index:idx_pe_profile" json:"-"`
	Ref       string    `gorm:"index" json:"ref"` // videoId/lid
	Title     string    `json:"title"`
	Artist    string    `json:"artist"`
	ArtistID  string    `json:"artistId"`
	Album     string    `json:"album"`
	Source    string    `json:"source"` // local | youtube
	Data      string    `json:"-"`
	PlayedAt  time.Time `gorm:"index" json:"playedAt"`
}

// SkipEvent (c40b B6-10): the user pressed "next" (button or MediaSession
// nexttrack) early in a track (< 20 s or < 30 % of it). Not a play: kept
// apart from play_events so the stats keep counting real listens.
type SkipEvent struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProfileID string    `gorm:"index:idx_se_profile" json:"-"`
	Ref       string    `gorm:"index" json:"ref"` // videoId/lid
	Position  float64   `json:"position"`         // seconds into the track
	Duration  float64   `json:"duration"`         // seconds (0 = unknown)
	Source    string    `json:"source"`           // what pressed next: player | mediasession | fullscreen | keyboard
	Origin    string    `json:"origin"`           // local | youtube
	SkippedAt time.Time `gorm:"index" json:"skippedAt"`
}

type PlaylistItem struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	PlaylistID uint      `gorm:"index" json:"playlistId"`
	Position   int       `json:"position"`
	Ref        string    `json:"ref"`
	Title      string    `json:"title"`
	Artist     string    `json:"artist"`
	Thumbnail  string    `json:"thumbnail"`
	Data       string    `json:"-"`
	CreatedAt  time.Time `json:"createdAt"`
}

// NowPlaying (C2): one row per profile, the last C1 resume state pushed by the
// device that played last (slim queue rows + index + position, <= 64 KB).
type NowPlaying struct {
	ProfileID  string    `gorm:"primaryKey" json:"-"`
	DeviceID   string    `json:"deviceId"`
	DeviceName string    `json:"deviceName"`
	Payload    string    `json:"-"`        // C1 resume state JSON
	Position   float64   `json:"position"` // seconds
	UpdatedAt  time.Time `json:"updatedAt"`
}
