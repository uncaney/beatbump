#!/usr/bin/env python3
# Mine Echo JSON access logs (docker logs <ctr> --since N) -> p50/p95/p99 latency per route.
# usage: docker logs --since 168h <app container> 2>&1 | python3 log-latency.py [--all | --bots]
#
# c50a (PF5-8): by default the lines that are not a human are left out and
# counted per class on stderr:
#   healthcheck  `beat-server -healthcheck` (healthcheck.go): 127.0.0.1 / ::1 with the
#                Go-http-client UA, one GET /api/v1/stats/library every 30 s
#   kuma         Uptime-Kuma monitors (/, stats/library, player.json every 5 min)
#   harness      Playwright (HeadlessChrome), ytm-harness-*, ytm-smoke, ytm-perf,
#                perf*-audit, the fixture UAs "Mozilla/5.0 (Macintosh) Chrome/128" and
#                "Mozilla/5.0 (X11; Linux x86_64) Chrome/126" (harness-core.cjs), the
#                iPhone UA of ux-audit/shots.cjs (exact string; a real iPhone on that
#                exact Safari 17.5 build would be excluded too)
#   probe        curl, python (api-latency.sh, ad hoc probes)
# --all keeps everything (the pre-c50a behaviour), --bots keeps ONLY the excluded
# classes (to measure the harness itself). Robots of link previews (WhatsApp,
# Twitterbot, facebookexternalhit) are real traffic and stay in.
#
# The H/S/M and hit% columns read the "cache" field the Echo logger writes since
# PF5-8 (X-Ytm-Cache: HIT / STALE / MISS; BYPASS is not counted); "-" while no
# line of the route carries it (journal of an image older than c50a).
import json
import re
import statistics
import sys
from collections import Counter, defaultdict

MODE = "human"
if "--all" in sys.argv[1:]:
    MODE = "all"
elif "--bots" in sys.argv[1:]:
    MODE = "bots"

HARNESS_UA = re.compile(
    r"HeadlessChrome|ytm-harness|ytm-smoke|ytm-perf|perf\d*-audit"
    r"|^Mozilla/5\.0 \((Macintosh|X11; Linux x86_64)\) Chrome/\d+( |$)",
)
PROBE_UA = re.compile(r"^curl/|python", re.I)
UX_AUDIT_IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
                      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")


def klass(j):
    """'' for a human, else the exclusion class of the line."""
    ua = j.get("user_agent", "") or ""
    ip = j.get("remote_ip", "") or ""
    if ip in ("127.0.0.1", "::1") and ua.startswith("Go-http-client"):
        return "healthcheck"
    if "Uptime-Kuma" in ua:
        return "kuma"
    if HARNESS_UA.search(ua) or ua == UX_AUDIT_IPHONE_UA:
        return "harness"
    if PROBE_UA.search(ua):
        return "probe"
    return ""


rows = defaultdict(list)
bytes_out = defaultdict(list)
cache = defaultdict(Counter)
excluded = Counter()
total = kept = 0
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        j = json.loads(line)
    except Exception:
        continue
    total += 1
    k = klass(j)
    if MODE == "human" and k:
        excluded[k] += 1
        continue
    if MODE == "bots" and not k:
        excluded["human"] += 1
        continue
    kept += 1
    uri = j.get("uri", "").split("?")[0]
    if uri.startswith("/_app/"):
        uri = "/_app/*"
    if uri.startswith("/aud/"):
        uri = "/aud/*"
    if uri.startswith("/api/v1/local/"):
        uri = "/api/v1/local/*"
    if uri.startswith("/api/v1/artist/"):
        uri = "/api/v1/artist/*"
    if uri.startswith("/api/v1/me/"):
        uri = "/api/v1/me/*"
    if uri == "/" and k == "kuma":
        uri = "/ (kuma)"
    rows[uri].append(j.get("latency", 0) / 1e6)  # ns -> ms
    bytes_out[uri].append(j.get("bytes_out", 0))
    v = (j.get("cache") or "").upper()
    if v in ("HIT", "STALE", "MISS"):
        cache[uri][v] += 1


def pct(v, p):
    v = sorted(v)
    k = (len(v) - 1) * p
    f = int(k)
    c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)


def cache_cols(uri):
    c = cache.get(uri)
    if not c:
        return "-", "-"
    h, s, m = c["HIT"], c["STALE"], c["MISS"]
    return "%d/%d/%d" % (h, s, m), "%.0f" % (100.0 * (h + s) / (h + s + m))


print("%-34s %6s %9s %9s %9s %9s %9s %12s %5s" % ("route", "n", "p50ms", "p95ms", "p99ms", "max", "medBytes", "H/S/M", "hit%"))
for uri, v in sorted(rows.items(), key=lambda x: -len(x[1])):
    hsm, ratio = cache_cols(uri)
    print("%-34s %6d %9.1f %9.1f %9.1f %9.1f %9.0f %12s %5s" % (
        uri, len(v), pct(v, .5), pct(v, .95), pct(v, .99), max(v), statistics.median(bytes_out[uri]), hsm, ratio))
if MODE == "human":
    sys.stderr.write("log-latency: %d lines, %d kept, excluded %s (--all keeps everything, --bots keeps only these)\n" % (
        total, kept, ", ".join("%s %d" % kv for kv in sorted(excluded.items())) or "none"))
else:
    sys.stderr.write("log-latency (%s): %d lines, %d kept, left out %s\n" % (
        MODE, total, kept, ", ".join("%s %d" % kv for kv in sorted(excluded.items())) or "none"))
