package api

// 39A (B6-7): giving a first name on a device must not lose what that device
// already did anonymously. MeLoginHandler moves the anonymous profile's rows
// onto the named profile in one transaction. A named profile is never merged
// into another named one (switching names must not mix two people).

import (
	"errors"
	"strconv"
	"strings"
	"sync"
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
	// Skips (L12-6): early "next" presses, so "Pour toi" keeps excluding
	// what the device skipped anonymously.
	Skips int64 `json:"skips"`
}

// playlistDeviceSuffix marks a moved playlist whose name the named profile
// already uses (both are kept).
const playlistDeviceSuffix = " (appareil)"

// namedProfileID: the u-<hash> ids MeLoginHandler mints.
func namedProfileID(pid string) bool { return strings.HasPrefix(pid, "u-") }

// mergeProfileInto moves every per-profile row of `from` onto `to` inside tx.
// Duplicates are resolved in favour of the target: a favourite (kind, ref) or
// a follow (artistId) the target already has is dropped from the source; a
// playlist whose name the target already uses is kept with " (appareil)"
// appended; now_playings keeps the most recent row; skip events move as
// they are. Counts are the moved rows.
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

	// skip events (L12-6): plain move.
	if tx.Migrator().HasTable(&db.SkipEvent{}) {
		r = tx.Model(&db.SkipEvent{}).Where("profile_id = ?", from).Update("profile_id", to)
		if r.Error != nil {
			return out, r.Error
		}
		out.Skips = r.RowsAffected
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

// ---- c45b B7-17 (L12-8): clean login ----
//
// Three holes in the 39A merge: (1) a write that left with the anonymous
// cookie and lands after the merge commits sits on the abandoned anonymous
// id for ever; (2) two logins at once (double tap, two tabs) both found the
// anonymous profile mergeable, the second answered `migrated: {plays: 0}`
// ("0 écoute rattachée"); (3) `profileAnonymous(from)` ran outside the
// transaction. Now:
//   - logins are serialised (loginMu): one transaction at a time, the second
//     concurrent login sees the rows already moved and adopts nothing;
//   - the anonymous check runs inside the transaction (txProfileAnonymous);
//   - an adopted anonymous id gets a Profile row {Name: "", AdoptedBy: to}:
//     still anonymous for every other reader, but the next login of the SAME
//     name with that id (stale cookie, or the client's remembered
//     `prevAnon`) re-adopts whatever landed on it since; another name never
//     takes those rows;
//   - for adoptionGrace after the merge, a request still carrying the old
//     cookie is served as the named profile (profileID -> resolveAdopted),
//     so an in-flight play / favourite / now_playing is not orphaned;
//   - `migrated` is null when nothing moved (all counters zero), so the
//     client never shows "0 écoute rattachée".

// loginMu serialises POST me/login: logins are rare, and the merge must not
// run twice for the same anonymous source.
var loginMu sync.Mutex

// adoptionGrace: how long a request with an adopted anonymous cookie is still
// served as the named profile it was moved onto.
const adoptionGrace = 15 * time.Minute

// adoptionMemoMax bounds the in-memory map (a login per entry).
const adoptionMemoMax = 5000

type adoption struct {
	to string
	at time.Time
}

var (
	adoptionMu   sync.Mutex
	adoptionMemo = map[string]adoption{}
	adoptionNow  = time.Now
)

func rememberAdoption(from, to string) {
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	if len(adoptionMemo) >= adoptionMemoMax {
		now := adoptionNow()
		for k, a := range adoptionMemo {
			if now.Sub(a.at) > adoptionGrace {
				delete(adoptionMemo, k)
			}
		}
		if len(adoptionMemo) >= adoptionMemoMax {
			adoptionMemo = map[string]adoption{}
		}
	}
	adoptionMemo[from] = adoption{to: to, at: adoptionNow()}
}

// resolveAdopted maps a recently adopted anonymous id onto its named
// profile; any other id (or an adoption older than adoptionGrace) is
// returned as is.
func resolveAdopted(pid string) string {
	if pid == "" || namedProfileID(pid) {
		return pid
	}
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	a, ok := adoptionMemo[pid]
	if !ok {
		return pid
	}
	if adoptionNow().Sub(a.at) > adoptionGrace {
		delete(adoptionMemo, pid)
		return pid
	}
	return a.to
}

// resetAdoptions forgets every remembered adoption (tests).
func resetAdoptions() {
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	adoptionMemo = map[string]adoption{}
}

// txProfileAnonymous is profileAnonymousErr inside a transaction: no Profile
// row, or an empty name (an adopted anonymous id keeps an empty name).
func txProfileAnonymous(tx *gorm.DB, pid string) (bool, error) {
	if pid == "" {
		return true, nil
	}
	var p db.Profile
	if err := tx.Where("id = ?", pid).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return true, nil
		}
		return false, err
	}
	return strings.TrimSpace(p.Name) == "", nil
}

