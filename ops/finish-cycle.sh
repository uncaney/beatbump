#!/bin/sh
# Generic end of cycle, host side (survives a dropped ssh link); cycle 39 B6-30.
#   1. staging chain: ops/stage-cycle.sh > $YTM_LOG_DIR/ytm-stage-cycle<chain>.log (build of $YTM_SRC_DIR HEAD,
#      harness core + offline); green = 2 lines "Report: P passed / F failed / U upstream / S skipped" with F = 0
#      (core P >= FINISH_MIN_CORE, default 50; offline P >= FINISH_MIN_OFF, default 17) and the staging serving
#      the <sha> of HEAD
#   2. --ds1: DS1 probe (seed on the prod image, verify upgrade, verify rollback, staging put back on the new
#      image); green = empty "fails" in e2e/out/ds1-upgrade.json and ds1-rollback.json written DURING this run.
#      Without --ds1, when the SM2 guard applies: no promotion. SM2 guard CLOSED by default (cycle 42, L12-3): it
#      applies when the prod sha (stats/library) is unreadable, is not a sha, is unknown or ambiguous in
#      $YTM_SRC_DIR, is not an ancestor of HEAD, when git diff or the SW import scan fails, or when an SM2 file
#      changed (pattern SM2_RE + the files app/src/service-worker.ts imports, transitively; see sm2_guard).
#   3. unless --no-promote: flock $YTM_BUILD_LOCK sh ops/promote.sh <sha> (full output in the log; exit != 0 =
#      stop, ROLLBACK lines in the log), journal.py <cycle> <sha> --chain <chain>, post-deploy probe (4 min,
#      covers the 90 s wait), prod harness core then offline (HARNESS_TIER=full)
# Log: $YTM_LOG_DIR/ytm-finish-<cycle>.log, last line "FINISH <cycle> DONE".
# Usage (on the host, always detached):
#   nohup sh ops/finish-cycle.sh <cycle> <chain> [--ds1] [--no-promote] [--wait] >/dev/null 2>&1 &
#   tail -f $YTM_LOG_DIR/ytm-finish-<cycle>.log
# Exit codes: 0 = done (promoted and journaled, or --no-promote green); 1 = refusal / usage; 3 = not green
#   (chain, DS1 or SM2 guard: nothing promoted); 4 = promote.sh failed (see ROLLBACK in the log).
# Argument check without launching anything: FINISH_PARSE_ONLY=1 sh finish-cycle.sh <cycle> <chain> [...]
#   (also prints the SM2 guard of the moment: read-only, prod stats/library + git)
# Guard test on a file list (no argument, nothing launched):
#   FINISH_GUARD_TEST=<list file | -> [FINISH_GUARD_PRODV=<sha>] sh finish-cycle.sh
#   exit 0 = no DS1 required, 3 = DS1 required (reasons on stdout); without FINISH_GUARD_PRODV: sha of HEAD;
#   FINISH_GUARD_IG=<throw-away git repo> replaces $YTM_SRC_DIR (test only).
# svelte-check guard (c48c, B8-24): before the chain, `npx svelte-check --threshold error` in $YTM_SRC_DIR/app; the
#   line "svelte-check found N errors" is compared with ops/svelte-check.baseline: N > baseline = refusal (exit 3,
#   nothing launched). Unreadable output or missing baseline = refusal (closed guard). The baseline only goes down
#   by commit. FINISH_SKIP_SVELTE_CHECK=1 skips the guard. FINISH_PARSE_ONLY=1 also plays the guard (read-only,
#   1 to 2 min) and prints "svelte-check N <= baseline B". Guard alone (nothing else):
#   FINISH_SC_TEST=1 [FINISH_SC_BASELINE=<file>] [FINISH_SC_APP=<app dir>] sh finish-cycle.sh
#   exit 0 = ok, 3 = refusal (verdict on stdout); both variables are test overrides only.
# gated guard (c53c, B9-20): after a green chain, the report.json of the core harness carries `gated` (steps
#   skipped by a module C<N>_SKIP or env, harness-core.cjs gatedSteps). The list is printed ("gated guard: [...]")
#   and written to ops/gated.prev (one module:step line per step, first line "# chain <N>"). A step gated at the
#   previous chain (gated.prev) AND at this one has been gated for more than one chain: refusal (exit 3, nothing
#   promoted) unless FINISH_ALLOW_GATED=1 (promotion anyway, list printed). A step gated for the first time passes
#   with a warning. Unreadable report.json = refusal (closed guard). FINISH_PARSE_ONLY=1 prints the list of the
#   last chain (gated.prev). Guard alone (nothing launched, gated.prev NOT modified):
#   FINISH_GATED_TEST=<report.json> [FINISH_GATED_PREV=<file>] sh finish-cycle.sh ; exit 0 = ok, 3 = refusal.
# Go verification (B9-20, `go test -count=3 ./backend/api/`): lives in the integration queue check before a merge
#   (go vet + go test in the golang image); finish-cycle.sh does not replay it.
set -u
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
. "$OPS_DIR/env.sh"
E2E="$YTM_E2E_DIR"
IG="$YTM_SRC_DIR"
STG="$YTM_STAGING_URL"
PRD="$YTM_PROD_URL"

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  echo "Options: --ds1 (DS1 probe before the promotion), --no-promote (chain + DS1 only), --wait (wait for a running"
  echo "  ytm-harness-* to finish instead of refusing), --help."
}

