#!/usr/bin/env bash
# Beatbump music stack: one command to a working, healthy stack.
#
#   ./up.sh                    first run: writes deploy/.env, creates ./deploy/data,
#                              builds the images, starts everything, waits for health
#   ./up.sh --sample-library   same, and fills an EMPTY MUSIC_DIR with a small CC0
#                              synthetic library so the app has content right away
#   ./up.sh down [-v]          stop (and with -v delete the index/cache volumes)
#   ./up.sh logs [service]     follow logs
#   ./up.sh ps                 container status
#   ./up.sh update             git pull --ff-only, rebuild, restart, wait for health
#   ./up.sh build              rebuild the images only
#
# Environment overrides: COMPOSE_PROJECT_NAME (default beatbump; several stacks can
# coexist), BEATBUMP_PORT (written into deploy/.env on first run), MUSIC_DIR (idem),
# BUILD_PARALLEL=1 to build the images in parallel (default: one at a time).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
ENV_EXAMPLE="$DEPLOY/.env.example"
PROJECT="${COMPOSE_PROJECT_NAME:-beatbump}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-600}"

log()  { printf '[up.sh] %s\n' "$*"; }
warn() { printf '[up.sh] WARNING: %s\n' "$*" >&2; }
die()  { printf '[up.sh] ERROR: %s\n' "$*" >&2; exit 1; }

compose() {
    docker compose --project-name "$PROJECT" --project-directory "$DEPLOY" \
        -f "$DEPLOY/compose.yml" --env-file "$ENV_FILE" "$@"
}

# env_get KEY -> value from deploy/.env (empty when absent)
env_get() {
    sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

# env_set KEY VALUE: replace (or append) KEY= in deploy/.env, atomically.
env_set() {
    local tmp
    tmp=$(mktemp "$ENV_FILE.XXXXXX")
    awk -v k="$1" -v v="$2" '
        index($0, k "=") == 1 { print k "=" v; done = 1; next }
        { print }
        END { if (!done) print k "=" v }
    ' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
}

random_hex() { # random_hex BYTES -> 2*BYTES hex chars
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$1"
    else
        od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
    fi
}

check_prereqs() {
    command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"
    docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? are you in the docker group?)"
    docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (the 'docker compose' plugin)"
}

ensure_env() {
    if [ ! -f "$ENV_FILE" ]; then
        [ -f "$ENV_EXAMPLE" ] || die "missing $ENV_EXAMPLE"
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log "created deploy/.env from deploy/.env.example"
        # First run: honour BEATBUMP_PORT / MUSIC_DIR / BEATBUMP_BIND from the environment.
        if [ -n "${BEATBUMP_PORT:-}" ]; then env_set BEATBUMP_PORT "$BEATBUMP_PORT"; fi
        if [ -n "${MUSIC_DIR:-}" ]; then env_set MUSIC_DIR "$MUSIC_DIR"; fi
        if [ -n "${BEATBUMP_BIND:-}" ]; then env_set BEATBUMP_BIND "$BEATBUMP_BIND"; fi
        # Ownership: containers run as PUID:PGID = the invoking user (1000:1000 for root),
        # so the bind mounts under deploy/data stay writable without any chown.
        if [ "$(id -u)" = "0" ]; then env_set PUID 1000; env_set PGID 1000
        else env_set PUID "$(id -u)"; env_set PGID "$(id -g)"; fi
    fi
    # Secrets: generated once, never printed.
    [ -n "$(env_get MEILI_MASTER_KEY)" ]    || { env_set MEILI_MASTER_KEY "$(random_hex 32)"; log "generated MEILI_MASTER_KEY (64 chars)"; }
    # invidious-companion requires EXACTLY 16 characters.
    [ -n "$(env_get COMPANION_SECRET_KEY)" ] || { env_set COMPANION_SECRET_KEY "$(random_hex 8)"; log "generated COMPANION_SECRET_KEY (16 chars)"; }
    [ -n "$(env_get YTM_ADMIN_TOKEN)" ]     || { env_set YTM_ADMIN_TOKEN "$(random_hex 32)"; log "generated YTM_ADMIN_TOKEN (64 chars)"; }
    local key; key=$(env_get COMPANION_SECRET_KEY)
    [ "${#key}" -eq 16 ] || die "COMPANION_SECRET_KEY must be exactly 16 characters (companion constraint), got ${#key}"
    [ -n "$(env_get PUID)" ] || env_set PUID 1000
    [ -n "$(env_get PGID)" ] || env_set PGID 1000
    # Version string for the image/stats page (git short sha when available).
    if [ "$(env_get BEATBUMP_VERSION)" = "dev" ] || [ -z "$(env_get BEATBUMP_VERSION)" ]; then
        if git -C "$ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
            env_set BEATBUMP_VERSION "$(git -C "$ROOT" rev-parse --short HEAD)"
        fi
    fi
}

