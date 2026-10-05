#!/usr/bin/env bash
# forgejo-release.sh TAG [ASSET...]
# Create (or update) the Forgejo release for TAG with the matching CHANGELOG.md
# section as notes, then attach the given files as release assets (an asset
# with the same name is replaced). Idempotent: re-running updates in place.
#
# Environment:
#   RELEASE_TOKEN  required, a Forgejo access token with write:repository
#   FORGEJO_URL    default $GITHUB_SERVER_URL or https://forgejo.ekaii.fr
#   REPO           default $GITHUB_REPOSITORY or Ekaii/beatbump
#   REGISTRY / IMAGE_NS   used for the "Images" paragraph of the notes
#   DRAFT          1 to create a draft (default 0)
# Needs curl and python3 (JSON). Only the Forgejo REST API is used, no action.
set -euo pipefail
cd "$(dirname "$0")/../.."

tag=${1:?tag}; shift || true
: "${RELEASE_TOKEN:?RELEASE_TOKEN is required (write:repository)}"
FORGEJO_URL=${FORGEJO_URL:-${GITHUB_SERVER_URL:-https://forgejo.ekaii.fr}}
REPO=${REPO:-${GITHUB_REPOSITORY:-Ekaii/beatbump}}
REGISTRY=${REGISTRY:-forgejo.ekaii.fr}
IMAGE_NS=${IMAGE_NS:-ekaii/beatbump}
DRAFT=${DRAFT:-0}
api="$FORGEJO_URL/api/v1/repos/$REPO"

version=${tag#v}
notes=$(scripts/release/changelog-notes.sh "$version")
prerelease=false
case "$version" in *-*) prerelease=true ;; esac

body=$(cat <<EOF
$notes

### Images

Published to the Forgejo container registry (linux/amd64):

- \`$REGISTRY/$IMAGE_NS:$tag\`
- \`$REGISTRY/$IMAGE_NS-bridge:$tag\`
- \`$REGISTRY/$IMAGE_NS-indexer:$tag\`
- \`$REGISTRY/$IMAGE_NS-yubal:$tag\`

Deploy by building locally (\`deploy/compose.yml\` + \`up.sh\`, attached below) or
by pulling these images with the \`deploy/compose.images.yml\` override:
\`docker compose -f deploy/compose.yml -f deploy/compose.images.yml up -d\`.
EOF
)

req() { # req METHOD PATH [curl args...]
  local method=$1 path=$2; shift 2
  curl -sS --fail-with-body --retry 3 --retry-delay 5 \
    -H "Authorization: token $RELEASE_TOKEN" -H "Accept: application/json" \
    -X "$method" "$api$path" "$@"
}
json_field() { python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get(sys.argv[1], ""); print(v if not isinstance(v, bool) else str(v).lower())' "$1"; }

payload=$(TAG="$tag" BODY="$body" PRE="$prerelease" DRAFT="$DRAFT" python3 -c '
import json, os
print(json.dumps({
  "tag_name": os.environ["TAG"],
  "name": "beatbump " + os.environ["TAG"],
  "body": os.environ["BODY"],
  "draft": os.environ["DRAFT"] == "1",
  "prerelease": os.environ["PRE"] == "true",
}))')

existing=$(req GET "/releases/tags/$tag" 2>/dev/null || true)
release_id=""
if [ -n "$existing" ]; then release_id=$(printf '%s' "$existing" | json_field id 2>/dev/null || true); fi
if [ -n "$release_id" ] && [ "$release_id" != "" ]; then
  echo "release: updating existing release $release_id for $tag"
  req PATCH "/releases/$release_id" -H "Content-Type: application/json" --data-binary "$payload" >/dev/null
else
  echo "release: creating release for $tag"
  created=$(req POST "/releases" -H "Content-Type: application/json" --data-binary "$payload")
  release_id=$(printf '%s' "$created" | json_field id)
fi
[ -n "$release_id" ] || { echo "release: could not determine the release id" >&2; exit 1; }
echo "release: id $release_id -> $FORGEJO_URL/$REPO/releases/tag/$tag"

if [ $# -gt 0 ]; then
  assets=$(req GET "/releases/$release_id/assets")
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "release: asset $f missing, skipped" >&2; continue; fi
    name=$(basename "$f")
    # deploy/.env.example keeps its dot name; a bare ".env.example" is fine as an asset.
    old=$(printf '%s' "$assets" | NAME="$name" python3 -c 'import json,os,sys; print(" ".join(str(a["id"]) for a in json.load(sys.stdin) if a.get("name")==os.environ["NAME"]))')
    for id in $old; do
      echo "release: replacing asset $name ($id)"
      req DELETE "/releases/$release_id/assets/$id" >/dev/null
    done
    echo "release: uploading $f as $name"
    req POST "/releases/$release_id/assets?name=$name" -F "attachment=@$f" >/dev/null
  done
fi
echo "release: done"
