#!/bin/sh
# Fin de cycle generique de music.ekaii.fr, cote box (survit aux coupures du lien Mac) ; cycle 39 B6-30.
# Remplace les scripts ad hoc /tmp/ytm-c37-finish.sh, /tmp/ytm-c37-promote.sh, /tmp/ytm-c38-finish.sh.
#   1. chaine staging : agents/ops/stage-cycle.sh > /tmp/ytm-stage-cycle<chain>.log (build HEAD integration,
#      harness coeur + hors-ligne) ; verte = 2 lignes "Report: P passed / F failed / U upstream" avec F = 0
#      (coeur P >= FINISH_MIN_CORE, defaut 50 ; hors-ligne P >= FINISH_MIN_OFF, defaut 17) et staging qui
#      sert la version <sha> de HEAD
#   2. --ds1 : sonde DS1 (seed sur l image prod, verify upgrade, verify rollback, staging remis sur la
#      nouvelle image) exactement comme /tmp/ytm-c37-finish.sh ; verte = "fails" vide dans
#      e2e/out/ds1-upgrade.json et ds1-rollback.json ecrits PENDANT ce run. Sans --ds1, si la garde SM2
#      s applique : pas de promotion. Garde SM2 FERMEE par defaut (cycle 42, L12-3) : elle s applique si le sha
#      prod (stats/library) est illisible, n est pas un sha, est inconnu ou ambigu dans agents/integration, n est
#      pas un ancetre de HEAD, si git diff ou la lecture des imports du SW echoue, ou si un fichier SM2 a change
#      (motif SM2_RE + fichiers importes, transitivement, par app/src/service-worker.ts ; voir sm2_guard).
#   3. sauf --no-promote : flock /tmp/beatbump-build.lock sh agents/promote.sh <sha> (sortie complete dans le
#      log ; exit != 0 = arret, lignes ROLLBACK dans le log), journal.py <cycle> <sha> --chain <chain>,
#      sonde post-deploiement (4 min, couvre l attente de 90 s), harness prod coeur puis hors-ligne
# Log : /tmp/ytm-finish-<cycle>.log, derniere ligne "FINISH <cycle> DONE".
# Usage (sur la box, toujours detache) :
#   nohup sh /srv/beatbump/agents/ops/finish-cycle.sh <cycle> <chain> [--ds1] [--no-promote] [--wait] >/dev/null 2>&1 &
#   tail -f /tmp/ytm-finish-<cycle>.log
# Codes de sortie : 0 = fini (promu et journalise, ou --no-promote vert) ; 1 = refus / usage ; 3 = pas vert
#   (chaine, DS1 ou garde SM2 : rien promu) ; 4 = promote.sh en echec (voir ROLLBACK dans le log).
# Controle des arguments sans rien lancer : FINISH_PARSE_ONLY=1 sh finish-cycle.sh <cycle> <chain> [...]
#   (imprime aussi la garde SM2 du moment : lecture seule, stats/library prod + git)
# Test de la garde sur une liste de fichiers (aucun argument, rien lance) :
#   FINISH_GUARD_TEST=<fichier liste | -> [FINISH_GUARD_PRODV=<sha>] sh finish-cycle.sh
#   exit 0 = pas de DS1 requis, 3 = DS1 requis (raisons sur stdout) ; sans FINISH_GUARD_PRODV : sha de HEAD ;
#   FINISH_GUARD_IG=<depot git jetable> remplace agents/integration (test seulement).
# Garde svelte-check (c48c, B8-24) : avant la chaine, `npx svelte-check --threshold error` dans $IG/app ; la ligne
#   "svelte-check found N errors" est comparee a agents/ops/svelte-check.baseline (411 au cycle 48) : N > baseline
#   = refus (exit 3, rien lance). Sortie illisible ou baseline absente = refus (garde fermee). La baseline ne
#   descend que par commit. FINISH_SKIP_SVELTE_CHECK=1 saute la garde. FINISH_PARSE_ONLY=1 joue aussi la garde
#   (lecture seule, ~1 a 2 min) et imprime "svelte-check N <= baseline B". Test de la garde seule (rien d autre) :
#   FINISH_SC_TEST=1 [FINISH_SC_BASELINE=<fichier>] [FINISH_SC_APP=<dossier app>] sh finish-cycle.sh
#   exit 0 = ok, 3 = refus (verdict sur stdout) ; les deux variables sont des remplacements de test seulement.
# Garde gated (c53c, B9-20) : apres une chaine verte, le report.json du harness coeur porte `gated` (etapes sautees
#   par un C<N>_SKIP de module ou d env, harness-core.cjs gatedSteps). La liste est imprimee ("garde gated : [...]")
#   et ecrite dans agents/ops/gated.prev (une ligne module:step par etape, premiere ligne "# chaine <N>"). Une etape
#   gatee a la chaine precedente (gated.prev) ET a celle-ci est gatee depuis plus d une chaine : refus (exit 3, rien
#   promu) sauf FINISH_ALLOW_GATED=1 (promotion quand meme, liste imprimee). Une etape gatee pour la premiere fois
#   passe avec un avertissement. report.json illisible = refus (garde fermee). FINISH_PARSE_ONLY=1 imprime la liste
#   de la derniere chaine (gated.prev). Test de la garde seule (rien lance, gated.prev NON modifie) :
#   FINISH_GATED_TEST=<report.json> [FINISH_GATED_PREV=<fichier>] sh finish-cycle.sh ; exit 0 = ok, 3 = refus.
# Verification Go (B9-20, `go test -count=3 ./backend/api/`, pollution des memos globaux L14-11) : pas de `go` sur
#   la box et le Dockerfile ne joue pas les tests ; elle vit dans la verification de la file d integration avant
#   fusion (program/LOOP.md : `go vet` + `go test` dans l image golang:1.24.5), ou le -count=3 doit etre ajoute.
#   finish-cycle.sh ne la rejoue pas.
set -u
YTM=/srv/beatbump
AG="$YTM/agents"
E2E="$YTM/e2e"
IG="$AG/integration"
STG=https://staging-music.ekaii.fr
PRD=https://music.ekaii.fr

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  echo "Options : --ds1 (sonde DS1 avant promotion), --no-promote (chaine + DS1 seulement), --wait (attendre la"
  echo "  fin d un harness ytm-harness-* en cours au lieu de refuser), --help."
}

