#!/bin/sh
# Smoke test SM1 de music.ekaii.fr / staging-music.ekaii.fr (cycle 34), DEPUIS la box.
#   - sans navigateur, lecture seule (GET), aucune acquisition : seulement des ids LOCAUX (lid / lb-),
#     player.json n est appele qu avec un lid (branche LocalPlayer, retour avant toute acquisition) ;
#     la recherche YouTube (search.json) ne declenche pas d acquisition.
#   - --resolve <host>:443:127.0.0.1 (hairpin NAT casse sur la box) ; budget total 90 s.
# Usage : agents/ops/smoke.sh https://music.ekaii.fr [version attendue]
#   une ligne "OK|FAIL <check> : detail" par controle, puis "SMOKE <n> ok, <m> echec(s) en <s> s" ;
#   code de sortie 1 au premier echec constate (tous les controles sont quand meme joues), 2 si usage.
# Cycle 43 (lane c43c, B7-15 / B7-16), variables d environnement optionnelles :
#   SMOKE_BROWSER=1 : 12e controle "smoke_browser" = e2e/harness-smoke.cjs via e2e/run.sh (vrai navigateur, < 90 s :
#     accueil + premiere rangee personnelle, lecture du lid de fixture qui avance, service worker enregistre,
#     version servie = version attendue). Un seul navigateur a la fois sur la box : si un conteneur ytm-harness-*
#     tourne deja (ou si run.sh refuse, exit 2), le controle est SAUTE avec une ligne "SKIP smoke_browser ..."
#     (pas un echec). Budget propre de 90 s (le budget HTTP de 90 s ne le compte pas), timeout dur 240 s.
#     La version attendue ($2) passe au harness par YTM_SMOKE_EXPECT (run.sh la transmet au conteneur).
#   SMOKE_ALERT=1 : en cas d echec, un bloc (raisons = lignes FAIL) est ajoute a program/ALERT.md, comme weekly.sh
#     (pour la ligne de cron quotidienne, voir cron.weekly.example / README "Planification").
set -u
BASE="${1:-}"; EXPECT="${2:-}"
case "$BASE" in https://*) ;; *) echo "usage: $0 https://<host> [version attendue]"; exit 2 ;; esac
BASE="${BASE%/}"; HOST="${BASE#https://}"; HOST="${HOST%%/*}"
UA="Mozilla/5.0 (Macintosh) Chrome/128 ytm-smoke"
BOT="WhatsApp/2.23.20.0"
T0=$(date +%s); OKN=0; KON=0
W=$(mktemp -d /tmp/ytm-smoke.XXXXXX); trap 'rm -rf "$W"' EXIT INT TERM
# get <name> <path> [curl args...] : body -> $W/<name>.b, headers -> $W/<name>.h, prints http code
get() { n="$1"; p="$2"; shift 2
  curl -s --max-time 20 --resolve "$HOST:443:127.0.0.1" -A "$UA" -D "$W/$n.h" -o "$W/$n.b" -w "%{http_code}" "$@" "$BASE$p" 2>/dev/null || true; }
