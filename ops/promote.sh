#!/bin/sh
# Promotion en PROD de l'app musique (music.ekaii.fr) depuis l'image testee sur staging.
# A lancer UNIQUEMENT apres un harness offline vert sur staging-music.ekaii.fr.
#  - promeut l'image EXACTE testee (beatbump-ekaii:staging) en beatbump-ekaii:local
#  - passe la prod en audio same-origin (LOCALF_BASE=/localf, COVER_BASE=/cover, IVVP_URL)
#  - recree uniquement le service beatbump (pas de --deps), verifie, et affiche le rollback
# Usage : sh promote.sh [sha court attendu]   (cycle 34 OP3 : sans argument, la version attendue est celle
#   que sert ytm-beatbump-staging s il tourne sur l image beatbump-ekaii:staging ; voir agents/ops/README.md)
# Codes de sortie (cycle 39 L11-2) : 0 = promu et verifie ; 2 = sauvegarde image ECHOUEE (tarball invalide :
#   tag :local remis sur l image prod precedente, prod NON recreee, aucune rotation) ; 3 = promu mais prod HTTP
#   != 200, version servie illisible ou differente de l attendue, ou smoke en echec (lignes ROLLBACK affichees avant).
# Cycle 43 (lane c43c, B7-14 / B7-15) :
#   - healthcheck : l image est FROM scratch (ni wget, ni curl, ni busybox) ; le test est le binaire lui-meme
#     (`/app/beat-server -healthcheck`, healthcheck.go). Le bloc `healthcheck` du service beatbump est ecrit ICI
#     (seul chemin d ecriture du compose prod), de facon idempotente, SEULEMENT si l image promue porte le label
#     fr.ekaii.ytm.healthcheck=1 (Dockerfile) ; sans label, un bloc existant est retire (un binaire plus ancien
#     ignorerait l argument et demarrerait un second serveur). Apres `up -d`, attente de l etat healthy (75 s
#     max) : unhealthy ou toujours starting = exit 3 (ROLLBACK affiche).
#   - smoke navigateur : ops/smoke.sh est appele avec SMOKE_BROWSER=1 (e2e/harness-smoke.cjs via e2e/run.sh,
#     < 90 s, saute avec un message si un ytm-harness-* tourne deja) ; PROMOTE_SMOKE_BROWSER=0 pour s en passer.
#     Un smoke en echec (HTTP ou navigateur) = exit 3 (promu mais pas sain) + un bloc dans program/ALERT.md
#     (meme forme que weekly.sh).
set -eu
YTM=/srv/beatbump
cd "$YTM"
TS=$(date -u +%Y%m%d-%H%M%S)
R="--resolve music.ekaii.fr:443:127.0.0.1"
ver() { python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true; }
EXPECT="${1:-}"
STG_ID=$(docker image inspect -f '{{.Id}}' beatbump-ekaii:staging | cut -c8-19)
if [ -z "$EXPECT" ] && [ "$(docker inspect -f '{{.Image}}' ytm-beatbump-staging 2>/dev/null | cut -c8-19)" = "$STG_ID" ]; then
  EXPECT=$(curl -s --max-time 10 --resolve staging-music.ekaii.fr:443:127.0.0.1 https://staging-music.ekaii.fr/api/v1/stats/library | ver)
fi
PREV_VER=$(curl -s --max-time 10 $R https://music.ekaii.fr/api/v1/stats/library | ver)
PREV_ID=$(docker image inspect -f '{{.Id}}' beatbump-ekaii:local 2>/dev/null | cut -c8-19 || true)
echo "promotion $TS : image $STG_ID (version attendue ${EXPECT:-inconnue}) ; prod actuelle ${PREV_ID:-?} (version ${PREV_VER:-?})"
cp docker-compose.yml "docker-compose.yml.pre-sameorigin-$TS"
N=$(ls docker-compose.yml.pre-sameorigin-* | wc -l)
ls -t docker-compose.yml.pre-sameorigin-* | tail -n +11 | xargs -r -d '\n' rm -f --
echo "backups compose : $N -> $(ls docker-compose.yml.pre-sameorigin-* | wc -l) (10 plus recents gardes)"
python3 - <<"PY"
import pathlib, sys
p = pathlib.Path("/srv/beatbump/docker-compose.yml"); s = p.read_text()
old_l = "      LOCALF_BASE: https://ytify.ekaii.fr/localf\n"
old_c = "      COVER_BASE: https://ytify.ekaii.fr/cover\n"
if old_l in s: s = s.replace(old_l, "      LOCALF_BASE: /localf\n", 1)
if old_c in s: s = s.replace(old_c, "      COVER_BASE: /cover\n      IVVP_URL: http://iv-vp:5007\n", 1)
if "IVVP_URL" not in s: print("ANCRE COVER_BASE introuvable dans le service beatbump"); sys.exit(1)
p.write_text(s); print("compose prod: env same-origin poses")
PY
# c43c B7-14 : bloc healthcheck du service beatbump (ajoute / garde / retire selon le label de l image promue).
HC_LABEL=$(docker image inspect -f '{{index .Config.Labels "fr.ekaii.ytm.healthcheck"}}' beatbump-ekaii:staging 2>/dev/null || true)
HC_LABEL="$HC_LABEL" python3 - <<"PY"
import os, pathlib, re, sys
p = pathlib.Path("/srv/beatbump/docker-compose.yml"); s = p.read_text()
want = os.environ.get("HC_LABEL", "") == "1"
m = re.search(r"(?m)^  beatbump:\n", s)
if not m: print("service beatbump introuvable dans le compose prod"); sys.exit(1)
start = m.end()
e = re.search(r"(?m)^(  \S|\S)", s[start:])
end = start + e.start() if e else len(s)
block = s[start:end]
has = re.search(r"(?m)^    healthcheck:\n", block) is not None
hc = ("    healthcheck:\n"
      "      test: [\"CMD\", \"/app/beat-server\", \"-healthcheck\"]\n"
      "      interval: 30s\n"
      "      timeout: 5s\n"
      "      retries: 3\n"
      "      start_period: 20s\n")
if want and not has:
    anchor = "    restart: unless-stopped\n"
    if anchor not in block: print("ANCRE restart: unless-stopped introuvable dans le service beatbump"); sys.exit(1)
    block = block.replace(anchor, anchor + hc, 1)
    print("compose prod: bloc healthcheck ajoute (beat-server -healthcheck, 30s/5s/3/20s)")
elif want:
    print("compose prod: bloc healthcheck deja present")
elif has:
    block = re.sub(r"(?m)^    healthcheck:\n(?:      .*\n)*", "", block, count=1)
    print("compose prod: bloc healthcheck RETIRE (image sans label fr.ekaii.ytm.healthcheck)")
else:
    print("compose prod: pas de healthcheck (image sans label fr.ekaii.ytm.healthcheck : binaire sans -healthcheck)")
p.write_text(s[:start] + block + s[end:])
PY
# c59c (decisions 15 et 17) : env_file du service beatbump (secrets hors compose : COMPANION_SECRET_KEY,
# YTM_ADMIN_TOKEN, YTM_REPORT_EMAIL dans /srv/beatbump/beatbump.env, mode 600). Ajoute de facon idempotente
# SEULEMENT si le fichier existe, est en mode 600 et porte COMPANION_SECRET_KEY= ; la ligne COMPANION_SECRET_KEY en
# clair est alors retiree du compose (la valeur vient du fichier). Sans fichier valide : compose inchange (message).
python3 - <<"PY"
import os, pathlib, re, stat, sys
ENV = "/srv/beatbump/beatbump.env"
p = pathlib.Path("/srv/beatbump/docker-compose.yml"); s = p.read_text()
m = re.search(r"(?m)^  beatbump:\n", s)
if not m: print("service beatbump introuvable dans le compose prod"); sys.exit(1)
start = m.end()
e = re.search(r"(?m)^(  \S|\S)", s[start:])
end = start + e.start() if e else len(s)
block = s[start:end]
try:
    st = os.stat(ENV)
    ok = stat.S_ISREG(st.st_mode) and (st.st_mode & 0o077) == 0 and "COMPANION_SECRET_KEY=" in pathlib.Path(ENV).read_text()
except OSError:
    ok = False
if not ok:
    print("compose prod: env_file NON pose (%s absent, mode != 600 ou sans COMPANION_SECRET_KEY=) : compose inchange" % ENV)
    sys.exit(0)
ef = "    env_file:\n      - %s\n" % ENV
if "    env_file:\n" not in block:
    anchor = "    environment:\n"
    if anchor not in block: print("ANCRE environment: introuvable dans le service beatbump"); sys.exit(1)
    block = block.replace(anchor, ef + anchor, 1)
    print("compose prod: env_file ajoute (%s)" % ENV)
else:
    print("compose prod: env_file deja present")
n = len(re.findall(r"(?m)^      COMPANION_SECRET_KEY: .*\n", block))
if n:
    block = re.sub(r"(?m)^      COMPANION_SECRET_KEY: .*\n", "", block)
    print("compose prod: %d ligne COMPANION_SECRET_KEY en clair retiree (valeur dans env_file)" % n)
p.write_text(s[:start] + block + s[end:])
PY
docker compose config -q && echo "compose prod valide"
# Rollback safety: keep the current prod image under a dated tag AND as a tarball outside the
# Docker image store (a prune on this box deleted the previous backup tags on 2026-10-01).
if docker image inspect beatbump-ekaii:local >/dev/null 2>&1; then
  docker tag beatbump-ekaii:local "beatbump-ekaii:prod-backup-$TS"
  BACKUP_TAG="beatbump-ekaii:prod-backup-$TS"
else
  echo "ATTENTION: beatbump-ekaii:local absent du store (image elaguee) : pas de tag de backup, seul le tarball precedent fait foi"
  BACKUP_TAG=""
fi
docker tag beatbump-ekaii:staging beatbump-ekaii:local
BK="$YTM/image-backups"
mkdir -p "$BK"
SID=$(docker image inspect -f '{{.Id}}' beatbump-ekaii:staging | cut -c8-19)
TAR="$BK/beatbump-prod-$TS-$SID.tar.gz"
# L11-2 : docker save -o (pas de pipe : un echec de docker save n est plus masque par gzip), gzip -t et taille
# > 10 Mo AVANT de nommer le tarball ; la rotation (3 plus recents) ne tourne que si le nouveau est valide.
if docker save -o "$TAR.tmp.tar" beatbump-ekaii:local && gzip -1 "$TAR.tmp.tar" && gzip -t "$TAR.tmp.tar.gz" \
   && [ "$(wc -c < "$TAR.tmp.tar.gz")" -gt 10485760 ] && mv "$TAR.tmp.tar.gz" "$TAR"; then
  echo "image sauvegardee (gzip -t ok, $(wc -c < "$TAR") octets): $TAR"
  ls -t "$BK"/beatbump-prod-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r -d '\n' rm -f --
else
  rm -f "$TAR.tmp.tar" "$TAR.tmp.tar.gz"
  echo "!!!!! WARNING: sauvegarde image ECHOUEE ($TAR : docker save, gzip, gzip -t ou taille <= 10 Mo) : rotation annulee, prod NON recreee !!!!!"
  if [ -n "$BACKUP_TAG" ]; then docker tag "$BACKUP_TAG" beatbump-ekaii:local && echo "beatbump-ekaii:local remis sur $BACKUP_TAG (${PREV_ID:-?})"
  else echo "!!!!! WARNING: pas de tag de backup : beatbump-ekaii:local pointe sur l image staging $STG_ID mais le conteneur prod n a pas ete recree"; fi
  echo "verifier l espace disque : df -h $BK ; puis relancer promote.sh (exit 2)"
  exit 2
fi
# c52c (B9-19 / B9-22) : journal d acces du conteneur prod copie AVANT sa recreation (docker logs repart de zero
# avec le nouveau conteneur) : l audit perf (e2e/perf-audit/log-latency.py) garde l historique entre promotions.
# Nom : access-<date>-<sha de l ancienne image>.log ; 10 fichiers gardes ; echec non bloquant (timeout 60).
ALOG_DIR="$YTM/agents/program/logs"
mkdir -p "$ALOG_DIR"
ALOG="$ALOG_DIR/access-$TS-${PREV_ID:-inconnu}.log"
if timeout 60 docker logs ytm-beatbump > "$ALOG" 2>&1; then
  echo "journal d acces copie : $ALOG ($(wc -c < "$ALOG") octets, $(wc -l < "$ALOG") lignes)"
else
  echo "ATTENTION: copie du journal d acces echouee ($ALOG) : promotion poursuivie"
fi
ls -t "$ALOG_DIR"/access-*.log 2>/dev/null | tail -n +11 | xargs -r -d '\n' rm -f --
docker compose up -d --no-deps beatbump
FAIL=""
c=000
for i in 1 2 3 4 5 6 7 8; do
  c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 --resolve "music.ekaii.fr:443:127.0.0.1" -A "Mozilla/5.0 (Macintosh) Chrome/128" https://music.ekaii.fr/ || true)
  [ "$c" = "200" ] && break; sleep 5
done
echo "prod HTTP $c"
[ "$c" = "200" ] || { echo "!!!!! WARNING: prod HTTP $c (attendu 200) : ROLLBACK ci-dessous !!!!!"; FAIL="$FAIL http"; }
# c43c B7-14 : etat du healthcheck docker (seulement si le compose en a un : .State.Health absent sinon).
HS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' ytm-beatbump 2>/dev/null || true)
if [ -n "$HS" ]; then
  for i in $(seq 1 15); do
    [ "$HS" = healthy ] && break
    sleep 5
    HS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' ytm-beatbump 2>/dev/null || true)
  done
  if [ "$HS" = healthy ]; then echo "prod healthcheck : healthy"
  else
    echo "!!!!! WARNING: prod healthcheck '$HS' apres 75 s (attendu healthy) : ROLLBACK ci-dessous !!!!!"
    docker inspect -f '{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{printf "%.120s" .Output}}{{"\n"}}{{end}}' ytm-beatbump 2>/dev/null | tail -3 | sed 's/^/  healthcheck log: /' || true
    FAIL="$FAIL healthcheck"
  fi
else
  echo "prod healthcheck : aucun (compose sans bloc healthcheck)"
fi
# Sonde finale SANS acquisition (OP3) : stats/library, puis Range /localf sur une piste LOCALE (lid de
# local/songs ; player.json avec un lid repond depuis l index local, avant toute acquisition).
STATS=$(curl -s --max-time 15 $R https://music.ekaii.fr/api/v1/stats/library || true)
echo "prod stats/library: $STATS"
SERVED=$(printf '%s' "$STATS" | ver)
LID=$(curl -s --max-time 15 $R "https://music.ekaii.fr/api/v1/local/songs?limit=1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["items"][0]["videoId"])' 2>/dev/null || true)
U=$(curl -s --max-time 30 $R -H "X-Ytm-Prefetch: 1" -A "Mozilla/5.0 (Macintosh) Chrome/128" "https://music.ekaii.fr/api/v1/player.json?videoId=$LID" | python3 -c 'import json,sys;d=json.load(sys.stdin);f=[x for x in (d.get("streamingData",{}).get("adaptiveFormats") or []) if str(x.get("url","")).startswith("/localf")];print(f[0]["url"] if f else "")' 2>/dev/null || true)
printf "prod piste locale %s url: %.80s\n" "${LID:-?}" "$U"
curl -s -o /dev/null -D - --max-time 30 $R -A "Mozilla/5.0 (Macintosh) Chrome/128" -r 0-1023 "https://music.ekaii.fr$U" | grep -iE "^HTTP|content-type|accept-ranges|content-range|x-ytm" || echo "!!!!! WARNING: pas de reponse Range sur /localf (lid=${LID:-absent})"
if [ -z "$SERVED" ]; then echo "!!!!! WARNING: version servie illisible sur stats/library : verifier, ROLLBACK ci-dessous si besoin"; FAIL="$FAIL version-illisible"
elif [ -z "$EXPECT" ]; then echo "version servie = $SERVED (version attendue inconnue : passer le SHA en argument pour la verifier)"
elif [ "$SERVED" = "$EXPECT" ]; then echo "version servie = $SERVED OK"
else echo "!!!!! WARNING: version servie $SERVED != attendue $EXPECT : la prod ne sert PAS l image testee, ROLLBACK ci-dessous !!!!!"; FAIL="$FAIL version"; fi
[ "$STG_ID" = "${PREV_ID:-}" ] && echo "!!!!! WARNING: beatbump-ekaii:staging = image prod precedente ($STG_ID) : rien n a ete promu"
PREV_TAR=$(ls -t "$BK"/beatbump-prod-*-"${PREV_ID:-none}".tar.gz 2>/dev/null | head -1 || true)
[ -n "$PREV_TAR" ] || PREV_TAR=$(ls -t "$BK"/beatbump-prod-*.tar.gz 2>/dev/null | sed -n 2p || true)
[ -z "$PREV_TAR" ] || gzip -t "$PREV_TAR" 2>/dev/null || echo "!!!!! WARNING: tarball precedent $PREV_TAR illisible (gzip -t) : rollback par le tag seulement"
echo "ROLLBACK (depuis $YTM, retour a ${PREV_ID:-?} version ${PREV_VER:-?}) :"
if [ -n "$BACKUP_TAG" ]; then
  echo "  par le tag : cd \"$YTM\" && docker tag $BACKUP_TAG beatbump-ekaii:local && cp docker-compose.yml.pre-sameorigin-$TS docker-compose.yml && docker compose up -d --no-deps beatbump"
fi
echo "  par le tarball : cd \"$YTM\" && docker load -i \"${PREV_TAR:-<tarball precedent introuvable>}\" && docker tag ${PREV_ID:-<image>} beatbump-ekaii:local && cp docker-compose.yml.pre-sameorigin-$TS docker-compose.yml && docker compose up -d --no-deps beatbump"
echo "  verifier : curl -s $R https://music.ekaii.fr/api/v1/stats/library  (version attendue ${PREV_VER:-?})"
if [ -f "$YTM/agents/ops/smoke.sh" ]; then
  # c43c B7-15 : smoke HTTP + navigateur (SMOKE_BROWSER=1 ; YTM_RUN_SKIP_BUILD_WAIT=1 car finish-cycle.sh tient
  # /tmp/beatbump-build.lock autour de promote.sh et run.sh attendrait 900 s "le build"). Sortie gardee dans un
  # fichier pour le bloc ALERT.md, puis affichee en entier.
  SMOKE_LOG=$(mktemp /tmp/ytm-promote-smoke.XXXXXX)
  if SMOKE_BROWSER="${PROMOTE_SMOKE_BROWSER:-1}" YTM_RUN_SKIP_BUILD_WAIT=1 sh "$YTM/agents/ops/smoke.sh" https://music.ekaii.fr ${EXPECT:+"$EXPECT"} >"$SMOKE_LOG" 2>&1; then
    cat "$SMOKE_LOG"; echo "smoke 0 echec"
  else
    cat "$SMOKE_LOG"
    echo "!!!!! WARNING: smoke en echec (detail ci-dessus) : decider du ROLLBACK !!!!!"; FAIL="$FAIL smoke"
    ALERT="$YTM/agents/program/ALERT.md"
    [ -f "$ALERT" ] || printf '# ALERT music.ekaii.fr (ecrit par agents/ops/weekly.sh ou agents/promote.sh ; supprimer apres traitement)\n' > "$ALERT"
    {
      printf '\n## %s UTC (promote.sh)\n' "$(date -u +"%Y-%m-%d %H:%M")"
      printf -- '- raisons : smoke en echec apres la promotion %s (image %s, version attendue %s) : promu mais pas sain (exit 3), ROLLBACK a decider\n' "$TS" "$STG_ID" "${EXPECT:-inconnue}"
      grep -E '^(FAIL|SKIP|SMOKE) ' "$SMOKE_LOG" | sed 's/^/- /' || true
    } >> "$ALERT"
    echo "bloc ajoute a $ALERT"
  fi
  rm -f "$SMOKE_LOG"
fi
if [ -n "$FAIL" ]; then
  echo "!!!!! WARNING: promotion $TS en ECHEC (${FAIL# }) : appliquer une ligne ROLLBACK ci-dessus (exit 3) !!!!!"
  exit 3
fi
echo "promotion $TS OK (exit 0)"
