#!/bin/sh
# Smoke test SM1 (cycle 34) of a running instance, from the host.
#   - no browser, read-only (GET), no acquisition: only LOCAL ids (lid / lb-), player.json is called with a lid
#     only (LocalPlayer branch, answers before any acquisition); a search does not trigger an acquisition.
#   - any http(s) URL; YTM_RESOLVE_IP (env.sh) for a named host whose hairpin route is broken; budget 90 s.
# Usage: sh ops/smoke.sh <base url> [expected version]
#   one "OK|FAIL <check>: detail" line per check, then "SMOKE <host> version=<v>: <n> ok, <m> failure(s) in <s> s";
#   exit 1 when at least one check failed (every check is still played), 2 on usage.
# Optional environment (cycle 43, lane c43c, B7-15 / B7-16):
#   SMOKE_BROWSER=1  12th check "smoke_browser" = e2e/harness-smoke.cjs through e2e/run.sh (real browser, < 90 s:
#     home + first personal row, playback of the fixture lid, service worker registered, served version = expected).
#     One browser at a time on the host: when a ytm-harness-* container already runs (or run.sh refuses, exit 2)
#     the check is SKIPPED with a "SKIP smoke_browser ..." line (not a failure). Own budget of 90 s (the HTTP
#     budget does not count it), hard timeout 240 s. The expected version ($2) reaches the harness through
#     YTM_SMOKE_EXPECT (run.sh hands it to the container).
#   SMOKE_ALERT=1    on failure, a block (reasons = the FAIL lines) is appended to $YTM_PROGRAM_DIR/ALERT.md, like
#     weekly.sh (daily cron line: cron.weekly.example).
set -u
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
. "$OPS_DIR/env.sh"
BASE="${1:-}"; EXPECT="${2:-}"
case "$BASE" in http://*|https://*) ;; *) echo "usage: $0 http(s)://<host>[:port] [expected version]"; exit 2 ;; esac
BASE="${BASE%/}"; HOST=$(ytm_url_host "$BASE")
UA="Mozilla/5.0 (Macintosh) Chrome/128 ytm-smoke"
BOT="WhatsApp/2.23.20.0"
T0=$(date +%s); OKN=0; KON=0
W=$(mktemp -d "${TMPDIR:-/tmp}/ytm-smoke.XXXXXX"); trap 'rm -rf "$W"' EXIT INT TERM
# get <name> <path> [curl args...]: body -> $W/<name>.b, headers -> $W/<name>.h, prints the http code
get() { n="$1"; p="$2"; shift 2
  ytm_curl "$BASE$p" -s --max-time 20 -A "$UA" -D "$W/$n.h" -o "$W/$n.b" -w "%{http_code}" "$@" 2>/dev/null || true; }
