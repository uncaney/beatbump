#!/bin/sh
# Chaine staging de music.ekaii.fr (copie versionnee de /tmp/ytm-stage-cycle2.sh, cycle 34 OP2 ; meme comportement).
#   1. build de agents/integration en beatbump-ekaii:staging sous flock /tmp/beatbump-build.lock,
#      --build-arg VERSION=$(git rev-parse --short HEAD) (la version servie par /api/v1/stats/library)
#   2. redemarrage du staging (agents/staging-compose.yml, projet ytm-staging), chauffe, controles d en-tetes
#   3. harness coeur puis hors-ligne (timeout 600 chacun) sur https://staging-music.ekaii.fr
# Ne promeut RIEN : la promotion reste manuelle (agents/promote.sh), voir agents/ops/README.md (garde SM2).
# Usage (sur la box, toujours detache avec son propre log, jamais "a && b &" dans une session ssh) :
#   nohup /srv/beatbump/agents/ops/stage-cycle.sh > /tmp/ytm-stage-cycle<N>.log 2>&1 &
# Convention de log : /tmp/ytm-stage-cycle<N>.log, <N> = numero de la chaine (ex. cycle35).
# Lecture : grep -E "^(=== |PASS|FAIL|Report|staging HTTP)" /tmp/ytm-stage-cycle<N>.log
# Modification pendant qu une chaine tourne : remplacement atomique (ecrire un tmp puis mv), jamais en place.
set -u
cd /srv/beatbump/agents/integration
echo "=== build staging $(date -u +%H:%M:%S) HEAD $(git rev-parse --short HEAD) ==="
flock /tmp/beatbump-build.lock docker build -q --build-arg VERSION=$(git rev-parse --short HEAD) -t beatbump-ekaii:staging . 2>&1 | tail -3 || { echo BUILD_FAIL; exit 1; }
cd /srv/beatbump/agents
docker compose --env-file /srv/beatbump/.env -f staging-compose.yml -p ytm-staging up -d 2>&1 | tail -1
sleep 6
# Warm-up: the first requests right after a container start were flaky (MediaError on first play).
for i in 1 2 3; do curl -s -o /dev/null --resolve staging-music.ekaii.fr:443:127.0.0.1 https://staging-music.ekaii.fr/api/v1/home.json; curl -s -o /dev/null --resolve staging-music.ekaii.fr:443:127.0.0.1 "https://staging-music.ekaii.fr/api/v1/search.json?q=daft+punk"; done
sleep 20
echo "staging HTTP $(curl -s -o /dev/null -w %{http_code} --resolve staging-music.ekaii.fr:443:127.0.0.1 https://staging-music.ekaii.fr/home) ($(docker inspect -f {{.Image}} ytm-beatbump-staging | cut -c8-19))"
echo "=== headers ==="
for u in /home /api/v1/home.json /service-worker.js; do printf "%s -> " "$u"; curl -s -o /dev/null -D - -H "Accept-Encoding: gzip, br" --resolve staging-music.ekaii.fr:443:127.0.0.1 "https://staging-music.ekaii.fr$u" | grep -i "content-encoding\|cache-control\|^HTTP" | tr "\r\n" "  "; echo; done
A=$(curl -s -H "Accept-Encoding: gzip" --compressed --resolve staging-music.ekaii.fr:443:127.0.0.1 https://staging-music.ekaii.fr/home | grep -o "/_app/immutable/[^\" ]*\.js" | head -1); printf "%s -> " "$A"; curl -s -o /dev/null -D - -H "Accept-Encoding: gzip" --resolve staging-music.ekaii.fr:443:127.0.0.1 "https://staging-music.ekaii.fr$A" | grep -i "content-encoding\|cache-control" | tr "\r\n" "  "; echo
printf "range audio -> "; curl -s -o /dev/null -D - -H "Range: bytes=0-100" -H "Accept-Encoding: gzip" --resolve staging-music.ekaii.fr:443:127.0.0.1 "https://staging-music.ekaii.fr/aud/fa5IWHDbftI" | grep -i "^HTTP\|content-encoding\|content-range" | tr "\r\n" "  "; echo
cd /srv/beatbump/e2e
# c52c (B9-13): static self-check, no browser: every Playwright context under e2e/ sends X-Ytm-Harness: 1
# (a context without it writes real plays into the prod stats during the prod harness of finish-cycle.sh).
echo "=== HARNESS HEADER CHECK $(date -u +%H:%M:%S) ==="
node check-harness-headers.cjs || { echo "HARNESS_HEADER_CHECK_FAIL (see check-harness-headers.cjs; chain stopped before the harness)"; exit 1; }
# c47a (B8-14): staging chains play the chain tier (the four full-only steps run on prod in finish-cycle.sh).
# The 900 s timeout is a net, not a target (budget 480 s). c53c (B9-25): back from 1500 to 900 on evidence,
# the last three chains' core durationMs = 629 s (chain 59), 555 s (out/20261002-104126), 528 s (out/20261002-110207).
echo "=== HARNESS CORE $(date -u +%H:%M:%S) (HARNESS_TIER=chain) ==="
HARNESS_TIER=chain timeout 900 ./run.sh https://staging-music.ekaii.fr "daft punk" harness-core.cjs 2>&1 | grep -E "^(PASS|FAIL|UPSTREAM|RETRY|Report)"
echo "=== HARNESS OFFLINE $(date -u +%H:%M:%S) ==="
HARNESS_TIER=chain timeout 900 ./run.sh https://staging-music.ekaii.fr "daft punk" harness-offline.cjs 2>&1 | grep -E "^(PASS|FAIL|Report)"