// txAdoptedBy returns the AdoptedBy of pid's Profile row ("" without one).
func txAdoptedBy(tx *gorm.DB, pid string) (string, error) {
	var p db.Profile
	if err := tx.Where("id = ?", pid).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", nil
		}
		return "", err
	}
	return p.AdoptedBy, nil
}

func (m *migratedCounts) add(o migratedCounts) {
	m.Plays += o.Plays
	m.Favorites += o.Favorites
	m.Follows += o.Follows
	m.Playlists += o.Playlists
	m.Skips += o.Skips
}

func (m migratedCounts) empty() bool {
	return m.Plays == 0 && m.Favorites == 0 && m.Follows == 0 && m.Playlists == 0 && m.Skips == 0
}

// loginAndMerge creates (or renames) the named profile `to` and, in the same
// transaction, moves onto it the rows of `from` (the device's cookie, when
// `merge` and it is an anonymous profile) and of `prevAnon` (the anonymous id
// the client remembers from its previous login, only when that id was
// adopted by `to`). Every adopted source gets a Profile row {Name: "",
// AdoptedBy: to} and is remembered for adoptionGrace. The returned counts
// are nil when nothing moved: no eligible source, or sources already empty
// (a second concurrent login, a stale cookie).
func loginAndMerge(from, prevAnon, to, name string, merge bool) (*migratedCounts, error) {
	loginMu.Lock()
	defer loginMu.Unlock()
	var moved migratedCounts
	var adopted []string
	err := db.DB.Transaction(func(tx *gorm.DB) error {
		var p db.Profile
		if err := tx.Where("id = ?", to).Assign(db.Profile{Name: name}).
			Attrs(db.Profile{CreatedAt: time.Now()}).FirstOrCreate(&p, db.Profile{ID: to}).Error; err != nil {
			return err
		}
		if !merge {
			return nil
		}
		sources := []string{}
		if from != "" && from != to && !namedProfileID(from) {
			anon, err := txProfileAnonymous(tx, from)
			if err != nil {
				return err
			}
			if anon {
				sources = append(sources, from)
			}
		}
		if prevAnon != "" && prevAnon != to && prevAnon != from && !namedProfileID(prevAnon) {
			by, err := txAdoptedBy(tx, prevAnon)
			if err != nil {
				return err
			}
			if by == to {
				sources = append(sources, prevAnon)
			}
		}
		for _, src := range sources {
			m, err := mergeProfileInto(tx, src, to)
			if err != nil {
				return err
			}
			moved.add(m)
			// Mark the source as adopted by `to` (empty name: still anonymous).
			if err := tx.Where("id = ?", src).Assign(map[string]interface{}{"adopted_by": to}).
				Attrs(db.Profile{CreatedAt: time.Now()}).FirstOrCreate(&db.Profile{}, db.Profile{ID: src}).Error; err != nil {
				return err
			}
			adopted = append(adopted, src)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, src := range adopted {
		rememberAdoption(src, to)
	}
	if moved.empty() {
		return nil, nil
	}
	for _, pid := range append(adopted, to) {
		invalidateMixCache(pid)
		dropNeverPlayedMemoFor(pid)
		invalidateStatsTimeMemo(pid)
	}
	return &moved, nil
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
