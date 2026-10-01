package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// c43c B7-14: `beat-server -healthcheck` is the compose healthcheck of a
// FROM scratch image. Exit 0 only for a 200 JSON answer carrying a version.
func TestHealthcheckExitCodes(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   int
		reason string
	}{
		{"ok", 200, `{"tracks":55814,"albums":6871,"artists":1813,"version":"d1fe158"}`, 0, "ok version=d1fe158 tracks=55814"},
		{"no version", 200, `{"tracks":1}`, 1, "no version"},
		{"empty version", 200, `{"tracks":1,"version":""}`, 1, "no version"},
		{"html shell", 200, `<!doctype html><html></html>`, 1, "not JSON"},
		{"500", 500, `{"version":"d1fe158"}`, 1, "http 500"},
		{"404", 404, `{"error":"not_found"}`, 1, "http 404"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/stats/library" {
					t.Errorf("probed %s, want /api/v1/stats/library", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			code, why := healthcheck(srv.URL+"/api/v1/stats/library", 2*time.Second)
			if code != tc.want {
				t.Fatalf("exit %d, want %d (%s)", code, tc.want, why)
			}
			if !strings.Contains(why, tc.reason) {
				t.Fatalf("reason %q, want it to mention %q", why, tc.reason)
			}
		})
	}
}

func TestHealthcheckUnreachableAndTimeout(t *testing.T) {
	// A closed port (nothing listening) is unhealthy, quickly.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	t0 := time.Now()
	code, why := healthcheck("http://"+addr+"/api/v1/stats/library", 2*time.Second)
	if code != 1 || !strings.HasPrefix(why, "unreachable") {
		t.Fatalf("closed port: exit %d %q, want 1 unreachable", code, why)
	}
	if time.Since(t0) > 2*time.Second {
		t.Fatalf("closed port took %s", time.Since(t0))
	}

	// A server that hangs past the timeout is unhealthy (the compose timeout is 5 s,
	// the client one 4 s: the probe always answers before docker kills it).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1500 * time.Millisecond)
		_, _ = w.Write([]byte(`{"version":"late"}`))
	}))
	defer srv.Close()
	t0 = time.Now()
	code, why = healthcheck(srv.URL+"/api/v1/stats/library", 300*time.Millisecond)
	if code != 1 || !strings.HasPrefix(why, "unreachable") {
		t.Fatalf("slow server: exit %d %q, want 1 unreachable (timeout)", code, why)
	}
	if d := time.Since(t0); d > 1200*time.Millisecond {
		t.Fatalf("slow server: probe took %s, want about the 300 ms timeout", d)
	}
	if healthcheckTimeout >= 5*time.Second {
		t.Fatalf("healthcheckTimeout %s must stay under the compose timeout of 5 s", healthcheckTimeout)
	}
}

func TestIsHealthcheckArg(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want bool
	}{
		{[]string{"/app/beat-server"}, false},
		{[]string{"/app/beat-server", "-healthcheck"}, true},
		{[]string{"/app/beat-server", "--healthcheck"}, true},
		{[]string{"/app/beat-server", "healthcheck"}, false},
		{[]string{"/app/beat-server", "-v", "-healthcheck"}, false},
		{nil, false},
	} {
		if got := isHealthcheckArg(tc.args); got != tc.want {
			t.Fatalf("isHealthcheckArg(%q) = %v, want %v", tc.args, got, tc.want)
		}
	}
	if healthcheckURL != "http://127.0.0.1:8080/api/v1/stats/library" {
		t.Fatalf("healthcheckURL %q must target the :8080 listener of main()", healthcheckURL)
	}
}
