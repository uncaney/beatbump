#!/bin/sh
# Weekly measurements of the production instance (cycle 36, item HO6 of program/brainstorm-v5.md section 4).
# Read-only, no browser, under 90 s. Only write: ONE line appended to $YTM_PROGRAM_DIR/WEEKLY.md.
# Run ON the host.
#
# Usage: sh ops/weekly.sh [-]
#   Secrets (cycle 39 L11-3): NEVER a file path as argument, never a copy on the host disk. Two sources, read once
#   then removed from the environment (curl receives them through -K - on stdin: nothing in ps nor
#   /proc/<pid>/cmdline):
#     - environment variables WEEKLY_KUMA_KEY (Uptime Kuma API key, Settings > API keys) and YTM_ADMIN_TOKEN
#       (Bearer token of GET /api/v1/client-log, decision 15);
#     - argument "-": NAME=value lines on stdin (only these two names are accepted), e.g. from a workstation:
#         { printf 'WEEKLY_KUMA_KEY='; cat <key file>; echo; } | ssh host 'sh /path/ops/weekly.sh -'
#   Without a Kuma key: column "kuma: n/a (token)"; without the admin token: "n/a (YTM_ADMIN_TOKEN not set)".
#   The key and the token are never printed nor written.
#   WEEKLY_DRY_RUN=1 (env, optional): prints the line without appending it to WEEKLY.md (nor writing ALERT.md).
#   Alert (cycles 39 and 41, cron.weekly.example): a block is appended to $YTM_PROGRAM_DIR/ALERT.md when
#     - the pass rate of the prod harness (core or offline) is < 100 %, or no prod report exists;
#     - the served version differs from the last "PROD = <sha>" of $YTM_PROGRAM_DIR/CYCLES.md;
#     - the library volume or one of YTM_DISK_PATHS has less than 10 % free (or df does not answer in 10 s: NFS);
#     - zero track downloaded by the acquisition container over the window while there are failures;
#     - the Kuma monitor YTM_KUMA_STATS_MONITOR is DOWN (only with WEEKLY_KUMA_KEY).
#   No mail, no Kuma push. The alert reasons go to stderr; stdout keeps exactly the WEEKLY line.
#
# The columns (brainstorm-v5 section 4, then cycles 41 and 53):
#   (a) prod harness: last e2e/out/*/report.json whose url = $YTM_PROD_URL, core (step perf_cold_home_requests
#       present) and offline (step load_home present): passed, failed, upstream, durationMs, version. c53a B9-14:
#       the report kept is the LAST one of tier "full"; it must be younger than WEEKLY_MAX_REPORT_AGE_D days
#       (default 8, age read from finishedAt, else from the directory name); tier, age, firstSoundMs (core, "> 3 s"
#       when above) and the gated list (must be []) are printed; alert when no full report, a full report older
#       than the limit, or a non-empty gated list while a WEEKLY line at least 7 days old already carried one.
#   (b) cold home: detail of the step perf_cold_home_requests of that core report (_app requests ...)
#   (c) stats/library: tracks / albums / artists, age of lastAdded in days, served version
#   (d) Kuma: state + response time of the monitors YTM_KUMA_MONITORS (/metrics endpoint, API key)
#   (e) client-log: entries per kind over the 50 most recent (with YTM_ADMIN_TOKEN); without the token, the
#       POST /api/v1/client-log count per HTTP status in the access log of the prod container (cycle 41)
#   (f) usage 7 d: POST /api/v1/me/history (2xx) of the Echo access log of the prod container, harness agents
#       excluded (HeadlessChrome, ytm-perf, curl, python, Go-http, Uptime-Kuma); "active profiles" = distinct
#       client IPs (APPROXIMATION: no profile cookie in the logs). docker logs only cover the container's life:
#       every promotion recreates it, the real window ("logs since ...") is printed.
#   (g) acquisition: log of YTM_ACQ_CONTAINER over 168 h: tracks downloaded ("Downloaded:"), already present
#       ("Skipped (file exists)"), track failures ("Failed to download"), failed jobs ("Job <id> failed"), time of
#       the last download; "n/a" without YTM_ACQ_CONTAINER
#   (h) disk: df of the library volume and of each YTM_DISK_PATHS (timeout 10 s, NFS may hang)
#   (i) image backups: count and size of $YTM_IMAGE_BACKUPS/*.tar.gz (promote.sh rollback)
#   (j) slow API: the 3 /api/ uri prefixes with the highest p90 over the window (>= 5 requests, ids replaced by
#       :id, audio streams excluded)
#   (k) retention 7 d (READ-ONLY access to the prod database, only with WEEKLY_DB_RO=1; else "n/a"):
#       sqlite3 "file:<db dir>/beatbump.db?mode=ro" + PRAGMA query_only, tables profiles(id, name) and
#       play_events(profile_id, ref, title, artist, album, played_at). HARNESS profile = profiles.name LIKE
#       'harness-%' OR all its plays (whole history) are fixture plays: ref in the fixtures file (acquiredVideoId,
#       localLid) or 9bZkp7q19f0, title containing "gangnam style", artist = localAlbumArtist / localArtistName.
#       A profile with at least one non-fixture play is HUMAN. A = human profiles with a play in [D-7, D);
#       P = same over [D-14, D-7); returning = A and P; human plays 7 d = count and median per UTC day over the
#       last 7 days; last human play. The backend has not written harness plays since cycle 52 (X-Ytm-Harness
#       everywhere): the exclusions cover older rows. No public API gives these numbers (decision 15).
#       Database path: source of the /db mount of the prod container, else $YTM_DB_DIR.
set -u
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
. "$OPS_DIR/env.sh"
OUT="$YTM_E2E_DIR/out"
WEEKLY="$YTM_PROGRAM_DIR/WEEKLY.md"
CYCLES="$YTM_PROGRAM_DIR/CYCLES.md"
PRD="$YTM_PROD_URL"
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
         *) echo "stdin: line ignored (expected WEEKLY_KUMA_KEY=... or YTM_ADMIN_TOKEN=...)" >&2 ;;
       esac
     done ;;
  *) echo "weekly.sh: argument refused (no secret file path since cycle 39); see the header: env or \"-\" + stdin" >&2; exit 2 ;;