# SM2 guard (cycle 42, L12-3). Files that change the behaviour of a SW / shell update:
SM2_RE='^app/src/service-worker\.ts$|^app/src/routes/\+layout\.(svelte|ts)$|^app/vite\.config\.|^app/svelte\.config\.js$|^app/scripts/svelteRuntimeChunk\.ts$|^app/src/lib/utils/sharedJobs\.ts$|^app/src/app\.html$|^app/static/manifest\.json$'
# sw_imports [rev]: repository files imported (transitively) by app/src/service-worker.ts at <rev> (default
# HEAD): "$lib/..." specifiers (-> app/src/lib/...), "./" and "../" of `import|export ... from "..."`,
# `import "..."` and `import("...")`; extensions tried: as is, .ts, .js, .svelte, /index.ts, /index.js.
# npm packages and virtual modules ($service-worker, $app/...) ignored. Exit != 0 when the SW is unreadable.
sw_imports() {
  python3 - "$IG" "${1:-HEAD}" <<'PY'
import posixpath, re, subprocess, sys
ig, rev = sys.argv[1], sys.argv[2]
def show(p):
    r = subprocess.run(["git", "-C", ig, "show", "%s:%s" % (rev, p)], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None
IMP = re.compile(r"""(?:^|[;\s])(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']|(?:^|[;\s])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)""")
root = "app/src/service-worker.ts"
if show(root) is None:
    sys.exit(2)
seen, todo, out = {root}, [root], []
while todo and len(seen) < 200:
    f = todo.pop()
    src = show(f) or ""
    for m in IMP.finditer(src):
        spec = m.group(1) or m.group(2) or m.group(3)
        if spec.startswith("$lib/"):
            base = "app/src/lib/" + spec[5:]
        elif spec.startswith("./") or spec.startswith("../"):
            base = posixpath.normpath(posixpath.join(posixpath.dirname(f), spec))
        else:
            continue
        for cand in (base, base + ".ts", base + ".js", base + ".svelte", base + "/index.ts", base + "/index.js"):
            if cand in seen:
                break
            if show(cand) is not None:
                seen.add(cand); todo.append(cand); out.append(cand)
                break
for p in sorted(out):
    print(p)
PY
}
# sm2_guard <prod sha> [list file]: prints the guard reasons (empty = no DS1 required). CLOSED: any uncertainty
# (unreadable, unknown or ambiguous sha, outside HEAD's history, git diff or SW imports failing) prints a reason.
# With [list file] (test), the list replaces `git diff --name-only <sha>..HEAD`.
sm2_guard() {
  pv=$1; list=${2:-}
  [ -n "$pv" ] || { echo "(prod version unreadable: stats/library without version)"; return 0; }
  printf '%s' "$pv" | grep -Eq '^[0-9a-f]{7,40}$' || { echo "(prod version '$pv' is not a sha)"; return 0; }
  git -C "$IG" rev-parse -q --verify "$pv^{commit}" >/dev/null 2>&1 || { echo "(prod sha $pv unknown to the source tree or ambiguous: promoted from another tree?)"; return 0; }
  git -C "$IG" merge-base --is-ancestor "$pv" HEAD 2>/dev/null || { echo "(prod sha $pv is not an ancestor of HEAD: diff not meaningful)"; return 0; }
  if [ -n "$list" ]; then
    files=$(cat "$list") || { echo "(test list $list unreadable)"; return 0; }
  else
    files=$(git -C "$IG" diff --name-only "$pv..HEAD" 2>/dev/null) || { echo "(git diff $pv..HEAD failed)"; return 0; }
  fi
  sw=$(sw_imports HEAD) || { echo "(imports of app/src/service-worker.ts unreadable at HEAD)"; return 0; }
  printf '%s\n' "$files" | SM2_RE="$SM2_RE" SM2_SW="$(oneline "$sw")" awk '
    BEGIN { n = split(ENVIRON["SM2_SW"], a, " "); for (i = 1; i <= n; i++) sw[a[i]] = 1 }
    $0 == "" { next }
    $0 in sw { print $0 " (imported by the SW)"; next }
    $0 ~ ENVIRON["SM2_RE"] { print }' | sort -u
}
prod_ver() { ytm_served_version "$PRD"; }
# oneline <text>: the lines of <text> joined with spaces (log lines).
oneline() { printf '%s' "$1" | tr '\n' ' ' | sed 's/ *$//'; }

# svelte-check guard (c48c, B8-24). svelte_check_count: prints N (the error count of the line "svelte-check found
# N errors ..." of a run in $SC_APP, svelte-kit sync first) or nothing when unreadable. svelte_check_gate: prints
# the verdict, returns 0 = ok, 3 = refusal (N > baseline, unreadable output, unreadable baseline);
# FINISH_SKIP_SVELTE_CHECK=1 = skipped (returns 0).
SC_BASE_FILE=${FINISH_SC_BASELINE:-$OPS_DIR/svelte-check.baseline}
SC_APP=${FINISH_SC_APP:-$IG/app}
svelte_check_count() {
  (cd "$SC_APP" && npx svelte-kit sync >/dev/null 2>&1; timeout 900 npx svelte-check --threshold error 2>&1) \
    | grep -E 'svelte-check found [0-9]+ error' | tail -1 | sed -E 's/.*svelte-check found ([0-9]+) error.*/\1/'
}
svelte_check_gate() {
  if [ "${FINISH_SKIP_SVELTE_CHECK:-}" = 1 ]; then echo "svelte-check guard: skipped (FINISH_SKIP_SVELTE_CHECK=1)"; return 0; fi
  base=$(tr -dc '0-9' < "$SC_BASE_FILE" 2>/dev/null)
  [ -n "$base" ] || { echo "svelte-check guard: unreadable baseline ($SC_BASE_FILE) -> refusal"; return 3; }
  n=$(svelte_check_count)
  [ -n "$n" ] || { echo "svelte-check guard: unreadable output (no 'svelte-check found N errors' line in $SC_APP) -> refusal"; return 3; }
  if [ "$n" -gt "$base" ]; then echo "svelte-check guard: $n errors > baseline $base ($SC_BASE_FILE) -> refusal"; return 3; fi
  echo "svelte-check $n <= baseline $base"
  return 0
}

if [ "${FINISH_SC_TEST:-}" = 1 ]; then
  svelte_check_gate; exit $?
fi

# gated guard (c53c, B9-20). gated_list <report.json>: one module:step line per gated step ("?:unreadable" when the
# file is unreadable). core_report <chain log>: host-side path of the core harness report.json (first line
# "Report: ... -> /e2e/out/<ts>/report.json"). gated_gate <report.json> [prev]: prints the verdict, writes prev
# (unless FINISH_GATED_TEST), returns 0 = ok, 3 = refusal.
GATED_PREV=${FINISH_GATED_PREV:-$OPS_DIR/gated.prev}
gated_list() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "?:unreadable"
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    print("?:unreadable"); sys.exit()
for g in r.get("gated") or []:
    print("%s:%s" % (g.get("module", "?"), g.get("step", "?")))
PY
}
core_report() { grep -E '^Report: [0-9]+ passed' "$1" | sed -n '1p' | sed -E 's#.*-> (/e2e/[^ ]*report\.json).*#\1#' | sed "s#^/e2e#$E2E#"; }
gated_gate() {
  rep=$1; cur=$(gated_list "$rep")
  case "$cur" in *unreadable*) echo "gated guard: unreadable report.json ($rep) -> refusal"; return 3 ;; esac
  prevf=$(mktemp); grep -v '^#' "$GATED_PREV" 2>/dev/null > "$prevf" || true
  old=$(printf '%s\n' "$cur" | grep -v '^$' | grep -Fxf "$prevf" 2>/dev/null); rm -f "$prevf"
  if [ "${FINISH_GATED_TEST:-}" = "" ]; then
    { echo "# chain ${CHAIN:-?} $(date -u +%Y-%m-%dT%H:%M:%SZ) $rep"; printf '%s\n' "$cur" | grep -v '^$'; } > "$GATED_PREV.tmp" && mv "$GATED_PREV.tmp" "$GATED_PREV"
  fi
  echo "gated guard: [$(oneline "$cur")]"
  [ -n "$cur" ] || return 0
  if [ -n "$old" ]; then
    if [ "${FINISH_ALLOW_GATED:-}" = 1 ]; then echo "  gated for more than one chain: $(oneline "$old"); FINISH_ALLOW_GATED=1 -> promotion anyway"; return 0; fi
    echo "  gated for more than one chain: $(oneline "$old") -> refusal (FINISH_ALLOW_GATED=1 to promote anyway)"; return 3
  fi
  echo "  gated for the first time: passes; refusal at the next chain if still gated"
  return 0
}
if [ -n "${FINISH_GATED_TEST:-}" ]; then
  gated_gate "$FINISH_GATED_TEST"; exit $?
