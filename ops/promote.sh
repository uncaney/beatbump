#!/bin/sh
# Promotion to PRODUCTION of the image tested on staging.
# Run ONLY after a green staging chain (harness core + offline) on $YTM_STAGING_URL (finish-cycle.sh does that).
#  - promotes the EXACT tested image ($YTM_IMAGE:staging) as $YTM_IMAGE:local, keeping the previous one under a
#    dated tag AND as a gzip tarball outside the Docker image store ($YTM_IMAGE_BACKUPS, 3 kept)
#  - writes the healthcheck block of the prod service (only when the image carries the label
#    $YTM_HEALTHCHECK_LABEL=1: the binary itself is the probe, `/app/beat-server -healthcheck`) and the env_file
#    of the secrets ($YTM_SECRETS_ENV_FILE, when present, mode 600 and holding COMPANION_SECRET_KEY=)
#  - recreates only the app service (no --deps), waits for HTTP 200 and the healthy state, probes the served
#    version and a Range /localf on a local track, prints the exact rollback commands, runs smoke.sh (HTTP +
#    browser, PROMOTE_SMOKE_BROWSER=0 to skip the browser)
# Usage: sh ops/promote.sh [expected short sha]   (without argument: the version the staging container serves,
#   if it runs on $YTM_IMAGE:staging)
# Exit codes (cycle 39 L11-2): 0 promoted and verified; 2 image backup FAILED (invalid tarball: the :local tag is
#   put back on the previous prod image, prod NOT recreated, no rotation); 3 promoted but prod HTTP != 200,
#   healthcheck not healthy in 75 s, served version unreadable or different from the expected one, or smoke
#   failed (ROLLBACK lines printed before, a block appended to $YTM_PROGRAM_DIR/ALERT.md on a failed smoke).
# A caller must read the exit code: never lose it in a pipe (`promote.sh | grep` returns grep's status).
set -eu
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
. "$OPS_DIR/env.sh"
TS=$(date -u +%Y%m%d-%H%M%S)
EXPECT="${1:-}"
[ -f "$YTM_COMPOSE_FILE" ] || { echo "prod compose file missing: $YTM_COMPOSE_FILE"; exit 1; }
STG_ID=$(ytm_image_id "$YTM_IMAGE:staging")
[ -n "$STG_ID" ] || { echo "$YTM_IMAGE:staging missing: nothing to promote"; exit 1; }
if [ -z "$EXPECT" ] && [ "$(ytm_container_image "$YTM_STAGING_CONTAINER")" = "$STG_ID" ]; then
  EXPECT=$(ytm_served_version "$YTM_STAGING_URL")
fi
PREV_VER=$(ytm_served_version "$YTM_PROD_URL")
PREV_ID=$(ytm_image_id "$YTM_IMAGE:local")
echo "promotion $TS: image $STG_ID (expected version ${EXPECT:-unknown}); current prod ${PREV_ID:-?} (version ${PREV_VER:-?})"
COMPOSE_DIR=$(dirname "$YTM_COMPOSE_FILE"); COMPOSE_BASE=$(basename "$YTM_COMPOSE_FILE")
cp "$YTM_COMPOSE_FILE" "$YTM_COMPOSE_FILE.pre-promote-$TS"
N=$(find "$COMPOSE_DIR" -maxdepth 1 -name "$COMPOSE_BASE.pre-promote-*" | wc -l)
find "$COMPOSE_DIR" -maxdepth 1 -name "$COMPOSE_BASE.pre-promote-*" -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d' ' -f2- | tr '\n' '\0' | xargs -0 -r rm -f --
echo "compose backups: $N -> $(find "$COMPOSE_DIR" -maxdepth 1 -name "$COMPOSE_BASE.pre-promote-*" | wc -l) (10 most recent kept)"
# c43c B7-14: healthcheck block of the app service (added / kept / removed according to the image label).
HC_LABEL=$(docker image inspect -f "{{index .Config.Labels \"$YTM_HEALTHCHECK_LABEL\"}}" "$YTM_IMAGE:staging" 2>/dev/null || true)
HC_LABEL="$HC_LABEL" YTM_COMPOSE_FILE="$YTM_COMPOSE_FILE" YTM_COMPOSE_SERVICE="$YTM_COMPOSE_SERVICE" YTM_HEALTHCHECK_LABEL="$YTM_HEALTHCHECK_LABEL" python3 - <<"PY"
import os, pathlib, re, sys
p = pathlib.Path(os.environ["YTM_COMPOSE_FILE"]); s = p.read_text()
svc = os.environ["YTM_COMPOSE_SERVICE"]; label = os.environ["YTM_HEALTHCHECK_LABEL"]
want = os.environ.get("HC_LABEL", "") == "1"
m = re.search(r"(?m)^  %s:\n" % re.escape(svc), s)
if not m: print("service %s not found in the prod compose file" % svc); sys.exit(1)
start = m.end()
e = re.search(r"(?m)^(  \S|\S)", s[start:])
end = start + e.start() if e else len(s)
block = s[start:end]
has = re.search(r"(?m)^    healthcheck:\n", block) is not None
hc = ("    healthcheck:\n"
      "      test: [\"CMD\", \"/app/beat-server\", \"-healthcheck\"]\n"
      "      interval: 30s\n"
      "      timeout: 5s\n"
      "      retries: 3\n"
      "      start_period: 20s\n")
