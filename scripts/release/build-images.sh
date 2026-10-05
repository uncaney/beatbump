#!/usr/bin/env bash
# build-images.sh TAG
# Build (and by default push) the four images of a release:
#   $REGISTRY/$IMAGE_NS:TAG           root Dockerfile (SvelteKit app + Go server)
#   $REGISTRY/$IMAGE_NS-bridge:TAG    bridge/
#   $REGISTRY/$IMAGE_NS-indexer:TAG   indexer/
#   $REGISTRY/$IMAGE_NS-yubal:TAG     yubal/
# each also tagged :latest unless LATEST=0. linux/amd64 only: the root image
# copies the x86_64 musl loader for ffmpeg and yubal downloads an x86_64 deno.
#
# Environment:
#   REGISTRY      default forgejo.ekaii.fr
#   IMAGE_NS      default ekaii/beatbump
#   PUSH          1 (default) pushes; 0 builds only (loads into the local
#                 daemon when there is one)
#   LATEST        1 (default) also tags :latest
#   ONLY          space-separated subset of: beatbump bridge indexer yubal
#   BUILDKIT_ADDR address of a BuildKit daemon (tcp://host:1234) used through
#                 buildctl when no Docker daemon is reachable (CI on the
#                 hardened Forgejo runner); registry auth comes from
#                 ~/.docker/config.json written by `docker login`.
#
# Builder selection, in order: BUILDKIT_ADDR + buildctl, else a reachable
# Docker daemon with buildx, else fail with a pointer to scripts/release/README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

tag=${1:?tag}
REGISTRY=${REGISTRY:-forgejo.ekaii.fr}
IMAGE_NS=${IMAGE_NS:-ekaii/beatbump}
PUSH=${PUSH:-1}
LATEST=${LATEST:-1}
ONLY=${ONLY:-beatbump bridge indexer yubal}
PLATFORM=${PLATFORM:-linux/amd64}

sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
short=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_url=${SOURCE_URL:-https://forgejo.ekaii.fr/Ekaii/beatbump}
# Served by /api/v1/stats/library and /about (main.version via -ldflags).
app_version="${tag}+${short}"

labels=(
  "org.opencontainers.image.source=$source_url"
  "org.opencontainers.image.revision=$sha"
  "org.opencontainers.image.version=${tag#v}"
  "org.opencontainers.image.created=$created"
  "org.opencontainers.image.licenses=AGPL-3.0"
)

mode=""
if [ -n "${BUILDKIT_ADDR:-}" ] && command -v buildctl >/dev/null 2>&1; then
  mode=buildctl
  buildctl --addr "$BUILDKIT_ADDR" debug workers >/dev/null || {
    echo "build-images: BuildKit at $BUILDKIT_ADDR is not answering" >&2
    exit 1
  }
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  mode=buildx
  docker buildx version >/dev/null 2>&1 || { echo "build-images: docker buildx plugin missing" >&2; exit 1; }
else
  cat >&2 <<EOF
build-images: no builder available.
  - set BUILDKIT_ADDR=tcp://<buildkitd>:1234 and install buildctl
    (scripts/release/ci-install-tools.sh buildctl), or
  - run where a Docker daemon is reachable (docker info works).
See scripts/release/README.md, section "Image builds".
EOF
  exit 1
fi
echo "build-images: $tag (${app_version}) via $mode, push=$PUSH, platform=$PLATFORM"

build_one() { # build_one NAME CONTEXT [build-arg...]
  local name=$1 ctx=$2; shift 2
  local image="$REGISTRY/$IMAGE_NS"
  [ "$name" = beatbump ] || image="$image-$name"
  local tags=("$image:$tag")
  [ "$LATEST" = 1 ] && tags+=("$image:latest")
  echo "== $name ($ctx) -> ${tags[*]}"
  if [ "$mode" = buildctl ]; then
    local opts=() names push_flag=false output
    for a in "$@"; do opts+=(--opt "build-arg:$a"); done
    for l in "${labels[@]}"; do opts+=(--opt "label:$l"); done
    names=$(IFS=,; echo "${tags[*]}")
    [ "$PUSH" = 1 ] && push_flag=true
    output="type=image,\"name=${names}\",push=${push_flag}"
    buildctl --addr "$BUILDKIT_ADDR" build \
      --frontend dockerfile.v0 \
      --local context="$ctx" --local dockerfile="$ctx" \
      --opt platform="$PLATFORM" \
      "${opts[@]}" \
      --output "$output" \
      --progress plain
  else
    local args=()
    for a in "$@"; do args+=(--build-arg "$a"); done
    for l in "${labels[@]}"; do args+=(--label "$l"); done
    for t in "${tags[@]}"; do args+=(--tag "$t"); done
    if [ "$PUSH" = 1 ]; then args+=(--push); else args+=(--load); fi
    docker buildx build --platform "$PLATFORM" --file "$ctx/Dockerfile" "${args[@]}" "$ctx"
  fi
}

for name in $ONLY; do
  case "$name" in
    beatbump) build_one beatbump . "VERSION=$app_version" ;;
    bridge) build_one bridge bridge ;;
    indexer) build_one indexer indexer ;;
    yubal) build_one yubal yubal ;;
    *) echo "build-images: unknown image $name" >&2; exit 2 ;;
  esac
done
echo "build-images: done"