fi

if [ -n "${FINISH_GUARD_TEST:-}" ]; then
  [ -n "${FINISH_GUARD_IG:-}" ] && IG=$FINISH_GUARD_IG   # test only: a throw-away repo instead of the source tree
  L=$FINISH_GUARD_TEST
  if [ "$L" = - ]; then L=$(mktemp); cat > "$L"; trap 'rm -f "$L"' EXIT; fi
  PV=${FINISH_GUARD_PRODV-$(git -C "$IG" rev-parse --short HEAD)}
  echo "SW imports at HEAD: $(sw_imports HEAD | tr '\n' ' ')"
  G=$(sm2_guard "$PV" "$L")
  if [ -n "$G" ]; then echo "DS1 REQUIRED (prod=$PV):"; printf '%s\n' "$G" | sed 's/^/  /'; exit 3; fi
  echo "no DS1 required (prod=$PV)"; exit 0
fi

CYCLE=""; CHAIN=""; DS1=0; PROMOTE=1; WAIT=0
for a in "$@"; do
  case "$a" in
    --help|-h) usage; exit 0 ;;
    --ds1) DS1=1 ;;
    --no-promote) PROMOTE=0 ;;
    --wait) WAIT=1 ;;
    -*) echo "unknown option: $a" >&2; usage >&2; exit 1 ;;
    *) if [ -z "$CYCLE" ]; then CYCLE=$a; elif [ -z "$CHAIN" ]; then CHAIN=$a
       else echo "extra argument: $a" >&2; exit 1; fi ;;
  esac