# Resolve MUSIC_DIR as compose does (relative to deploy/).
music_dir() {
    local m; m=$(env_get MUSIC_DIR); m=${m:-./data/music}
    case "$m" in
        /*) printf '%s\n' "$m" ;;
        *)  printf '%s/%s\n' "$DEPLOY" "${m#./}" ;;
    esac
}

ensure_dirs() {
    local puid pgid music d
    puid=$(env_get PUID); pgid=$(env_get PGID); music=$(music_dir)
    for d in beatbump-db beatbump-downloads bridge-state indexer-state yubal-config; do
        mkdir -p "$DEPLOY/data/$d"
    done
    mkdir -p "$music/ytm" || die "cannot create $music/ytm"
    if [ "$(id -u)" = "0" ]; then
        chown -R "$puid:$pgid" "$DEPLOY/data"
        chown "$puid:$pgid" "$music" "$music/ytm" 2>/dev/null || warn "could not chown $music to $puid:$pgid"
    fi
    for d in "$DEPLOY/data/bridge-state" "$music/ytm"; do
        [ -w "$d" ] || warn "$d is not writable by $(id -un); containers run as $puid:$pgid"
    done
    log "data: $DEPLOY/data (owner $puid:$pgid), music: $music"
}

library_has_audio() {
    find "$1" -type f \( -iname '*.opus' -o -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.flac' \
        -o -iname '*.ogg' -o -iname '*.aac' -o -iname '*.wav' \) -print -quit 2>/dev/null | grep -q .
}

sample_library() {
    local music; music=$(music_dir)
    if library_has_audio "$music"; then
        log "MUSIC_DIR already has audio files, not adding the sample library"
        return
    fi
    log "generating the sample library in $music/sample (needs the ffmpeg + python images)"
    "$ROOT/fixtures/make-sample-library.sh" "$music/sample"
    if [ "$(id -u)" = "0" ]; then chown -R "$(env_get PUID):$(env_get PGID)" "$music/sample"; fi
}

# Print one status line per container; return 0 when every container is running
# and every healthchecked one is healthy.
stack_status() {
    local ids all_ok=0 line name state health
    mapfile -t ids < <(compose ps -q 2>/dev/null)
    [ "${#ids[@]}" -gt 0 ] || return 1
    while read -r line; do
        name=${line%% *}; line=${line#* }; state=${line%% *}; health=${line#* }
        printf '  %-40s %-10s %s\n' "${name#/}" "$state" "$health"
        [ "$state" = "running" ] || all_ok=1
        [ "$health" = "healthy" ] || [ "$health" = "none" ] || all_ok=1
    done < <(docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${ids[@]}")
    return $all_ok
}

wait_healthy() {
    local waited=0 step=5
    log "waiting for the stack to become healthy (up to ${HEALTH_TIMEOUT}s)"
    while :; do
        if stack_status >/dev/null 2>&1; then
            log "all containers running and healthy after ${waited}s"
            stack_status
            return 0
        fi
        if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
            warn "stack not healthy after ${HEALTH_TIMEOUT}s; current state:"
            stack_status || true
            warn "inspect with: ./up.sh logs <service>"
            return 1
        fi
        sleep "$step"; waited=$((waited + step))
    done
}

# Wait for the indexer's first pass when the music folder has audio, so the
# summary (and the first visit) see the library, not an empty index. The
# indexer logs "pass done" at the end of each pass. INDEX_TIMEOUT (default
# 900 s) bounds the wait; a large library keeps indexing in the background.
wait_indexed() {
    local waited=0 step=5 timeout=${INDEX_TIMEOUT:-900} port stats
    library_has_audio "$(music_dir)" || return 0
    log "waiting for the first index pass (up to ${timeout}s)"
    while ! compose logs --no-log-prefix indexer 2>/dev/null | grep -q 'pass done'; do
        if [ "$waited" -ge "$timeout" ]; then
            warn "indexer still on its first pass after ${timeout}s; it continues in the background (./up.sh logs indexer)"
            return 0
        fi
        sleep "$step"; waited=$((waited + step))
    done
    port=$(env_get BEATBUMP_PORT); port=${port:-8080}
    stats=$(curl -fsS --max-time 10 "http://127.0.0.1:$port/api/v1/stats/library" 2>/dev/null || true)
    log "first index pass done after ${waited}s${stats:+: $stats}"
}

print_summary() {
    local port bind host token
    port=$(env_get BEATBUMP_PORT); port=${port:-8080}
    bind=$(env_get BEATBUMP_BIND); host=localhost
    if [ -n "$bind" ] && [ "$bind" != "0.0.0.0" ]; then host=$bind; fi
    token=$(env_get YTM_ADMIN_TOKEN)
    cat <<EOF

  Beatbump is up:        http://$host:$port/
  Library stats:         http://$host:$port/api/v1/stats/library
  Admin token:           $ENV_FILE  (YTM_ADMIN_TOKEN, ${#token} chars)
  Music folder:          $(music_dir)   (indexed every $(env_get INDEXER_SCAN_INTERVAL)s)
  Logs / stop / update:  ./up.sh logs | ./up.sh down | ./up.sh update
EOF
}

# Build the four images one after the other: the node + go build of the app is
# memory hungry and a parallel build on a small host swaps or gets OOM-killed.
# BUILD_PARALLEL=1 restores compose's default parallel build.
build_images() {
    local s pull=()
    if [ "${1:-}" = "--pull" ]; then pull=(--pull); shift; fi
    # Explicit services given (./up.sh build indexer): build just those.
    if [ "$#" -gt 0 ] || [ "${BUILD_PARALLEL:-0}" = 1 ]; then compose build ${pull[@]+"${pull[@]}"} "$@"; return; fi
    for s in bridge indexer yubal beatbump; do
        log "building $s"
        compose build ${pull[@]+"${pull[@]}"} "$s"
    done
}

cmd_up() {
    check_prereqs
    ensure_env
    ensure_dirs
    if [ "$WANT_SAMPLE" = 1 ]; then sample_library; fi
    log "building images (first build takes several minutes)"
    build_images
    log "starting the stack (project $PROJECT)"
    compose up -d --remove-orphans
    wait_healthy || exit 1
    wait_indexed
    print_summary
}

WANT_SAMPLE=0
CMD=up
ARGS=()
for a in "$@"; do
    case "$a" in
        --sample-library) WANT_SAMPLE=1 ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        up|down|logs|ps|status|update|build) CMD=$a ;;
        *) ARGS+=("$a") ;;
    esac
done

case "$CMD" in
    up)      cmd_up ;;
    down)    check_prereqs; [ -f "$ENV_FILE" ] || die "no deploy/.env: nothing to stop"
             compose down ${ARGS[@]+"${ARGS[@]}"} ;;
    logs)    check_prereqs; compose logs -f --tail=200 ${ARGS[@]+"${ARGS[@]}"} ;;
    ps|status) check_prereqs; stack_status || true ;;
    build)   check_prereqs; ensure_env; build_images ${ARGS[@]+"${ARGS[@]}"} ;;
    update)  check_prereqs; ensure_env
             if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
                 log "git pull --ff-only"; git -C "$ROOT" pull --ff-only
                 env_set BEATBUMP_VERSION "$(git -C "$ROOT" rev-parse --short HEAD)"
             fi
             ensure_dirs
             build_images --pull
             compose up -d --remove-orphans
             wait_healthy || exit 1
             wait_indexed
             print_summary ;;
esac
