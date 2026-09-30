package api

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// Strict validation of the audio reverse-proxy inputs. /vp forwards the given URL to the
// bridge, which fetches it through the residential egress: without an allowlist it is an
// open proxy (SSRF into the docker network, abuse of the egress). Only YouTube googlevideo
// videoplayback URLs are legitimate, they come from player.json.
var (
	googlevideoHost = regexp.MustCompile(`^([a-z0-9-]+\.)*googlevideo\.com$`)
	videoIDRe       = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	lidRe           = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	errBadTarget    = errors.New("invalid target")
)

// ValidateVPTarget accepts only https://<*.>googlevideo.com/videoplayback... without
// userinfo, literal IPs or non standard ports.
func ValidateVPTarget(raw string) error {
	if raw == "" {
		return errors.New("missing u")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errBadTarget
	}
	if u.Scheme != "https" || u.User != nil || u.Opaque != "" {
		return errBadTarget
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || net.ParseIP(host) != nil || !googlevideoHost.MatchString(host) {
		return errBadTarget
	}
	if p := u.Port(); p != "" && p != "443" {
		return errBadTarget
	}
	if !strings.HasPrefix(u.Path, "/videoplayback") {
		return errBadTarget
	}
	return nil
}

// ValidateAudPath accepts exactly one 11 character video id after /aud/.
func ValidateAudPath(rest string) error {
	rest = strings.TrimPrefix(rest, "/")
	if !videoIDRe.MatchString(rest) {
		return errors.New("invalid video id")
	}
	return nil
}

func ValidateLocalfPath(p string) error {
	if p == "" {
		return errors.New("missing p")
	}
	if strings.Contains(p, "..") || strings.ContainsRune(p, 0) || strings.Contains(p, "://") {
		return errors.New("invalid p")
	}
	return nil
}

func ValidateCoverID(lid string) error {
	if !lidRe.MatchString(lid) {
		return errors.New("invalid lid")
	}
	return nil
}

// validateAudioProxyRequest returns a non nil error when the request must be rejected.
func validateAudioProxyRequest(path string, q url.Values) error {
	switch path {
	case "/vp":
		return ValidateVPTarget(q.Get("u"))
	case "/localf":
		return ValidateLocalfPath(q.Get("p"))
	case "/cover":
		return ValidateCoverID(q.Get("lid"))
	}
	return nil
}
