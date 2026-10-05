#!/usr/bin/env bash
# Validate the deploy stack without a Docker daemon:
#   docker compose -f deploy/compose.yml config -q
#   docker compose -f deploy/compose.yml -f deploy/compose.images.yml config -q
# with a deploy/.env generated from deploy/.env.example when none exists: the
# example leaves the secrets empty and compose.yml requires them (`${VAR:?}`),
# so every required variable without a value gets a 16-character placeholder
# (the companion secret must be exactly 16 characters). The generated file is
# removed afterwards so a local run never leaves one behind; an existing
# deploy/.env is used as is. Also checks that every service named in
# compose.images.yml exists in compose.yml.
set -euo pipefail
cd "$(dirname "$0")/../.."

base=deploy/compose.yml
images=deploy/compose.images.yml
[ -f "$base" ] || { echo "ci-compose: $base missing"; exit 1; }

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "ci-compose: neither 'docker compose' nor docker-compose found (scripts/release/ci-install-tools.sh compose)" >&2
  exit 1
fi

made_env=0
if [ ! -f deploy/.env ] && [ -f deploy/.env.example ]; then
  cp deploy/.env.example deploy/.env
  made_env=1
  placeholder=0123456789abcdef
  # Required variables: every ${VAR:?...} / ${VAR?...} of the compose files.
  required=$(grep -ohE '\$\{[A-Za-z_][A-Za-z0-9_]*:?\?' "$base" "$images" 2>/dev/null | sed -E 's/^\$\{([A-Za-z0-9_]+).*/\1/' | sort -u)
  for var in $required; do
    if ! grep -qE "^${var}=.+" deploy/.env; then
      sed -i.bak "/^${var}=\$/d" deploy/.env && rm -f deploy/.env.bak
      printf '%s=%s\n' "$var" "$placeholder" >>deploy/.env
      echo "generated deploy/.env: $var=<placeholder>"
    fi
  done
fi
cleanup() { [ "$made_env" = 1 ] && rm -f deploy/.env; return 0; }
trap cleanup EXIT

echo "compose config: $base"
compose -f "$base" config -q
compose -f "$base" config --services | sort >/tmp/compose-base-services.txt
echo "services: $(tr '\n' ' ' </tmp/compose-base-services.txt)"

if [ -f "$images" ]; then
  echo "compose config: $base + $images"
  compose -f "$base" -f "$images" config -q
  compose -f "$images" config --services 2>/dev/null | sort >/tmp/compose-images-services.txt || true
  if [ -s /tmp/compose-images-services.txt ]; then
    extra=$(comm -13 /tmp/compose-base-services.txt /tmp/compose-images-services.txt || true)
    if [ -n "$extra" ]; then
      echo "ci-compose: $images names services absent from $base: $(echo "$extra" | tr '\n' ' ')" >&2
      exit 1
    fi
  fi
  echo "images override resolves:"
  compose -f "$base" -f "$images" config --images 2>/dev/null | sed 's/^/  /' || true
fi
echo "compose: ok"
