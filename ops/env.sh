# shellcheck shell=sh
# ops/env.sh: the one place every ops script reads its layout from. Sourced, never executed:
#   OPS_DIR=$(cd "$(dirname "$0")" && pwd); . "$OPS_DIR/env.sh"
# Every variable keeps the value already in the environment, else the value of $YTM_ENV (default
# ops/env.local, git-ignored, same NAME=value lines as env.example), else the default below, which matches
# the shipped layout (deploy/compose.yml, data under deploy/data, one checkout = the tree that is built).
# env.example is an example production layout; keep the real values of a host in ops/env.local (never committed).
#
# Variables (all exported so that e2e/run.sh, python helpers and sub-scripts see them):
#   YTM_ROOT              checkout directory (default: the parent of ops/)
#   YTM_SRC_DIR           git tree that stage-cycle.sh builds and finish-cycle.sh diffs (default $YTM_ROOT)
#   YTM_PROD_URL          production base URL, any http(s) URL
#   YTM_STAGING_URL       staging base URL
#   YTM_RESOLVE_IP        when set, curl talks to this IP for a NAMED host (--resolve host:port:ip, SNI and Host
#                         kept): for a host whose hairpin route is broken. Empty = normal DNS.
#   YTM_PROD_CONTAINER    production container name (exact name, the only one these scripts touch; the shipped
#                         compose names it <project>-beatbump-1)
#   YTM_STAGING_CONTAINER staging container name
#   YTM_COMPOSE_SERVICE   service name of the app in the production compose file
#   YTM_IMAGE             image repository; <YTM_IMAGE>:local is what production runs, :staging the candidate
#   YTM_COMPOSE_FILE      production compose file (promote.sh edits its healthcheck / env_file blocks)
#   YTM_COMPOSE_PROJECT   optional -p for the production compose project (empty = the compose file's name)
#   YTM_COMPOSE_ENV_FILE  optional --env-file for the production compose (used only when the file exists)
#   YTM_COMPOSE_OVERRIDE  extra -f applied to BOTH compose commands (default ops/compose.image.yml: pins the app
#                         service on <YTM_IMAGE>:<YTM_IMAGE_TAG> so that the shipped build: service runs the
#                         promoted / staged tag); empty = none (a compose file that already names the image)
#   YTM_STAGING_COMPOSE   staging compose file (default: the same shipped compose, under another project),
#                         YTM_STAGING_PROJECT its -p project name, YTM_STAGING_ENV_FILE its --env-file (another
#                         BEATBUMP_PORT), YTM_STAGING_OVERRIDE an extra -f (default ops/compose.staging.yml:
#                         bind mounts under deploy/data-staging so the two instances never share a database)
#   YTM_DATA_DIR          data root; YTM_DB_DIR (prod beatbump.db), YTM_STAGING_DB_DIR, YTM_IMAGE_BACKUPS
#                         (promote.sh tarballs, prefix YTM_BACKUP_PREFIX) default under it
#   YTM_ANALYTICS_SRC, YTM_ANALYTICS_WEBSITE_ID, YTM_ANALYTICS_HOST
#                         optional page-view analytics of the staging build (an Umami-compatible script URL, its
#                         website id, its host URL): stage-cycle.sh passes them as the PUBLIC_ANALYTICS_* build
#                         args of the Dockerfile; empty (default) = no analytics script in the app
#   YTM_ALLOW_SKIPS       1 = a harness run with SKIP steps (precondition not met: small library, no YouTube
#                         fixture) still counts as green for finish-cycle.sh and weekly.sh; 0 (default) = a
#                         production target must play every step (0 FAIL and 0 SKIP)
#   YTM_SECRETS_ENV_FILE  env_file promote.sh wires into the prod service when it exists, mode 600, and holds
#                         COMPANION_SECRET_KEY= (secrets out of the compose file)
#   YTM_HEALTHCHECK_LABEL image label that tells promote.sh the binary supports -healthcheck
#   YTM_E2E_DIR           the harness directory (e2e/run.sh, fixtures.json, out/)
#   YTM_PROGRAM_DIR       journal and alerts: CHANGELOG.md, CYCLES.md, WEEKLY.md, ALERT.md, LIBRARY-LINT.md, logs/
#   YTM_LOG_DIR           chain / finish logs (ytm-stage-cycle<N>.log, ytm-finish-<cycle>.log)
#   YTM_BUILD_LOCK        flock file shared by the build, promote.sh and e2e/run.sh
#   YTM_QUERY             harness search query; empty = the "query" key of the fixtures file
#   HARNESS_RESOLVER      Chrome --host-resolver-rules for a named host (see e2e/run.sh), HARNESS_RESOLVE_IP
#                         its IP for the Node-side requests (defaults to the IP of the rules), HARNESS_FIXTURES
#                         an alternative fixtures file
#   YTM_LIBRARY_DIR       weekly.sh: directory of the music library for the disk column (default: the source of
#                         YTM_ACQ_MOUNT in YTM_ACQ_CONTAINER, else YTM_DATA_DIR)
#   YTM_ACQ_CONTAINER     weekly.sh: acquisition (downloader) container whose logs give the acquisition column;
#                         empty = column "n/a"
#   YTM_DISK_PATHS        weekly.sh: space-separated paths whose free space is reported and alerted under 10 %
#   YTM_KUMA_CONTAINER, YTM_KUMA_MONITORS, YTM_KUMA_STATS_MONITOR
#                         weekly.sh: Uptime Kuma container, monitor ids to print (space-separated, empty = column
#                         "n/a") and the id whose DOWN state raises an alert
#   YTM_ADMIN_TOKEN, WEEKLY_KUMA_KEY are secrets read by weekly.sh only (see its header), never written here.