# Garde SM2 (cycle 42, L12-3). Fichiers qui changent le comportement d une mise a jour du SW / de la coquille :
SM2_RE='^app/src/service-worker\.ts$|^app/src/routes/\+layout\.(svelte|ts)$|^app/vite\.config\.|^app/svelte\.config\.js$|^app/scripts/svelteRuntimeChunk\.ts$|^app/src/lib/utils/sharedJobs\.ts$|^app/src/app\.html$|^app/static/manifest\.json$'
# sw_imports [rev] : fichiers du depot importes (transitivement) par app/src/service-worker.ts a <rev> (defaut
# HEAD) : specificateurs "$lib/..." (-> app/src/lib/...), "./" et "../" de `import|export ... from "..."`,
# `import "..."` et `import("...")` ; extensions essayees : telle quelle, .ts, .js, .svelte, /index.ts, /index.js.
# Paquets npm et modules virtuels ($service-worker, $app/...) ignores. Exit != 0 si le SW est illisible.
sw_imports() {
  python3 - "$IG" "${1:-HEAD}" <<'PY'
import posixpath, re, subprocess, sys
ig, rev = sys.argv[1], sys.argv[2]
def show(p):
    r = subprocess.run(["git", "-C", ig, "show", "%s:%s" % (rev, p)], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None
IMP = re.compile(r"""(?:^|[;\s])(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']|(?:^|[;\s])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)""")
root = "app/src/service-worker.ts"
if show(root) is None:
    sys.exit(2)
seen, todo, out = {root}, [root], []
while todo and len(seen) < 200:
    f = todo.pop()
    src = show(f) or ""
    for m in IMP.finditer(src):
        spec = m.group(1) or m.group(2) or m.group(3)
        if spec.startswith("$lib/"):
            base = "app/src/lib/" + spec[5:]
        elif spec.startswith("./") or spec.startswith("../"):
            base = posixpath.normpath(posixpath.join(posixpath.dirname(f), spec))
        else:
            continue
        for cand in (base, base + ".ts", base + ".js", base + ".svelte", base + "/index.ts", base + "/index.js"):
            if cand in seen:
                break
            if show(cand) is not None:
                seen.add(cand); todo.append(cand); out.append(cand)
                break
for p in sorted(out):
    print(p)
PY
}
# sm2_guard <sha prod> [fichier liste] : imprime les raisons de la garde (vide = pas de DS1 requis). FERMEE :
# toute incertitude (sha illisible, inconnu, ambigu, hors historique de HEAD, git diff ou imports du SW en
# echec) imprime une raison. Avec [fichier liste] (test), la liste remplace `git diff --name-only <sha>..HEAD`.
sm2_guard() {
  pv=$1; list=${2:-}
  [ -n "$pv" ] || { echo "(version prod illisible : stats/library sans version)"; return 0; }
  printf '%s' "$pv" | grep -Eq '^[0-9a-f]{7,40}$' || { echo "(version prod '$pv' n est pas un sha)"; return 0; }
  git -C "$IG" rev-parse -q --verify "$pv^{commit}" >/dev/null 2>&1 || { echo "(sha prod $pv inconnu de l integration ou ambigu : promu depuis un autre arbre ?)"; return 0; }
  git -C "$IG" merge-base --is-ancestor "$pv" HEAD 2>/dev/null || { echo "(sha prod $pv n est pas un ancetre de HEAD : diff non significatif)"; return 0; }
  if [ -n "$list" ]; then
    files=$(cat "$list") || { echo "(liste de test $list illisible)"; return 0; }
  else
    files=$(git -C "$IG" diff --name-only "$pv..HEAD" 2>/dev/null) || { echo "(git diff $pv..HEAD en echec)"; return 0; }
  fi
  sw=$(sw_imports HEAD) || { echo "(imports de app/src/service-worker.ts illisibles a HEAD)"; return 0; }
  printf '%s\n' "$files" | SM2_RE="$SM2_RE" SM2_SW="$(echo $sw)" awk '
    BEGIN { n = split(ENVIRON["SM2_SW"], a, " "); for (i = 1; i <= n; i++) sw[a[i]] = 1 }
    $0 == "" { next }
    $0 in sw { print $0 " (importe par le SW)"; next }
    $0 ~ ENVIRON["SM2_RE"] { print }' | sort -u
}
prod_ver() { curl -s --max-time 15 --resolve music.ekaii.fr:443:127.0.0.1 "$PRD/api/v1/stats/library" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null; }

# Garde svelte-check (c48c, B8-24). svelte_check_count : imprime N (le compte d erreurs de la ligne
# "svelte-check found N errors ..." d un run dans $SC_APP, svelte-kit sync d abord) ou rien si illisible.
# svelte_check_gate : imprime le verdict, retour 0 = ok, 3 = refus (N > baseline, sortie illisible, baseline
# illisible) ; FINISH_SKIP_SVELTE_CHECK=1 = sautee (retour 0).
SC_BASE_FILE=${FINISH_SC_BASELINE:-$AG/ops/svelte-check.baseline}
SC_APP=${FINISH_SC_APP:-$IG/app}
svelte_check_count() {
  (cd "$SC_APP" && npx svelte-kit sync >/dev/null 2>&1; timeout 900 npx svelte-check --threshold error 2>&1) \
    | grep -E 'svelte-check found [0-9]+ error' | tail -1 | sed -E 's/.*svelte-check found ([0-9]+) error.*/\1/'
}
svelte_check_gate() {
  if [ "${FINISH_SKIP_SVELTE_CHECK:-}" = 1 ]; then echo "garde svelte-check : sautee (FINISH_SKIP_SVELTE_CHECK=1)"; return 0; fi
  base=$(tr -dc '0-9' < "$SC_BASE_FILE" 2>/dev/null)
  [ -n "$base" ] || { echo "garde svelte-check : baseline illisible ($SC_BASE_FILE) -> refus"; return 3; }
  n=$(svelte_check_count)
  [ -n "$n" ] || { echo "garde svelte-check : sortie illisible (pas de ligne 'svelte-check found N errors' dans $SC_APP) -> refus"; return 3; }
  if [ "$n" -gt "$base" ]; then echo "garde svelte-check : $n erreurs > baseline $base ($SC_BASE_FILE) -> refus"; return 3; fi
  echo "svelte-check $n <= baseline $base"
  return 0
}

if [ "${FINISH_SC_TEST:-}" = 1 ]; then
  svelte_check_gate; exit $?
fi

# Garde gated (c53c, B9-20). gated_list <report.json> : une ligne module:step par etape gatee ("?:unreadable" si
# le fichier est illisible). core_report <log chaine> : chemin cote box du report.json du harness coeur (ligne 1
# "Report: ... -> /e2e/out/<ts>/report.json"). gated_gate <report.json> [prev] : imprime le verdict, ecrit prev
# (sauf FINISH_GATED_TEST), retour 0 = ok, 3 = refus.
GATED_PREV=${FINISH_GATED_PREV:-$AG/ops/gated.prev}
gated_list() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "?:unreadable"
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    print("?:unreadable"); sys.exit()
for g in r.get("gated") or []:
    print("%s:%s" % (g.get("module", "?"), g.get("step", "?")))
PY
}
core_report() { grep -E '^Report: [0-9]+ passed' "$1" | sed -n '1p' | sed -E 's#.*-> (/e2e/[^ ]*report\.json).*#\1#' | sed "s#^/e2e#$E2E#"; }
gated_gate() {
  rep=$1; cur=$(gated_list "$rep")
  case "$cur" in *unreadable*) echo "garde gated : report.json illisible ($rep) -> refus"; return 3 ;; esac
  prevf=$(mktemp); grep -v '^#' "$GATED_PREV" 2>/dev/null > "$prevf" || true
  old=$(printf '%s\n' "$cur" | grep -v '^$' | grep -Fxf "$prevf" 2>/dev/null); rm -f "$prevf"
  if [ "${FINISH_GATED_TEST:-}" = "" ]; then
    { echo "# chaine ${CHAIN:-?} $(date -u +%Y-%m-%dT%H:%M:%SZ) $rep"; printf '%s\n' "$cur" | grep -v '^$'; } > "$GATED_PREV.tmp" && mv "$GATED_PREV.tmp" "$GATED_PREV"
  fi
  echo "garde gated : [$(echo $cur)]"
  [ -n "$cur" ] || return 0
  if [ -n "$old" ]; then
    if [ "${FINISH_ALLOW_GATED:-}" = 1 ]; then echo "  gatee depuis plus d une chaine : $(echo $old) ; FINISH_ALLOW_GATED=1 -> promotion quand meme"; return 0; fi
    echo "  gatee depuis plus d une chaine : $(echo $old) -> refus (FINISH_ALLOW_GATED=1 pour promouvoir quand meme)"; return 3
  fi
  echo "  gatee pour la premiere fois : passe ; refus a la prochaine chaine si toujours gatee"
  return 0
}
if [ -n "${FINISH_GATED_TEST:-}" ]; then
  gated_gate "$FINISH_GATED_TEST"; exit $?