if want and not has:
    anchor = "    restart: unless-stopped\n"
    if anchor not in block: print("anchor 'restart: unless-stopped' not found in service %s" % svc); sys.exit(1)
    block = block.replace(anchor, anchor + hc, 1)
    print("prod compose: healthcheck block added (beat-server -healthcheck, 30s/5s/3/20s)")
elif want:
    print("prod compose: healthcheck block already present")
elif has:
    block = re.sub(r"(?m)^    healthcheck:\n(?:      .*\n)*", "", block, count=1)
    print("prod compose: healthcheck block REMOVED (image without the label %s)" % label)
else:
    print("prod compose: no healthcheck (image without the label %s: binary without -healthcheck)" % label)
p.write_text(s[:start] + block + s[end:])
PY
# c59c (decisions 15 and 17): env_file of the app service (secrets out of the compose file: COMPANION_SECRET_KEY,
# YTM_ADMIN_TOKEN, YTM_REPORT_EMAIL in $YTM_SECRETS_ENV_FILE, mode 600). Added idempotently ONLY when the file
# exists, is mode 600 and carries COMPANION_SECRET_KEY=; a clear-text COMPANION_SECRET_KEY line is then removed
# from the compose file (the value comes from the file). Without a valid file: compose unchanged (message).
YTM_COMPOSE_FILE="$YTM_COMPOSE_FILE" YTM_COMPOSE_SERVICE="$YTM_COMPOSE_SERVICE" YTM_SECRETS_ENV_FILE="$YTM_SECRETS_ENV_FILE" python3 - <<"PY"
import os, pathlib, re, stat, sys
ENV = os.environ["YTM_SECRETS_ENV_FILE"]; svc = os.environ["YTM_COMPOSE_SERVICE"]
p = pathlib.Path(os.environ["YTM_COMPOSE_FILE"]); s = p.read_text()
m = re.search(r"(?m)^  %s:\n" % re.escape(svc), s)
if not m: print("service %s not found in the prod compose file" % svc); sys.exit(1)
start = m.end()
e = re.search(r"(?m)^(  \S|\S)", s[start:])
end = start + e.start() if e else len(s)
block = s[start:end]
try:
    st = os.stat(ENV)
    ok = stat.S_ISREG(st.st_mode) and (st.st_mode & 0o077) == 0 and "COMPANION_SECRET_KEY=" in pathlib.Path(ENV).read_text()
except OSError:
    ok = False
if not ok:
    print("prod compose: env_file NOT wired (%s absent, mode != 600 or without COMPANION_SECRET_KEY=): compose unchanged" % ENV)
    sys.exit(0)
