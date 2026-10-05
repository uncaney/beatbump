#!/usr/bin/env bash
# Install the Go toolchain declared by go.mod (the `toolchain` line, else the
# `go` line) into /usr/local/go and link go/gofmt into /usr/local/bin, so no
# step has to touch $GITHUB_PATH (appending to it kills jobs on the Forgejo
# runner, see scripts/release/README.md).
#
# Why not actions/setup-go: it writes $GITHUB_PATH, and the toolchain tarball
# from dl.google.com is verified with its published .sha256 anyway.
set -euo pipefail
cd "$(dirname "$0")/../.."

ver=$(awk '/^toolchain go/ {print substr($2, 3); exit}' go.mod)
[ -n "$ver" ] || ver=$(awk '/^go / {print $2; exit}' go.mod)
[ -n "$ver" ] || { echo "ci-install-go: no Go version in go.mod" >&2; exit 1; }

if [ -x /usr/local/go/bin/go ] && /usr/local/go/bin/go version | grep -q "go${ver} "; then
  echo "ci-install-go: go${ver} already installed"
else
  case "$(uname -m)" in
    x86_64) goarch=amd64 ;;
    aarch64 | arm64) goarch=arm64 ;;
    *) echo "ci-install-go: unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  tgz="go${ver}.linux-${goarch}.tar.gz"
  url="https://dl.google.com/go/${tgz}"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 5 -o "$tmp/$tgz.sha256" "$url.sha256"
  scripts/release/fetch.sh "$url" "$tmp/$tgz" "$(cat "$tmp/$tgz.sha256")"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tmp/$tgz"
fi

ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
go version
