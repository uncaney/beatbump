#!/bin/sh
# Monday in ONE command (cycle 53, lane c53a, brainstorm-v9 B9-15): the cron line of decision 19
# (cron.weekly.example). Run ON the host, never from a harness or a chain.
#   1. wait (at most MONDAY_WAIT_MAX s, default 1800, 30 s steps) while a ytm-harness-* container runs, while a
#      finish-cycle.sh is in progress (a chain keeps the browser between two steps) or while the build lock
#      $YTM_BUILD_LOCK is held (same flock -n test as e2e/run.sh); once the wait is over, go on: run.sh keeps its
#      own refusals (other browser: exit 2; 1 min load > 60: 15 min wait);
#   2. prod harness, full tier: HARNESS_TIER=full e2e/run.sh $YTM_PROD_URL "$YTM_QUERY" harness-core.cjs
#      (timeout 1500 s) then harness-offline.cjs (timeout 900 s); the X-Ytm-Harness header set by the harness
#      (c52c) keeps every play out of the prod database;
#   3. weekly.sh (WEEKLY.md line, ALERT.md block when needed) with WEEKLY_DB_RO=1 (retention column, read-only
#      access to the database; drop the variable below to do without it);
#   4. smoke.sh $YTM_PROD_URL <last "PROD = <sha>" of CYCLES.md> with SMOKE_ALERT=1 (HTTP only: the browser
#      already ran in step 2; the daily browser smoke is the other cron line).
# Log: $YTM_PROGRAM_DIR/logs/monday-<YYYY-MM-DD>.log (directory created when needed, 10 files kept); the cron
# stdout (-> ops/monday-cron.log) only receives the final summary (one line per step + the exit code).
# Exit code = the worst of the three (harness = worst of core / offline; weekly; smoke):
#   0 all green; 1 failure (FAIL step, failed smoke, weekly error); 2 run.sh refusal (other browser); 124 timeout;
#   both full reports and the WEEKLY line are written even when a step is red.
# Usage: sh ops/monday.sh        (about 25 to 35 min on a quiet host)
#   MONDAY_SKIP_HARNESS=1: skips step 2 (weekly.sh then reads the last existing full report; quick test).
set -u
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
. "$OPS_DIR/env.sh"
LOGDIR="$YTM_PROGRAM_DIR/logs"
WAIT_MAX="${MONDAY_WAIT_MAX:-1800}"

mkdir -p "$LOGDIR" || { echo "monday.sh: cannot create the log directory: $LOGDIR" >&2; exit 1; }
LOG="$LOGDIR/monday-$(date -u +%Y-%m-%d).log"
# original stdout (cron) kept on fd 3 for the summary; everything else goes to the day's log
exec 3>&1
exec >> "$LOG" 2>&1
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
worst() { [ "$1" -ge "$2" ] && echo "$1" || echo "$2"; }

log "== monday.sh start (log $LOG, max wait ${WAIT_MAX} s)"

# 1. wait for a free host: no harness browser, no chain, no build
chain_up() { pgrep -f "ops/finish-cycle.sh" 2>/dev/null | head -1; }
build_running() { command -v flock >/dev/null 2>&1 && [ -e "$YTM_BUILD_LOCK" ] && ! flock -n "$YTM_BUILD_LOCK" true 2>/dev/null; }
W=0
while :; do
  H=$(ytm_harness_up); C=$(chain_up); B=""; build_running && B=yes
  [ -z "$H" ] && [ -z "$C" ] && [ -z "$B" ] && break
  if [ "$W" -ge "$WAIT_MAX" ]; then
    log "WARNING: waited ${WAIT_MAX} s (harness=${H:-no}, chain pid=${C:-no}, build=${B:-no}): going on, run.sh keeps its refusals"
    break
  fi
  log "waiting ${W}s / ${WAIT_MAX}s (harness=${H:-no}, chain pid=${C:-no}, build=${B:-no}, load $(cut -d' ' -f1 /proc/loadavg 2>/dev/null))"
  sleep 30; W=$((W + 30))
done

# 2. prod harness, full tier: core then offline (run.sh: one browser, build lock, load)
RC_H=0
if [ "${MONDAY_SKIP_HARNESS:-0}" = 1 ]; then
  log "== prod harness skipped (MONDAY_SKIP_HARNESS=1)"
else
  for H in harness-core.cjs:1500 harness-offline.cjs:900; do
    F=${H%%:*}; T=${H##*:}
    log "== prod harness full $F (timeout ${T} s, load $(cut -d' ' -f1 /proc/loadavg 2>/dev/null))"
    ( cd "$YTM_E2E_DIR" && HARNESS_TIER=full timeout "$T" sh ./run.sh "$YTM_PROD_URL" "$YTM_QUERY" "$F" ); rc=$?
    log "harness $F exit $rc"
    RC_H=$(worst "$RC_H" "$rc")
  done
fi

# 3. weekly.sh: writes the WEEKLY.md line (stdout) and the alert reasons (stderr, ALERT.md block)
log "== weekly.sh"
WEEKLY_DB_RO=1 sh "$OPS_DIR/weekly.sh"; RC_W=$?
log "weekly.sh exit $RC_W"

# 4. HTTP smoke with the expected version = last "PROD = <sha>" of CYCLES.md (empty when not found)
EXPECT=$(grep -o 'PROD = [0-9a-f]\{7,12\}' "$YTM_PROGRAM_DIR/CYCLES.md" 2>/dev/null | tail -1 | cut -d' ' -f3)
log "== smoke.sh $YTM_PROD_URL ${EXPECT:-(expected version unknown)} (SMOKE_ALERT=1)"
if [ -n "$EXPECT" ]; then SMOKE_ALERT=1 sh "$OPS_DIR/smoke.sh" "$YTM_PROD_URL" "$EXPECT"; else SMOKE_ALERT=1 sh "$OPS_DIR/smoke.sh" "$YTM_PROD_URL"; fi
RC_S=$?
log "smoke.sh exit $RC_S"

RC=$(worst "$(worst "$RC_H" "$RC_W")" "$RC_S")

# rotation: 10 monday-*.log files kept
find "$LOGDIR" -maxdepth 1 -name 'monday-*.log' -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n +11 | cut -d' ' -f2- | while IFS= read -r f; do rm -f -- "$f"; done

LAST=$(tail -1 "$YTM_PROGRAM_DIR/WEEKLY.md" 2>/dev/null | cut -c1-160)
log "== monday.sh end: harness=$RC_H weekly=$RC_W smoke=$RC_S -> exit $RC"
{
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) monday.sh: harness=$RC_H weekly=$RC_W smoke=$RC_S -> exit $RC (log $LOG)"
  echo "  WEEKLY: $LAST"
  [ -f "$YTM_PROGRAM_DIR/ALERT.md" ] && echo "  ALERT.md present: $(grep -c '^## ' "$YTM_PROGRAM_DIR/ALERT.md" 2>/dev/null) block(s), handle then delete"
} >&3
exit "$RC"
