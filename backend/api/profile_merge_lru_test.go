package api

import (
	"fmt"
	"testing"
	"time"
)

// B9-9 (L14-8): the adoption memo is a bounded LRU. 6 000 unknown anonymous
// ids (negative entries) never push a recent adoption out, the negative
// entries stay under adoptionNegativeMax, and a full map of adoptions
// evicts the least recently used one, never everything at once.
func TestAdoptionMemoLRUKeepsRecentAdoption(t *testing.T) {
	resetAdoptions()
	t.Cleanup(resetAdoptions)
	prev := adoptedByRow
	adoptedByRow = func(string) (string, time.Time) { return "", time.Time{} }
	t.Cleanup(func() { adoptedByRow = prev })

	rememberAdoption("anon-keep", "u-keep")
	for i := 0; i < 6000; i++ {
		id := fmt.Sprintf("anon-unknown-%d", i)
		if got := resolveAdopted(id); got != id {
			t.Fatalf("unknown id redirected: %q -> %q", id, got)
		}
	}
	if got := resolveAdopted("anon-keep"); got != "u-keep" {
		t.Fatalf("recent adoption lost behind 6 000 unknown ids: %q", got)
	}
	n, neg := adoptionMemoLen()
	if neg > adoptionNegativeMax || n > adoptionNegativeMax+1 {
		t.Fatalf("negative entries not bounded: %d entries, %d negative (max %d)", n, neg, adoptionNegativeMax)
	}
	// The negative entries are evicted oldest first: the last one asked is
	// still answered from the memo (no database read).
	reads := 0
	adoptedByRow = func(string) (string, time.Time) { reads++; return "", time.Time{} }
	resolveAdopted("anon-unknown-5999")
	if reads != 0 {
		t.Fatalf("most recent negative entry evicted (%d reads)", reads)
	}
	resolveAdopted("anon-unknown-0")
	if reads != 1 {
		t.Fatalf("oldest negative entry still memoised (%d reads)", reads)
	}

	// A full map of adoptions: the least recently used goes, one at a time;
	// a touched entry survives.
	resetAdoptions()
	for i := 0; i < adoptionMemoMax; i++ {
		rememberAdoption(fmt.Sprintf("anon-login-%d", i), fmt.Sprintf("u-%d", i))
	}
	if got := resolveAdopted("anon-login-0"); got != "u-0" { // touched: now the most recent
		t.Fatalf("first adoption: %q", got)
	}
	rememberAdoption("anon-login-extra", "u-extra")
	n, _ = adoptionMemoLen()
	if n != adoptionMemoMax {
		t.Fatalf("map not bounded: %d", n)
	}
	reads = 0
	if got := resolveAdopted("anon-login-0"); got != "u-0" || reads != 0 {
		t.Fatalf("touched adoption evicted: %q (%d reads)", got, reads)
	}
	if got := resolveAdopted("anon-login-extra"); got != "u-extra" || reads != 0 {
		t.Fatalf("newest adoption evicted: %q (%d reads)", got, reads)
	}
	if got := resolveAdopted("anon-login-1"); got != "anon-login-1" || reads != 1 {
		t.Fatalf("least recently used adoption kept: %q (%d reads)", got, reads)
	}
	// That miss wrote one negative entry, which evicted exactly one more
	// (the next least recently used, anon-login-2): everything else stays.
	if n, _ := adoptionMemoLen(); n != adoptionMemoMax {
		t.Fatalf("map not bounded after the negative entry: %d", n)
	}
	if got := resolveAdopted("anon-login-3"); got != "u-3" || reads != 1 {
		t.Fatalf("one eviction wiped more than one entry: %q (%d reads)", got, reads)
	}
	if got := resolveAdopted("anon-login-4999"); got != "u-4999" || reads != 1 {
		t.Fatalf("recent adoption lost: %q (%d reads)", got, reads)
	}
}