esac
KUMA_KEY=$(printf '%s' "$KUMA_KEY" | tr -d ' \r\n')
ADMIN_TOKEN=$(printf '%s' "$ADMIN_TOKEN" | tr -d ' \r\n')
# quoted value for a curl config file (-K -): escapes \ and "
cfgq() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
NOW=$(date -u +"%Y-%m-%d %H:%M")

# (a) + (b): prod harness reports (file reads only). c53a B9-14: last full-tier report per kind (core = step
# perf_cold_home_requests, offline = step load_home: names kept by c52c), age < WEEKLY_MAX_REPORT_AGE_D days,
# firstSoundMs and gated printed, alert reasons on the 4th line (WHY).
MAX_AGE_D="${WEEKLY_MAX_REPORT_AGE_D:-8}"
AB=$(python3 - "$OUT" "$WEEKLY" "$MAX_AGE_D" "$PRD" "$YTM_ALLOW_SKIPS" <<'PY' 2>/dev/null
import datetime, glob, json, os, re, sys
out, weekly, maxage, prod = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4].rstrip("/")
allow_skips = sys.argv[5] == "1"
now = datetime.datetime.now(datetime.timezone.utc)
KINDS = ("core", "offline")
full = {k: None for k in KINDS}
latest = {k: None for k in KINDS}
for f in sorted(glob.glob(os.path.join(out, "*", "report.json")), reverse=True):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if str(d.get("url", "")).rstrip("/") != prod:
        continue
    names = {s.get("name") for s in d.get("steps", [])}
    kind = "core" if "perf_cold_home_requests" in names else ("offline" if "load_home" in names else None)
    if kind is None:
        continue
    ts = os.path.basename(os.path.dirname(f))
    if latest[kind] is None:
        latest[kind] = (ts, d)
    if full[kind] is None and d.get("tier") == "full":
        full[kind] = (ts, d)
    if all(full.values()):
        break
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
        return "%s no report" % label
    ts, d = r
    p, k = d.get("passed", 0), d.get("failed", 0)
    rate = (100.0 * p / (p + k)) if (p + k) else 0.0
    dur = d.get("durationMs")
    dur = "%d s" % round(dur / 1000) if isinstance(dur, (int, float)) else "-"
    a = age_days(r)
    extra = "tier=%s, age %s d" % (d.get("tier") or "-", "%.1f" % a if a is not None else "?")
    if core:
        fs = d.get("firstSoundMs")
        extra += ", firstSound=%s" % ("%d ms%s" % (fs, " (> 3 s)" if fs > 3000 else "") if isinstance(fs, (int, float)) else "-")
    if d.get("skipped"):
        extra += ", skipped=%s" % d.get("skipped")
    extra += ", " + gated_txt(d)
    return "%s %d/%d (%.0f %%, upstream %s, %s, version %s, %s, out/%s)" % (
        label, p, p + k, rate, d.get("upstream", "-"), dur, d.get("version", "-"), extra, ts)