done
case "$CYCLE" in ""|*[!0-9a-z]*) echo "invalid cycle: '${CYCLE}' (e.g. 39, 21b)" >&2; usage >&2; exit 1 ;; esac
case "$CHAIN" in ""|*[!0-9a-z]*) echo "invalid chain: '${CHAIN}' (e.g. 42)" >&2; usage >&2; exit 1 ;; esac
[ -f "$OPS_DIR/journal/cycle-$CYCLE.md" ] || [ "$PROMOTE" = 0 ] || { echo "journal text missing: $OPS_DIR/journal/cycle-$CYCLE.md" >&2; exit 1; }
SLOG="$YTM_LOG_DIR/ytm-stage-cycle$CHAIN.log"
[ -e "$SLOG" ] && { echo "$SLOG already exists (chain $CHAIN already played?): pick a new chain number" >&2; exit 1; }
if [ "${FINISH_PARSE_ONLY:-}" = 1 ]; then
  echo "parse ok: cycle=$CYCLE chain=$CHAIN ds1=$DS1 promote=$PROMOTE wait=$WAIT log=$YTM_LOG_DIR/ytm-finish-$CYCLE.log stage-log=$SLOG"
  echo "layout: src=$IG prod=$PRD staging=$STG image=$YTM_IMAGE e2e=$E2E program=$YTM_PROGRAM_DIR"
  PV=$(prod_ver); G=$(sm2_guard "$PV")
  echo "SM2 guard now (prod=${PV:-?}, HEAD=$(git -C "$IG" rev-parse --short HEAD 2>/dev/null || echo '?')): ${G:+DS1 REQUIRED: }$(oneline "${G:-no DS1 required}")"
  [ -z "$G" ] || [ "$DS1" = 1 ] || echo "  -> without --ds1, this run would stop after the chain (exit 3, nothing promoted)"
  SCV=$(svelte_check_gate); SCRC=$?
  echo "svelte-check guard now: $SCV"
  [ "$SCRC" = 0 ] || echo "  -> this run would refuse before the chain (exit 3, nothing launched); FINISH_SKIP_SVELTE_CHECK=1 to override"
  echo "gated guard: [$(grep -v '^#' "$GATED_PREV" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')] (last chain, $GATED_PREV; a step still gated at the next chain = refusal without FINISH_ALLOW_GATED=1)"
  exit 0
