package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// PF5-8: every access line carries the response's cache verdicts ("cache"
// from X-Ytm-Cache, "mix_cache" from X-Ytm-Mix-Cache, empty when the route
// sets none) and keeps the default fields log-latency.py and weekly.sh read.
func TestAccessLogCarriesCacheVerdicts(t *testing.T) {
	var buf bytes.Buffer
	e := echo.New()
	e.Use(middleware.LoggerWithConfig(accessLogConfig(&buf)))
	e.GET("/api/v1/home.json", func(c echo.Context) error {
		c.Response().Header().Set("X-Ytm-Cache", "STALE")
		return c.String(http.StatusOK, "home")
	})
	e.GET("/api/v1/me/mix", func(c echo.Context) error {
		c.Response().Header().Set("X-Ytm-Mix-Cache", "HIT")
		return c.String(http.StatusOK, "mix")
	})
	e.GET("/cover", func(c echo.Context) error {
		c.Response().Header().Set("X-Ytm-Cache", `HIT"\`) // never emitted, but must stay valid JSON
		return c.NoContent(http.StatusNotFound)
	})
	e.GET("/plain", func(c echo.Context) error { return c.String(http.StatusOK, "p") })

	targets := []string{"/api/v1/home.json?x=1", "/api/v1/me/mix", "/cover?lid=abc", "/plain"}
	for _, target := range targets {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.Header.Set("User-Agent", "ytm-harness-c50")
		e.ServeHTTP(httptest.NewRecorder(), req)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != len(targets) {
		t.Fatalf("%d lines, want %d:\n%s", len(lines), len(targets), buf.String())
	}
	want := []struct{ cache, mix string }{{"STALE", ""}, {"", "HIT"}, {`HIT"\`, ""}, {"", ""}}
	for i, line := range lines {
		var j map[string]interface{}
		if err := json.Unmarshal([]byte(line), &j); err != nil {
			t.Fatalf("line %d is not JSON (%v): %s", i, err, line)
		}
		for _, k := range []string{"time", "remote_ip", "host", "method", "uri", "user_agent", "status", "latency", "bytes_in", "bytes_out"} {
			if _, ok := j[k]; !ok {
				t.Fatalf("line %d lacks %q: %s", i, k, line)
			}
		}
		if j["uri"] != targets[i] || j["user_agent"] != "ytm-harness-c50" {
			t.Fatalf("line %d: uri %v ua %v", i, j["uri"], j["user_agent"])
		}
		if _, ok := j["latency"].(float64); !ok {
			t.Fatalf("line %d: latency is not a number: %s", i, line)
		}
		if j["cache"] != want[i].cache || j["mix_cache"] != want[i].mix {
			t.Fatalf("line %d: cache %v mix_cache %v, want %q %q", i, j["cache"], j["mix_cache"], want[i].cache, want[i].mix)
		}
	}
}