chosen, why = {}, []
for k in KINDS:
    r = full[k]
    if r is None:
        chosen[k] = latest[k]
        l = latest[k]
        why.append("prod harness %s: no full-tier report (last prod report: %s)" % (
            k, ("tier=%s, age %s d, out/%s" % (l[1].get("tier") or "-", "%.1f" % age_days(l) if age_days(l) is not None else "?", l[0])) if l else "none"))
        continue
    chosen[k] = r
    a = age_days(r)
    if a is None:
        why.append("prod harness %s: full report without a readable date (out/%s)" % (k, r[0]))
    elif a > maxage:
        why.append("prod harness %s: full report %.1f d old (> %g d, out/%s)" % (k, a, maxage, r[0]))
    if r[1].get("skipped") and not allow_skips:
        why.append("prod harness %s: %s step(s) skipped (precondition not met; YTM_ALLOW_SKIPS=1 to accept)" % (k, r[1].get("skipped")))
core, off = chosen["core"], chosen["offline"]
cold = "-"
if core:
    for s in core[1].get("steps", []):
        if s.get("name") == "perf_cold_home_requests":
            cold = "%s%s" % (s.get("detail", "-"), "" if s.get("ok") else " (FAIL)")
# non-empty gated list while a WEEKLY line at least 7 days old already carried one
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
        why.append("steps gated for more than a week (already in the line of %s): %s" % (
            old[-1], "; ".join("%s [%s]" % (k, ",".join(str(x) for x in g)) for k, g in gated_now)))
print("prod harness: " + fmt("core", core, True) + "; " + fmt("offline", off, False))
print("cold home: " + cold)
def ok(r):
    if not r:
        return "none"
    p, k = r[1].get("passed", 0), r[1].get("failed", 0)
    return "1" if (p + k) and k == 0 else "0"
print("RATES %s %s" % (ok(core), ok(off)))
print("WHY " + "; ".join(why))
PY
)
[ -n "$AB" ] || AB="prod harness: reports unreadable
cold home: -"
A=$(printf '%s\n' "$AB" | sed -n 1p)
B=$(printf '%s\n' "$AB" | sed -n 2p)
RATES=$(printf '%s\n' "$AB" | sed -n 3p)
AWHY=$(printf '%s\n' "$AB" | sed -n 4p | sed 's/^WHY //; s/^WHY$//')