fi

H=$(ytm_harness_up)
if [ -n "$H" ] && [ "$WAIT" = 0 ]; then
  echo "REFUSED: a harness is already running ($H); retry later or with --wait" >&2
  exit 1
fi

LOG="$YTM_LOG_DIR/ytm-finish-$CYCLE.log"
echo "finish-cycle $CYCLE (chain $CHAIN): log $LOG"
exec >> "$LOG" 2>&1
log() { echo "$(date -u +%H:%M:%S) $*"; }
done_() { log "FINISH $CYCLE DONE"; exit "$1"; }
log "== finish-cycle $CYCLE chain=$CHAIN ds1=$DS1 promote=$PROMOTE wait=$WAIT (src=$IG prod=$PRD staging=$STG)"
N=0
while H=$(ytm_harness_up); [ -n "$H" ]; do
  [ "$N" -ge 60 ] && { log "harness $H still there after 60 min: giving up"; done_ 1; }
  log "harness up: $H, waiting 60 s"; sleep 60; N=$((N + 1))
done

SHA=$(git -C "$IG" rev-parse --short HEAD)

# 0. svelte-check guard (c48c, B8-24): before the chain, nothing is launched while the count exceeds the baseline.
log "== svelte-check guard ($SHA, baseline $SC_BASE_FILE)"
SCV=$(svelte_check_gate); SCRC=$?
log "$SCV"
[ "$SCRC" = 0 ] || { log "NOT GREEN (svelte-check above the baseline) -> chain not launched, nothing promoted"; done_ 3; }

stg_ver() { ytm_served_version "$STG"; }
report() { grep -E '^Report: [0-9]+ passed / [0-9]+ failed( / [0-9]+ upstream)?( / [0-9]+ skipped)?' "$1" | sed -n "${2}p"; }
# green <Report line> <minimum passed>: "Report: P passed / F failed / U upstream / S skipped" is green when
# P >= minimum, F = 0 and S = 0; YTM_ALLOW_SKIPS=1 (env.sh) accepts skipped steps (fresh install: small
# library, no YouTube-backed fixture). An older three-field line (no "skipped") counts as S = 0.
green() {
  printf '%s\n' "$1" | awk -v m="$2" -v a="$YTM_ALLOW_SKIPS" '{ s = ($12 == "skipped") ? $11 : 0; exit !($2 >= m && $5 == 0 && (a == 1 || s == 0)) }'
}