fi

if [ -n "${FINISH_GUARD_TEST:-}" ]; then
  [ -n "${FINISH_GUARD_IG:-}" ] && IG=$FINISH_GUARD_IG   # test seulement : depot jetable a la place de l integration
  L=$FINISH_GUARD_TEST
  if [ "$L" = - ]; then L=$(mktemp); cat > "$L"; trap 'rm -f "$L"' EXIT; fi
  PV=${FINISH_GUARD_PRODV-$(git -C "$IG" rev-parse --short HEAD)}
  echo "imports du SW a HEAD : $(sw_imports HEAD | tr '\n' ' ')"
  G=$(sm2_guard "$PV" "$L")
  if [ -n "$G" ]; then echo "DS1 REQUIS (prod=$PV) :"; printf '%s\n' "$G" | sed 's/^/  /'; exit 3; fi
  echo "pas de DS1 requis (prod=$PV)"; exit 0
fi

CYCLE=""; CHAIN=""; DS1=0; PROMOTE=1; WAIT=0
for a in "$@"; do
  case "$a" in
    --help|-h) usage; exit 0 ;;
    --ds1) DS1=1 ;;
    --no-promote) PROMOTE=0 ;;
    --wait) WAIT=1 ;;
    -*) echo "option inconnue : $a" >&2; usage >&2; exit 1 ;;
    *) if [ -z "$CYCLE" ]; then CYCLE=$a; elif [ -z "$CHAIN" ]; then CHAIN=$a
       else echo "argument en trop : $a" >&2; exit 1; fi ;;
  esac
