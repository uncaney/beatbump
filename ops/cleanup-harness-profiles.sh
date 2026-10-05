#!/bin/sh
# Purge des profils nommes "harness-*" crees par le harness (audit-logic-v11 angle mort 7, v12 L12-15 ; cycle 42).
# Motifs comptes un par un : harness-blank-* (steps-c38 blank_profile_empty_states, un par run),
# harness-id-* (c39 identity_migration, staging), harness-take-* (c40 resume_take_over, staging),
# harness-remote-* (resume_remote), harness-skip-* (steps-c42 skips_exclusion_real, staging), les noms FIXES
# reutilises a chaque run (harness-np, harness-days, harness-remote) et "autres harness-*".
# Purge par defaut = tous les harness-* SAUF les noms fixes (ils ne s accumulent pas ; --include-fixed les ajoute).
# Par defaut : LECTURE SEULE (sqlite mode=ro) : compte par motif et IMPRIME les DELETE, n execute rien.
# Usage : sh cleanup-harness-profiles.sh [--staging | --db <chemin beatbump.db>] [--include-fixed] [--execute]
#   --db      : defaut /srv/beatbump/beatbump-db/beatbump.db (prod) ;
#   --staging : raccourci pour /srv/beatbump/agents/staging-db/beatbump.db
#   --execute : execute les DELETE dans une transaction ; exige YTM_CONFIRM=yes et le droit d ecriture sur la
#               base, son -wal / -shm et son dossier. Prod : refuse sauf en root (base root:root 644, decision
#               Camille) ; staging : fichiers aussi root:root 644 au 02/10 (ecrits par le conteneur) : il faut root
#               ou un chown de agents/staging-db/beatbump.db* vers ce compte.
# Tables (GORM, backend/db/me_models.go) : profiles (id, name), et les lignes rattachees par profile_id :
# favorites, follows, playlists (+ playlist_items par playlist_id), play_events, now_playings, skip_events.
# acquire_jobs n est pas touche (file d acquisition, pas un etat d utilisateur). Une table absente est sautee.
# Aucune route API ne supprime un profil (main.go : seulement favorites / follows / playlists par profil).
set -eu
PROD_DB=/srv/beatbump/beatbump-db/beatbump.db
STG_DB=/srv/beatbump/agents/staging-db/beatbump.db
DB=$PROD_DB
EXEC=0
FIXED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB=${2:?--db sans chemin}; shift 2 ;;
    --staging) DB=$STG_DB; shift ;;
    --include-fixed) FIXED=1; shift ;;
    --execute) EXEC=1; shift ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argument inconnu : $1" >&2; exit 1 ;;
  esac
done
[ -r "$DB" ] || { echo "base illisible : $DB" >&2; exit 1; }
if [ "$EXEC" = 1 ]; then
  [ "${YTM_CONFIRM:-}" = yes ] || { echo "REFUS : --execute exige YTM_CONFIRM=yes" >&2; exit 1; }
  if [ "$(readlink -f "$DB")" = "$(readlink -f "$PROD_DB")" ] && [ "$(id -u)" != 0 ]; then
    echo "REFUS : --execute sur la base PROD exige root (purge prod = manuelle, decision Camille) ; staging : --staging" >&2; exit 1
  fi
  for f in "$DB" "$DB-wal" "$DB-shm" "$(dirname "$DB")"; do
    [ -e "$f" ] || continue
    [ -w "$f" ] || { echo "REFUS : pas de droit d ecriture sur $f (proprietaire : $(stat -c %U "$f"))" >&2; exit 1; }
  done
fi
python3 - "$DB" "$EXEC" "$FIXED" <<'PY'
import sqlite3, sys
db, execute, include_fixed = sys.argv[1], sys.argv[2] == "1", sys.argv[3] == "1"
FIXED = ["harness-np", "harness-days", "harness-remote"]
PATTERNS = ["harness-blank-*", "harness-id-*", "harness-take-*", "harness-remote-*", "harness-skip-*"]
q = lambda s: "'" + s.replace("'", "''") + "'"
uri = "file:%s?mode=%s" % (db, "rw" if execute else "ro")
c = sqlite3.connect(uri, uri=True, timeout=10)
tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
cnt = lambda where: c.execute("SELECT count(*) FROM profiles WHERE " + where).fetchone()[0]
print("base %s" % db)
for p in PATTERNS:
    print("  %-18s %5d" % (p, cnt("name GLOB " + q(p))))
for f in FIXED:
    print("  %-18s %5d  (nom fixe, %s)" % (f, cnt("name = " + q(f)), "purge" if include_fixed else "garde"))
known = " OR ".join(["name GLOB " + q(p) for p in PATTERNS] + ["name = " + q(f) for f in FIXED])
other = "name GLOB 'harness-*' AND NOT (%s)" % known
ex = [r[0] for r in c.execute("SELECT name FROM profiles WHERE %s ORDER BY name LIMIT 5" % other)]
print("  %-18s %5d%s" % ("autres harness-*", cnt(other), ("  (ex. " + ", ".join(ex) + ")") if ex else ""))
print("  %-18s %5d" % ("total harness-*", cnt("name GLOB 'harness-*'")))
WHERE = "name GLOB 'harness-*'" + ("" if include_fixed else " AND name NOT IN (%s)" % ", ".join(q(f) for f in FIXED))
SEL = "SELECT id FROM profiles WHERE " + WHERE
print("a purger : %d profil(s) (%s)" % (cnt(WHERE), "noms fixes inclus" if include_fixed else "noms fixes gardes"))
STMTS = []
if "playlist_items" in tables and "playlists" in tables:
    STMTS.append("DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE profile_id IN (%s));" % SEL)
for t in ["playlists", "favorites", "follows", "play_events", "now_playings", "skip_events"]:
    if t in tables:
        STMTS.append("DELETE FROM %s WHERE profile_id IN (%s);" % (t, SEL))
    else:
        print("-- table %s absente : sautee" % t)
STMTS.append("DELETE FROM profiles WHERE %s;" % WHERE)
print("-- SQL de purge (ordre : enfants puis profiles) :")
print("BEGIN;")
for s in STMTS:
    print(s)
print("COMMIT;")
if not execute:
    print("-- rien execute (relancer avec --execute et YTM_CONFIRM=yes)")
    sys.exit()
with c:
    for s in STMTS:
        cur = c.execute(s)
        print("%s -> %d ligne(s)" % (s.split(" WHERE")[0], cur.rowcount))
print("purge faite")
PY