# (c) stats/library served by prod
STATS=$(ytm_curl "$PRD/api/v1/stats/library" -s --max-time 15 2>/dev/null || true)
C=$(printf '%s' "$STATS" | python3 -c '
import json, sys, datetime
try:
    d = json.load(sys.stdin)
except Exception:
    print("library: stats/library unreadable"); sys.exit()
age = "?"
la = d.get("lastAdded") or ""
try:
    t = datetime.datetime.strptime(la, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    age = "%.1f" % ((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 86400)
except Exception:
    pass
print("library: %s tracks / %s albums / %s artists, lastAdded %s d ago, served version %s" % (
    d.get("tracks", "?"), d.get("albums", "?"), d.get("artists", "?"), age, d.get("version", "?")))
' 2>/dev/null)
[ -n "$C" ] || C="library: stats/library unreadable"
SERVED=$(printf '%s' "$STATS" | ytm_json_get version)

# (d) Kuma: only with an API key and configured monitors; the container IP is resolved on every run (never fixed)
D="kuma: n/a (token)"
if [ -z "$YTM_KUMA_MONITORS" ]; then D="kuma: n/a (YTM_KUMA_MONITORS not set)"
elif [ -n "$KUMA_KEY" ]; then
    KIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$YTM_KUMA_CONTAINER" 2>/dev/null | cut -d' ' -f1)
    if [ -n "$KIP" ]; then
      D=$(printf 'user = ":%s"\n' "$(cfgq "$KUMA_KEY")" | curl -s --max-time 10 -K - "http://$KIP:3001/metrics" 2>/dev/null | python3 -c '
import re, sys
want = sys.argv[1].split()
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
    print("kuma: /metrics without a monitor (key refused?)"); sys.exit()
name = {"1": "up", "0": "DOWN", "2": "pending", "3": "maintenance"}
print("kuma: " + ", ".join("%s=%s %s ms" % (i, name.get(st.get(i, ""), "?"), rt.get(i, "?").split(".")[0]) for i in want))
' "$YTM_KUMA_MONITORS" 2>/dev/null)
      [ -n "$D" ] || D="kuma: /metrics unreachable"
    else
      D="kuma: container $YTM_KUMA_CONTAINER not found"
    fi
fi

# Echo access log of the prod container (stdout, one JSON line per request): (e) without token, (f), (j)
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
    win = "logs since %s, %.1f d" % (t0.strftime("%d/%m %H:%M"), (now - t0).total_seconds() / 86400)
else:
    win = "7 d"
priv = sum(1 for i in ips if re.match(r"(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.", i))
print("usage 7 d: %d plays outside the harness (%d harness), %d distinct client IPs of which %d private (proxy of the active profiles: no cookie in the logs) (%s)" % (plays, harness, len(ips), priv, win))
tot = sum(cl.values())
print("client-log: %d posts (7 d) via logs%s (%s)" % (tot, (" (" + ", ".join("http %d=%d" % kv for kv in sorted(cl.items())) + ")") if cl else "", win))
rows = []
for k, v in lat.items():
    if len(v) < 5:
        continue
    v.sort()
    rows.append((v[min(len(v) - 1, int(0.9 * len(v) + 0.999) - 1)], k, len(v)))
rows.sort(reverse=True)
print("slow API (p90): " + (", ".join("%s %s ms (n=%d)" % (k, ("%.0f" % p), n) for p, k, n in rows[:3]) if rows else "fewer than 5 requests per prefix") + " (%s)" % win)
PY
)
STARTED=$(docker inspect -f '{{.State.StartedAt}}' "$YTM_PROD_CONTAINER" 2>/dev/null || true)
ACC=$(timeout 40 docker logs --since 168h "$YTM_PROD_CONTAINER" 2>&1 | python3 -c "$PYACCESS" "$STARTED" 2>/dev/null)
F=$(printf '%s\n' "$ACC" | sed -n 1p)
ELOG=$(printf '%s\n' "$ACC" | sed -n 2p)
J=$(printf '%s\n' "$ACC" | sed -n 3p)
[ -n "$F" ] || F="usage 7 d: access log of $YTM_PROD_CONTAINER unreadable"
[ -n "$J" ] || J="slow API (p90): access log unreadable"

# (e) client error log (decision 15); without the token: POST count in the access log
E=${ELOG:-"client-log: access log unreadable (YTM_ADMIN_TOKEN not set)"}
if [ -n "$ADMIN_TOKEN" ]; then
  # shellcheck disable=SC2046  # resolve rule words
  E=$(printf 'header = "Authorization: Bearer %s"\n' "$(cfgq "$ADMIN_TOKEN")" | curl -s --max-time 15 $(ytm_resolve_args "$PRD") -K - -w '\n%{http_code}' "$PRD/api/v1/client-log?limit=50" 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read().rsplit("\n", 1)
code = raw[1] if len(raw) == 2 else "?"
if code != "200":
    print("client-log: http %s" % code); sys.exit()
try:
    e = json.loads(raw[0]).get("entries") or []
except Exception:
    print("client-log: unreadable answer"); sys.exit()
c = {}
for x in e:
    c[x.get("kind", "?")] = c.get(x.get("kind", "?"), 0) + 1
print("client-log: %d entries of 50 max%s" % (len(e), (" (" + ", ".join("%s=%d" % kv for kv in sorted(c.items())) + ")") if c else ""))
' 2>/dev/null)
  [ -n "$E" ] || E="client-log: read failed"
fi

# (g) acquisition: log of the acquisition container (rich output: ANSI codes removed, messages cut on 2 lines)
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
win = "7 d"
if t0 and t0 > now - datetime.timedelta(days=7):
    win = "logs since %s" % t0.strftime("%d/%m %H:%M")
lt = ts(last)
print("acquisition: %d tracks downloaded, %d already present, %d track failures, %d failed jobs (%s), last download %s" % (
    dl, skip, ftrack, fjob, win, lt.strftime("%Y-%m-%d %H:%M UTC") if lt else "none"))
print("ACQ %d %d" % (dl, ftrack + fjob))
PY
)
G="acquisition: n/a (YTM_ACQ_CONTAINER not set)"; ACQ=""
if [ -n "$YTM_ACQ_CONTAINER" ]; then
  YSTART=$(docker inspect -f '{{.State.StartedAt}}' "$YTM_ACQ_CONTAINER" 2>/dev/null || true)
  GA=$(timeout 40 docker logs -t --since 168h "$YTM_ACQ_CONTAINER" 2>&1 | python3 -c "$PYACQ" "$YSTART" 2>/dev/null)
  G=$(printf '%s\n' "$GA" | sed -n 1p)
  ACQ=$(printf '%s\n' "$GA" | sed -n 2p)
  [ -n "$G" ] || G="acquisition: log of $YTM_ACQ_CONTAINER unreadable"
fi
# c59b (decision 8): today's acquisition requests (UTC, every profile) counted by the server (stats/library
# acquisitionsToday, cap YTM_ACQUIRE_DAILY_CAP per profile and per day, 20 by default)
ACQD=$(printf '%s' "$STATS" | ytm_json_get acquisitionsToday)
[ -n "$ACQD" ] && G="$G, $ACQD acquisition requests today (server cap per profile)"

# (h) disk: library volume (source of the acquisition container's mount, resolved on every run) and YTM_DISK_PATHS
LIB="$YTM_LIBRARY_DIR"
[ -n "$LIB" ] || [ -z "$YTM_ACQ_CONTAINER" ] || LIB=$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$YTM_ACQ_MOUNT\"}}{{.Source}}{{end}}{{end}}" "$YTM_ACQ_CONTAINER" 2>/dev/null)
[ -n "$LIB" ] || LIB="$YTM_DATA_DIR"
# df -P -k: fields 2 = size, 4 = available (KB); output "<human free> <integer free percentage>"
dfree() { timeout 10 df -P -k "$1" 2>/dev/null | awk 'NR == 2 && $2 > 0 { a = $4; u = "KB"; if (a >= 1024) { a /= 1024; u = "MB" } if (a >= 1024) { a /= 1024; u = "GB" } if (a >= 1024) { a /= 1024; u = "TB" } printf "%.1f %s %d\n", a, u, int(100 * $4 / $2) }'; }
fmtdf() { if [ -n "$2" ]; then echo "$1 ${2% *} free (${2##* } %)"; else echo "$1 df without answer in 10 s"; fi; }
DL=$(dfree "$LIB")
H="disk: library $(fmtdf "$LIB" "$DL")"
DISK_WHY=""
[ -z "$DL" ] && DISK_WHY="$DISK_WHY; disk library $LIB: df without answer in 10 s"
[ -n "$DL" ] && [ "${DL##* }" -lt 10 ] && DISK_WHY="$DISK_WHY; disk library $LIB: ${DL##* } % free (< 10 %)"
for p in $YTM_DISK_PATHS; do
  [ "$p" = "$LIB" ] && continue
  DF=$(dfree "$p"); H="$H, $(fmtdf "$p" "$DF")"
  [ -z "$DF" ] && DISK_WHY="$DISK_WHY; disk $p: df without answer in 10 s"
  [ -n "$DF" ] && [ "${DF##* }" -lt 10 ] && DISK_WHY="$DISK_WHY; disk $p: ${DF##* } % free (< 10 %)"
done

# (i) image backups of promote.sh
I=$(find "$YTM_IMAGE_BACKUPS" -maxdepth 1 -name '*.tar.gz' -printf '%s\n' 2>/dev/null | awk '{ n++; s += $1 } END { printf "image backups: %d (%.0f MB)", n, s / 1048576 }')
[ -n "$I" ] || I="image backups: 0"

# (k) retention 7 d (c53a, B9-16): READ-ONLY access to the prod database, only with WEEKLY_DB_RO=1 (monday.sh sets
# it; by hand: WEEKLY_DB_RO=1 WEEKLY_DRY_RUN=1 sh weekly.sh). Formula in the header.
K="retention 7 d: n/a (WEEKLY_DB_RO=1 not set: no database read)"
if [ "${WEEKLY_DB_RO:-}" = 1 ]; then
  DBDIR=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/db"}}{{.Source}}{{end}}{{end}}' "$YTM_PROD_CONTAINER" 2>/dev/null)
  [ -n "$DBDIR" ] || DBDIR="$YTM_DB_DIR"
  FIXF=${HARNESS_FIXTURES:-$YTM_E2E_DIR/fixtures.json}; case "$FIXF" in /*) ;; *) FIXF="$YTM_E2E_DIR/$FIXF" ;; esac
  K=$(timeout 30 python3 - "$DBDIR/beatbump.db" "$FIXF" <<'PY' 2>/dev/null
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
    print("retention 7 d: n/a (database unreadable in ro mode: %s)" % str(e)[:80]); sys.exit()
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
print("retention 7 d: active human profiles %d (D-14..D-7: %d, returning %d); human plays 7 d: %d (median/day %g); last human play: %s; excluded: %d harness or fixture-only profiles out of %d (mode=ro read)" % (
    len(A), len(P), len(A & P), len(plays7), med, last.strftime("%Y-%m-%d %H:%M UTC") if last else "none", len(harness), len(byp)))
PY
)
  [ -n "$K" ] || K="retention 7 d: n/a (ro read failed or database absent: $DBDIR)"
fi

LINE="- $NOW UTC | $A | $B | $C | $D | $E | $F | $G | $H | $I | $J | $K"

# Alert: prod harness < 100 % (or absent), served version != last "PROD = <sha>" of CYCLES.md
WHY=""
# c53a B9-14: full report absent or too old, steps gated for more than a week (4th line of block (a))
[ -z "${AWHY:-}" ] || WHY="$WHY; $AWHY"
case "$RATES" in
  "RATES 1 1") ;;
  RATES*) # shellcheck disable=SC2086
          set -- $RATES; [ "$2" = 1 ] || WHY="$WHY; prod harness core $( [ "$2" = none ] && echo absent || echo '< 100 %')"
          [ "$3" = 1 ] || WHY="$WHY; prod harness offline $( [ "$3" = none ] && echo absent || echo '< 100 %')" ;;
  *) WHY="$WHY; prod harness reports unreadable" ;;
esac
LASTPROD=$(grep -o 'PROD = [0-9a-f]\{7,12\}' "$CYCLES" 2>/dev/null | tail -1 | cut -d' ' -f3)
if [ -z "$SERVED" ]; then WHY="$WHY; served version unreadable"
elif [ -z "$LASTPROD" ]; then WHY="$WHY; no \"PROD = <sha>\" in CYCLES.md"
elif [ "$SERVED" != "$LASTPROD" ]; then WHY="$WHY; served version $SERVED != last PROD = $LASTPROD (CYCLES.md)"
fi
# cycle 41: disk < 10 % free (or hung df), zero acquisition with failures, stats monitor DOWN
WHY="$WHY$DISK_WHY"
case "$ACQ" in
  "ACQ 0 0"|"") ;;
  "ACQ 0 "*) WHY="$WHY; acquisition: 0 track downloaded and ${ACQ##* } failures over the window" ;;
esac
[ -z "$YTM_KUMA_STATS_MONITOR" ] || case "$D" in *"$YTM_KUMA_STATS_MONITOR=DOWN"*) WHY="$WHY; Kuma $YTM_KUMA_STATS_MONITOR (API stats/library) DOWN" ;; esac
WHY=${WHY#; }

if [ "${WEEKLY_DRY_RUN:-}" = 1 ]; then
  echo "$LINE"
  [ -z "$WHY" ] || echo "ALERT (dry-run, ALERT.md not written): $WHY" >&2
else
  mkdir -p "$YTM_PROGRAM_DIR"
  [ -f "$WEEKLY" ] || printf '# WEEKLY (one line per run of ops/weekly.sh; columns in its header)\n' > "$WEEKLY"
  printf '%s\n' "$LINE" >> "$WEEKLY"
  echo "$LINE"
  if [ -n "$WHY" ]; then
    ALERT=$(ytm_alert_file)
    printf '\n## %s UTC (weekly.sh)\n- reasons: %s\n- line: %s\n' "$NOW" "$WHY" "$LINE" >> "$ALERT"
    echo "ALERT: $WHY (-> $ALERT)" >&2
  fi
fi