done
case "$CYCLE" in ""|*[!0-9a-z]*) echo "cycle invalide : '${CYCLE}' (ex. 39, 21b)" >&2; usage >&2; exit 1 ;; esac
case "$CHAIN" in ""|*[!0-9a-z]*) echo "chaine invalide : '${CHAIN}' (ex. 42)" >&2; usage >&2; exit 1 ;; esac
[ -f "$AG/ops/journal/cycle-$CYCLE.md" ] || [ "$PROMOTE" = 0 ] || { echo "texte de journal absent : $AG/ops/journal/cycle-$CYCLE.md" >&2; exit 1; }
SLOG="/tmp/ytm-stage-cycle$CHAIN.log"
[ -e "$SLOG" ] && { echo "$SLOG existe deja (chaine $CHAIN deja jouee ?) : choisir un nouveau numero de chaine" >&2; exit 1; }
if [ "${FINISH_PARSE_ONLY:-}" = 1 ]; then
  echo "parse ok : cycle=$CYCLE chain=$CHAIN ds1=$DS1 promote=$PROMOTE wait=$WAIT log=/tmp/ytm-finish-$CYCLE.log stage-log=$SLOG"
  PV=$(prod_ver); G=$(sm2_guard "$PV")
  echo "garde SM2 maintenant (prod=${PV:-?}, HEAD=$(git -C "$IG" rev-parse --short HEAD)) : ${G:+DS1 REQUIS : }$(echo ${G:-pas de DS1 requis})"
  [ -z "$G" ] || [ "$DS1" = 1 ] || echo "  -> sans --ds1, ce run s arreterait apres la chaine (exit 3, rien promu)"
  SCV=$(svelte_check_gate); SCRC=$?
  echo "garde svelte-check maintenant : $SCV"
  [ "$SCRC" = 0 ] || echo "  -> ce run refuserait avant la chaine (exit 3, rien lance) ; FINISH_SKIP_SVELTE_CHECK=1 pour passer outre"
  echo "garde gated : [$(grep -v '^#' "$GATED_PREV" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')] (derniere chaine, $GATED_PREV ; une etape encore gatee a la prochaine chaine = refus sans FINISH_ALLOW_GATED=1)"
  exit 0