ef = "    env_file:\n      - %s\n" % ENV
if "    env_file:\n" not in block:
    anchor = "    environment:\n"
    if anchor not in block: print("anchor 'environment:' not found in service %s" % svc); sys.exit(1)
    block = block.replace(anchor, ef + anchor, 1)
    print("prod compose: env_file added (%s)" % ENV)
else:
    print("prod compose: env_file already present")
n = len(re.findall(r"(?m)^      COMPANION_SECRET_KEY: .*\n", block))
if n:
    block = re.sub(r"(?m)^      COMPANION_SECRET_KEY: .*\n", "", block)
    print("prod compose: %d clear-text COMPANION_SECRET_KEY line(s) removed (value in env_file)" % n)
p.write_text(s[:start] + block + s[end:])
PY
ytm_compose config -q && echo "prod compose valid"
# Rollback safety: keep the current prod image under a dated tag AND as a tarball outside the Docker image
# store (an image prune on the host deleted the previous backup tags on 2026-10-01).
if [ -n "$PREV_ID" ]; then
  docker tag "$YTM_IMAGE:local" "$YTM_IMAGE:prod-backup-$TS"
  BACKUP_TAG="$YTM_IMAGE:prod-backup-$TS"
else
  echo "WARNING: $YTM_IMAGE:local missing from the store (pruned image): no backup tag, only the previous tarball counts"
  BACKUP_TAG=""
fi
docker tag "$YTM_IMAGE:staging" "$YTM_IMAGE:local"
BK="$YTM_IMAGE_BACKUPS"
mkdir -p "$BK"
TAR="$BK/$YTM_BACKUP_PREFIX-$TS-$STG_ID.tar.gz"
# L11-2: docker save -o (no pipe: a docker save failure is no longer hidden by gzip), gzip -t and size > 10 MB
# BEFORE the tarball gets its final name; the rotation (3 most recent) runs only when the new one is valid.
if docker save -o "$TAR.tmp.tar" "$YTM_IMAGE:local" && gzip -1 "$TAR.tmp.tar" && gzip -t "$TAR.tmp.tar.gz" \
   && [ "$(wc -c < "$TAR.tmp.tar.gz")" -gt 10485760 ] && mv "$TAR.tmp.tar.gz" "$TAR"; then
  echo "image saved (gzip -t ok, $(wc -c < "$TAR") bytes): $TAR"
  find "$BK" -maxdepth 1 -name "$YTM_BACKUP_PREFIX-*.tar.gz" -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | tr '\n' '\0' | xargs -0 -r rm -f --
else
  rm -f "$TAR.tmp.tar" "$TAR.tmp.tar.gz"
  echo "!!!!! WARNING: image backup FAILED ($TAR: docker save, gzip, gzip -t or size <= 10 MB): rotation cancelled, prod NOT recreated !!!!!"
  if [ -n "$BACKUP_TAG" ]; then docker tag "$BACKUP_TAG" "$YTM_IMAGE:local" && echo "$YTM_IMAGE:local put back on $BACKUP_TAG (${PREV_ID:-?})"
  else echo "!!!!! WARNING: no backup tag: $YTM_IMAGE:local points at the staging image $STG_ID but the prod container was not recreated"; fi
  echo "check the disk space: df -h $BK ; then run promote.sh again (exit 2)"
  exit 2
fi
# c52c (B9-19 / B9-22): access log of the prod container copied BEFORE it is recreated (docker logs restart from
# zero with the new container): the perf audit (e2e/perf-audit/log-latency.py) keeps the history between
# promotions. Name: access-<date>-<old image id>.log; 10 files kept; a failure does not block (timeout 60 s).
ALOG_DIR="$YTM_PROGRAM_DIR/logs"
mkdir -p "$ALOG_DIR"
ALOG="$ALOG_DIR/access-$TS-${PREV_ID:-unknown}.log"
if timeout 60 docker logs "$YTM_PROD_CONTAINER" > "$ALOG" 2>&1; then
  echo "access log copied: $ALOG ($(wc -c < "$ALOG") bytes, $(wc -l < "$ALOG") lines)"
else
  echo "WARNING: access log copy failed ($ALOG): promotion goes on"
