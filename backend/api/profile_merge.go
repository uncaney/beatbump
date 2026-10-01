package api

// 39A (B6-7): giving a first name on a device must not lose what that device
// already did anonymously. MeLoginHandler moves the anonymous profile's rows
// onto the named profile in one transaction. A named profile is never merged
// into another named one (switching names must not mix two people).

import (
	"strconv"
	"strings"
	"time"

	"beatbump-server/backend/db"

	"gorm.io/gorm"
)

// migratedCounts is the `migrated` object of POST me/login.
type migratedCounts struct {
	Plays     int64 `json:"plays"`
	Favorites int64 `json:"favorites"`
	Follows   int64 `json:"follows"`
	Playlists int64 `json:"playlists"`
}

// playlistDeviceSuffix marks a moved playlist whose name the named profile
// already uses (both are kept).
const playlistDeviceSuffix = " (appareil)"

// namedProfileID: the u-<hash> ids MeLoginHandler mints.
func namedProfileID(pid string) bool { return strings.HasPrefix(pid, "u-") }

// mergeableSource reports whether `from` is an anonymous profile whose rows
// may be moved onto `to`: distinct ids, not a u- id, no named Profile row.
func mergeableSource(from, to string) bool {
	if from == "" || from == to || namedProfileID(from) {
		return false
	}
	return profileAnonymous(from)
}

// mergeProfileInto moves every per-profile row of `from` onto `to` inside tx.
// Duplicates are resolved in favour of the target: a favourite (kind, ref) or
// a follow (artistId) the target already has is dropped from the source; a
// playlist whose name the target already uses is kept with " (appareil)"
// appended; now_playings keeps the most recent row. Counts are the moved rows.
func mergeProfileInto(tx *gorm.DB, from, to string) (migratedCounts, error) {
	var out migratedCounts
	// play events: plain move.
	r := tx.Model(&db.PlayEvent{}).Where("profile_id = ?", from).Update("profile_id", to)
	if r.Error != nil {
		return out, r.Error
	}
	out.Plays = r.RowsAffected

	// favorites: unique (profile_id, kind, ref).
	if err := tx.Where("profile_id = ? AND EXISTS (SELECT 1 FROM favorites t WHERE t.profile_id = ? AND t.kind = favorites.kind AND t.ref = favorites.ref)", from, to).
		Delete(&db.Favorite{}).Error; err != nil {
		return out, err
	}
	r = tx.Model(&db.Favorite{}).Where("profile_id = ?", from).Update("profile_id", to)
	if r.Error != nil {
		return out, r.Error
	}
	out.Favorites = r.RowsAffected

	// follows: unique (profile_id, artist_id).
	if err := tx.Where("profile_id = ? AND EXISTS (SELECT 1 FROM follows t WHERE t.profile_id = ? AND t.artist_id = follows.artist_id)", from, to).
		Delete(&db.Follow{}).Error; err != nil {
		return out, err
	}
	r = tx.Model(&db.Follow{}).Where("profile_id = ?", from).Update("profile_id", to)
	if r.Error != nil {
		return out, r.Error
	}
	out.Follows = r.RowsAffected

	// playlists: items follow through playlist_id; same name => suffix.
	var taken []string
	if err := tx.Model(&db.Playlist{}).Where("profile_id = ?", to).Pluck("name", &taken).Error; err != nil {
		return out, err
	}
	names := map[string]bool{}
	for _, n := range taken {
		names[n] = true
	}
	var pls []db.Playlist
	if err := tx.Where("profile_id = ?", from).Order("id asc").Find(&pls).Error; err != nil {
		return out, err
	}
	for _, p := range pls {
		name := p.Name
		if names[name] {
			name = p.Name + playlistDeviceSuffix
			for i := 2; names[name]; i++ {
				name = p.Name + " (appareil " + strconv.Itoa(i) + ")"
			}
		}
		names[name] = true
		if err := tx.Model(&db.Playlist{}).Where("id = ?", p.ID).
			Updates(map[string]interface{}{"profile_id": to, "name": name}).Error; err != nil {
			return out, err
		}
		out.Playlists++
	}

	// acquire jobs: plain move (the Compte "Ajouts récents" list).
	if err := tx.Model(&db.AcquireJob{}).Where("profile_id = ?", from).Update("profile_id", to).Error; err != nil {
		return out, err
	}

	// now_playings: one row per profile, keep the most recent.
	if err := mergeNowPlaying(tx, from, to); err != nil {
		return out, err
	}
	return out, nil
}

func mergeNowPlaying(tx *gorm.DB, from, to string) error {
	if !tx.Migrator().HasTable(&db.NowPlaying{}) {
		return nil
	}
	var src db.NowPlaying
	if err := tx.Where("profile_id = ?", from).Limit(1).Find(&src).Error; err != nil {
		return err
	}
	if src.ProfileID == "" {
		return nil
	}
	var dst db.NowPlaying
	if err := tx.Where("profile_id = ?", to).Limit(1).Find(&dst).Error; err != nil {
		return err
	}
	if dst.ProfileID != "" && !src.UpdatedAt.After(dst.UpdatedAt) {
		return tx.Where("profile_id = ?", from).Delete(&db.NowPlaying{}).Error
	}
	if dst.ProfileID != "" {
		if err := tx.Where("profile_id = ?", to).Delete(&db.NowPlaying{}).Error; err != nil {
			return err
		}
	}
	return tx.Model(&db.NowPlaying{}).Where("profile_id = ?", from).Update("profile_id", to).Error
}

// loginAndMerge creates (or renames) the named profile `to` and, when `from`
// is a mergeable anonymous profile, moves its rows, all in one transaction.
// The returned counts are nil when nothing was eligible for a merge.
func loginAndMerge(from, to, name string, merge bool) (*migratedCounts, error) {
	var moved *migratedCounts
	err := db.DB.Transaction(func(tx *gorm.DB) error {
		var p db.Profile
		if err := tx.Where("id = ?", to).Assign(db.Profile{Name: name}).
			Attrs(db.Profile{CreatedAt: time.Now()}).FirstOrCreate(&p, db.Profile{ID: to}).Error; err != nil {
			return err
		}
		if !merge {
			return nil
		}
		m, err := mergeProfileInto(tx, from, to)
		if err != nil {
			return err
		}
		moved = &m
		return nil
	})
	if err != nil {
		return nil, err
	}
	if moved != nil {
		invalidateMixCache(from)
		invalidateMixCache(to)
		dropNeverPlayedMemoFor(from)
		dropNeverPlayedMemoFor(to)
	}
	return moved, nil
}

// dropNeverPlayedMemoFor forgets the memoised never-played scans of a
// profile (its history just changed in bulk).
func dropNeverPlayedMemoFor(pid string) {
	neverPlayedMemoMu.Lock()
	defer neverPlayedMemoMu.Unlock()
	for k := range neverPlayedMemo {
		if strings.HasPrefix(k, pid+"\x00") {
			delete(neverPlayedMemo, k)
		}
	}
}
