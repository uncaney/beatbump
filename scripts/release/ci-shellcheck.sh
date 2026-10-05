#!/usr/bin/env bash
# Run ShellCheck over the shell entry points of the repository.
# Blocking at SHELLCHECK_SEVERITY (default: warning, the tree is clean at that
# level since ops/ became path-agnostic); with a stricter default the
# warning-level report is still printed for information.
set -euo pipefail
cd "$(dirname "$0")/../.."

severity=${SHELLCHECK_SEVERITY:-warning}
files=()
for f in up.sh ops/*.sh e2e/run.sh fixtures/*.sh scripts/release/*.sh; do
  [ -f "$f" ] && files+=("$f")
done
[ "${#files[@]}" -gt 0 ] || { echo "ci-shellcheck: no shell files found"; exit 0; }

echo "shellcheck -S $severity on ${#files[@]} files:"
printf '  %s\n' "${files[@]}"
shellcheck -S "$severity" "${files[@]}"
echo "shellcheck: no finding at severity $severity"

if [ "$severity" != "warning" ] && [ "$severity" != "info" ] && [ "$severity" != "style" ]; then
  # ShellCheck exits 1 when it reports anything: never let that reach `set -e`.
  report=$(shellcheck -f gcc -S warning "${files[@]}" 2>/dev/null || true)
  n=$(printf '%s' "$report" | grep -c . || true)
  echo "shellcheck: $n finding(s) at severity warning (informational, not blocking):"
  printf '%s\n' "$report" | head -40
fi