fi
find "$ALOG_DIR" -maxdepth 1 -name 'access-*.log' -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d' ' -f2- | tr '\n' '\0' | xargs -0 -r rm -f --
ytm_compose up -d --no-deps "$YTM_COMPOSE_SERVICE"
FAIL=""
c=000
for _ in 1 2 3 4 5 6 7 8; do
  c=$(ytm_curl "$YTM_PROD_URL/" -s -o /dev/null -w "%{http_code}" --max-time 8 -A "Mozilla/5.0 (Macintosh) Chrome/128" || true)
  [ "$c" = "200" ] && break; sleep 5
done
echo "prod HTTP $c"
[ "$c" = "200" ] || { echo "!!!!! WARNING: prod HTTP $c (expected 200): ROLLBACK below !!!!!"; FAIL="$FAIL http"; }
# c43c B7-14: docker healthcheck state (only when the compose file has one: .State.Health absent otherwise).
HS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$YTM_PROD_CONTAINER" 2>/dev/null || true)
if [ -n "$HS" ]; then
  for _ in $(seq 1 15); do
    [ "$HS" = healthy ] && break
    sleep 5
    HS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$YTM_PROD_CONTAINER" 2>/dev/null || true)
  done
  if [ "$HS" = healthy ]; then echo "prod healthcheck: healthy"
  else
    echo "!!!!! WARNING: prod healthcheck '$HS' after 75 s (expected healthy): ROLLBACK below !!!!!"
    docker inspect -f '{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{printf "%.120s" .Output}}{{"\n"}}{{end}}' "$YTM_PROD_CONTAINER" 2>/dev/null | tail -3 | sed 's/^/  healthcheck log: /' || true
    FAIL="$FAIL healthcheck"
  fi
else
  echo "prod healthcheck: none (compose file without a healthcheck block)"
fi
# Final probe WITHOUT acquisition (OP3): stats/library, then a Range /localf on a LOCAL track (lid of
# local/songs; player.json with a lid answers from the local index, before any acquisition).
STATS=$(ytm_curl "$YTM_PROD_URL/api/v1/stats/library" -s --max-time 15 || true)
echo "prod stats/library: $STATS"
SERVED=$(printf '%s' "$STATS" | ytm_json_get version)
LID=$(ytm_curl "$YTM_PROD_URL/api/v1/local/songs?limit=1" -s --max-time 15 | python3 -c 'import json,sys;print(json.load(sys.stdin)["items"][0]["videoId"])' 2>/dev/null || true)
U=$(ytm_curl "$YTM_PROD_URL/api/v1/player.json?videoId=$LID" -s --max-time 30 -H "X-Ytm-Prefetch: 1" -A "Mozilla/5.0 (Macintosh) Chrome/128" | python3 -c 'import json,sys;d=json.load(sys.stdin);f=[x for x in (d.get("streamingData",{}).get("adaptiveFormats") or []) if str(x.get("url","")).startswith("/localf")];print(f[0]["url"] if f else "")' 2>/dev/null || true)
printf "prod local track %s url: %.80s\n" "${LID:-?}" "$U"
ytm_curl "$YTM_PROD_URL$U" -s -o /dev/null -D - --max-time 30 -A "Mozilla/5.0 (Macintosh) Chrome/128" -r 0-1023 | grep -iE "^HTTP|content-type|accept-ranges|content-range|x-ytm" || echo "!!!!! WARNING: no Range answer on /localf (lid=${LID:-absent})"
if [ -z "$SERVED" ]; then echo "!!!!! WARNING: served version unreadable on stats/library: check, ROLLBACK below if needed"; FAIL="$FAIL version-unreadable"
elif [ -z "$EXPECT" ]; then echo "served version = $SERVED (expected version unknown: pass the sha as argument to check it)"
elif [ "$SERVED" = "$EXPECT" ]; then echo "served version = $SERVED OK"
else echo "!!!!! WARNING: served version $SERVED != expected $EXPECT: prod does NOT serve the tested image, ROLLBACK below !!!!!"; FAIL="$FAIL version"; fi
[ "$STG_ID" = "${PREV_ID:-}" ] && echo "!!!!! WARNING: $YTM_IMAGE:staging = previous prod image ($STG_ID): nothing was promoted"
PREV_TAR=$(find "$BK" -maxdepth 1 -name "$YTM_BACKUP_PREFIX-*-${PREV_ID:-none}.tar.gz" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)
[ -n "$PREV_TAR" ] || PREV_TAR=$(find "$BK" -maxdepth 1 -name "$YTM_BACKUP_PREFIX-*.tar.gz" -printf '%T@ %p\n' 2>/dev/null | sort -rn | sed -n 2p | cut -d' ' -f2- || true)
[ -z "$PREV_TAR" ] || gzip -t "$PREV_TAR" 2>/dev/null || echo "!!!!! WARNING: previous tarball $PREV_TAR unreadable (gzip -t): rollback by tag only"
COMPOSE_UP="docker compose${YTM_COMPOSE_PROJECT:+ -p $YTM_COMPOSE_PROJECT} -f \"$YTM_COMPOSE_FILE\" up -d --no-deps $YTM_COMPOSE_SERVICE"
echo "ROLLBACK (back to ${PREV_ID:-?} version ${PREV_VER:-?}):"
if [ -n "$BACKUP_TAG" ]; then
  echo "  by tag: docker tag $BACKUP_TAG $YTM_IMAGE:local && cp \"$YTM_COMPOSE_FILE.pre-promote-$TS\" \"$YTM_COMPOSE_FILE\" && $COMPOSE_UP"
