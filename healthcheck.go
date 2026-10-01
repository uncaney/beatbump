package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// c43c B7-14: the image is FROM scratch (no wget, curl or busybox), so the
// container healthcheck is the server binary itself:
//
//	/app/beat-server -healthcheck
//
// It GETs http://127.0.0.1:8080/api/v1/stats/library and exits 0 when the
// answer is a 200 whose JSON body carries a non-empty "version" (the handler
// only talks to Meili, never to YouTube), 1 otherwise. It must stay cheap and
// side-effect free: no DB open, no worker, no listener. main() dispatches on
// os.Args BEFORE db.InitDB(). The compose block (written by agents/promote.sh,
// only when the image carries the label fr.ekaii.ytm.healthcheck=1) is:
//
//	healthcheck:
//	  test: ["CMD", "/app/beat-server", "-healthcheck"]
//	  interval: 30s / timeout: 5s / retries: 3 / start_period: 20s
const (
	healthcheckURL     = "http://127.0.0.1:8080/api/v1/stats/library"
	healthcheckTimeout = 4 * time.Second
)

// isHealthcheckArg is true when the process was started as a healthcheck probe
// (first argument -healthcheck or --healthcheck).
func isHealthcheckArg(args []string) bool {
	return len(args) > 1 && (args[1] == "-healthcheck" || args[1] == "--healthcheck")
}

// healthcheck probes url and returns the process exit code (0 healthy, 1
// unhealthy) with a one-line reason for stderr.
func healthcheck(url string, timeout time.Duration) (int, string) {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(url)
	if err != nil {
		return 1, "unreachable: " + err.Error()
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return 1, "read: " + err.Error()
	}
	if resp.StatusCode != http.StatusOK {
		return 1, fmt.Sprintf("http %d", resp.StatusCode)
	}
	var out struct {
		Version string `json:"version"`
		Tracks  int    `json:"tracks"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return 1, "body is not JSON: " + err.Error()
	}
	if out.Version == "" {
		return 1, "no version in body"
	}
	return 0, fmt.Sprintf("ok version=%s tracks=%d", out.Version, out.Tracks)
}

// runHealthcheck is the -healthcheck entry point: one line on stderr, then exit.
func runHealthcheck() {
	code, why := healthcheck(healthcheckURL, healthcheckTimeout)
	fmt.Fprintln(os.Stderr, "healthcheck:", why)
	os.Exit(code)
}
