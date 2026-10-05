#!/bin/sh
# Mesures hebdomadaires de music.ekaii.fr (cycle 36, item HO6 de program/brainstorm-v5.md section 4).
# Lecture seule, sans navigateur, moins de 90 s. Seule ecriture : UNE ligne ajoutee a program/WEEKLY.md.
# A lancer SUR la box docker-host (depuis le Mac : ssh -o ControlMaster=no -o ControlPath=none docker-host '...').
#
# Usage : sh /srv/beatbump/agents/ops/weekly.sh [-]
#   Secrets (cycle 39 L11-3) : JAMAIS un chemin de fichier en argument, jamais une copie sur le disque de la box.
#   Deux sources possibles, lues une fois puis retirees de l environnement (curl les recoit par -K - sur
#   l entree standard : rien dans ps ni /proc/<pid>/cmdline) :
#     - variables d environnement WEEKLY_KUMA_KEY (cle API Uptime Kuma, Reglages > Cles API) et
#       YTM_ADMIN_TOKEN (jeton Bearer de GET /api/v1/client-log, decision 15) ;
#     - argument "-" : lignes NOM=valeur sur l entree standard (seuls ces deux noms sont acceptes). Depuis le Mac,
#       apres "secret-store request" (le clair reste dans <secret store>, il transite par ssh) :
#         { printf 'WEEKLY_KUMA_KEY='; cat <secret store>/<nom>; echo; } | \
#           ssh -o ControlMaster=no -o ControlPath=none docker-host 'sh /srv/beatbump/agents/ops/weekly.sh -'
#   Sans cle Kuma : colonne "kuma : n/a (jeton)" ; sans jeton admin : "n/a (YTM_ADMIN_TOKEN non pose)".
#   La cle et le jeton ne sont jamais affiches ni ecrits.
#   WEEKLY_DRY_RUN=1 (env, optionnel) : affiche la ligne sans l ajouter a WEEKLY.md (ni ecrire ALERT.md).
#   Alerte (cycles 39 et 41, cron.weekly.example) : ajoute un bloc a program/ALERT.md (raisons + ligne) quand
#     - le taux de passage du harness prod (coeur ou hors-ligne) est < 100 %, ou qu aucun rapport prod n existe ;
#     - la version servie differe du dernier "PROD = <sha>" de program/CYCLES.md ;
#     - le volume de la bibliotheque (source du montage /app/data de ytm-yubal) ou /srv/data a moins de 10 % libre
#       (ou df ne repond pas en 10 s : NFS bloque) ;
#     - zero piste telechargee par yubal sur la fenetre alors qu il y a des echecs (piste ou tache) ;
#     - le moniteur Kuma 167 (API stats/library) est DOWN (seulement avec WEEKLY_KUMA_KEY).
#   Pas de mail, pas de push Kuma. Les raisons de l alerte vont sur stderr ; stdout garde exactement la ligne WEEKLY.
#
# Les 5 chiffres (brainstorm-v5 section 4) :
#   (a) harness prod : dernier e2e/out/*/report.json dont url = https://music.ekaii.fr, coeur (etape
#       perf_cold_home_requests presente) et hors-ligne (etape load_home presente)
#       (passed, failed, upstream, durationMs, version ; "-" quand le rapport date d avant le cycle 34)
#   (b) accueil a froid : detail de l etape perf_cold_home_requests de ce rapport coeur (_app requests ...)
#   (c) stats/library : titres / albums / artistes, age de lastAdded en jours, version servie
#   (d) Kuma : etat + temps de reponse des moniteurs 86, 119, 106, 167 (endpoint /metrics, cle API)
#   (e) client-log : nombre d entrees par kind sur les 50 plus recentes (avec YTM_ADMIN_TOKEN) ; sans jeton,
#       nombre de POST /api/v1/client-log par statut HTTP dans le journal d acces du conteneur prod (cycle 41)
# Colonnes ajoutees au cycle 41 (lane 41C, B6-27), apres (e), toujours en lecture seule :
#   (f) usage 7 j : POST /api/v1/me/history (2xx) du journal d acces Echo de ytm-beatbump, hors agents harness
#       (HeadlessChrome, ytm-perf, curl, python, Go-http, Uptime-Kuma) ; "profils actifs" = IP clientes
#       distinctes (APPROXIMATION : pas de cookie bbp dans les logs ; les clients du LAN et de la box sont
#       confondus sous l IP privee du proxy). docker logs ne couvre que la vie du conteneur : chaque promotion
#       le recree, la fenetre reelle ("logs depuis ...") est affichee.
#   (g) acquisition : journal de ytm-yubal sur 168 h : pistes telechargees ("Downloaded:"), deja presentes
#       ("Skipped (file exists)"), echecs de piste ("Failed to download"), taches en echec ("Job <id> failed"),
#       heure du dernier telechargement.
#   (h) disque : df du volume de la bibliotheque et de /srv/data (timeout 10 s, le NFS peut bloquer)
#   (i) sauvegardes image : nombre et taille de image-backups/*.tar.gz (rollback de promote.sh)
#   (j) API lente : les 3 prefixes d uri /api/ au p90 le plus haut sur la fenetre (>= 5 requetes, ids
#       remplaces par :id, flux audio exclus)
# Cycle 53 (lane c53a, brainstorm-v9 B9-14 et B9-16) :
#   (a) auto-controle : le rapport prod retenu (coeur et hors-ligne) est le DERNIER de palier "full" (champ
#       tier de report.json) ; il doit avoir moins de WEEKLY_MAX_REPORT_AGE_D jours (defaut 8, age lu dans
#       finishedAt, sinon dans le nom du dossier). La colonne imprime tier, age, firstSoundMs (coeur, "> 3 s"
#       si au-dessus ; la charge au moment du run n est pas dans le rapport) et la liste gated (doit etre []).
#       Raison d alerte (bloc ALERT.md) : aucun rapport full (le dernier rapport prod, quel que soit son palier,
#       est alors affiche avec son tier), rapport full plus vieux que la limite, ou liste gated non vide alors
#       qu une ligne de WEEKLY.md vieille d au moins 7 jours en portait deja une : une colonne a 100 % sur un
#       rapport vieux d un mois n est plus silencieuse.
#   (k) retention 7 j (lecture SEULE de la base prod, seulement avec WEEKLY_DB_RO=1 ; sinon "n/a") :
#       sqlite3 "file:<beatbump-db>/beatbump.db?mode=ro" + PRAGMA query_only, tables profiles(id, name) et
#       play_events(profile_id, ref, title, artist, album, played_at). Profil HARNESS = profiles.name LIKE
#       'harness-%' OU toutes ses ecoutes (tout l historique) sont des ecoutes de fixture : ref dans
#       e2e/fixtures.json (acquiredVideoId, localLid) ou 9bZkp7q19f0 (Gangnam Style), titre contenant
#       "gangnam style", artiste = localAlbumArtist / localArtistName (Daft Punk : la requete du harness, dont
#       les pistes de l album lb-f9c16fd93917). Un profil avec au moins une ecoute hors fixtures est HUMAIN.
#       A = profils humains avec une ecoute sur [J-7, J) ; P = idem sur [J-14, J-7) ; revenus = A inter P ;
#       ecoutes humaines 7 j = nombre et mediane par jour UTC sur les 7 derniers jours ; derniere ecoute humaine.
#       Le backend n ecrit plus les ecoutes harness depuis le cycle 52 (en-tete X-Ytm-Harness partout) : les
#       exclusions couvrent les lignes anterieures. Aucune API publique ne donne ces chiffres (decision 15).
#       Chemin de la base : source du montage /db de ytm-beatbump (docker inspect), sinon $YTM/beatbump-db.
set -u
YTM=/srv/beatbump
OUT="$YTM/e2e/out"
WEEKLY="$YTM/agents/program/WEEKLY.md"
ALERT="$YTM/agents/program/ALERT.md"
CYCLES="$YTM/agents/program/CYCLES.md"
R="--resolve music.ekaii.fr:443:127.0.0.1"
KUMA_KEY="${WEEKLY_KUMA_KEY:-}"
ADMIN_TOKEN="${YTM_ADMIN_TOKEN:-}"
unset WEEKLY_KUMA_KEY YTM_ADMIN_TOKEN
case "${1:-}" in
  "") ;;
  -) while IFS= read -r l || [ -n "$l" ]; do
       case "$l" in
         WEEKLY_KUMA_KEY=*) KUMA_KEY=${l#WEEKLY_KUMA_KEY=} ;;
         YTM_ADMIN_TOKEN=*) ADMIN_TOKEN=${l#YTM_ADMIN_TOKEN=} ;;
         "") ;;
         *) echo "entree standard : ligne ignoree (attendu WEEKLY_KUMA_KEY=... ou YTM_ADMIN_TOKEN=...)" >&2 ;;
       esac
     done ;;
  *) echo "weekly.sh : argument refuse (plus de chemin de fichier secret depuis le cycle 39) ; voir l en-tete : env ou \"-\" + stdin" >&2; exit 2 ;;
