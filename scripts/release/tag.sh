#!/usr/bin/env bash
# tag.sh [--push] [TAG]
# Create the annotated release tag locally. Refuses when the working tree is
# dirty, when the tag does not match VERSION, when CHANGELOG.md lacks the
# section, or when the tag already exists. TAG defaults to "v$(cat VERSION)".
# The tag message is the CHANGELOG section. With --push the tag is pushed to
# `origin`, which triggers .forgejo/workflows/release.yml.
set -euo pipefail
cd "$(dirname "$0")/../.."

push=0
tag=""
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) tag=$arg ;;
  esac
done
[ -n "$tag" ] || tag="v$(tr -d '[:space:]' <VERSION)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "tag: working tree has uncommitted changes, commit or stash first" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
scripts/release/check-version.sh "$tag"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "tag: $tag already exists ($(git rev-parse --short "refs/tags/$tag"))" >&2
  exit 1
fi

notes=$(scripts/release/changelog-notes.sh "$tag")
git tag -a "$tag" -m "beatbump $tag" -m "$notes"
echo "tag: created $tag on $(git rev-parse --short HEAD) ($(git branch --show-current))"
if [ "$push" = 1 ]; then
  git push origin "refs/tags/$tag"
  echo "tag: pushed, the release workflow runs on origin"
else
  echo "next: git push origin $tag"
fi