fi

harness_up() { docker ps --format '{{.Names}}' 2>/dev/null | grep '^ytm-harness-' | head -1; }
H=$(harness_up)
if [ -n "$H" ] && [ "$WAIT" = 0 ]; then
  echo "REFUS : un harness tourne deja ($H) ; relancer plus tard ou avec --wait" >&2
  exit 1
fi

LOG="/tmp/ytm-finish-$CYCLE.log"
echo "finish-cycle $CYCLE (chaine $CHAIN) : log $LOG"
exec >> "$LOG" 2>&1
log() { echo "$(date -u +%H:%M:%S) $*"; }
done_() { log "FINISH $CYCLE DONE"; exit "$1"; }
log "== finish-cycle $CYCLE chain=$CHAIN ds1=$DS1 promote=$PROMOTE wait=$WAIT"
N=0
while H=$(harness_up); [ -n "$H" ]; do
  [ "$N" -ge 60 ] && { log "harness $H toujours la apres 60 min : abandon"; done_ 1; }
  log "harness up: $H, attente 60 s"; sleep 60; N=$((N + 1))
done

SHA=$(git -C "$IG" rev-parse --short HEAD)

# 0. garde svelte-check (c48c, B8-24) : avant la chaine, rien n est lance tant que le compte depasse la baseline.
log "== garde svelte-check ($SHA, baseline $SC_BASE_FILE)"
SCV=$(svelte_check_gate); SCRC=$?
log "$SCV"
[ "$SCRC" = 0 ] || { log "NOT GREEN (svelte-check au-dessus de la baseline) -> chaine non lancee, rien promu"; done_ 3; }

