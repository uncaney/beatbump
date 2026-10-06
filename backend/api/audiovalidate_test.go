package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestValidateVPTarget(t *testing.T) {
	ok := []string{
		"https://rr3---sn-abcdef.googlevideo.com/videoplayback?expire=1&id=x",
		"https://manifest.googlevideo.com/videoplayback/id/abc",
		"https://a.googlevideo.com:443/videoplayback",
	}
	bad := []string{
		"", "http://rr3---sn-a.googlevideo.com/videoplayback", "https://example.com/videoplayback",
		"https://googlevideo.com.evil.tld/videoplayback", "https://bridge:8789/localf?p=x",
		"https://127.0.0.1/videoplayback", "https://[::1]/videoplayback", "https://user@a.googlevideo.com/videoplayback",
		"https://a.googlevideo.com:8443/videoplayback", "https://a.googlevideo.com/x", "ftp://a.googlevideo.com/videoplayback",
	}
	for _, u := range ok {
		if err := ValidateVPTarget(u); err != nil {
			t.Errorf("expected %q to be accepted: %v", u, err)
		}
	}
	for _, u := range bad {
		if err := ValidateVPTarget(u); err == nil {
			t.Errorf("expected %q to be rejected", u)
		}
	}
}

func TestValidateOthers(t *testing.T) {
	if ValidateAudPath("dQw4w9WgXcQ") != nil || ValidateAudPath("/dQw4w9WgXcQ") != nil {
		t.Fatal("valid aud id rejected")
	}
	for _, s := range []string{"", "x", "dQw4w9WgXcQ/extra", "../../etc", "dQw4w9WgXc?"} {
		if ValidateAudPath(s) == nil {
			t.Errorf("expected aud %q rejected", s)
		}
	}
	if ValidateLocalfPath("ytm/Artist/Album/01 - Song.opus") != nil {
		t.Fatal("valid localf path rejected")
	}
	for _, s := range []string{"", "../x", "http://x/y", "a/../b"} {
		if ValidateLocalfPath(s) == nil {
			t.Errorf("expected localf %q rejected", s)
		}
	}
	if ValidateCoverID("lb-cbf6d33107f2") != nil || ValidateCoverID("") == nil || ValidateCoverID("a b") == nil {
		t.Fatal("cover id validation wrong")
	}
}

func TestAudioProxyRejectsOpenProxy(t *testing.T) {
	e := echo.New()
	RegisterAudioProxyRoutes(e)
	for _, target := range []string{"/vp?u=https://example.com/", "/vp", "/aud/not-an-id", "/localf?p=../x", "/cover?lid="} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, target, nil)
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d", target, rec.Code)
		}
	}
}