OPS_DIR=${OPS_DIR:-$(cd "$(dirname "$0")" && pwd)}
YTM_ENV=${YTM_ENV:-$OPS_DIR/env.local}
if [ -f "$YTM_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$YTM_ENV"
  set +a
fi

YTM_ROOT=${YTM_ROOT:-$(cd "$OPS_DIR/.." && pwd)}
YTM_SRC_DIR=${YTM_SRC_DIR:-$YTM_ROOT}
YTM_PROD_URL=${YTM_PROD_URL:-http://127.0.0.1:8080}
YTM_STAGING_URL=${YTM_STAGING_URL:-http://127.0.0.1:8081}
YTM_RESOLVE_IP=${YTM_RESOLVE_IP:-}
YTM_COMPOSE_PROJECT=${YTM_COMPOSE_PROJECT:-}
YTM_PROD_CONTAINER=${YTM_PROD_CONTAINER:-${YTM_COMPOSE_PROJECT:-beatbump}-beatbump-1}
YTM_STAGING_PROJECT=${YTM_STAGING_PROJECT:-beatbump-staging}
YTM_STAGING_CONTAINER=${YTM_STAGING_CONTAINER:-$YTM_STAGING_PROJECT-beatbump-1}
YTM_COMPOSE_SERVICE=${YTM_COMPOSE_SERVICE:-beatbump}
YTM_IMAGE=${YTM_IMAGE:-beatbump}
YTM_COMPOSE_FILE=${YTM_COMPOSE_FILE:-$YTM_ROOT/deploy/compose.yml}
YTM_COMPOSE_ENV_FILE=${YTM_COMPOSE_ENV_FILE:-$YTM_ROOT/deploy/.env}
YTM_COMPOSE_OVERRIDE=${YTM_COMPOSE_OVERRIDE-$OPS_DIR/compose.image.yml}
YTM_STAGING_COMPOSE=${YTM_STAGING_COMPOSE:-$YTM_COMPOSE_FILE}
YTM_STAGING_ENV_FILE=${YTM_STAGING_ENV_FILE:-$YTM_ROOT/deploy/.env.staging}
YTM_STAGING_OVERRIDE=${YTM_STAGING_OVERRIDE-$OPS_DIR/compose.staging.yml}
YTM_DATA_DIR=${YTM_DATA_DIR:-$YTM_ROOT/deploy/data}
YTM_DB_DIR=${YTM_DB_DIR:-$YTM_DATA_DIR/beatbump-db}
YTM_STAGING_DB_DIR=${YTM_STAGING_DB_DIR:-$YTM_ROOT/deploy/data-staging/beatbump-db}
YTM_IMAGE_BACKUPS=${YTM_IMAGE_BACKUPS:-$YTM_DATA_DIR/image-backups}
YTM_ALLOW_SKIPS=${YTM_ALLOW_SKIPS:-0}
YTM_ANALYTICS_SRC=${YTM_ANALYTICS_SRC:-}
YTM_ANALYTICS_WEBSITE_ID=${YTM_ANALYTICS_WEBSITE_ID:-}
YTM_ANALYTICS_HOST=${YTM_ANALYTICS_HOST:-}
YTM_BACKUP_PREFIX=${YTM_BACKUP_PREFIX:-beatbump-prod}
YTM_SECRETS_ENV_FILE=${YTM_SECRETS_ENV_FILE:-$YTM_ROOT/deploy/beatbump.env}
YTM_HEALTHCHECK_LABEL=${YTM_HEALTHCHECK_LABEL:-fr.ekaii.ytm.healthcheck}
YTM_E2E_DIR=${YTM_E2E_DIR:-$YTM_ROOT/e2e}
YTM_PROGRAM_DIR=${YTM_PROGRAM_DIR:-$YTM_ROOT/ops/program}
YTM_LOG_DIR=${YTM_LOG_DIR:-/tmp}
YTM_BUILD_LOCK=${YTM_BUILD_LOCK:-/tmp/beatbump-build.lock}
YTM_QUERY=${YTM_QUERY:-}
HARNESS_RESOLVER=${HARNESS_RESOLVER:-}
HARNESS_RESOLVE_IP=${HARNESS_RESOLVE_IP:-}
HARNESS_FIXTURES=${HARNESS_FIXTURES:-}
YTM_LIBRARY_DIR=${YTM_LIBRARY_DIR:-}
YTM_ACQ_CONTAINER=${YTM_ACQ_CONTAINER-${YTM_COMPOSE_PROJECT:-beatbump}-yubal-1}
YTM_ACQ_MOUNT=${YTM_ACQ_MOUNT:-/app/data}
YTM_DISK_PATHS=${YTM_DISK_PATHS:-$YTM_DATA_DIR}
YTM_KUMA_CONTAINER=${YTM_KUMA_CONTAINER:-kuma}
YTM_KUMA_MONITORS=${YTM_KUMA_MONITORS:-}
YTM_KUMA_STATS_MONITOR=${YTM_KUMA_STATS_MONITOR:-}
export OPS_DIR YTM_ROOT YTM_SRC_DIR YTM_PROD_URL YTM_STAGING_URL YTM_RESOLVE_IP YTM_PROD_CONTAINER YTM_STAGING_CONTAINER \
  YTM_COMPOSE_SERVICE YTM_IMAGE YTM_COMPOSE_FILE YTM_COMPOSE_PROJECT YTM_COMPOSE_ENV_FILE YTM_COMPOSE_OVERRIDE \
  YTM_STAGING_COMPOSE YTM_STAGING_PROJECT YTM_STAGING_ENV_FILE YTM_STAGING_OVERRIDE YTM_DATA_DIR YTM_DB_DIR \
  YTM_STAGING_DB_DIR YTM_IMAGE_BACKUPS YTM_BACKUP_PREFIX YTM_ALLOW_SKIPS \
  YTM_ANALYTICS_SRC YTM_ANALYTICS_WEBSITE_ID YTM_ANALYTICS_HOST \
  YTM_SECRETS_ENV_FILE YTM_HEALTHCHECK_LABEL YTM_E2E_DIR YTM_PROGRAM_DIR YTM_LOG_DIR YTM_BUILD_LOCK YTM_QUERY \
  HARNESS_RESOLVER HARNESS_RESOLVE_IP HARNESS_FIXTURES YTM_LIBRARY_DIR YTM_ACQ_CONTAINER YTM_ACQ_MOUNT \
  YTM_DISK_PATHS YTM_KUMA_CONTAINER YTM_KUMA_MONITORS YTM_KUMA_STATS_MONITOR

# ---- helpers -----------------------------------------------------------------------------------------
# ytm_url_host <url>: host part (no scheme, port or path). ytm_url_port <url>: explicit port, else 443 / 80.
ytm_url_host() { printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##; s#:[0-9]+$##; s#^\[(.*)\]$#\1#'; }
ytm_url_port() {
  p=$(printf '%s' "$1" | sed -nE 's#^[a-zA-Z]+://[^/:]+:([0-9]+).*$#\1#p')
  if [ -n "$p" ]; then printf '%s' "$p"; else case "$1" in https://*) printf 443 ;; *) printf 80 ;; esac; fi
}
# ytm_resolve_args <url>: "--resolve host:port:ip" when YTM_RESOLVE_IP is set and the host is a name.
ytm_resolve_args() {
  [ -n "$YTM_RESOLVE_IP" ] || return 0
  h=$(ytm_url_host "$1")
  case "$h" in *[!0-9.]*) printf -- '--resolve %s:%s:%s' "$h" "$(ytm_url_port "$1")" "$YTM_RESOLVE_IP" ;; esac
}
# ytm_curl <url> [curl options...]: curl with the resolve rule; -s is NOT implied.
ytm_curl() {
  u=$1; shift
  # shellcheck disable=SC2046  # the resolve rule is at most three space-free words
  curl $(ytm_resolve_args "$u") "$@" "$u"
}
# ytm_json_get <key>: value of a top-level key of the JSON on stdin ("" when unreadable).
ytm_json_get() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
v=d.get(sys.argv[1]) if isinstance(d,dict) else None
print("" if v is None else v)' "$1" 2>/dev/null || true; }
# ytm_served_version <base url>: the "version" of /api/v1/stats/library ("" when unreadable).
ytm_served_version() { ytm_curl "$1/api/v1/stats/library" -s --max-time 15 2>/dev/null | ytm_json_get version; }
# ytm_fixture_query: the harness query (YTM_QUERY, else the "query" key of the fixtures file, else "").
ytm_fixture_query() {
  [ -z "$YTM_QUERY" ] || { printf '%s' "$YTM_QUERY"; return; }
  f=${HARNESS_FIXTURES:-$YTM_E2E_DIR/fixtures.json}; case "$f" in /*) ;; *) f="$YTM_E2E_DIR/$f" ;; esac
  [ -f "$f" ] && ytm_json_get query < "$f"
}
# docker compose wrappers (project / env-file / overrides applied only when configured). The image override
# reads YTM_IMAGE_TAG: "local" for production, "staging" for the staging project.
ytm_compose() {
  [ -z "$YTM_COMPOSE_OVERRIDE" ] || set -- -f "$YTM_COMPOSE_OVERRIDE" "$@"
  set -- -f "$YTM_COMPOSE_FILE" "$@"
  [ -z "$YTM_COMPOSE_PROJECT" ] || set -- -p "$YTM_COMPOSE_PROJECT" "$@"
  [ -n "$YTM_COMPOSE_ENV_FILE" ] && [ -f "$YTM_COMPOSE_ENV_FILE" ] && set -- --env-file "$YTM_COMPOSE_ENV_FILE" "$@"
  YTM_IMAGE_TAG=local docker compose "$@"
}
ytm_staging_compose() {
  [ -z "$YTM_STAGING_OVERRIDE" ] || set -- -f "$YTM_STAGING_OVERRIDE" "$@"
  [ -z "$YTM_COMPOSE_OVERRIDE" ] || set -- -f "$YTM_COMPOSE_OVERRIDE" "$@"
  set -- -f "$YTM_STAGING_COMPOSE" -p "$YTM_STAGING_PROJECT" "$@"
  [ -n "$YTM_STAGING_ENV_FILE" ] && [ -f "$YTM_STAGING_ENV_FILE" ] && set -- --env-file "$YTM_STAGING_ENV_FILE" "$@"
  YTM_IMAGE_TAG=staging docker compose "$@"
}
# ytm_image_id <tag>: 12-hex id of an image ("" when absent). ytm_container_image <name>: id of its image.
ytm_image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null | cut -c8-19; }
ytm_container_image() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null | cut -c8-19; }
# ytm_harness_up: name of a running ytm-harness-* container ("" when none).
ytm_harness_up() { docker ps --format '{{.Names}}' 2>/dev/null | grep '^ytm-harness-' | head -1; }
# ytm_alert_begin <writer>: creates $YTM_PROGRAM_DIR/ALERT.md with its header when absent, prints its path.
ytm_alert_file() {
  mkdir -p "$YTM_PROGRAM_DIR"
  f="$YTM_PROGRAM_DIR/ALERT.md"
  [ -f "$f" ] || printf '# ALERT %s (written by ops/weekly.sh, ops/smoke.sh or ops/promote.sh; delete once handled)\n' "$(ytm_url_host "$YTM_PROD_URL")" > "$f"
  printf '%s' "$f"
}
