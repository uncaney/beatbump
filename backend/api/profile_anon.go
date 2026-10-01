package api

import (
	"strings"

	"beatbump-server/backend/db"
)

// profileAnonymous reports whether `pid` is an anonymous (guest) profile: no
// named Profile row (MeLoginHandler writes one, MeWhoamiHandler answers its
// name). U12-12: such a profile has no history worth filtering on, so the
// never-played filter answers an empty list with reason "anonymous" instead
// of the whole library capped at the scan size. Without a database nothing
// can be told apart and the profile counts as named (previous behaviour).
func profileAnonymous(pid string) bool {
	if db.DB == nil {
		return false
	}
	if pid == "" {
		return true
	}
	var p db.Profile
	if err := db.DB.Where("id = ?", pid).First(&p).Error; err != nil {
		return true
	}
	return strings.TrimSpace(p.Name) == ""
}