stg_ver() { curl -s --max-time 15 --resolve staging-music.ekaii.fr:443:127.0.0.1 "$STG/api/v1/stats/library" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null; }
report() { grep -E '^Report: [0-9]+ passed / [0-9]+ failed( / [0-9]+ upstream)?' "$1" | sed -n "${2}p"; }
green() { # $1 = ligne Report, $2 = minimum de passed
  printf '%s\n' "$1" | awk -v m="$2" '{ exit !($2 >= m && $5 == 0) }'
}

# 1. chaine staging
log "== chaine $CHAIN sur $SHA (log $SLOG)"
sh "$AG/ops/stage-cycle.sh" > "$SLOG" 2>&1
grep -E '^Report:|^FAIL|^UPSTREAM|^RETRY|^=== |BUILD_FAIL|^staging HTTP' "$SLOG" | cut -c1-200
CORE=$(report "$SLOG" 1); OFF=$(report "$SLOG" 2); SV=$(stg_ver)
log "core=[$CORE] off=[$OFF] staging version=$SV"
OK=1
[ -n "$CORE" ] && green "$CORE" "${FINISH_MIN_CORE:-50}" || { log "coeur PAS vert"; OK=0; }
[ -n "$OFF" ] && green "$OFF" "${FINISH_MIN_OFF:-17}" || { log "hors-ligne PAS vert"; OK=0; }
[ "$SV" = "$SHA" ] || { log "staging sert '$SV' et non $SHA"; OK=0; }
[ "$OK" = 1 ] || { log "NOT GREEN (chaine $CHAIN) -> pas de promotion"; done_ 3; }

# 1b. garde gated (c53c, B9-20) : une etape gatee depuis plus d une chaine n est pas promue sans FINISH_ALLOW_GATED=1.
CR=$(core_report "$SLOG")
GV=$(gated_gate "${CR:-/nonexistent}"); GRC=$?
log "$GV"
[ "$GRC" = 0 ] || { log "NOT GREEN (garde gated) -> pas de promotion"; done_ 3; }