esac
KUMA_KEY=$(printf '%s' "$KUMA_KEY" | tr -d ' \r\n')
ADMIN_TOKEN=$(printf '%s' "$ADMIN_TOKEN" | tr -d ' \r\n')
# valeur entre guillemets pour un fichier de config curl (-K -) : echappe \ et "
cfgq() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
NOW=$(date -u +"%Y-%m-%d %H:%M")

# (a) + (b) : rapports du harness prod (lecture des fichiers seulement). c53a B9-14 : dernier rapport de palier
# full par genre (coeur = etape perf_cold_home_requests, hors-ligne = etape load_home : noms conserves par c52c),
# age < WEEKLY_MAX_REPORT_AGE_D jours, firstSoundMs et gated imprimes, raisons d alerte sur la 4e ligne (WHY).
MAX_AGE_D="${WEEKLY_MAX_REPORT_AGE_D:-8}"
AB=$(python3 - "$OUT" "$WEEKLY" "$MAX_AGE_D" <<'PY' 2>/dev/null
import datetime, glob, json, os, re, sys
out, weekly, maxage = sys.argv[1], sys.argv[2], float(sys.argv[3])
now = datetime.datetime.now(datetime.timezone.utc)
KINDS = ("coeur", "hors-ligne")
full = {k: None for k in KINDS}
latest = {k: None for k in KINDS}
for f in sorted(glob.glob(os.path.join(out, "*", "report.json")), reverse=True):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if str(d.get("url", "")).rstrip("/") != "https://music.ekaii.fr":
        continue
    names = {s.get("name") for s in d.get("steps", [])}
    kind = "coeur" if "perf_cold_home_requests" in names else ("hors-ligne" if "load_home" in names else None)
    if kind is None:
        continue
    ts = os.path.basename(os.path.dirname(f))
    if latest[kind] is None:
        latest[kind] = (ts, d)
    if full[kind] is None and d.get("tier") == "full":
        full[kind] = (ts, d)
    if all(full.values()):
        break
def fr(x):
    return ("%.1f" % x).replace(".", ",")
def age_days(r):
    ts, d = r
    try:
        t = datetime.datetime.strptime(str(d.get("finishedAt"))[:19], "%Y-%m-%dT%H:%M:%S")
    except Exception:
        try:
            t = datetime.datetime.strptime(ts, "%Y%m%d-%H%M%S")
        except Exception:
            return None
    return (now - t.replace(tzinfo=datetime.timezone.utc)).total_seconds() / 86400
def gated_txt(d):
    g = d.get("gated")
    if not isinstance(g, list):
        return "gated=?"
    return "gated=[%s]" % ",".join(str(x) for x in g)
def fmt(label, r, core):
    if not r:
        return "%s aucun rapport" % label
    ts, d = r
    p, k = d.get("passed", 0), d.get("failed", 0)
    rate = (100.0 * p / (p + k)) if (p + k) else 0.0
    dur = d.get("durationMs")
    dur = "%d s" % round(dur / 1000) if isinstance(dur, (int, float)) else "-"
    a = age_days(r)
    extra = "tier=%s, age %s j" % (d.get("tier") or "-", fr(a) if a is not None else "?")
    if core:
        fs = d.get("firstSoundMs")
        extra += ", firstSound=%s" % ("%d ms%s" % (fs, " (> 3 s)" if fs > 3000 else "") if isinstance(fs, (int, float)) else "-")
    extra += ", " + gated_txt(d)
    return "%s %d/%d (%.0f %%, upstream %s, %s, version %s, %s, out/%s)" % (
        label, p, p + k, rate, d.get("upstream", "-"), dur, d.get("version", "-"), extra, ts)
chosen, why = {}, []
for k in KINDS:
    r = full[k]
    if r is None:
        chosen[k] = latest[k]
        l = latest[k]
        why.append("harness prod %s : aucun rapport de palier full (dernier rapport prod : %s)" % (
            k, ("tier=%s, age %s j, out/%s" % (l[1].get("tier") or "-", fr(age_days(l)) if age_days(l) is not None else "?", l[0])) if l else "aucun"))
        continue
    chosen[k] = r
    a = age_days(r)
    if a is None:
        why.append("harness prod %s : rapport full sans date lisible (out/%s)" % (k, r[0]))
    elif a > maxage:
        why.append("harness prod %s : rapport full vieux de %s j (> %g j, out/%s)" % (k, fr(a), maxage, r[0]))
core, off = chosen["coeur"], chosen["hors-ligne"]
cold = "-"
if core:
    for s in core[1].get("steps", []):
        if s.get("name") == "perf_cold_home_requests":
            cold = "%s%s" % (s.get("detail", "-"), "" if s.get("ok") else " (FAIL)")
# liste gated non vide alors qu une ligne WEEKLY d au moins 7 jours en portait deja une
gated_now = [(k, chosen[k][1].get("gated")) for k in KINDS if chosen[k] and isinstance(chosen[k][1].get("gated"), list) and chosen[k][1].get("gated")]
if gated_now:
    old = []
    try:
        for line in open(weekly, encoding="utf-8", errors="replace"):
            m = re.match(r"- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC \|", line)
            if not m:
                continue
            t = datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M").replace(tzinfo=datetime.timezone.utc)
            if (now - t).total_seconds() >= 7 * 86400 and re.search(r"gated=\[[^\]]+\]", line):
                old.append(m.group(1))
    except Exception:
        pass
    if old:
        why.append("etapes gatees depuis plus d une semaine (deja dans la ligne du %s) : %s" % (
            old[-1], " ; ".join("%s [%s]" % (k, ",".join(str(x) for x in g)) for k, g in gated_now)))
print("harness prod : " + fmt("coeur", core, True) + " ; " + fmt("hors-ligne", off, False))
print("accueil a froid : " + cold)
def ok(r):
    if not r:
        return "none"
    p, k = r[1].get("passed", 0), r[1].get("failed", 0)
    return "1" if (p + k) and k == 0 else "0"
print("RATES %s %s" % (ok(core), ok(off)))
print("WHY " + "; ".join(why))
PY
)
[ -n "$AB" ] || AB="harness prod : lecture des rapports impossible
accueil a froid : -"
A=$(printf '%s\n' "$AB" | sed -n 1p)
B=$(printf '%s\n' "$AB" | sed -n 2p)
RATES=$(printf '%s\n' "$AB" | sed -n 3p)
AWHY=$(printf '%s\n' "$AB" | sed -n 4p | sed 's/^WHY //; s/^WHY$//')