# 1. staging chain
log "== chain $CHAIN on $SHA (log $SLOG)"
sh "$OPS_DIR/stage-cycle.sh" > "$SLOG" 2>&1
grep -E '^Report:|^FAIL|^SKIP|^UPSTREAM|^RETRY|^=== |BUILD_FAIL|^staging HTTP' "$SLOG" | cut -c1-200
CORE=$(report "$SLOG" 1); OFF=$(report "$SLOG" 2); SV=$(stg_ver)
log "core=[$CORE] off=[$OFF] staging version=$SV"
OK=1
if [ -n "$CORE" ] && green "$CORE" "${FINISH_MIN_CORE:-50}"; then :; else log "core NOT green (min passed ${FINISH_MIN_CORE:-50}, 0 failed, 0 skipped unless YTM_ALLOW_SKIPS=1)"; OK=0; fi
if [ -n "$OFF" ] && green "$OFF" "${FINISH_MIN_OFF:-17}"; then :; else log "offline NOT green (min passed ${FINISH_MIN_OFF:-17}, 0 failed, 0 skipped unless YTM_ALLOW_SKIPS=1)"; OK=0; fi
[ "$SV" = "$SHA" ] || { log "staging serves '$SV' and not $SHA"; OK=0; }
[ "$OK" = 1 ] || { log "NOT GREEN (chain $CHAIN) -> no promotion"; done_ 3; }

# 1b. gated guard (c53c, B9-20): a step gated for more than one chain is not promoted without FINISH_ALLOW_GATED=1.
CR=$(core_report "$SLOG")
GV=$(gated_gate "${CR:-/nonexistent}"); GRC=$?
log "$GV"
[ "$GRC" = 0 ] || { log "NOT GREEN (gated guard) -> no promotion"; done_ 3; }

