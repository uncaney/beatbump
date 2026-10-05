#!/usr/bin/env bash
# svelte-check gate: the error count may not rise above ops/svelte-check.baseline.
# Same rule as ops/finish-cycle.sh (the fork inherited ~400 type errors from
# upstream Beatbump; the baseline is a ceiling, lowered by hand when errors are
# fixed). Exit 0 when count <= baseline, 3 when it rises or the output or the
# baseline cannot be read (closed gate).
#
# Run from anywhere; expects app/node_modules to be installed (npm ci).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
baseline_file=${SVELTE_CHECK_BASELINE:-$root/ops/svelte-check.baseline}

base=$(tr -dc '0-9' <"$baseline_file" 2>/dev/null || true)
[ -n "$base" ] || { echo "svelte-check gate: baseline unreadable ($baseline_file) -> refuse"; exit 3; }

cd "$root/app"
npx svelte-kit sync >/dev/null 2>&1 || true
# svelte-check exits 1 whenever it finds an error; the count is what we gate on.
# Its output is occasionally cut short on a loaded host (seen once: the
# summary line missing after ~30 files), so one retry before the gate closes.
esc=$(printf '\033')
log=${TMPDIR:-/tmp}/svelte-check.log
n=""
for attempt in 1 2; do
  out=$(npx svelte-check --threshold error 2>&1 | sed -E "s/${esc}\[[0-9;]*[A-Za-z]//g" || true)
  printf '%s\n' "$out" >"$log"
  n=$(printf '%s\n' "$out" | grep -E 'svelte-check found [0-9]+ error' | tail -1 | sed -E 's/.*svelte-check found ([0-9]+) error.*/\1/' || true)
  [ -z "$n" ] || break
  echo "svelte-check gate: attempt $attempt produced no 'svelte-check found N errors' line ($(printf '%s\n' "$out" | wc -l | tr -d ' ') lines, see $log)"
done
[ -n "$n" ] || {
  tail -20 "$log"
  echo "svelte-check gate: no 'svelte-check found N errors' line after 2 attempts -> refuse"
  exit 3
}
if [ "$n" -gt "$base" ]; then
  # Show the first errors so the failing lane sees what it introduced.
  printf '%s\n' "$out" | grep -E -A3 '^(.*Error:|/.*:[0-9]+:[0-9]+)' | head -80 || true
  echo "svelte-check gate: $n errors > baseline $base ($baseline_file) -> refuse"
  exit 3
fi
echo "svelte-check $n <= baseline $base"
if [ "$n" -lt "$base" ]; then
  echo "svelte-check gate: errors went down, consider lowering ops/svelte-check.baseline to $n"
fi