# (c) stats/library servie par la prod (hairpin casse : --resolve vers Traefik local)
STATS=$(curl -s --max-time 15 $R https://music.ekaii.fr/api/v1/stats/library 2>/dev/null || true)
C=$(printf '%s' "$STATS" | python3 -c '
import json, sys, datetime
try:
    d = json.load(sys.stdin)
except Exception:
    print("bibliotheque : stats/library illisible"); sys.exit()
age = "?"
la = d.get("lastAdded") or ""
try:
    t = datetime.datetime.strptime(la, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    age = ("%.1f" % ((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 86400)).replace(".", ",")
except Exception:
    pass
print("bibliotheque : %s titres / %s albums / %s artistes, lastAdded il y a %s j, version servie %s" % (
    d.get("tracks", "?"), d.get("albums", "?"), d.get("artists", "?"), age, d.get("version", "?")))
' 2>/dev/null)
[ -n "$C" ] || C="bibliotheque : stats/library illisible"
SERVED=$(printf '%s' "$STATS" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)

# (d) Kuma : seulement avec une cle API ; IP du conteneur resolue a chaque execution (jamais en dur)
D="kuma : n/a (jeton)"
if [ -n "$KUMA_KEY" ]; then
    KIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' uptime-kuma 2>/dev/null | cut -d' ' -f1)
    if [ -n "$KIP" ]; then
      D=$(printf 'user = ":%s"\n' "$(cfgq "$KUMA_KEY")" | curl -s --max-time 10 -K - "http://$KIP:3001/metrics" 2>/dev/null | python3 -c '
import re, sys
want = ["86", "119", "106", "167"]
st, rt = {}, {}
for line in sys.stdin:
    m = re.match(r"(monitor_status|monitor_response_time)\{([^}]*)\}\s+(\S+)", line)
    if not m:
        continue
    lab = dict(re.findall(r"(\w+)=\"([^\"]*)\"", m.group(2)))
    i = lab.get("monitor_id", "")
    if i in want:
        (st if m.group(1) == "monitor_status" else rt)[i] = m.group(3)
if not st:
    print("kuma : /metrics sans moniteur (cle refusee ?)"); sys.exit()
name = {"1": "up", "0": "DOWN", "2": "pending", "3": "maintenance"}
print("kuma : " + ", ".join("%s=%s %s ms" % (i, name.get(st.get(i, ""), "?"), rt.get(i, "?").split(".")[0]) for i in want))
' 2>/dev/null)
      [ -n "$D" ] || D="kuma : /metrics injoignable"
    else
      D="kuma : conteneur uptime-kuma introuvable"
    fi
fi

# Journal d acces Echo du conteneur prod (stdout, une ligne JSON par requete) : (e) sans jeton, (f), (j)
PYACCESS=$(cat <<'PY'
import collections, datetime, json, re, sys
started = sys.argv[1] if len(sys.argv) > 1 else ""
BOT = re.compile(r"HeadlessChrome|ytm-perf|curl/|python|Go-http|Uptime-Kuma", re.I)
AUDIO = ("/localf", "/vp", "/aud/", "/cover")
plays = harness = 0
ips = set()
cl = collections.Counter()
lat = collections.defaultdict(list)
first = ""
def norm(p):
    out = []
    for s in p.split("/")[1:6]:
        if re.fullmatch(r"\d+|[0-9a-f-]{12,}|[A-Za-z0-9_-]{16,}|.*[:%].*", s):
            s = ":id"
        out.append(s)
    return "/" + "/".join(out)
for line in sys.stdin:
    if '"uri"' not in line:
        continue
    try:
        d = json.loads(line[line.index("{"):])
    except Exception:
        continue
    if not first:
        first = d.get("time", "")
    uri = d.get("uri", "").split("?", 1)[0]
    m, st, ua = d.get("method", ""), int(d.get("status") or 0), d.get("user_agent", "")
    if m == "POST" and uri == "/api/v1/me/history" and 200 <= st < 300:
        if BOT.search(ua):
            harness += 1
        else:
            plays += 1
            ips.add(d.get("remote_ip", "?"))
    if m == "POST" and uri == "/api/v1/client-log":
        cl[st] += 1
    if uri.startswith("/api/") and not uri.startswith(AUDIO):
        lat[norm(uri)].append(float(d.get("latency") or 0) / 1e6)
def ts(s):
    try:
        return datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    except Exception:
        return None
now = datetime.datetime.now(datetime.timezone.utc)
t0 = ts(started) or ts(first)
week = now - datetime.timedelta(days=7)
if t0 and t0 > week:
    win = "logs depuis %s, %s j" % (t0.strftime("%d/%m %H:%M"), ("%.1f" % ((now - t0).total_seconds() / 86400)).replace(".", ","))
else:
    win = "7 j"
priv = sum(1 for i in ips if re.match(r"(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.", i))
print("usage 7 j : %d ecoutes hors harness (%d harness), %d IP clientes distinctes dont %d privees (proxy des profils actifs : pas de cookie dans les logs) (%s)" % (plays, harness, len(ips), priv, win))
tot = sum(cl.values())
print("client-log : %d envois (7 j) via logs%s (%s)" % (tot, (" (" + ", ".join("http %d=%d" % kv for kv in sorted(cl.items())) + ")") if cl else "", win))
rows = []
for k, v in lat.items():
    if len(v) < 5:
        continue
    v.sort()
    rows.append((v[min(len(v) - 1, int(0.9 * len(v) + 0.999) - 1)], k, len(v)))
rows.sort(reverse=True)
print("API lente (p90) : " + (", ".join("%s %s ms (n=%d)" % (k, ("%.0f" % p), n) for p, k, n in rows[:3]) if rows else "moins de 5 requetes par prefixe") + " (%s)" % win)
PY
)
STARTED=$(docker inspect -f '{{.State.StartedAt}}' ytm-beatbump 2>/dev/null || true)
ACC=$(timeout 40 docker logs --since 168h ytm-beatbump 2>&1 | python3 -c "$PYACCESS" "$STARTED" 2>/dev/null)
F=$(printf '%s\n' "$ACC" | sed -n 1p)
ELOG=$(printf '%s\n' "$ACC" | sed -n 2p)
J=$(printf '%s\n' "$ACC" | sed -n 3p)
[ -n "$F" ] || F="usage 7 j : journal d acces de ytm-beatbump illisible"
[ -n "$J" ] || J="API lente (p90) : journal d acces illisible"

# (e) journal des erreurs client (decision 15) ; sans jeton : comptage des POST dans le journal d acces
E=${ELOG:-"client-log : journal d acces illisible (YTM_ADMIN_TOKEN non pose)"}
if [ -n "$ADMIN_TOKEN" ]; then
  E=$(printf 'header = "Authorization: Bearer %s"\n' "$(cfgq "$ADMIN_TOKEN")" | curl -s --max-time 15 $R -K - -w '\n%{http_code}' "https://music.ekaii.fr/api/v1/client-log?limit=50" 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read().rsplit("\n", 1)
code = raw[1] if len(raw) == 2 else "?"
if code != "200":
    print("client-log : http %s" % code); sys.exit()
try:
    e = json.loads(raw[0]).get("entries") or []
except Exception:
    print("client-log : reponse illisible"); sys.exit()
c = {}
for x in e:
    c[x.get("kind", "?")] = c.get(x.get("kind", "?"), 0) + 1
print("client-log : %d entrees sur 50 max%s" % (len(e), (" (" + ", ".join("%s=%d" % kv for kv in sorted(c.items())) + ")") if c else ""))
' 2>/dev/null)
  [ -n "$E" ] || E="client-log : lecture impossible"
fi

# (g) acquisition : journal de ytm-yubal (sortie rich : codes ANSI retires, messages coupes sur 2 lignes)
PYACQ=$(cat <<'PY'
import datetime, re, sys
started = sys.argv[1] if len(sys.argv) > 1 else ""
ansi = re.compile(r"\x1b\[[0-9;]*m")
dl = skip = ftrack = fjob = 0
last = first = ""
for line in sys.stdin:
    line = ansi.sub("", line)
    t = line[:19]
    if not first and t[:2] == "20":
        first = t
    if "download_service - Downloaded:" in line:
        dl += 1; last = t
    elif "download_service - Skipped" in line:
        skip += 1
    elif "download_service - Failed to download" in line:
        ftrack += 1
    elif re.search(r"job_executor - Job \S+ failed", line):
        fjob += 1
def ts(s):
    try:
        return datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    except Exception:
        return None
now = datetime.datetime.now(datetime.timezone.utc)
t0 = ts(started)
f0 = ts(first)
if f0 and (not t0 or f0 > t0):
    t0 = f0
win = "7 j"
if t0 and t0 > now - datetime.timedelta(days=7):
    win = "logs depuis %s" % t0.strftime("%d/%m %H:%M")
lt = ts(last)
print("acquisition : %d pistes telechargees, %d deja presentes, %d echecs de piste, %d taches en echec (%s), dernier telechargement %s" % (
    dl, skip, ftrack, fjob, win, lt.strftime("%Y-%m-%d %H:%M UTC") if lt else "aucun"))
print("ACQ %d %d" % (dl, ftrack + fjob))
PY
)
YSTART=$(docker inspect -f '{{.State.StartedAt}}' ytm-yubal 2>/dev/null || true)
GA=$(timeout 40 docker logs -t --since 168h ytm-yubal 2>&1 | python3 -c "$PYACQ" "$YSTART" 2>/dev/null)
G=$(printf '%s\n' "$GA" | sed -n 1p)
ACQ=$(printf '%s\n' "$GA" | sed -n 2p)
[ -n "$G" ] || G="acquisition : journal de ytm-yubal illisible"
# c59b (decision 8) : demandes d acquisition du jour (UTC, tous profils) comptees par le serveur
# (stats/library acquisitionsToday, plafond YTM_ACQUIRE_DAILY_CAP par profil et par jour, 20 par defaut)
ACQD=$(printf '%s' "$STATS" | python3 -c 'import json,sys;v=json.load(sys.stdin).get("acquisitionsToday");print("" if v is None else v)' 2>/dev/null || true)
[ -n "$ACQD" ] && G="$G, $ACQD demandes d acquisition aujourd hui (plafond serveur par profil)"

# (h) disque : volume de la bibliotheque (source du montage /app/data de ytm-yubal, resolue a chaque run) et /srv/data
LIB=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' ytm-yubal 2>/dev/null)
[ -n "$LIB" ] || LIB=/mnt/nas/media/music/ytm
# df -P -k : champs 2 = taille, 4 = disponible (Ko) ; sortie "<libre lisible> <pourcentage libre entier>"
dfree() { timeout 10 df -P -k "$1" 2>/dev/null | awk 'NR == 2 && $2 > 0 { a = $4; u = "Ko"; if (a >= 1024) { a /= 1024; u = "Mo" } if (a >= 1024) { a /= 1024; u = "Go" } if (a >= 1024) { a /= 1024; u = "To" } s = sprintf("%.1f %s", a, u); sub(/\./, ",", s); printf "%s %d\n", s, int(100 * $4 / $2) }'; }
DL=$(dfree "$LIB"); DF=$(dfree /srv/data)
fmtdf() { if [ -n "$2" ]; then echo "$1 ${2% *} libres (${2##* } %)"; else echo "$1 df sans reponse en 10 s"; fi; }
H="disque : bibliotheque $(fmtdf "$LIB" "$DL"), $(fmtdf /srv/data "$DF")"

# (i) sauvegardes image de promote.sh
I=$(ls -l "$YTM"/image-backups/*.tar.gz 2>/dev/null | awk '{ n++; s += $5 } END { printf "sauvegardes image : %d (%.0f Mo)", n, s / 1048576 }')
[ -n "$I" ] || I="sauvegardes image : 0"

# (k) retention 7 j (c53a, B9-16) : lecture SEULE de la base prod, seulement avec WEEKLY_DB_RO=1 (monday.sh le
# pose ; a la main : WEEKLY_DB_RO=1 WEEKLY_DRY_RUN=1 sh weekly.sh). Formule dans l en-tete et program/WEEKLY.md.
K="retention 7 j : n/a (WEEKLY_DB_RO=1 non pose : pas de lecture de la base)"
if [ "${WEEKLY_DB_RO:-}" = 1 ]; then
  DBDIR=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/db"}}{{.Source}}{{end}}{{end}}' ytm-beatbump 2>/dev/null)
  [ -n "$DBDIR" ] || DBDIR="$YTM/beatbump-db"
  K=$(timeout 30 python3 - "$DBDIR/beatbump.db" "$YTM/e2e/fixtures.json" <<'PY' 2>/dev/null
import collections, datetime, json, re, sqlite3, statistics, sys
db, fx = sys.argv[1], sys.argv[2]
try:
    f = json.load(open(fx))
except Exception:
    f = {}
REFS = {str(f.get(k) or "") for k in ("acquiredVideoId", "localLid")} | {"9bZkp7q19f0"}
REFS.discard("")
ARTISTS = {str(f.get(k) or "").strip().lower() for k in ("localAlbumArtist", "localArtistName")}
ARTISTS.discard("")
def fixture(ref, title, artist):
    return ref in REFS or "gangnam style" in title.lower() or artist.strip().lower() in ARTISTS
try:
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=5)
    con.execute("PRAGMA query_only=1")
    names = {r[0]: r[1] for r in con.execute("SELECT id, COALESCE(name, '') FROM profiles")}
    rows = con.execute("SELECT profile_id, COALESCE(ref, ''), COALESCE(title, ''), COALESCE(artist, ''), played_at FROM play_events").fetchall()
    con.close()
except Exception as e:
    print("retention 7 j : n/a (base illisible en mode ro : %s)" % str(e)[:80]); sys.exit()
def ts(v):
    m = re.match(r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?", str(v))
    if not m:
        return None
    t = datetime.datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M:%S")
    off = m.group(3)
    if off and off != "Z":
        t -= (1 if off[0] == "+" else -1) * datetime.timedelta(hours=int(off[1:3]), minutes=int(off[-2:]))
    return t.replace(tzinfo=datetime.timezone.utc)
now = datetime.datetime.now(datetime.timezone.utc)
d7, d14 = now - datetime.timedelta(days=7), now - datetime.timedelta(days=14)
byp = {}
for pid, ref, title, artist, pa in rows:
    t = ts(pa)
    if t is None:
        continue
    e = byp.setdefault(pid, [0, 0, []])
    e[0 if fixture(ref, title, artist) else 1] += 1
    e[2].append(t)
harness = {p for p, e in byp.items() if str(names.get(p, "")).startswith("harness-") or e[1] == 0}
humans = set(byp) - harness
A = {p for p in humans if any(d7 <= t < now for t in byp[p][2])}
P = {p for p in humans if any(d14 <= t < d7 for t in byp[p][2])}
plays7 = [t for p in humans for t in byp[p][2] if d7 <= t < now]
perday = collections.Counter(t.date() for t in plays7)
med = statistics.median(perday.get((now - datetime.timedelta(days=i)).date(), 0) for i in range(7))
last = max((t for p in humans for t in byp[p][2]), default=None)
print("retention 7 j : profils humains actifs %d (J-14..J-7 : %d, revenus %d) ; ecoutes humaines 7 j : %d (mediane/jour %s) ; derniere ecoute humaine : %s ; exclus : %d profils harness ou fixtures seules sur %d (lecture mode=ro)" % (
    len(A), len(P), len(A & P), len(plays7), ("%g" % med).replace(".", ","), last.strftime("%Y-%m-%d %H:%M UTC") if last else "aucune", len(harness), len(byp)))
PY
)
  [ -n "$K" ] || K="retention 7 j : n/a (lecture mode=ro en echec ou base absente : $DBDIR)"
fi

LINE="- $NOW UTC | $A | $B | $C | $D | $E | $F | $G | $H | $I | $J | $K"

# Alerte : harness prod < 100 % (ou absent), version servie != dernier "PROD = <sha>" de CYCLES.md
WHY=""
# c53a B9-14 : rapport full absent ou trop vieux, etapes gatees depuis plus d une semaine (4e ligne du bloc (a))
[ -z "${AWHY:-}" ] || WHY="$WHY; $AWHY"
case "$RATES" in
  "RATES 1 1") ;;
  RATES*) set -- $RATES; [ "$2" = 1 ] || WHY="$WHY; harness prod coeur $( [ "$2" = none ] && echo absent || echo '< 100 %')"
          [ "$3" = 1 ] || WHY="$WHY; harness prod hors-ligne $( [ "$3" = none ] && echo absent || echo '< 100 %')" ;;
  *) WHY="$WHY; rapports du harness prod illisibles" ;;
esac
LASTPROD=$(grep -o 'PROD = [0-9a-f]\{7,12\}' "$CYCLES" 2>/dev/null | tail -1 | cut -d' ' -f3)
if [ -z "$SERVED" ]; then WHY="$WHY; version servie illisible"
elif [ -z "$LASTPROD" ]; then WHY="$WHY; aucun \"PROD = <sha>\" dans CYCLES.md"
elif [ "$SERVED" != "$LASTPROD" ]; then WHY="$WHY; version servie $SERVED != dernier PROD = $LASTPROD (CYCLES.md)"
fi
# cycle 41 : disque < 10 % libre (ou df bloque), acquisition a zero avec des echecs, moniteur Kuma 167 DOWN
for pair in "bibliotheque $LIB|$DL" "/srv/data|$DF"; do
  lab=${pair%%|*}; v=${pair#*|}
  if [ -z "$v" ]; then WHY="$WHY; disque $lab : df sans reponse en 10 s"
  elif [ "${v##* }" -lt 10 ]; then WHY="$WHY; disque $lab : ${v##* } % libre (< 10 %)"
  fi
done
case "$ACQ" in
  "ACQ 0 0"|"") ;;
  "ACQ 0 "*) WHY="$WHY; acquisition : 0 piste telechargee et ${ACQ##* } echecs sur la fenetre" ;;
esac
case "$D" in *"167=DOWN"*) WHY="$WHY; Kuma 167 (API stats/library) DOWN" ;; esac
WHY=${WHY#; }

if [ "${WEEKLY_DRY_RUN:-}" = 1 ]; then
  echo "$LINE"
  [ -z "$WHY" ] || echo "ALERT (dry-run, ALERT.md non ecrit) : $WHY" >&2
else
  [ -f "$WEEKLY" ] || { echo "WEEKLY.md absent : $WEEKLY" >&2; exit 1; }
  printf '%s\n' "$LINE" >> "$WEEKLY"
  echo "$LINE"
  if [ -n "$WHY" ]; then
    [ -f "$ALERT" ] || printf '# ALERT music.ekaii.fr (ecrit par agents/ops/weekly.sh ; supprimer apres traitement)\n' > "$ALERT"
    printf '\n## %s UTC\n- raisons : %s\n- ligne : %s\n' "$NOW" "$WHY" "$LINE" >> "$ALERT"
    echo "ALERT : $WHY (-> $ALERT)" >&2
  fi
fi
