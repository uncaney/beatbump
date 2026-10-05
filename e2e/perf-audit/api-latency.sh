#!/bin/sh
# Latence p50/p95 des endpoints API + audio de staging-music.ekaii.fr, DEPUIS la box
# (Traefik 127.0.0.1:443, UA navigateur pour passer le gate). Sequentiel: une seule charge a la fois.
# usage: api-latency.sh [host] [iterations]
H="${1:-staging-music.ekaii.fr}"; N="${2:-7}"
UA="Mozilla/5.0 (Macintosh) Chrome/128"
C="curl -sS --resolve $H:443:127.0.0.1 -A $UA -H Accept-Encoding:gzip,br --compressed"
j() { curl -sS --resolve "$H:443:127.0.0.1" -A "$UA" --compressed "https://$H$1"; }
ids() {
  python3 - "$H" "$UA" <<'PY'
import sys, json, re, urllib.request, ssl
h, ua = sys.argv[1], sys.argv[2]
# curl --resolve equivalent: connect 127.0.0.1 with SNI/Host = h
import http.client
ctx = ssl.create_default_context()
def get(path):
    c = http.client.HTTPSConnection("127.0.0.1", 443, context=ctx, timeout=60)
    c._context.check_hostname = False; c._context.verify_mode = ssl.CERT_NONE
    c.sock = None
    c.connect()
    c.sock = ctx.wrap_socket(c.sock, server_hostname=h) if False else c.sock
    c.putrequest("GET", path); c.putheader("Host", h); c.putheader("User-Agent", ua); c.endheaders()
    r = c.getresponse(); return json.loads(r.read())
PY
}
LOCAL=$(j "/api/v1/local/songs?limit=1")
LID=$(printf '%s' "$LOCAL" | python3 -c '
import sys, json, re
d = json.load(sys.stdin)
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("videoId", "lid") and isinstance(v, str) and re.fullmatch(r"[0-9a-f]{11}", v): yield v
            else: yield from walk(v)
    elif isinstance(o, list):
        for x in o: yield from walk(x)
print(next(walk(d), ""))')
VID=$(j "/api/v1/search.json?q=daft%20punk%20get%20lucky&filter=songs" | python3 -c '
import sys, json, re
d = json.load(sys.stdin)
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "videoId" and isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_-]{11}", v) and not re.fullmatch(r"[0-9a-f]{11}", v): yield v
            else: yield from walk(v)
    elif isinstance(o, list):
        for x in o: yield from walk(x)
print(next(walk(d), ""))')
LPATH=$(j "/api/v1/player.json?videoId=$LID" | python3 -c '
import sys, json
print(json.load(sys.stdin)["streamingData"]["adaptiveFormats"][0]["url"])')
echo "LID=$LID VID=$VID LPATH=$LPATH"

measure() { # label url [extra curl args]
  label="$1"; url="$2"; shift 2
  ts=""; tt=""; sz=""; code=""
  i=0
  while [ "$i" -lt "$N" ]; do
    out=$(curl -sS --resolve "$H:443:127.0.0.1" -A "$UA" -H "Accept-Encoding: gzip, br" --compressed "$@" \
      -o /dev/null -w "%{time_starttransfer} %{time_total} %{size_download} %{http_code}" "https://$H$url")
    ts="$ts $(printf '%s' "$out" | cut -d' ' -f1)"
    tt="$tt $(printf '%s' "$out" | cut -d' ' -f2)"
    sz=$(printf '%s' "$out" | cut -d' ' -f3)
    code=$(printf '%s' "$out" | cut -d' ' -f4)
    i=$((i + 1))
  done
  TS="$ts" TT="$tt" LABEL="$label" SZ="$sz" CODE="$code" python3 -c '
import os
def p(v, q):
    v = sorted(v); k = (len(v) - 1) * q; f = int(k); c = min(f + 1, len(v) - 1); return v[f] + (v[c] - v[f]) * (k - f)
ts = [float(x) * 1000 for x in os.environ["TS"].split()]
tt = [float(x) * 1000 for x in os.environ["TT"].split()]
print("%-26s n=%d code=%s size=%8s  TTFB p50=%7.0f p95=%7.0f  total p50=%7.0f p95=%7.0f ms" % (
    os.environ["LABEL"], len(ts), os.environ["CODE"], os.environ["SZ"], p(ts, .5), p(ts, .95), p(tt, .5), p(tt, .95)))'
}

measure "shell /" "/"
measure "chunk window.js (hls)" "/_app/immutable/chunks/window.e1a32b6c.js"
measure "service-worker.js" "/service-worker.js"
measure "home.json" "/api/v1/home.json"
measure "search.json all" "/api/v1/search.json?q=daft%20punk"
measure "search.json songs" "/api/v1/search.json?q=radiohead&filter=songs"
measure "player.json LOCAL lid" "/api/v1/player.json?videoId=$LID"
measure "player.json YT vid" "/api/v1/player.json?videoId=$VID"
measure "next.json LOCAL lid" "/api/v1/next.json?videoId=$LID"
measure "next.json YT vid" "/api/v1/next.json?videoId=$VID"
measure "local/songs?limit=50" "/api/v1/local/songs?limit=50"
measure "local/albums?limit=50" "/api/v1/local/albums?limit=50"
measure "cover?lid" "/cover?lid=$LID"
measure "localf full file" "$LPATH"
measure "localf Range 0-65535" "$LPATH" -H "Range: bytes=0-65535"
