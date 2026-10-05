#!/bin/sh
# Lundi de music.ekaii.fr en UNE commande (cycle 53, lane c53a, brainstorm-v9 B9-15) : la ligne de cron de la
# decision 19 (cron.weekly.example). A lancer SUR la box docker-host, jamais depuis un harness ou une chaine.
#   1. attente (au plus MONDAY_WAIT_MAX s, defaut 1800, pas de 30 s) tant qu un conteneur ytm-harness-* tourne,
#      qu un finish-cycle.sh est en cours (la chaine garde le navigateur entre deux etapes) ou que le verrou de
#      build /tmp/beatbump-build.lock est tenu (meme test flock -n que e2e/run.sh) ; attente ecoulee = on
#      continue, run.sh garde ses propres refus (autre navigateur : exit 2, charge 1 min > 60 : attente 15 min) ;
#   2. harness prod palier full : HARNESS_TIER=full e2e/run.sh https://music.ekaii.fr "daft punk" harness-core.cjs
#      (timeout 1500 s) puis harness-offline.cjs (timeout 900 s) ; l en-tete X-Ytm-Harness est pose par le harness
#      (c52c) : aucune ecoute n est ecrite dans la base prod ;
#   3. weekly.sh (ligne WEEKLY.md, bloc ALERT.md si besoin) avec WEEKLY_DB_RO=1 (colonne retention, lecture seule
#      de la base ; retirer la variable ci-dessous pour s en passer) ;
#   4. smoke.sh https://music.ekaii.fr <dernier "PROD = <sha>" de CYCLES.md> avec SMOKE_ALERT=1 (HTTP seulement :
#      le navigateur a deja tourne en 2 ; le smoke quotidien avec navigateur est l autre ligne de cron).
# Journal : program/logs/monday-<AAAA-MM-JJ>.log (dossier cree au besoin, 10 fichiers gardes) ; stdout du cron
# (-> ops/monday-cron.log) ne recoit que le resume final (une ligne par etape + le code de sortie).
# Code de sortie = le pire des trois (harness = pire de coeur / hors-ligne ; weekly ; smoke) :
#   0 tout vert ; 1 echec (etape FAIL, smoke en echec, weekly en erreur) ; 2 refus de run.sh (autre navigateur) ;
#   124 timeout ; les deux rapports full et la ligne WEEKLY sont ecrits meme si une etape est rouge.
# Usage : sh /srv/beatbump/agents/ops/monday.sh        (environ 25 a 35 min sur une box calme)
#   MONDAY_SKIP_HARNESS=1 : saute l etape 2 (weekly.sh lit alors le dernier rapport full existant ; test rapide).
set -u
YTM=/srv/beatbump
AG="$YTM/agents"
E2E="$YTM/e2e"
PRD=https://music.ekaii.fr
LOGDIR="$AG/program/logs"
BUILD_LOCK=/tmp/beatbump-build.lock
WAIT_MAX="${MONDAY_WAIT_MAX:-1800}"

mkdir -p "$LOGDIR" || { echo "monday.sh : dossier de journal impossible : $LOGDIR" >&2; exit 1; }
LOG="$LOGDIR/monday-$(date -u +%Y-%m-%d).log"
# stdout d origine (cron) garde sur 3 pour le resume ; tout le reste va dans le journal du jour
exec 3>&1
exec >> "$LOG" 2>&1
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
worst() { [ "$1" -ge "$2" ] && echo "$1" || echo "$2"; }

log "== monday.sh debut (log $LOG, attente max ${WAIT_MAX} s)"

# 1. attendre que la box soit libre : pas de navigateur harness, pas de chaine, pas de build
harness_up() { docker ps --format '{{.Names}}' 2>/dev/null | grep '^ytm-harness-' | head -1; }
chain_up() { pgrep -f "ops/finish-cycle.sh" 2>/dev/null | head -1; }
build_running() { command -v flock >/dev/null 2>&1 && [ -e "$BUILD_LOCK" ] && ! flock -n "$BUILD_LOCK" true 2>/dev/null; }
W=0
while :; do
  H=$(harness_up); C=$(chain_up); B=""; build_running && B=oui
  [ -z "$H" ] && [ -z "$C" ] && [ -z "$B" ] && break
  if [ "$W" -ge "$WAIT_MAX" ]; then
    log "ATTENTION : attente de ${WAIT_MAX} s ecoulee (harness=${H:-non}, chaine pid=${C:-non}, build=${B:-non}) : on continue, run.sh garde ses refus"
    break
  fi
  log "attente ${W}s / ${WAIT_MAX}s (harness=${H:-non}, chaine pid=${C:-non}, build=${B:-non}, charge $(cut -d' ' -f1 /proc/loadavg 2>/dev/null))"
  sleep 30; W=$((W + 30))
done

# 2. harness prod palier full : coeur puis hors-ligne (run.sh : un seul navigateur, verrou de build, charge)
RC_H=0
if [ "${MONDAY_SKIP_HARNESS:-0}" = 1 ]; then
  log "== harness prod saute (MONDAY_SKIP_HARNESS=1)"
else
  for H in harness-core.cjs:1500 harness-offline.cjs:900; do
    F=${H%%:*}; T=${H##*:}
    log "== harness prod full $F (timeout ${T} s, charge $(cut -d' ' -f1 /proc/loadavg 2>/dev/null))"
    ( cd "$E2E" && HARNESS_TIER=full timeout "$T" sh ./run.sh "$PRD" "daft punk" "$F" ); rc=$?
    log "harness $F exit $rc"
    RC_H=$(worst "$RC_H" "$rc")
  done
fi

# 3. weekly.sh : ecrit la ligne WEEKLY.md (stdout) et les raisons d alerte (stderr, bloc ALERT.md)
log "== weekly.sh"
WEEKLY_DB_RO=1 sh "$AG/ops/weekly.sh"; RC_W=$?
log "weekly.sh exit $RC_W"

# 4. smoke.sh HTTP avec la version attendue = dernier "PROD = <sha>" de CYCLES.md (vide si introuvable)
EXPECT=$(grep -o 'PROD = [0-9a-f]\{7,12\}' "$AG/program/CYCLES.md" 2>/dev/null | tail -1 | cut -d' ' -f3)
log "== smoke.sh $PRD ${EXPECT:-(version attendue inconnue)} (SMOKE_ALERT=1)"
SMOKE_ALERT=1 sh "$AG/ops/smoke.sh" "$PRD" $EXPECT; RC_S=$?
log "smoke.sh exit $RC_S"

RC=$(worst "$(worst "$RC_H" "$RC_W")" "$RC_S")

# rotation : 10 journaux monday-*.log gardes
ls -1t "$LOGDIR"/monday-*.log 2>/dev/null | tail -n +11 | while IFS= read -r f; do rm -f -- "$f"; done

LAST=$(tail -1 "$AG/program/WEEKLY.md" 2>/dev/null | cut -c1-160)
log "== monday.sh fin : harness=$RC_H weekly=$RC_W smoke=$RC_S -> exit $RC"
{
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) monday.sh : harness=$RC_H weekly=$RC_W smoke=$RC_S -> exit $RC (journal $LOG)"
  echo "  WEEKLY : $LAST"
  [ -f "$AG/program/ALERT.md" ] && echo "  ALERT.md present : $(grep -c '^## ' "$AG/program/ALERT.md" 2>/dev/null) bloc(s), a traiter puis supprimer"
} >&3
exit "$RC"
