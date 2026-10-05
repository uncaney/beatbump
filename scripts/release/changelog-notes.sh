#!/usr/bin/env bash
# changelog-notes.sh VERSION
# Print the body of the "## [VERSION] - date" section of CHANGELOG.md (Keep a
# Changelog format), without the heading, trimmed. VERSION may carry a leading
# "v". Exit 1 when the section does not exist or is empty.
set -euo pipefail
cd "$(dirname "$0")/../.."

v=${1:?version}
v=${v#v}
[ -f CHANGELOG.md ] || { echo "changelog-notes: CHANGELOG.md missing" >&2; exit 1; }

notes=$(awk -v v="$v" '
  /^## \[/ {
    if (found) exit
    if (index($0, "## [" v "]") == 1) { found = 1; next }
  }
  found { print }
' CHANGELOG.md | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
# strip leading blank lines
notes=$(printf '%s\n' "$notes" | sed '/./,$!d')

if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "changelog-notes: no '## [$v]' section with content in CHANGELOG.md" >&2
  exit 1
fi
printf '%s\n' "$notes"
