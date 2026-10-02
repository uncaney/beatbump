package api

// 39A (B6-7): giving a first name on a device must not lose what that device
// already did anonymously. MeLoginHandler moves the anonymous profile's rows
// onto the named profile in one transaction. A named profile is never merged
// into another named one (switching names must not mix two people).

import (
	"errors"
	"sort"
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
//   - logins of the same profiles are serialised (loginLocks, L13-6: per
//     profile, bounded wait): the second concurrent login sees the rows
//     already moved and adopts nothing;
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

// ---- c47b L13-6: bounded per-profile login lock ----
//
// A single global mutex serialised every login for the whole transaction;
// Echo has no request timeout, so with a slow SQLite (a big anonymous
// profile, busy_timeout 5 s) the next logins piled up in goroutines without
// bound. Now a login locks only the profiles it touches (the target, the
// device's anonymous id, the remembered prevAnon), waits at most
// loginLockTimeout for them and answers 503 "retry" past that. Two logins
// of unrelated profiles run in parallel; two logins of the same source or
// target are still serialised, so the merge never runs twice.

// loginLockTimeout bounds the wait for the profile locks (a variable for
// tests).
var loginLockTimeout = 5 * time.Second

// errLoginBusy: the locks could not be taken within loginLockTimeout.
var errLoginBusy = errors.New("login in progress for this profile")

// keyedLocks is a set of mutexes by key with a bounded acquire; a key's
// entry exists only while someone holds or waits for it.
type keyedLocks struct {
	mu   sync.Mutex
	held map[string]*keyedLock
}

type keyedLock struct {
	ch   chan struct{} // 1-slot semaphore: full = held
	refs int           // holders + waiters
}

// acquire takes key, waiting at most `timeout`; false when it timed out.
func (k *keyedLocks) acquire(key string, timeout time.Duration) bool {
	k.mu.Lock()
	if k.held == nil {
		k.held = map[string]*keyedLock{}
	}
	l := k.held[key]
	if l == nil {
		l = &keyedLock{ch: make(chan struct{}, 1)}
		k.held[key] = l
	}
	l.refs++
	k.mu.Unlock()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case l.ch <- struct{}{}:
		return true
	case <-timer.C:
		k.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(k.held, key)
		}
		k.mu.Unlock()
		return false
	}
}

// release gives key back (the caller holds it).
func (k *keyedLocks) release(key string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	l := k.held[key]
	if l == nil {
		return
	}
	<-l.ch
	l.refs--
	if l.refs == 0 {
		delete(k.held, key)
	}
}

// loginLocks: the per-profile login locks.
var loginLocks = &keyedLocks{}

// loginLockKeys lists the distinct non-empty ids a login touches, sorted
// (every login takes them in the same order: no deadlock).
func loginLockKeys(ids ...string) []string {
	seen := map[string]bool{}
	keys := []string{}
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			keys = append(keys, id)
		}
	}
	sort.Strings(keys)
	return keys
}

// acquireLoginLocks takes every key within loginLockTimeout overall and
// returns the release; errLoginBusy (nothing held) when it could not.
func acquireLoginLocks(keys []string) (func(), error) {
	deadline := time.Now().Add(loginLockTimeout)
	held := []string{}
	release := func() {
		for i := len(held) - 1; i >= 0; i-- {
			loginLocks.release(held[i])
		}
	}
	for _, k := range keys {
		if !loginLocks.acquire(k, time.Until(deadline)) {
			release()
			return nil, errLoginBusy
		}
		held = append(held, k)
	}
	return release, nil
}

// loginLockedHook runs once the locks are held, before the transaction (a
// test hook: nil in production).
var loginLockedHook func(to string)

// adoptionGrace: how long a request with an adopted anonymous cookie is still
// served as the named profile it was moved onto.
const adoptionGrace = 15 * time.Minute

// adoptionMemoMax bounds the in-memory map (a login per entry).
const adoptionMemoMax = 5000

// adoptionNegativeTTL: how long "this id was not adopted" (a database
// lookup that found nothing, L13-6) is remembered, so a plain anonymous
// cookie does not cost one profiles read per request.
const adoptionNegativeTTL = time.Minute

// adoption is a memo entry: to == "" is a negative entry (not adopted as of
// `at`).
type adoption struct {
	to string
	at time.Time
}

var (
	adoptionMu   sync.Mutex
	adoptionMemo = map[string]adoption{}
	adoptionNow  = time.Now
)

// stale reports whether the entry is past its life (grace or negative TTL).
func (a adoption) stale(now time.Time) bool {
	if a.to == "" {
		return now.Sub(a.at) >= adoptionNegativeTTL
	}
	return now.Sub(a.at) > adoptionGrace
}

func rememberAdoption(from, to string) {
	rememberAdoptionAt(from, to, adoptionNow())
}

// rememberAdoptionAt stores (from -> to, at); to == "" is the negative
// entry. The stale entries are purged when the map is full.
func rememberAdoptionAt(from, to string, at time.Time) {
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	if _, ok := adoptionMemo[from]; !ok && len(adoptionMemo) >= adoptionMemoMax {
		now := adoptionNow()
		for k, a := range adoptionMemo {
			if a.stale(now) {
				delete(adoptionMemo, k)
			}
		}
		if len(adoptionMemo) >= adoptionMemoMax {
			adoptionMemo = map[string]adoption{}
		}
	}
	adoptionMemo[from] = adoption{to: to, at: at}
}

// adoptedByRow reads AdoptedBy / AdoptedAt from pid's Profile row ("" and
// zero without one, or without a database). A variable for tests.
var adoptedByRow = func(pid string) (string, time.Time) {
	if db.DB == nil {
		return "", time.Time{}
	}
	var p db.Profile
	if err := db.DB.Where("id = ?", pid).First(&p).Error; err != nil || p.AdoptedBy == "" || p.AdoptedAt == nil {
		return "", time.Time{}
	}
	return p.AdoptedBy, *p.AdoptedAt
}

// resolveAdopted maps a recently adopted anonymous id onto its named
// profile; any other id (or an adoption older than adoptionGrace) is
// returned as is. An id the memory map does not know (restart, promotion
// within the grace, L13-6) is looked up once in profiles.adopted_by /
// adopted_at and the answer, positive or negative, is remembered.
func resolveAdopted(pid string) string {
	if pid == "" || namedProfileID(pid) {
		return pid
	}
	now := adoptionNow()
	adoptionMu.Lock()
	a, ok := adoptionMemo[pid]
	if ok && !a.stale(now) {
		adoptionMu.Unlock()
		if a.to == "" {
			return pid
		}
		return a.to
	}
	if ok {
		delete(adoptionMemo, pid)
	}
	adoptionMu.Unlock()
	to, at := adoptedByRow(pid)
	if to != "" && !at.IsZero() && now.Sub(at) <= adoptionGrace {
		rememberAdoptionAt(pid, to, at)
		return to
	}
	rememberAdoptionAt(pid, "", now)
	return pid
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
	release, err := acquireLoginLocks(loginLockKeys(to, from, prevAnon))
	if err != nil {
		return nil, err
	}
	defer release()
	if loginLockedHook != nil {
		loginLockedHook(to)
	}
	var moved migratedCounts
	var adopted []string
	err = db.DB.Transaction(func(tx *gorm.DB) error {
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
			// Mark the source as adopted by `to` (empty name: still anonymous);
			// adopted_at serves resolveAdopted after a restart (L13-6).
			now := time.Now()
			if err := tx.Where("id = ?", src).Assign(map[string]interface{}{"adopted_by": to, "adopted_at": &now}).
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
