#!/bin/sh
# Real-browser harness runner: Playwright inside the mcr.microsoft.com/playwright image, Google Chrome channel
# when the local image ytm-harness-chrome:<ver> exists (built from chrome-image/: AAC/H.264 decoding, which the
# stock Chromium lacks). The container runs with --network host so http://127.0.0.1:<port> targets work.
#
# Usage: run.sh [url] [query] [harness] [extra harness args...]
#   url      target, any http(s) URL (default $YTM_URL, else http://127.0.0.1:8080)
#   query    search query; empty = the "query" key of the fixtures file
#   harness  entry point under this directory (default harness-core.cjs)
#   example: HARNESS_TIER=chain ./run.sh http://127.0.0.1:18080 "" harness-core.cjs
# Environment:
#   HARNESS_TIER=chain|full, HARNESS_ONLY=a,b   forwarded to the harness (see harness-core.cjs)
#   HARNESS_FIXTURES=<file>                     fixtures file instead of fixtures.json (absolute or relative to here)
#   HARNESS_RESOLVER="MAP *.example.org 127.0.0.1"  Chrome --host-resolver-rules, used only when the URL host is a
#                                               name (not an IP): for a box whose hairpin NAT is broken
#   HARNESS_RESOLVE_IP=127.0.0.1                where Node-side requests of the harness connect for that name
#                                               (SNI + Host kept); defaults to the IP of a single-IP HARNESS_RESOLVER
#   YTM_SMOKE_EXPECT=<sha>                      expected served version (harness-smoke.cjs)
#   YTM_RUN_SKIP_BUILD_WAIT=1                   do not wait for the build lock (the caller holds it: promote.sh)
#   YTM_BUILD_LOCK (default /tmp/beatbump-build.lock), HARNESS_LOAD_MAX (default 60), HARNESS_WAIT_MAX (default 900 s)
#   HARNESS_IMAGE, HARNESS_CHROME_IMAGE         image overrides (defaults below)
# Guards: one browser at a time on the host (another ytm-harness-* container => exit 2, nothing launched), never
# during a build (the lock is held), never on an overloaded host (Chrome loses the network above ~40:
# ERR_CERT_VERIFIER_CHANGED). Output: out/<timestamp>/ next to this script, "report: <path>/report.json" last.
set -eu
E2E=$(cd "$(dirname "$0")" && pwd)
URL="${1:-${YTM_URL:-http://127.0.0.1:8080}}"
QUERY="${2:-}"
HARNESS="${3:-harness-core.cjs}"
if [ $# -gt 3 ]; then shift 3; else shift $#; fi
BUILD_LOCK="${YTM_BUILD_LOCK:-/tmp/beatbump-build.lock}"
LOAD_MAX="${HARNESS_LOAD_MAX:-60}"
WAIT_MAX="${HARNESS_WAIT_MAX:-900}"
PW_VERSION=1.47.0
IMG="${HARNESS_IMAGE:-mcr.microsoft.com/playwright:v$PW_VERSION-jammy}"
CHROME_IMG="${HARNESS_CHROME_IMAGE:-ytm-harness-chrome:$PW_VERSION}"
[ -f "$E2E/$HARNESS" ] || { echo "run.sh: harness not found: $E2E/$HARNESS" >&2; exit 1; }

other_harness() { docker ps --filter "name=ytm-harness-" --format '{{.Names}}' 2>/dev/null | grep -E '^ytm-harness-' | head -1; }
refuse_if_other() {
  O=$(other_harness)
  if [ -n "$O" ]; then
    echo "REFUSED: another harness is already running ($O); one browser at a time on this host." >&2
    exit 2
  fi
}
build_running() { [ "${YTM_RUN_SKIP_BUILD_WAIT:-}" != 1 ] && command -v flock >/dev/null 2>&1 && [ -e "$BUILD_LOCK" ] && ! flock -n "$BUILD_LOCK" true 2>/dev/null; }
load_high() { awk -v m="$LOAD_MAX" '{ exit !($1 > m) }' /proc/loadavg 2>/dev/null; }
refuse_if_other
W=0
while build_running || load_high; do
  if [ "$W" -ge "$WAIT_MAX" ]; then
    echo "WARNING: waited ${WAIT_MAX} s (build=$(build_running && echo yes || echo no), load=$(cut -d' ' -f1 /proc/loadavg)): launching anyway, read the results with care" >&2
    break
  fi
  if build_running; then echo "waiting for the build ($BUILD_LOCK held) ${W}s / ${WAIT_MAX}s"; else echo "waiting for the load to drop (1 min load $(cut -d' ' -f1 /proc/loadavg) > $LOAD_MAX) ${W}s / ${WAIT_MAX}s"; fi
  sleep 30; W=$((W + 30))
done
refuse_if_other

TS=$(date -u +%Y%m%d-%H%M%S)
OUT="$E2E/out/$TS"
mkdir -p "$OUT"
if ! docker image inspect "$CHROME_IMG" >/dev/null 2>&1; then
  echo "image $CHROME_IMG missing (pruned?): rebuilding from chrome-image/"
  docker build -q -t "$CHROME_IMG" "$E2E/chrome-image" >/dev/null 2>&1 || true
fi
if docker image inspect "$CHROME_IMG" >/dev/null 2>&1; then IMG="$CHROME_IMG"; export PW_CHANNEL=chrome; else echo "WARNING: running on Chromium without AAC codecs (playback steps may fail)" >&2; fi
if [ ! -d "$E2E/node_modules/playwright" ]; then
  docker run --rm -v "$E2E:/e2e" -w /e2e "$IMG" sh -c "npm i --no-save --no-audit --no-fund playwright@$PW_VERSION >/dev/null 2>&1 && echo playwright npm installed"
fi

# Resolver only for a named host (an IP target needs none); HARNESS_RESOLVE_IP defaults to the single IP of the rules.
HOSTNAME_PART=$(printf '%s' "$URL" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##; s#^\[(.*)\]$#\1#')
RESOLVER=""; RESOLVE_IP="${HARNESS_RESOLVE_IP:-}"
if printf '%s' "$HOSTNAME_PART" | grep -Eq '^[0-9.]+$|^[0-9a-fA-F:]+$'; then
  RESOLVE_IP=""
elif [ -n "${HARNESS_RESOLVER:-}" ]; then
  RESOLVER="$HARNESS_RESOLVER"
  [ -n "$RESOLVE_IP" ] || RESOLVE_IP=$(printf '%s' "$HARNESS_RESOLVER" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | sort -u | { read -r a; read -r b || true; [ -z "${b:-}" ] && printf '%s' "$a"; } || true)
fi
# Fixtures: fixtures.json next to this script, or HARNESS_FIXTURES; mounted read-only at a fixed path in the
# container (a file bind mount inside the /e2e bind mount), named to the harness through HARNESS_FIXTURES.
FIX_SRC="$E2E/fixtures.json"
if [ -n "${HARNESS_FIXTURES:-}" ]; then
  FIX_SRC="$HARNESS_FIXTURES"; case "$FIX_SRC" in /*) ;; *) FIX_SRC="$E2E/$FIX_SRC" ;; esac
  [ -f "$FIX_SRC" ] || { echo "run.sh: HARNESS_FIXTURES not found: $FIX_SRC" >&2; exit 1; }
fi
[ -f "$FIX_SRC" ] || { echo "run.sh: fixtures file not found: $FIX_SRC" >&2; exit 1; }
echo "fixtures: $FIX_SRC"

# Harness arguments (built with set -- so that a query with spaces stays one argument).
[ -z "$RESOLVER" ] || set -- --resolver="$RESOLVER" "$@"
[ -z "$QUERY" ] || set -- --query="$QUERY" "$@"
trap 'docker rm -f "ytm-harness-$TS" >/dev/null 2>&1' EXIT INT TERM
docker run --rm --name "ytm-harness-$TS" --network host \
  -e PW_CHANNEL="${PW_CHANNEL:-}" -e YTM_SMOKE_EXPECT="${YTM_SMOKE_EXPECT:-}" \
  -e HARNESS_TIER="${HARNESS_TIER:-chain}" -e HARNESS_ONLY="${HARNESS_ONLY:-}" \
  -e HARNESS_FIXTURES=/e2e/.fixtures.json -e HARNESS_RESOLVE_IP="$RESOLVE_IP" \
  -e HARNESS_GOTO_QUIET_MS="${HARNESS_GOTO_QUIET_MS:-}" -e HARNESS_GOTO_CAP_MS="${HARNESS_GOTO_CAP_MS:-}" \
  -e HARNESS_STATS_INCLUDE_HARNESS="${HARNESS_STATS_INCLUDE_HARNESS:-}" \
  -v "$E2E:/e2e" -v "$FIX_SRC:/e2e/.fixtures.json:ro" -w /e2e -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  "$IMG" node "$HARNESS" --url="$URL" --out="/e2e/out/$TS" --repeat=1 "$@"
echo "report: $OUT/report.json"
