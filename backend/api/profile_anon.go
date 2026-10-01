package api

import (
	"errors"
	"log"
	"strings"

	"gorm.io/gorm"

	"beatbump-server/backend/db"
)

// profileAnonymousErr reports whether `pid` is an anonymous (guest) profile: no
// named Profile row (MeLoginHandler writes one, MeWhoamiHandler answers its
// name). U12-12: such a profile has no history worth filtering on, so the
// never-played filter answers an empty list with reason "anonymous" instead
// of the whole library capped at the scan size. Without a database nothing
// can be told apart and the profile counts as named (previous behaviour).
// L11-5/L11-7: only a MISSING row (or an empty name) is anonymous; any other
// database error (lock, timeout) is returned with false, so the caller can
// answer 500 instead of showing a named user "Dis-moi ton prénom".
func profileAnonymousErr(pid string) (bool, error) {
	if db.DB == nil {
		return false, nil
	}
	if pid == "" {
		return true, nil
	}
	var p db.Profile
	if err := db.DB.Where("id = ?", pid).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return true, nil
		}
		return false, err
	}
	return strings.TrimSpace(p.Name) == "", nil
}

// profileAnonymous is profileAnonymousErr for callers that cannot fail: a
// database error counts as NOT anonymous (named, the safe side: no merge, no
// guest state) and is logged.
func profileAnonymous(pid string) bool {
	anon, err := profileAnonymousErr(pid)
	if err != nil {
		log.Printf("profileAnonymous %q: %v", pid, err)
		return false
	}
	return anon
}