fi
echo "  by tarball: docker load -i \"${PREV_TAR:-<previous tarball not found>}\" && docker tag ${PREV_ID:-<image>} $YTM_IMAGE:local && cp \"$YTM_COMPOSE_FILE.pre-promote-$TS\" \"$YTM_COMPOSE_FILE\" && $COMPOSE_UP"
echo "  check: curl -s $(ytm_resolve_args "$YTM_PROD_URL") $YTM_PROD_URL/api/v1/stats/library  (expected version ${PREV_VER:-?})"
if [ -f "$OPS_DIR/smoke.sh" ]; then
  # c43c B7-15: HTTP + browser smoke (SMOKE_BROWSER=1; YTM_RUN_SKIP_BUILD_WAIT=1 because finish-cycle.sh holds
  # $YTM_BUILD_LOCK around promote.sh and run.sh would wait 900 s for "the build"). Output kept in a file for the
  # ALERT.md block, then printed in full.
  SMOKE_LOG=$(mktemp "${TMPDIR:-/tmp}/ytm-promote-smoke.XXXXXX")
  if SMOKE_BROWSER="${PROMOTE_SMOKE_BROWSER:-1}" YTM_RUN_SKIP_BUILD_WAIT=1 sh "$OPS_DIR/smoke.sh" "$YTM_PROD_URL" ${EXPECT:+"$EXPECT"} >"$SMOKE_LOG" 2>&1; then
    cat "$SMOKE_LOG"; echo "smoke 0 failure"
  else
    cat "$SMOKE_LOG"
    echo "!!!!! WARNING: smoke failed (details above): decide on the ROLLBACK !!!!!"; FAIL="$FAIL smoke"
    ALERT=$(ytm_alert_file)
    {
      printf '\n## %s UTC (promote.sh)\n' "$(date -u +"%Y-%m-%d %H:%M")"
      printf -- '- reasons: smoke failed after promotion %s (image %s, expected version %s): promoted but not healthy (exit 3), ROLLBACK to decide\n' "$TS" "$STG_ID" "${EXPECT:-unknown}"
      grep -E '^(FAIL|SKIP|SMOKE) ' "$SMOKE_LOG" | sed 's/^/- /' || true
    } >> "$ALERT"
    echo "block appended to $ALERT"
  fi
  rm -f "$SMOKE_LOG"
fi
if [ -n "$FAIL" ]; then
  echo "!!!!! WARNING: promotion $TS FAILED (${FAIL# }): apply a ROLLBACK line above (exit 3) !!!!!"
  exit 3
fi
echo "promotion $TS OK (exit 0)"