ok() { OKN=$((OKN + 1)); echo "OK   $1 : $2"; }
ko() { KON=$((KON + 1)); echo "FAIL $1 : $2"; echo "FAIL $1 : $2" >> "$W/fails"; }
hdr() { grep -i "^$2:" "$W/$1.h" | tail -1 | cut -d: -f2- | tr -d "\r" | sed "s/^ *//"; }
js() { python3 -c "import json,sys
try: d=json.load(open('$W/$1.b'))
except Exception: print(''); sys.exit()
$2" 2>/dev/null; }

# 0. (c59e) garde image prod : l elagage Coolify ("Forced Docker cleanup", chaque nuit 00:00, store containerd) supprime
#    beatbump-ekaii:local SOUS le conteneur qui tourne (constate 03-04/10). Sans ce tag : DS1 "same build served", rollback
#    impossible, `compose up` echoue. Si le tag est ABSENT, on le restaure depuis le tarball image-backups dont le nom porte
#    l id de l image du conteneur ; si le tag existe mais differe (promotion en cours), on ne touche a rien et on le signale.
CID=$(docker inspect -f '{{.Image}}' ytm-beatbump 2>/dev/null | cut -c8-19)
if [ -n "$CID" ]; then
  TID=$(docker image inspect -f '{{.Id}}' beatbump-ekaii:local 2>/dev/null | cut -c8-19)
  if [ "$TID" = "$CID" ]; then ok prod_image_tag "beatbump-ekaii:local = image du conteneur ($CID)"
  elif [ -n "$TID" ]; then ko prod_image_tag "tag=$TID mais conteneur=$CID (promotion en cours ou tag devie) : rien touche"
  else
    TAR=$(ls -t /srv/beatbump/image-backups/beatbump-prod-*-"$CID".tar.gz 2>/dev/null | head -1)
    if [ -z "$TAR" ]; then ko prod_image_tag "tag ABSENT (image elaguee) et aucun tarball beatbump-prod-*-$CID.tar.gz : restauration impossible"
    else
      docker load -i "$TAR" >/dev/null 2>&1 || true
      TID=$(docker image inspect -f '{{.Id}}' beatbump-ekaii:local 2>/dev/null | cut -c8-19)
      if [ "$TID" = "$CID" ]; then
        ok prod_image_tag "tag ABSENT (elagage Coolify) : RESTAURE depuis $(basename "$TAR") -> $CID"
        if [ "${SMOKE_ALERT:-0}" = 1 ]; then
          ALERT=/srv/beatbump/agents/program/ALERT.md
          [ -f "$ALERT" ] || printf '# ALERT music.ekaii.fr (ecrit par agents/ops/weekly.sh ou agents/ops/smoke.sh ; supprimer apres traitement)\n' > "$ALERT"
          printf '\n## %s UTC (smoke.sh) : image prod restauree\n- beatbump-ekaii:local avait disparu du store (elagage Coolify 00:00) ; restaure depuis %s. Decision 3 (exclure ce serveur du nettoyage Coolify) toujours ouverte.\n' "$(date -u +"%Y-%m-%d %H:%M")" "$(basename "$TAR")" >> "$ALERT"
        fi
      else ko prod_image_tag "tag ABSENT, docker load $(basename "$TAR") n a pas redonne $CID (tag=${TID:-absent})"; fi
    fi
  fi
fi

# 1. stats/library : tracks > 0 et version
c=$(get stats /api/v1/stats/library)
TR=$(js stats "print(d.get('tracks') or 0)"); VER=$(js stats "print(d.get('version') or '')")
if [ "$c" = 200 ] && [ "${TR:-0}" -gt 0 ] 2>/dev/null && [ -n "$VER" ]; then ok stats_library "200 tracks=$TR version=$VER"; else ko stats_library "http=$c tracks=${TR:-?} version=${VER:-absent}"; fi
if [ -n "$EXPECT" ]; then
  if [ "$VER" = "$EXPECT" ]; then ok version_expected "$VER"; else ko version_expected "servie=$VER attendue=$EXPECT"; fi
fi

# 2. coquille /home + script d entree _app
c=$(get home /home)
ENTRY=$(grep -o '/_app/immutable/entry/[^"]*\.js' "$W/home.b" 2>/dev/null | head -1)
if [ "$c" = 200 ] && [ -n "$ENTRY" ]; then ok home_shell "200 entry=$ENTRY"; else ko home_shell "http=$c entry=${ENTRY:-absent}"; fi

# 3. service worker
c=$(get sw /service-worker.js)
if [ "$c" = 200 ]; then ok service_worker "200 $(wc -c < "$W/sw.b") o, cache-control=$(hdr sw cache-control)"; else ko service_worker "http=$c"; fi

# 4. manifest.json avec share_target
c=$(get mf /manifest.json)
ST=$(js mf "print('yes' if d.get('share_target') else '')")
if [ "$c" = 200 ] && [ "$ST" = yes ]; then ok manifest_share_target "200 share_target present"; else ko manifest_share_target "http=$c share_target=${ST:-absent}"; fi

# 5. recherche < 300 Ko
c=$(get search "/api/v1/search.json?q=daft+punk")
SZ=$(wc -c < "$W/search.b" 2>/dev/null || echo 0)
if [ "$c" = 200 ] && [ "$SZ" -lt 307200 ]; then ok search_json "200 $SZ o"; else ko search_json "http=$c taille=$SZ o (max 307200)"; fi

# 6. album local
c=$(get alb "/api/v1/local/albums?limit=1")
AID=$(js alb "print(d['items'][0]['browseId'])")
ACOV=$(js alb "u=d['items'][0]['thumbnails'][0]['url'];print(u.split('lid=',1)[1] if 'lid=' in u else '')")
if [ "$c" = 200 ] && [ -n "$AID" ]; then ok local_albums "200 album=$AID cover=${ACOV:-absent}"; else ko local_albums "http=$c album=${AID:-absent}"; fi

# 7. suggestion locale seedee sur cet album
if [ -n "$AID" ]; then
  c=$(get rel "/api/v1/local/related?seed=album:$AID")
  if [ "$c" = 200 ]; then ok local_related "200 $(wc -c < "$W/rel.b") o, x-ytm-cache=$(hdr rel x-ytm-cache)"; else ko local_related "http=$c"; fi
else ko local_related "pas d album local"; fi

# 8. /localf en Range sur une piste locale (url tiree de player.json?videoId=<lid>, branche locale)
c=$(get song "/api/v1/local/songs?limit=1")
LID=$(js song "print(d['items'][0]['videoId'])")
LU=""
if [ -n "$LID" ]; then
  get pl "/api/v1/player.json?videoId=$LID" >/dev/null
  LU=$(js pl "f=[x for x in (d.get('streamingData',{}).get('adaptiveFormats') or []) if str(x.get('url','')).startswith('/localf')];print(f[0]['url'] if f else '')")
fi
if [ -n "$LU" ]; then
  c=$(get lf "$LU" -r 0-1023)
  AR=$(hdr lf accept-ranges); CR=$(hdr lf content-range)
  if [ "$c" = 206 ] && [ -n "$AR" ]; then ok localf_range "206 lid=$LID accept-ranges=$AR content-range=$CR"; else ko localf_range "http=$c lid=$LID accept-ranges=${AR:-absent}"; fi
else ko localf_range "pas d url /localf (lid=${LID:-absent})"; fi

# 9. pochette cacheable de l album
if [ -n "$ACOV" ]; then
  c=$(get cov "/cover?lid=$ACOV")
  CC=$(hdr cov cache-control)
  if [ "$c" = 200 ] && [ -n "$CC" ]; then ok cover_cacheable "200 cache-control=$CC"; else ko cover_cacheable "http=$c cache-control=${CC:-absent}"; fi
else ko cover_cacheable "pas de pochette locale"; fi

# 10. carte OG pour un robot de previsualisation
if [ -n "$LID" ]; then
  c=$(curl -s --max-time 20 --resolve "$HOST:443:127.0.0.1" -A "$BOT" -o "$W/og.b" -w "%{http_code}" "$BASE/listen?id=$LID" 2>/dev/null || true)
  OG=$(grep -o '<meta[^>]*og:title[^>]*>' "$W/og.b" 2>/dev/null | head -1 | grep -o 'content="[^"]*"' | head -1)
  if [ "$c" = 200 ] && [ -n "$OG" ]; then ok og_robot_card "200 og:title $OG"; else ko og_robot_card "http=$c og:title=${OG:-absent}"; fi
else ko og_robot_card "pas de lid"; fi

# 11. cache serveur : 2e appel local/mixes = HIT
get mix1 /api/v1/local/mixes >/dev/null
c=$(get mix2 /api/v1/local/mixes); X1=$(hdr mix1 x-ytm-cache); X2=$(hdr mix2 x-ytm-cache)
if [ "$c" = 200 ] && [ "$X2" = HIT ]; then ok mixes_cache_hit "200 1er=$X1 2e=$X2"; else ko mixes_cache_hit "http=$c 1er=${X1:-absent} 2e=${X2:-absent}"; fi

DT=$(( $(date +%s) - T0 ))
[ "$DT" -le 90 ] || ko duration "${DT} s > 90 s"

# 12. (c43c B7-15) smoke navigateur, seulement avec SMOKE_BROWSER=1 : e2e/harness-smoke.cjs via e2e/run.sh.
BDT=0; BROWSER=""
if [ "${SMOKE_BROWSER:-0}" = 1 ]; then
  RUN=/srv/beatbump/e2e/run.sh
  OTHER=$(docker ps --filter "name=ytm-harness-" --format '{{.Names}}' 2>/dev/null | grep -E '^ytm-harness-' | head -1)
  if [ -n "$OTHER" ]; then
    echo "SKIP smoke_browser : un harness tourne deja ($OTHER), un seul navigateur a la fois : smoke navigateur saute (pas un echec)"
    BROWSER=" (navigateur saute)"
  elif [ ! -f "$RUN" ]; then ko smoke_browser "e2e/run.sh introuvable ($RUN)"
  else
    B0=$(date +%s); BL="$W/browser.log"
    YTM_SMOKE_EXPECT="$EXPECT" timeout 240 sh "$RUN" "$BASE" "daft punk" harness-smoke.cjs >"$BL" 2>&1; rc=$?
    BDT=$(( $(date +%s) - B0 )); BROWSER=" (navigateur ${BDT} s)"
    grep -E "^(PASS|FAIL|UPSTREAM|REFUS|FATAL|Report:|rapport:)" "$BL" | sed 's/^/     /'
    if [ "$rc" = 0 ]; then ok smoke_browser "$(grep -E '^Report:' "$BL" | head -1 | sed 's/^Report: //; s/ -> .*//') en ${BDT} s"
    elif [ "$rc" = 2 ]; then echo "SKIP smoke_browser : run.sh a refuse (autre harness en cours) : smoke navigateur saute (pas un echec)"; BROWSER=" (navigateur saute)"
    elif [ "$rc" = 124 ]; then ko smoke_browser "timeout 240 s (run.sh ou le navigateur bloque)"
    else ko smoke_browser "exit $rc : $(grep -E '^(FAIL|UPSTREAM|FATAL|REFUS)' "$BL" | head -1 | cut -c1-160)"; fi
    [ "$BDT" -le 90 ] || ko smoke_browser_duration "${BDT} s > 90 s"
  fi
fi

echo "SMOKE $HOST version=${VER:-?} : $OKN ok, $KON echec(s) en ${DT} s${BROWSER}"
if [ "$KON" -gt 0 ] && [ "${SMOKE_ALERT:-0}" = 1 ]; then
  ALERT=/srv/beatbump/agents/program/ALERT.md
  [ -f "$ALERT" ] || printf '# ALERT music.ekaii.fr (ecrit par agents/ops/weekly.sh ou agents/ops/smoke.sh ; supprimer apres traitement)\n' > "$ALERT"
  {
    printf '\n## %s UTC (smoke.sh)\n' "$(date -u +"%Y-%m-%d %H:%M")"
    printf -- '- raisons : smoke %s en echec (%d echec(s) sur %d controles, version servie %s, attendue %s)\n' "$HOST" "$KON" "$((OKN + KON))" "${VER:-?}" "${EXPECT:-non donnee}"
    sed 's/^/- /' "$W/fails" 2>/dev/null
  } >> "$ALERT"
  echo "ALERT : $KON echec(s) (-> $ALERT)" >&2
fi
[ "$KON" -eq 0 ]
