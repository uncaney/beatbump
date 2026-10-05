#!/bin/sh
# Purge of the "harness-*" profiles the harness creates (audit-logic-v11 blind spot 7, v12 L12-15; cycle 42).
# Patterns counted one by one: harness-blank-* (steps-c38 blank_profile_empty_states, one per run),
# harness-id-* (c39 identity_migration), harness-take-* (c40 resume_take_over), harness-remote-* (resume_remote),
# harness-skip-* (steps-c42 skips_exclusion_real), the FIXED names reused on every run (harness-np, harness-days,
# harness-remote) and "other harness-*".
# Default purge = every harness-* EXCEPT the fixed names (they do not accumulate; --include-fixed adds them).
# By default: READ-ONLY (sqlite mode=ro): counts per pattern and PRINTS the DELETE statements, executes nothing.
# Usage: sh ops/cleanup-harness-profiles.sh [--staging | --db <path to beatbump.db>] [--include-fixed] [--execute]
#   --db      : default $YTM_DB_DIR/beatbump.db (prod);  --staging: $YTM_STAGING_DB_DIR/beatbump.db
#   --execute : runs the DELETEs in one transaction; requires YTM_CONFIRM=yes and write access to the database,
#               its -wal / -shm and its directory. Prod: refused unless root (the prod purge is a manual, root
#               decision); staging: the files are usually owned by the container's user, so root or a chown to
#               this account is needed too.
# Tables (GORM, backend/db/me_models.go): profiles (id, name), and the rows attached by profile_id: favorites,
# follows, playlists (+ playlist_items by playlist_id), play_events, now_playings, skip_events. acquire_jobs is not
# touched (acquisition queue, not a user state). A missing table is skipped. No API route deletes a profile
# (main.go: only favorites / follows / playlists per profile).
set -eu
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
. "$OPS_DIR/env.sh"
PROD_DB="$YTM_DB_DIR/beatbump.db"
STG_DB="$YTM_STAGING_DB_DIR/beatbump.db"
DB=$PROD_DB
EXEC=0
FIXED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB=${2:?--db without a path}; shift 2 ;;
    --staging) DB=$STG_DB; shift ;;
    --include-fixed) FIXED=1; shift ;;
    --execute) EXEC=1; shift ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
[ -r "$DB" ] || { echo "database unreadable: $DB" >&2; exit 1; }
if [ "$EXEC" = 1 ]; then
  [ "${YTM_CONFIRM:-}" = yes ] || { echo "REFUSED: --execute requires YTM_CONFIRM=yes" >&2; exit 1; }
  if [ "$(readlink -f "$DB")" = "$(readlink -f "$PROD_DB")" ] && [ "$(id -u)" != 0 ]; then
    echo "REFUSED: --execute on the PROD database requires root (prod purge = manual decision); staging: --staging" >&2; exit 1
  fi
  for f in "$DB" "$DB-wal" "$DB-shm" "$(dirname "$DB")"; do
    [ -e "$f" ] || continue
    [ -w "$f" ] || { echo "REFUSED: no write access to $f (owner: $(stat -c %U "$f"))" >&2; exit 1; }
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
print("database %s" % db)
for p in PATTERNS:
    print("  %-18s %5d" % (p, cnt("name GLOB " + q(p))))
for f in FIXED:
    print("  %-18s %5d  (fixed name, %s)" % (f, cnt("name = " + q(f)), "purged" if include_fixed else "kept"))
known = " OR ".join(["name GLOB " + q(p) for p in PATTERNS] + ["name = " + q(f) for f in FIXED])
other = "name GLOB 'harness-*' AND NOT (%s)" % known
ex = [r[0] for r in c.execute("SELECT name FROM profiles WHERE %s ORDER BY name LIMIT 5" % other)]
print("  %-18s %5d%s" % ("other harness-*", cnt(other), ("  (e.g. " + ", ".join(ex) + ")") if ex else ""))
print("  %-18s %5d" % ("total harness-*", cnt("name GLOB 'harness-*'")))
WHERE = "name GLOB 'harness-*'" + ("" if include_fixed else " AND name NOT IN (%s)" % ", ".join(q(f) for f in FIXED))
SEL = "SELECT id FROM profiles WHERE " + WHERE
print("to purge: %d profile(s) (%s)" % (cnt(WHERE), "fixed names included" if include_fixed else "fixed names kept"))
STMTS = []
if "playlist_items" in tables and "playlists" in tables:
    STMTS.append("DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE profile_id IN (%s));" % SEL)
for t in ["playlists", "favorites", "follows", "play_events", "now_playings", "skip_events"]:
    if t in tables:
        STMTS.append("DELETE FROM %s WHERE profile_id IN (%s);" % (t, SEL))
    else:
        print("-- table %s absent: skipped" % t)
STMTS.append("DELETE FROM profiles WHERE %s;" % WHERE)
print("-- purge SQL (order: children then profiles):")
print("BEGIN;")
for s in STMTS:
    print(s)
print("COMMIT;")
if not execute:
    print("-- nothing executed (run again with --execute and YTM_CONFIRM=yes)")
    sys.exit()
with c:
    for s in STMTS:
        cur = c.execute(s)
        print("%s -> %d row(s)" % (s.split(" WHERE")[0], cur.rowcount))
print("purge done")
PY
