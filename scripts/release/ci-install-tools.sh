#!/usr/bin/env bash
# ci-install-tools.sh TOOL...
# Install pinned CLI tools into /usr/local/bin (and Docker CLI plugins into
# ~/.docker/cli-plugins) for CI jobs that run in a plain node:22-bookworm
# container. Every download is verified against the checksum the project
# publishes, except the Docker static CLI (docker.com publishes none; the
# version is pinned and fetched over HTTPS).
#
# Tools: docker | buildx | compose | buildctl | ruff | shellcheck
# Versions can be overridden with DOCKER_VERSION, BUILDX_VERSION,
# COMPOSE_VERSION, BUILDKIT_VERSION, RUFF_VERSION.
set -euo pipefail
cd "$(dirname "$0")/../.."

DOCKER_VERSION=${DOCKER_VERSION:-29.8.2}
BUILDX_VERSION=${BUILDX_VERSION:-v0.37.2}
COMPOSE_VERSION=${COMPOSE_VERSION:-v5.6.0}
BUILDKIT_VERSION=${BUILDKIT_VERSION:-v0.33.1}
RUFF_VERSION=${RUFF_VERSION:-0.16.10}

bin=/usr/local/bin
plugins="${HOME:-/root}/.docker/cli-plugins"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() { scripts/release/fetch.sh "$@"; }
sha_from_list() { # sha_from_list FILE NAME -> digest of NAME in a checksums.txt
  awk -v n="$2" '$2 == n || $2 == "*" n {print $1; exit}' "$1"
}

case "$(uname -m)" in
  x86_64) arch=x86_64; goarch=amd64 ;;
  aarch64 | arm64) arch=aarch64; goarch=arm64 ;;
  *) echo "ci-install-tools: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker --version | grep -q " ${DOCKER_VERSION},"; then return; fi
  fetch "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" "$tmp/docker.tgz"
  tar -C "$tmp" -xzf "$tmp/docker.tgz" docker/docker
  install -m 0755 "$tmp/docker/docker" "$bin/docker"
  docker --version
}

install_buildx() {
  mkdir -p "$plugins"
  name="buildx-${BUILDX_VERSION}.linux-${goarch}"
  base="https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}"
  fetch "$base/checksums.txt" "$tmp/buildx-checksums.txt"
  fetch "$base/$name" "$tmp/$name" "$(sha_from_list "$tmp/buildx-checksums.txt" "$name")"
  install -m 0755 "$tmp/$name" "$plugins/docker-buildx"
  "$plugins/docker-buildx" version
}

install_compose() {
  mkdir -p "$plugins"
  name="docker-compose-linux-${arch}"
  base="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}"
  fetch "$base/$name.sha256" "$tmp/$name.sha256"
  fetch "$base/$name" "$tmp/$name" "$(cat "$tmp/$name.sha256")"
  install -m 0755 "$tmp/$name" "$plugins/docker-compose"
  install -m 0755 "$tmp/$name" "$bin/docker-compose"
  "$bin/docker-compose" version
}

install_buildctl() {
  name="buildkit-${BUILDKIT_VERSION}.linux-${goarch}.tar.gz"
  base="https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}"
  # buildkit publishes per-release provenance/SBOM but no plain checksum file;
  # pin the version and fetch over HTTPS from GitHub.
  fetch "$base/$name" "$tmp/$name"
  tar -C "$tmp" -xzf "$tmp/$name" bin/buildctl
  install -m 0755 "$tmp/bin/buildctl" "$bin/buildctl"
  buildctl --version
}

install_ruff() {
  name="ruff-${arch}-unknown-linux-gnu.tar.gz"
  base="https://github.com/astral-sh/ruff/releases/download/${RUFF_VERSION}"
  fetch "$base/$name.sha256" "$tmp/$name.sha256"
  fetch "$base/$name" "$tmp/$name" "$(cat "$tmp/$name.sha256")"
  tar -C "$tmp" -xzf "$tmp/$name"
  install -m 0755 "$tmp/ruff-${arch}-unknown-linux-gnu/ruff" "$bin/ruff"
  ruff --version
}

install_shellcheck() {
  if command -v shellcheck >/dev/null 2>&1; then shellcheck --version | head -2; return; fi
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends shellcheck >/dev/null
    rm -rf /var/lib/apt/lists/*
    shellcheck --version | head -2
  else
    echo "ci-install-tools: no apt-get, install shellcheck yourself" >&2
    exit 1
  fi
}

[ $# -gt 0 ] || { echo "usage: $0 docker|buildx|compose|buildctl|ruff|shellcheck ..." >&2; exit 2; }
for tool in "$@"; do
  case "$tool" in
    docker) install_docker ;;
    buildx) install_buildx ;;
    compose) install_compose ;;
    buildctl) install_buildctl ;;
    ruff) install_ruff ;;
    shellcheck) install_shellcheck ;;
    *) echo "ci-install-tools: unknown tool $tool" >&2; exit 2 ;;
  esac
done
