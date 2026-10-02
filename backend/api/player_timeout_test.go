package api

import (
	"testing"
	"time"

	"beatbump-server/backend/_youtube/api"
)

// PF5-3: the player budget defaults to 20 s (was 90 s: a walled YouTube
// video held player.json for 30 s and more without ever failing, audit v5)
// and PLAYER_TIMEOUT_SECONDS still overrides it; junk values fall back to
// the default.
func TestPlayerTimeoutDefaultsTo20s(t *testing.T) {
	for _, env := range []string{"", "0", "-5", "abc", " ", "1.5"} {
		t.Setenv("PLAYER_TIMEOUT_SECONDS", env)
		if got := api.PlayerTimeout(); got != 20*time.Second {
			t.Fatalf("PLAYER_TIMEOUT_SECONDS=%q: PlayerTimeout() = %s, want 20s", env, got)
		}
	}
	for env, want := range map[string]time.Duration{"45": 45 * time.Second, " 90 ": 90 * time.Second, "1": time.Second} {
		t.Setenv("PLAYER_TIMEOUT_SECONDS", env)
		if got := api.PlayerTimeout(); got != want {
			t.Fatalf("PLAYER_TIMEOUT_SECONDS=%q: PlayerTimeout() = %s, want %s", env, got, want)
		}
	}
}
