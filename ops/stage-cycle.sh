#!/bin/sh
# Staging chain (cycle 34 OP2): build, staging restart, warm-up, header checks, harness core then offline.
#   1. docker build of $YTM_SRC_DIR into $YTM_IMAGE:staging under flock $YTM_BUILD_LOCK, with
#      --build-arg VERSION=$(git rev-parse --short HEAD) (the version /api/v1/stats/library serves) and the
#      optional analytics build args (YTM_ANALYTICS_*, empty = none)
#   2. staging restart ($YTM_STAGING_COMPOSE, project $YTM_STAGING_PROJECT), warm-up, header checks
#   3. harness-core then harness-offline (timeout 900 s each, HARNESS_TIER=chain) on $YTM_STAGING_URL
# Promotes NOTHING: the promotion stays with finish-cycle.sh / promote.sh (SM2 guard), see ops/README.md.
# Usage (on the host, always detached with its own log, never "a && b &" inside an ssh session):
#   nohup sh ops/stage-cycle.sh > $YTM_LOG_DIR/ytm-stage-cycle<N>.log 2>&1 &
# Log convention: ytm-stage-cycle<N>.log, <N> = chain number. Reading:
#   grep -E "^(=== |PASS|FAIL|SKIP|Report|staging HTTP)" $YTM_LOG_DIR/ytm-stage-cycle<N>.log
# Editing the script while a chain runs: atomic replacement (write a temp file then mv), never in place.
set -u
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
. "$OPS_DIR/env.sh"
cd "$YTM_SRC_DIR" || { echo "BUILD_FAIL: source tree missing: $YTM_SRC_DIR"; exit 1; }
SHA=$(git rev-parse --short HEAD)
echo "=== build staging $(date -u +%H:%M:%S) HEAD $SHA ($YTM_SRC_DIR -> $YTM_IMAGE:staging) ==="
BLOG=$(mktemp "${TMPDIR:-/tmp}/ytm-build.XXXXXX")
# Optional analytics of the app (env.sh YTM_ANALYTICS_*): empty values build an app without any analytics script.
if ! flock "$YTM_BUILD_LOCK" docker build -q --build-arg VERSION="$SHA" \
    --build-arg PUBLIC_ANALYTICS_SRC="$YTM_ANALYTICS_SRC" --build-arg PUBLIC_ANALYTICS_WEBSITE_ID="$YTM_ANALYTICS_WEBSITE_ID" \
    --build-arg PUBLIC_ANALYTICS_HOST="$YTM_ANALYTICS_HOST" -t "$YTM_IMAGE:staging" . > "$BLOG" 2>&1; then
  tail -20 "$BLOG"; rm -f "$BLOG"; echo BUILD_FAIL; exit 1
fi
tail -3 "$BLOG"; rm -f "$BLOG"
ytm_staging_compose up -d 2>&1 | tail -1
sleep 6
# Warm-up: the first requests right after a container start were flaky (MediaError on first play).
Q=$(ytm_fixture_query); Q=${Q:-music}
for _ in 1 2 3; do
  ytm_curl "$YTM_STAGING_URL/api/v1/home.json" -s -o /dev/null
  ytm_curl "$YTM_STAGING_URL/api/v1/search.json?q=$(printf '%s' "$Q" | sed 's/ /+/g')" -s -o /dev/null
done
sleep 20
echo "staging HTTP $(ytm_curl "$YTM_STAGING_URL/home" -s -o /dev/null -w '%{http_code}') (image $(ytm_container_image "$YTM_STAGING_CONTAINER"))"
echo "=== headers ==="
for u in /home /api/v1/home.json /service-worker.js; do
  printf "%s -> " "$u"
  ytm_curl "$YTM_STAGING_URL$u" -s -o /dev/null -D - -H "Accept-Encoding: gzip, br" | grep -i "content-encoding\|cache-control\|^HTTP" | tr "\r\n" "  "; echo
done
A=$(ytm_curl "$YTM_STAGING_URL/home" -s -H "Accept-Encoding: gzip" --compressed | grep -o "/_app/immutable/[^\" ]*\.js" | head -1)
printf "%s -> " "$A"; ytm_curl "$YTM_STAGING_URL$A" -s -o /dev/null -D - -H "Accept-Encoding: gzip" | grep -i "content-encoding\|cache-control" | tr "\r\n" "  "; echo
# Range request on a local track (no acquisition: a lid of local/songs; informational like the lines above).
LID=$(ytm_curl "$YTM_STAGING_URL/api/v1/local/songs?limit=1" -s | python3 -c 'import json,sys;print(json.load(sys.stdin)["items"][0]["videoId"])' 2>/dev/null || true)
LU=""
[ -z "$LID" ] || LU=$(ytm_curl "$YTM_STAGING_URL/api/v1/player.json?videoId=$LID" -s -H "X-Ytm-Prefetch: 1" -A "Mozilla/5.0 (Macintosh) Chrome/128" | python3 -c 'import json,sys;d=json.load(sys.stdin);f=[x for x in (d.get("streamingData",{}).get("adaptiveFormats") or []) if str(x.get("url","")).startswith("/localf")];print(f[0]["url"] if f else "")' 2>/dev/null || true)
printf "range audio (lid %s) -> " "${LID:-none}"
if [ -n "$LU" ]; then ytm_curl "$YTM_STAGING_URL$LU" -s -o /dev/null -D - -H "Range: bytes=0-100" -H "Accept-Encoding: gzip" | grep -i "^HTTP\|content-encoding\|content-range" | tr "\r\n" "  "; else printf "no /localf url"; fi; echo
cd "$YTM_E2E_DIR" || { echo "e2e directory missing: $YTM_E2E_DIR"; exit 1; }
# c52c (B9-13): static self-check, no browser: every Playwright context under e2e/ sends X-Ytm-Harness: 1
# (a context without it writes real plays into the prod stats during the prod harness of finish-cycle.sh).
echo "=== HARNESS HEADER CHECK $(date -u +%H:%M:%S) ==="
node check-harness-headers.cjs || { echo "HARNESS_HEADER_CHECK_FAIL (see check-harness-headers.cjs; chain stopped before the harness)"; exit 1; }
# c47a (B8-14): staging chains play the chain tier (the full-only steps run on prod in finish-cycle.sh).
# The 900 s timeout is a net, not a target (budget 480 s; c53c B9-25: measured core durations 528 to 629 s).
echo "=== HARNESS CORE $(date -u +%H:%M:%S) (HARNESS_TIER=chain) ==="
HARNESS_TIER=chain timeout 900 ./run.sh "$YTM_STAGING_URL" "$YTM_QUERY" harness-core.cjs 2>&1 | grep -E "^(PASS|FAIL|SKIP|UPSTREAM|RETRY|Report|REFUSED)"
echo "=== HARNESS OFFLINE $(date -u +%H:%M:%S) ==="
HARNESS_TIER=chain timeout 900 ./run.sh "$YTM_STAGING_URL" "$YTM_QUERY" harness-offline.cjs 2>&1 | grep -E "^(PASS|FAIL|SKIP|UPSTREAM|RETRY|Report|REFUSED)"
