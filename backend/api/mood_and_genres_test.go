package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"beatbump-server/backend/_youtube/api"
)

// explore/<unknown category>: the upstream 404 is mapped to a JSON 404
// (audit v3 F22/G19); other failures answer a JSON 500.
func TestExploreErrorMapsUpstream404(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code int
		want string
	}{
		{"upstream 404", &api.UpstreamStatusError{StatusCode: 404, Status: "404 Not Found"}, http.StatusNotFound, "not_found"},
		{"wrapped upstream 404", fmt.Errorf("browse: %w", &api.UpstreamStatusError{StatusCode: 404, Status: "404 Not Found"}), http.StatusNotFound, "not_found"},
		{"upstream 503", &api.UpstreamStatusError{StatusCode: 503, Status: "503"}, http.StatusInternalServerError, "internal"},
		{"plain error", errors.New("boom"), http.StatusInternalServerError, "internal"},
	}
	for _, tc := range cases {
		c, rec := ctxFor(http.MethodGet, "/api/v1/explore/zzz", "", nil)
		if err := exploreError(c, tc.err); err != nil {
			t.Fatalf("%s: handler error: %v", tc.name, err)
		}
		if rec.Code != tc.code {
			t.Fatalf("%s: status = %d, want %d", tc.name, rec.Code, tc.code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
			t.Fatalf("%s: content-type = %q, want JSON", tc.name, ct)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: body not JSON: %v (%s)", tc.name, err, rec.Body.String())
		}
		if body["error"] != tc.want {
			t.Fatalf("%s: error = %q, want %q", tc.name, body["error"], tc.want)
		}
	}
}
