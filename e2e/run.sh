#!/bin/sh
# Harness navigateur reel pour music.ekaii.fr / staging-music.ekaii.fr, lance DEPUIS la box.
#  - --network host : IP source interne => nopasaran ALLOW (pas de PoW), et 127.0.0.1:443 = Traefik.
#  - --host-resolver-rules : contourne le hairpin NAT casse (les *.ekaii.fr pointent vers la WAN).
#  - image node Playwright (navigateurs + deps inclus), playwright npm installe une fois dans e2e/.
# Usage: run.sh [url] [query] [harness]   ex: run.sh https://staging-music.ekaii.fr "daft punk" harness-core.cjs
# Exit 2 = another ytm-harness-* container is running (nothing launched).
set -eu
E2E=/srv/beatbump/e2e
URL="${1:-https://staging-music.ekaii.fr}"
QUERY="${2:-daft punk}"
HARNESS="${3:-harness.cjs}"
# Cycle 34 HD3 guards (RUNBOOK 6.3 / 6.4): one browser at a time, never during a staging build,
# never on an overloaded box (Chrome loses the network above ~40: ERR_CERT_VERIFIER_CHANGED).
BUILD_LOCK=/tmp/beatbump-build.lock
LOAD_MAX=60
WAIT_MAX=900
other_harness() { docker ps --filter "name=ytm-harness-" --format '{{.Names}}' 2>/dev/null | grep -E '^ytm-harness-' | head -1; }
refuse_if_other() {
  O=$(other_harness)
  if [ -n "$O" ]; then
    echo "REFUS: un autre harness tourne deja ($O) ; un seul navigateur a la fois sur la box (RUNBOOK 6.3)." >&2
    exit 2
  fi
}
# c43c B7-15: YTM_RUN_SKIP_BUILD_WAIT=1 skips the build-lock wait only. promote.sh runs under
# `flock /tmp/beatbump-build.lock` (finish-cycle.sh) and calls smoke.sh -> run.sh for the browser
# smoke: the lock is held by the caller, not by a build. The one-harness and load guards stay.
build_running() { [ "${YTM_RUN_SKIP_BUILD_WAIT:-}" != 1 ] && command -v flock >/dev/null 2>&1 && [ -e "$BUILD_LOCK" ] && ! flock -n "$BUILD_LOCK" true 2>/dev/null; }
load_high() { awk -v m="$LOAD_MAX" '{ exit !($1 > m) }' /proc/loadavg 2>/dev/null; }
refuse_if_other
W=0
while build_running || load_high; do
  if [ "$W" -ge "$WAIT_MAX" ]; then
    echo "ATTENTION: attente de ${WAIT_MAX} s ecoulee (build=$(build_running && echo oui || echo non), load=$(cut -d' ' -f1 /proc/loadavg)) : lancement quand meme, resultats a lire avec prudence" >&2
    break
  fi
  if build_running; then echo "attente du build ($BUILD_LOCK tenu) ${W}s / ${WAIT_MAX}s"; else echo "attente de la charge (load 1 min $(cut -d' ' -f1 /proc/loadavg) > $LOAD_MAX) ${W}s / ${WAIT_MAX}s"; fi
  sleep 30; W=$((W + 30))
done
refuse_if_other
TS=$(date -u +%Y%m%d-%H%M%S)
OUT="$E2E/out/$TS"
mkdir -p "$OUT"
IMG=mcr.microsoft.com/playwright:v1.47.0-jammy
# Real Google Chrome (AAC/H.264): the stock Chromium cannot decode the m4a served by iv-vp (/aud).
CHROME_IMG=ytm-harness-chrome:1.47.0
if ! docker image inspect "$CHROME_IMG" >/dev/null 2>&1; then
  echo "image $CHROME_IMG absente (elaguee ?) : reconstruction"
  docker build -q -t "$CHROME_IMG" "$E2E/chrome-image" >/dev/null 2>&1 || true
fi
if docker image inspect "$CHROME_IMG" >/dev/null 2>&1; then IMG="$CHROME_IMG"; export PW_CHANNEL=chrome; else echo "ATTENTION: harness sur Chromium sans codecs AAC"; fi
if [ ! -d "$E2E/node_modules/playwright" ]; then
  docker run --rm -v "$E2E:/e2e" -w /e2e "$IMG" sh -c "npm i --no-save --no-audit --no-fund playwright@1.47.0 >/dev/null 2>&1 && echo playwright npm installe"
fi
trap "docker rm -f ytm-harness-$TS >/dev/null 2>&1" EXIT INT TERM
# c43c B7-15: YTM_SMOKE_EXPECT (expected served sha) reaches harness-smoke.cjs; run.sh passes no extra argv.
# c47a B8-14: HARNESS_TIER=chain|full (default chain; finish-cycle.sh passes full for the prod harness) and
# HARNESS_ONLY=a,b (play the named steps only) reach harness-core.cjs / harness-offline.cjs the same way.
docker run --rm --name "ytm-harness-$TS" --network host -e PW_CHANNEL="${PW_CHANNEL:-}" -e YTM_SMOKE_EXPECT="${YTM_SMOKE_EXPECT:-}" -e HARNESS_TIER="${HARNESS_TIER:-chain}" -e HARNESS_ONLY="${HARNESS_ONLY:-}" -v "$E2E:/e2e" -w /e2e \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  "$IMG" node "$HARNESS" --url="$URL" --out="/e2e/out/$TS" --query="$QUERY" --repeat=1 \
  --resolver="MAP *.ekaii.fr 127.0.0.1, MAP *.example.org 127.0.0.1"
echo "rapport: $OUT/report.json"
