#!/bin/sh
# Lance les sondes de l'audit acces (lecture seule) DEPUIS la box. Memes conventions que ../run.sh.
#   run-probe.sh probe [url] [query]   -> parcours interne (IP interne => ALLOW), staging par defaut
#   run-probe.sh tor   [url]           -> gate PoW via Tor SOCKS 127.0.0.1:9055 (prod par defaut, GET only)
set -eu
E2E=/srv/beatbump/e2e
MODE="${1:-probe}"
IMG=mcr.microsoft.com/playwright:v1.47.0-jammy
TS=$(date -u +%Y%m%d-%H%M%S)
if [ ! -d "$E2E/node_modules/playwright" ]; then
  docker run --rm -v "$E2E:/e2e" -w /e2e "$IMG" sh -c "npm i --no-save --no-audit --no-fund playwright@1.47.0 >/dev/null 2>&1 && echo playwright npm installe"
fi
case "$MODE" in
  probe)
    URL="${2:-https://staging-music.ekaii.fr}"; QUERY="${3:-daft punk}"
    OUT="$E2E/access-audit/out/$TS"; mkdir -p "$OUT"
    docker run --rm --network host -v "$E2E:/e2e" -w /e2e/access-audit -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright "$IMG" \
      node probe.cjs --url="$URL" --out="/e2e/access-audit/out/$TS" --query="$QUERY" --resolver="MAP *.ekaii.fr 127.0.0.1"
    echo "rapport: $OUT/report.json" ;;
  tor)
    URL="${2:-https://music.ekaii.fr}"
    OUT="$E2E/access-audit/out-tor/$TS"; mkdir -p "$OUT"
    docker run --rm --network host -v "$E2E:/e2e" -w /e2e/access-audit -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright "$IMG" \
      node gate-tor.cjs --url="$URL" --out="/e2e/access-audit/out-tor/$TS"
    echo "rapport: $OUT/report.json" ;;
  *) echo "usage: $0 probe|tor [url] [query]"; exit 2 ;;
esac