# 2. DS1 / SM2 guard
PRODV=$(prod_ver)
GUARD=$(sm2_guard "$PRODV")
log "SM2 guard (prod ${PRODV:-?} -> $SHA): $(oneline "${GUARD:-none, DS1 optional}")"
if [ "$DS1" = 1 ]; then
  up() { docker tag "$1" "$YTM_IMAGE:staging" && ytm_staging_compose up -d 2>&1 | tail -1; sleep 25; log "staging serves $(ytm_served_version "$STG")"; }
  NEW=$(docker inspect -f '{{.Id}}' "$YTM_IMAGE:staging"); OLD=$(docker inspect -f '{{.Id}}' "$YTM_IMAGE:local" 2>/dev/null)
  if [ -z "$OLD" ]; then  # c59e: pruned tag (nightly image cleanup): image of the prod container, else the image-backups tarball
    CID=$(docker inspect -f '{{.Image}}' "$YTM_PROD_CONTAINER" 2>/dev/null)
    if [ -n "$CID" ] && ! docker image inspect "$CID" >/dev/null 2>&1; then
      TAR=$(find "$YTM_IMAGE_BACKUPS" -maxdepth 1 -name "$YTM_BACKUP_PREFIX-*-$(echo "$CID" | cut -c8-19).tar.gz" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
      [ -n "$TAR" ] && { log "DS1: $YTM_IMAGE:local ABSENT and prod image pruned from the store: docker load $(basename "$TAR")"; docker load -i "$TAR" >/dev/null 2>&1 || true; }
    fi
    if [ -n "$CID" ] && docker image inspect "$CID" >/dev/null 2>&1; then
      docker tag "$CID" "$YTM_IMAGE:local" && OLD=$CID && log "DS1: $YTM_IMAGE:local put back on the prod container's image $(echo "$CID" | cut -c8-19)"
    fi
  fi
  if [ -z "$OLD" ] || [ "$OLD" = "$NEW" ]; then log "NOT GREEN (DS1): OLD=${OLD:-absent} NEW=$(echo "$NEW" | cut -c8-19): no distinct prod image for the probe -> no promotion"; done_ 3; fi
  log "DS1: NEW=$(echo "$NEW" | cut -c8-19) OLD=$(echo "$OLD" | cut -c8-19) (prod $PRODV, guard: $(oneline "$GUARD"))"
  T0=$(date +%s)
  cd "$E2E" || done_ 1
  log "== DS1 seed on OLD (prod build)"; up "$OLD"; ./run.sh "$STG" "$YTM_QUERY" probe-ds1-seed.cjs 2>&1 | grep -E '^\[ds1|FATAL|REFUSED'
  log "== DS1 upgrade to NEW"; up "$NEW"; ./run.sh "$STG" "$YTM_QUERY" probe-ds1-verify-upgrade.cjs 2>&1 | grep -E '^\[ds1|FATAL|REFUSED'
  log "== DS1 rollback to OLD"; up "$OLD"; ./run.sh "$STG" "$YTM_QUERY" probe-ds1-verify-rollback.cjs 2>&1 | grep -E '^\[ds1|FATAL|REFUSED'
  log "== restore NEW"; up "$NEW"
  fails() { python3 - "$E2E/out/$1" "$T0" <<'PY' 2>/dev/null || echo 9
import json, os, sys
f, t0 = sys.argv[1], int(sys.argv[2])
if os.path.getmtime(f) < t0:
    print(9); sys.exit()  # file of a previous run: the probe did not run
print(len(json.load(open(f))["fails"]))
PY
  }
  U=$(fails ds1-upgrade.json); RB=$(fails ds1-rollback.json)
  log "DS1 fails: upgrade=$U rollback=$RB"
  [ "$(docker inspect -f '{{.Id}}' "$YTM_IMAGE:staging")" = "$NEW" ] || { log "$YTM_IMAGE:staging is NOT back on NEW: no promotion"; done_ 3; }
  if [ "$U" != 0 ] || [ "$RB" != 0 ]; then log "NOT GREEN (DS1) -> no promotion"; done_ 3; fi
elif [ -n "$GUARD" ]; then
  log "DS1 REQUIRED (SM2 guard: $(oneline "$GUARD")) but --ds1 absent -> no promotion; run again with --ds1"
  done_ 3
fi

if [ "$PROMOTE" = 0 ]; then log "GREEN, --no-promote: nothing promoted ($SHA)"; done_ 0; fi

# 3. promotion, journal, probe, prod harness
log "GREEN -> promote $SHA (cycle $CYCLE)"
flock "$YTM_BUILD_LOCK" sh "$OPS_DIR/promote.sh" "$SHA" 2>&1; RC=$?
log "promote.sh exit $RC"
[ "$RC" = 0 ] || { log "PROMOTE FAILED (exit $RC): no journal; apply a ROLLBACK line above if needed"; done_ 4; }
(cd "$OPS_DIR" && python3 journal.py "$CYCLE" "$SHA" --chain "$CHAIN")
cd "$E2E" || done_ 1
log "-- postdeploy probe"; ./run.sh "$PRD" "$YTM_QUERY" probe-postdeploy.cjs 2>&1 | grep -E '^T\+|ERR|FATAL|REFUSED' | cut -c1-120 | tail -2
# c47a (B8-14): the prod harness after a promotion plays the FULL tier (every step, incl. resume_take_over,
# buttons_readable, recent_by_day, french_program_screens); staging chains (stage-cycle.sh) stay on chain.
log "-- prod harness ($SHA, HARNESS_TIER=full)"
HARNESS_TIER=full ./run.sh "$PRD" "$YTM_QUERY" harness-core.cjs 2>&1 | grep -E '^FAIL|^SKIP|^UPSTREAM|^RETRY|^Report|REFUSED'
HARNESS_TIER=full ./run.sh "$PRD" "$YTM_QUERY" harness-offline.cjs 2>&1 | grep -E '^FAIL|^SKIP|^UPSTREAM|^RETRY|^Report|REFUSED'
done_ 0
