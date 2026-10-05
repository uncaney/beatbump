#!/usr/bin/env bash
# check-version.sh TAG
# The release gate: TAG must be vMAJOR.MINOR.PATCH[-prerelease], equal to the
# VERSION file (without the v), and CHANGELOG.md must carry a dated
# "## [MAJOR.MINOR.PATCH] - YYYY-MM-DD" section with content.
set -euo pipefail
cd "$(dirname "$0")/../.."

tag=${1:?tag (vX.Y.Z)}
case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "check-version: tag '$tag' is not vMAJOR.MINOR.PATCH" >&2; exit 1 ;;
esac
if ! printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "check-version: tag '$tag' is not vMAJOR.MINOR.PATCH[-prerelease]" >&2
  exit 1
fi
version=${tag#v}

[ -f VERSION ] || { echo "check-version: VERSION file missing" >&2; exit 1; }
file_version=$(tr -d '[:space:]' <VERSION)
if [ "$file_version" != "$version" ]; then
  echo "check-version: tag $tag != VERSION file ($file_version)" >&2
  exit 1
fi

if ! grep -Eq "^## \[$(printf '%s' "$version" | sed 's/[.]/\\./g')\] - [0-9]{4}-[0-9]{2}-[0-9]{2}" CHANGELOG.md; then
  echo "check-version: CHANGELOG.md has no '## [$version] - YYYY-MM-DD' section" >&2
  exit 1
fi
scripts/release/changelog-notes.sh "$version" >/dev/null
echo "check-version: $tag matches VERSION and CHANGELOG.md"