ok() { OKN=$((OKN + 1)); echo "OK   $1: $2"; }
ko() { KON=$((KON + 1)); echo "FAIL $1: $2"; echo "FAIL $1: $2" >> "$W/fails"; }
hdr() { grep -i "^$2:" "$W/$1.h" | tail -1 | cut -d: -f2- | tr -d "\r" | sed "s/^ *//"; }
js() { python3 -c "import json,sys
try: d=json.load(open('$W/$1.b'))
except Exception: print(''); sys.exit()
$2" 2>/dev/null; }

# 0. (c59e) prod image tag guard: a host-wide image prune (Coolify "Forced Docker cleanup" every night at 00:00
#    on the original box) removed $YTM_IMAGE:local UNDER the running container. Without that tag: DS1 "same build
#    served", no rollback, `compose up` fails. When the tag is ABSENT it is restored from the image-backups tarball
#    whose name carries the id of the container's image; when it exists but differs (promotion in progress) nothing
#    is touched and it is reported. Played only when the prod container exists on this host AND promote.sh has
#    been used (the :local tag or a backup tarball exists): a fresh install that runs the compose build has
#    neither, and the check is skipped with a SKIP line (not a failure).
CID=$(ytm_container_image "$YTM_PROD_CONTAINER")
TID=$(ytm_image_id "$YTM_IMAGE:local")
if [ -n "$CID" ] && [ -z "$TID" ] && ! find "$YTM_IMAGE_BACKUPS" -maxdepth 1 -name "$YTM_BACKUP_PREFIX-*.tar.gz" 2>/dev/null | grep -q .; then
  echo "SKIP prod_image_tag: $YTM_IMAGE:local absent and no backup tarball in $YTM_IMAGE_BACKUPS (promote.sh never used on this host)"
elif [ -n "$CID" ]; then
  if [ "$TID" = "$CID" ]; then ok prod_image_tag "$YTM_IMAGE:local = image of the container ($CID)"
  elif [ -n "$TID" ]; then ko prod_image_tag "tag=$TID but container=$CID (promotion in progress or drifted tag): nothing touched"
  else
    TAR=$(find "$YTM_IMAGE_BACKUPS" -maxdepth 1 -name "$YTM_BACKUP_PREFIX-*-$CID.tar.gz" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
    if [ -z "$TAR" ]; then ko prod_image_tag "tag ABSENT (pruned image) and no tarball $YTM_BACKUP_PREFIX-*-$CID.tar.gz in $YTM_IMAGE_BACKUPS: restore impossible"
    else
      docker load -i "$TAR" >/dev/null 2>&1 || true
      TID=$(ytm_image_id "$YTM_IMAGE:local")
      if [ "$TID" = "$CID" ]; then
        ok prod_image_tag "tag ABSENT (pruned image): RESTORED from $(basename "$TAR") -> $CID"
        if [ "${SMOKE_ALERT:-0}" = 1 ]; then
          ALERT=$(ytm_alert_file)
          printf '\n## %s UTC (smoke.sh): prod image restored\n- %s:local had vanished from the image store; restored from %s. Exclude this host from automatic image pruning.\n' "$(date -u +"%Y-%m-%d %H:%M")" "$YTM_IMAGE" "$(basename "$TAR")" >> "$ALERT"
        fi
      else ko prod_image_tag "tag ABSENT, docker load $(basename "$TAR") did not give $CID back (tag=${TID:-absent})"; fi
    fi
  fi
fi

# 1. stats/library: tracks > 0 and version
c=$(get stats /api/v1/stats/library)
TR=$(js stats "print(d.get('tracks') or 0)"); VER=$(js stats "print(d.get('version') or '')")
if [ "$c" = 200 ] && [ "${TR:-0}" -gt 0 ] 2>/dev/null && [ -n "$VER" ]; then ok stats_library "200 tracks=$TR version=$VER"; else ko stats_library "http=$c tracks=${TR:-?} version=${VER:-absent}"; fi
if [ -n "$EXPECT" ]; then
  if [ "$VER" = "$EXPECT" ]; then ok version_expected "$VER"; else ko version_expected "served=$VER expected=$EXPECT"; fi
fi

# 2. /home shell + _app entry script
c=$(get home /home)
ENTRY=$(grep -o '/_app/immutable/entry/[^"]*\.js' "$W/home.b" 2>/dev/null | head -1)
if [ "$c" = 200 ] && [ -n "$ENTRY" ]; then ok home_shell "200 entry=$ENTRY"; else ko home_shell "http=$c entry=${ENTRY:-absent}"; fi

# 3. service worker
c=$(get sw /service-worker.js)
if [ "$c" = 200 ]; then ok service_worker "200 $(wc -c < "$W/sw.b") B, cache-control=$(hdr sw cache-control)"; else ko service_worker "http=$c"; fi

# 4. manifest.json with share_target
c=$(get mf /manifest.json)
ST=$(js mf "print('yes' if d.get('share_target') else '')")
if [ "$c" = 200 ] && [ "$ST" = yes ]; then ok manifest_share_target "200 share_target present"; else ko manifest_share_target "http=$c share_target=${ST:-absent}"; fi

# 5. search under 300 KB (query = YTM_QUERY, else the fixtures file, else "music")
Q=$(ytm_fixture_query); Q=${Q:-music}
c=$(get search "/api/v1/search.json?q=$(printf '%s' "$Q" | sed 's/ /+/g')")
SZ=$(wc -c < "$W/search.b" 2>/dev/null || echo 0)
if [ "$c" = 200 ] && [ "$SZ" -lt 307200 ]; then ok search_json "200 $SZ B (q=$Q)"; else ko search_json "http=$c size=$SZ B (max 307200, q=$Q)"; fi

# 6. a local album
c=$(get alb "/api/v1/local/albums?limit=1")
AID=$(js alb "print(d['items'][0]['browseId'])")
ACOV=$(js alb "u=d['items'][0]['thumbnails'][0]['url'];print(u.split('lid=',1)[1] if 'lid=' in u else '')")
if [ "$c" = 200 ] && [ -n "$AID" ]; then ok local_albums "200 album=$AID cover=${ACOV:-absent}"; else ko local_albums "http=$c album=${AID:-absent}"; fi

# 7. local suggestions seeded on that album
if [ -n "$AID" ]; then
  c=$(get rel "/api/v1/local/related?seed=album:$AID")
  if [ "$c" = 200 ]; then ok local_related "200 $(wc -c < "$W/rel.b") B, x-ytm-cache=$(hdr rel x-ytm-cache)"; else ko local_related "http=$c"; fi
else ko local_related "no local album"; fi

# 8. Range /localf on a local track (url from player.json?videoId=<lid>, local branch)
c=$(get song "/api/v1/local/songs?limit=1")
LID=$(js song "print(d['items'][0]['videoId'])")
LU=""
if [ -n "$LID" ]; then
  get pl "/api/v1/player.json?videoId=$LID" >/dev/null
  LU=$(js pl "f=[x for x in (d.get('streamingData',{}).get('adaptiveFormats') or []) if str(x.get('url','')).startswith('/localf')];print(f[0]['url'] if f else '')")
fi
if [ -n "$LU" ]; then
  c=$(get lf "$LU" -r 0-1023)
  AR=$(hdr lf accept-ranges); CR=$(hdr lf content-range)
  if [ "$c" = 206 ] && [ -n "$AR" ]; then ok localf_range "206 lid=$LID accept-ranges=$AR content-range=$CR"; else ko localf_range "http=$c lid=$LID accept-ranges=${AR:-absent}"; fi
else ko localf_range "no /localf url (lid=${LID:-absent})"; fi

# 9. cacheable album cover
if [ -n "$ACOV" ]; then
  c=$(get cov "/cover?lid=$ACOV")
  CC=$(hdr cov cache-control)
  if [ "$c" = 200 ] && [ -n "$CC" ]; then ok cover_cacheable "200 cache-control=$CC"; else ko cover_cacheable "http=$c cache-control=${CC:-absent}"; fi
else ko cover_cacheable "no local cover"; fi

# 10. OG card for a link-preview robot
if [ -n "$LID" ]; then
  c=$(ytm_curl "$BASE/listen?id=$LID" -s --max-time 20 -A "$BOT" -o "$W/og.b" -w "%{http_code}" 2>/dev/null || true)
  OG=$(grep -o '<meta[^>]*og:title[^>]*>' "$W/og.b" 2>/dev/null | head -1 | grep -o 'content="[^"]*"' | head -1)
  if [ "$c" = 200 ] && [ -n "$OG" ]; then ok og_robot_card "200 og:title $OG"; else ko og_robot_card "http=$c og:title=${OG:-absent}"; fi
else ko og_robot_card "no lid"; fi

# 11. server cache: second call of local/mixes = HIT
get mix1 /api/v1/local/mixes >/dev/null
c=$(get mix2 /api/v1/local/mixes); X1=$(hdr mix1 x-ytm-cache); X2=$(hdr mix2 x-ytm-cache)
# A STALE answer starts the background refresh (about 0.1 s): two calls 20 ms apart can both be STALE,
# so the check accepts STALE then a HIT one second later.
if [ "$X2" = STALE ]; then sleep 1; get mix3 /api/v1/local/mixes >/dev/null; X2="STALE->$(hdr mix3 x-ytm-cache)"; fi
if [ "$c" = 200 ] && { [ "$X2" = HIT ] || [ "$X2" = "STALE->HIT" ]; }; then ok mixes_cache_hit "200 1st=$X1 2nd=$X2"; else ko mixes_cache_hit "http=$c 1st=${X1:-absent} 2nd=${X2:-absent}"; fi

DT=$(( $(date +%s) - T0 ))
[ "$DT" -le 90 ] || ko duration "${DT} s > 90 s"

# 12. (c43c B7-15) browser smoke, only with SMOKE_BROWSER=1: e2e/harness-smoke.cjs through e2e/run.sh.
BDT=0; BROWSER=""
if [ "${SMOKE_BROWSER:-0}" = 1 ]; then
  RUN="$YTM_E2E_DIR/run.sh"
  OTHER=$(ytm_harness_up)
  if [ -n "$OTHER" ]; then
    echo "SKIP smoke_browser: a harness is already running ($OTHER), one browser at a time: browser smoke skipped (not a failure)"
    BROWSER=" (browser skipped)"
  elif [ ! -f "$RUN" ]; then ko smoke_browser "e2e/run.sh not found ($RUN)"
  else
    B0=$(date +%s); BL="$W/browser.log"
    YTM_SMOKE_EXPECT="$EXPECT" timeout 240 sh "$RUN" "$BASE" "$YTM_QUERY" harness-smoke.cjs >"$BL" 2>&1; rc=$?
    BDT=$(( $(date +%s) - B0 )); BROWSER=" (browser ${BDT} s)"
    grep -E "^(PASS|FAIL|UPSTREAM|REFUSED|FATAL|Report:|report:)" "$BL" | sed 's/^/     /'
    if [ "$rc" = 0 ]; then ok smoke_browser "$(grep -E '^Report:' "$BL" | head -1 | sed 's/^Report: //; s/ -> .*//') in ${BDT} s"
    elif [ "$rc" = 2 ]; then echo "SKIP smoke_browser: run.sh refused (another harness running): browser smoke skipped (not a failure)"; BROWSER=" (browser skipped)"
    elif [ "$rc" = 124 ]; then ko smoke_browser "timeout 240 s (run.sh or the browser hung)"
    else ko smoke_browser "exit $rc: $(grep -E '^(FAIL|UPSTREAM|FATAL|REFUSED)' "$BL" | head -1 | cut -c1-160)"; fi
    [ "$BDT" -le 90 ] || ko smoke_browser_duration "${BDT} s > 90 s"
  fi
fi

echo "SMOKE $HOST version=${VER:-?}: $OKN ok, $KON failure(s) in ${DT} s${BROWSER}"
if [ "$KON" -gt 0 ] && [ "${SMOKE_ALERT:-0}" = 1 ]; then
  ALERT=$(ytm_alert_file)
  {
    printf '\n## %s UTC (smoke.sh)\n' "$(date -u +"%Y-%m-%d %H:%M")"
    printf -- '- reasons: smoke %s failed (%d failure(s) out of %d checks, served version %s, expected %s)\n' "$HOST" "$KON" "$((OKN + KON))" "${VER:-?}" "${EXPECT:-not given}"
    sed 's/^/- /' "$W/fails" 2>/dev/null
  } >> "$ALERT"
  echo "ALERT: $KON failure(s) (-> $ALERT)" >&2
fi
[ "$KON" -eq 0 ]
