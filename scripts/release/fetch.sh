#!/usr/bin/env bash
# fetch.sh URL DEST [SHA256]
# Download URL to DEST with resume + retries (long downloads inside CI job
# containers get reset now and then), then verify the SHA-256 when given.
# The SHA may be the bare hex digest or a "<hex>  <name>" checksum line.
set -euo pipefail

url=${1:?url}
dest=${2:?dest}
sha=${3:-}

mkdir -p "$(dirname "$dest")"
rm -f "$dest"
attempt=0
until curl -fsSL -C - --retry 3 --retry-delay 5 --connect-timeout 20 -o "$dest" "$url"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 5 ]; then
    echo "fetch: giving up on $url after $attempt attempts" >&2
    exit 1
  fi
  echo "fetch: retry $attempt for $url" >&2
  sleep 5
done

if [ -n "$sha" ]; then
  hex=$(printf '%s' "$sha" | awk '{print $1}')
  echo "$hex  $dest" | sha256sum -c - >/dev/null || {
    echo "fetch: SHA-256 mismatch for $url" >&2
    exit 1
  }
fi