# 2. DS1 / garde SM2
PRODV=$(prod_ver)
GUARD=$(sm2_guard "$PRODV")
log "garde SM2 (prod ${PRODV:-?} -> $SHA) : $(echo ${GUARD:-rien, DS1 facultatif})"
if [ "$DS1" = 1 ]; then
  up() { docker tag "$1" beatbump-ekaii:staging && (cd "$AG" && docker compose --env-file "$YTM/.env" -f "$AG/staging-compose.yml" -p ytm-staging up -d 2>&1 | tail -1); sleep 25; log "staging serves $(curl -s --resolve staging-music.ekaii.fr:443:127.0.0.1 "$STG/api/v1/stats/library" | grep -o '"version":"[^"]*"')"; }
  NEW=$(docker inspect -f '{{.Id}}' beatbump-ekaii:staging); OLD=$(docker inspect -f '{{.Id}}' beatbump-ekaii:local)
  if [ -z "$OLD" ]; then  # c59e : tag elague (nettoyage Coolify 00:00, store containerd) : image du conteneur prod, sinon tarball image-backups
    CID=$(docker inspect -f '{{.Image}}' ytm-beatbump 2>/dev/null)
    if [ -n "$CID" ] && ! docker image inspect "$CID" >/dev/null 2>&1; then
      TAR=$(ls -t "$YTM"/image-backups/beatbump-prod-*-"$(echo "$CID" | cut -c8-19)".tar.gz 2>/dev/null | head -1)
      [ -n "$TAR" ] && { log "DS1 : beatbump-ekaii:local ABSENT et image prod elaguee du store : docker load $(basename "$TAR")"; docker load -i "$TAR" >/dev/null 2>&1 || true; }
    fi
    if [ -n "$CID" ] && docker image inspect "$CID" >/dev/null 2>&1; then
      docker tag "$CID" beatbump-ekaii:local && OLD=$CID && log "DS1 : beatbump-ekaii:local remis sur l image du conteneur prod $(echo "$CID" | cut -c8-19)"
    fi
  fi
  [ -n "$OLD" ] && [ "$OLD" != "$NEW" ] || { log "NOT GREEN (DS1) : OLD=${OLD:-absent} NEW=$(echo "$NEW" | cut -c8-19) : pas d image prod distincte pour la sonde -> pas de promotion"; done_ 3; }
  log "DS1 : NEW=$(echo "$NEW" | cut -c8-19) OLD=$(echo "$OLD" | cut -c8-19) (prod $PRODV, garde : $(echo $GUARD))"
  T0=$(date +%s)
  cd "$E2E" || done_ 1
  log "== DS1 seed on OLD (prod build)"; up "$OLD"; ./run.sh "$STG" "daft punk" probe-ds1-seed.cjs 2>&1 | grep -E '^\[ds1|FATAL|REFUS'
  log "== DS1 upgrade to NEW"; up "$NEW"; ./run.sh "$STG" "daft punk" probe-ds1-verify-upgrade.cjs 2>&1 | grep -E '^\[ds1|FATAL|REFUS'
  log "== DS1 rollback to OLD"; up "$OLD"; ./run.sh "$STG" "daft punk" probe-ds1-verify-rollback.cjs 2>&1 | grep -E '^\[ds1|FATAL|REFUS'
  log "== restore NEW"; up "$NEW"
  fails() { python3 - "$E2E/out/$1" "$T0" <<'PY' 2>/dev/null || echo 9
import json, os, sys
f, t0 = sys.argv[1], int(sys.argv[2])
if os.path.getmtime(f) < t0:
    print(9); sys.exit()  # fichier d un run precedent : la sonde n a pas tourne
print(len(json.load(open(f))["fails"]))
PY
  }
  U=$(fails ds1-upgrade.json); RB=$(fails ds1-rollback.json)
  log "DS1 fails: upgrade=$U rollback=$RB"
  [ "$(docker inspect -f '{{.Id}}' beatbump-ekaii:staging)" = "$NEW" ] || { log "beatbump-ekaii:staging n est PAS revenu sur NEW : pas de promotion"; done_ 3; }
  [ "$U" = 0 ] && [ "$RB" = 0 ] || { log "NOT GREEN (DS1) -> pas de promotion"; done_ 3; }
elif [ -n "$GUARD" ]; then
  log "DS1 REQUIS (garde SM2 : $(echo $GUARD)) mais --ds1 absent -> pas de promotion ; relancer avec --ds1"
  done_ 3
fi

if [ "$PROMOTE" = 0 ]; then log "GREEN, --no-promote : rien promu ($SHA)"; done_ 0; fi

# 3. promotion, journal, sonde, harness prod
log "GREEN -> promote $SHA (cycle $CYCLE)"
cd "$YTM" || done_ 1
flock /tmp/beatbump-build.lock sh "$AG/promote.sh" "$SHA" 2>&1; RC=$?
log "promote.sh exit $RC"
[ "$RC" = 0 ] || { log "PROMOTE EN ECHEC (exit $RC) : pas de journal ; appliquer une ligne ROLLBACK ci-dessus si besoin"; done_ 4; }
(cd "$AG/ops" && python3 journal.py "$CYCLE" "$SHA" --chain "$CHAIN")
cd "$E2E" || done_ 1
log "-- postdeploy probe"; ./run.sh "$PRD" "daft punk" probe-postdeploy.cjs 2>&1 | grep -E '^T\+|ERR|FATAL|REFUS' | cut -c1-120 | tail -2
# c47a (B8-14): the prod harness after a promotion plays the FULL tier (every step, incl. resume_take_over,
# buttons_readable, recent_by_day, french_program_screens); staging chains (stage-cycle.sh) stay on chain.
log "-- prod harness ($SHA, HARNESS_TIER=full)"
HARNESS_TIER=full ./run.sh "$PRD" "daft punk" harness-core.cjs 2>&1 | grep -E '^FAIL|^UPSTREAM|^RETRY|^Report|REFUS'
HARNESS_TIER=full ./run.sh "$PRD" "daft punk" harness-offline.cjs 2>&1 | grep -E '^FAIL|^UPSTREAM|^RETRY|^Report|REFUS'
done_ 0
