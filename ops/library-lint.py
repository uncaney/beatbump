#!/usr/bin/env python3
"""library-lint (B7-9, lane c44c): hygiene report of the local library, READ-ONLY, through the public API
of the app. Python 3 stdlib only, no database touched.

    python3 ops/library-lint.py                              # $YTM_STAGING_URL (env.sh), writes $YTM_PROGRAM_DIR/LIBRARY-LINT.md
    python3 ops/library-lint.py --url http://127.0.0.1:8080  # any instance (read-only too)
    python3 ops/library-lint.py --out /tmp/x.md              # another output file

YTM_RESOLVE_IP (ops/env.sh) is honoured for a named host whose hairpin route is broken (SNI + Host kept).

Four sections, each: total + first 30 examples with ids.
  1. albums without a year : GET /local/albums?filter=no-year (exact; an older server without the filter: the
                             common TAIL of both Meili sorts year:asc AND year:desc). Also: total - sum(decades)
                             of /local/mixes (year absent, empty or invalid).
  2. albums without a cover: /local/albums paginated, empty `/cover?lid=` thumbnail (coverLid of the doc); a
                             bounded sample of HEAD /cover?lid= checks the declared covers.
  3. single-album genres    : /local/genres (normalised names, Meili facet bounded to 100 raw values,
                             alphabetical order) then /local/songs?genre= -> distinct albums. Names containing
                             `;` or `/` or starting with `_`. The RAW tag values are not exposed by the public API
                             (normalizeGenres server side): only what survives the normalisation is visible here.
  4. near-duplicate artists : /local/artists paginated, matchNorm (backend/api/local_match.go) reimplemented
                             below: case, accents, "feat.", "&", punctuation.
"""
import argparse
import http.client
import json
import os
import re
import socket
import ssl
import sys
import time
from collections import defaultdict
from urllib.parse import urlsplit

PAGE = 200          # max limit of pag() server side
ALBUM_PAGES_MAX = 60  # 12 000 albums (maxTotalHits of the index)
TAIL_PAGES_MAX = 8    # 1 600 albums without a year at most, beyond: announced bound
COVER_HEAD_SAMPLE = 40
GENRE_PAGES_MAX = 5
EXAMPLES = 30


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- HTTP (explicit SNI + Host)
class Api:
    """Client for one base URL. With resolve_ip, the socket goes to that IP for a named host."""

    def __init__(self, base_url, resolve_ip="", timeout=25):
        u = urlsplit(base_url.rstrip("/") + "/")
        self.secure = u.scheme == "https"
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or (443 if self.secure else 80)
        is_ip = re.fullmatch(r"[\d.]+|[0-9a-fA-F:]+", self.host) is not None
        self.ip = resolve_ip if (resolve_ip and not is_ip) else self.host
        self.timeout = timeout
        self.ctx = ssl._create_unverified_context() if self.secure else None
        self.conn = None
        self.requests = 0
        default_port = 443 if self.secure else 80
        self.host_header = self.host if self.port == default_port else "%s:%d" % (self.host, self.port)

    def _connect(self):
        sock = socket.create_connection((self.ip, self.port), self.timeout)
        if self.secure:
            self.conn = http.client.HTTPSConnection(self.ip, self.port, context=self.ctx, timeout=self.timeout)
            self.conn.sock = self.ctx.wrap_socket(sock, server_hostname=self.host)
        else:
            self.conn = http.client.HTTPConnection(self.ip, self.port, timeout=self.timeout)
            self.conn.sock = sock

    def raw(self, method, path, retries=2):
        last = None
        for attempt in range(retries + 1):
            try:
                if self.conn is None:
                    self._connect()
                self.conn.request(method, path, headers={"Host": self.host_header, "User-Agent": "library-lint/1 (c44c)", "Accept": "application/json"})
                r = self.conn.getresponse()
                body = r.read()
                self.requests += 1
                if r.getheader("Connection", "").lower() == "close":
                    self.conn.close()
                    self.conn = None
                return r.status, body
            except (OSError, http.client.HTTPException) as e:
                last = e
                try:
                    if self.conn:
                        self.conn.close()
                except Exception:
                    pass
                self.conn = None
                time.sleep(0.5 * (attempt + 1))
        raise RuntimeError("%s %s: %s" % (method, path, last))

    def get_json(self, path):
        st, body = self.raw("GET", path)
        if st != 200:
            raise RuntimeError("GET %s -> HTTP %d" % (path, st))
        return json.loads(body.decode("utf-8"))

    def head_status(self, path):
        st, _ = self.raw("HEAD", path, retries=1)
        return st


# ---------------------------------------------------------------- matchNorm (local_match.go) in Python
_ACC = {
    "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "æ": "ae",
    "ç": "c", "è": "e", "é": "e", "ê": "e", "ë": "e",
    "ì": "i", "í": "i", "î": "i", "ï": "i", "ñ": "n",
    "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o", "ø": "o", "œ": "oe",
    "ù": "u", "ú": "u", "û": "u", "ü": "u", "ý": "y", "ÿ": "y", "ß": "ss",
    "\u2019": "'", "\u2018": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-",
}
_EDITION = r"deluxe|remaster(?:ed)?|edition|expanded|anniversary|bonus|special|collector'?s?|super|explicit|clean|reissue"
_CONTENT = r"live|drumless|instrumentals?|acoustic|remix\w*|demos?|karaoke|a ?cappella|acapella|unplugged|orchestral|commentary"
_A = re.ASCII
_bracket_re = re.compile(r"[\(\[\{][^\)\]\}]*\b(?:" + _EDITION + r")\b[^\)\]\}]*[\)\]\}]", _A)
_dash_re = re.compile(r"\s+-\s+[^-]*\b(?:" + _EDITION + r")\b.*$", _A)
_content_re = re.compile(r"\b(?:" + _CONTENT + r")\b", _A)
_feat_re = re.compile(r"[\(\[]?\b(?:feat|ft|featuring)\b\.?.*$", _A)
_nonalnum_re = re.compile(r"[^a-z0-9]+", _A)
_feat_word_re = re.compile(r"\b(?:feat|ft|featuring)\b", _A)


def fold_accents(s):
    return "".join(_ACC.get(ch, ch) for ch in s)


def _drop_packaging(s):
    def keep(m):
        q = m.group(0)
        return q if _content_re.search(q) else " "
    s = _bracket_re.sub(keep, s)
    return _dash_re.sub(keep, s)


def match_norm(s):
    s = fold_accents(s.lower())
    s = _drop_packaging(s)
    s = _feat_re.sub(" ", s)
    s = s.replace("&", " and ").replace("'", "")
    s = _nonalnum_re.sub(" ", s)
    return " ".join(s.split())


# ---------------------------------------------------------------- helpers
def album_row(item):
    sub = item.get("subtitle") or []
    artist = sub[0].get("text", "") if sub else ""
    thumbs = item.get("thumbnails") or []
    url = thumbs[0].get("url", "") if thumbs else ""
    cover = url.split("lid=", 1)[1] if "lid=" in url else ""
    return {"id": item.get("browseId", ""), "title": item.get("title", ""), "artist": artist, "cover": cover}


def q(s):
    from urllib.parse import quote
    return quote(s, safe="")


def md_cell(s, n=60):
    s = str(s).replace("|", "\\|").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "~"


# ---------------------------------------------------------------- sections
def section_year(api, total):
    """Albums without a usable year: GET local/albums?filter=no-year (B8-19, exact, paginated), else (an older
    server answers 400) the common tail of the year:asc and year:desc sorts, which is only meaningful when the
    tail pages do not hold the whole index (a small library would list every album)."""
    rows, pages, off = {}, 0, 0
    while pages < ALBUM_PAGES_MAX:
        st, body = api.raw("GET", "/api/v1/local/albums?filter=no-year&limit=%d&offset=%d" % (PAGE, off))
        if st != 200:
            break
        d = json.loads(body or b"{}")
        pages += 1
        items = d.get("items", [])
        for i in items:
            r = album_row(i)
            rows[r["id"]] = r
        log("  year: no-year filter page %d: %d albums" % (pages, len(items)))
        nxt = d.get("nextOffset")
        if not items or not isinstance(nxt, int) or nxt <= off:
            return sorted(rows.values(), key=lambda r: (r["artist"].lower(), r["title"].lower())), False, pages
        off = nxt
    if pages:
        return sorted(rows.values(), key=lambda r: (r["artist"].lower(), r["title"].lower())), pages >= ALBUM_PAGES_MAX, pages
    missing = {}
    pages = 0
    bounded = False
    for k in range(1, TAIL_PAGES_MAX + 1):
        off, lim = total - PAGE * k, PAGE
        if off < 0:
            lim, off = PAGE + off, 0
        if lim <= 0:
            break
        asc = api.get_json("/api/v1/local/albums?sort=year:asc&limit=%d&offset=%d" % (lim, off))
        desc = api.get_json("/api/v1/local/albums?sort=year:desc&limit=%d&offset=%d" % (lim, off))
        pages += 1
        a = {album_row(i)["id"]: album_row(i) for i in asc.get("items", [])}
        d = {i.get("browseId") for i in desc.get("items", [])}
        inter = [a[i] for i in a if i in d]
        for row in inter:
            missing[row["id"]] = row
        log("  year: tail page %d (offset %d): %d/%d in common" % (k, off, len(inter), len(a)))
        if len(inter) < len(a) or off == 0:
            break
        if k == TAIL_PAGES_MAX:
            bounded = True
    # Documents without the attribute sit at the very end: the tail order is stable, sort by id.
    rows = sorted(missing.values(), key=lambda r: (r["artist"].lower(), r["title"].lower()))
    return rows, bounded, pages


def section_cover(api, total):
    albums = []
    pages = min(ALBUM_PAGES_MAX, (total + PAGE - 1) // PAGE)
    for p in range(pages):
        d = api.get_json("/api/v1/local/albums?sort=albumArtist:asc&limit=%d&offset=%d" % (PAGE, p * PAGE))
        items = d.get("items", [])
        albums.extend(album_row(i) for i in items)
        if p % 5 == 0 or p == pages - 1:
            log("  covers: page %d/%d (%d albums)" % (p + 1, pages, len(albums)))
        if len(items) < PAGE:
            break
    seen = set()
    uniq = []
    for a in albums:
        if a["id"] and a["id"] not in seen:
            seen.add(a["id"])
            uniq.append(a)
    without = [a for a in uniq if not a["cover"]]
    # Bounded sample: do the declared covers answer 200?
    sample, done = [], set()
    for a in uniq:
        if a["cover"] and a["cover"] not in done:
            done.add(a["cover"])
            sample.append(a)
        if len(sample) >= COVER_HEAD_SAMPLE:
            break
    broken = []
    for a in sample:
        st = api.head_status("/cover?lid=" + q(a["cover"]))
        if st != 200:
            broken.append((a, st))
    log("  covers: %d albums read, %d without coverLid, HEAD sample %d -> %d not 200" % (len(uniq), len(without), len(sample), len(broken)))
    return uniq, without, sample, broken


def section_genres(api):
    g = api.get_json("/api/v1/local/genres").get("genres", [])
    names = [(x.get("name", ""), int(x.get("count", 0) or 0)) for x in g if x.get("name")]
    odd = [n for n, _ in names if ";" in n or "/" in n or n.startswith("_")]
    single, empty = [], []
    for i, (name, cnt) in enumerate(names):
        albums = {}
        total = 0
        for p in range(GENRE_PAGES_MAX):
            d = api.get_json("/api/v1/local/songs?genre=%s&limit=%d&offset=%d" % (q(name), PAGE, p * PAGE))
            items = d.get("items", [])
            total = int(d.get("total", 0) or 0)
            for it in items:
                al = it.get("album") or {}
                bid = (al.get("browseId") or "").split(".", 1)[0]
                if bid:
                    albums.setdefault(bid, al.get("text", ""))
            if len(albums) > 1 or len(items) < PAGE or (p + 1) * PAGE >= total:
                break
        if total == 0:
            empty.append((name, cnt))
        elif len(albums) == 1:
            bid, title = next(iter(albums.items()))
            single.append({"genre": name, "tracks": total, "album": bid, "title": title})
        if (i + 1) % 20 == 0 or i + 1 == len(names):
            log("  genres: %d/%d examined, %d with a single album" % (i + 1, len(names), len(single)))
    single.sort(key=lambda r: (r["tracks"], r["genre"].lower()))
    return names, odd, single, empty


def section_artists(api):
    arts = []
    off = 0
    while True:
        d = api.get_json("/api/v1/local/artists?sort=name:asc&limit=%d&offset=%d" % (PAGE, off))
        items = d.get("items", [])
        for it in items:
            arts.append({"id": it.get("browseId", ""), "name": it.get("title", "")})
        off += PAGE
        total = int(d.get("total", 0) or 0)
        log("  artists: %d/%d" % (min(off, total), total))
        if len(items) < PAGE or off >= total or off >= 12000:
            break
    groups = defaultdict(list)
    for a in arts:
        if not a["id"]:
            continue
        k = match_norm(a["name"])
        if k:
            groups[k].append(a)
    dup = []
    for k, members in groups.items():
        names = sorted({m["name"] for m in members})
        if len(names) < 2:
            continue
        lower = {n.lower() for n in names}
        folded = {fold_accents(n.lower()) for n in names}
        if any(_feat_word_re.search(fold_accents(n.lower())) for n in names):
            why = "feat."
        elif len(lower) == 1:
            why = "case"
        elif len(folded) == 1:
            why = "accents"
        else:
            why = "punctuation / &"
        dup.append({"key": k, "why": why, "members": sorted(members, key=lambda m: m["name"])})
    dup.sort(key=lambda g: (-len(g["members"]), g["key"]))
    return arts, dup


# ---------------------------------------------------------------- report
def write_report(path, ctx):
    L = []
    w = L.append
    w("# LIBRARY-LINT: hygiene of the local library (B7-9, lane c44c)")
    w("")
    w("Generated on %s UTC by `ops/library-lint.py` against `%s` (served version `%s`), read-only through the public API, %d requests in %.1f s."
      % (ctx["when"], ctx["url"], ctx["version"], ctx["requests"], ctx["elapsed"]))
    w("Library: %d tracks, %d albums, %d artists (stats/library)." % (ctx["tracks"], ctx["albums_total"], ctx["artists_total"]))
    w("")
    w("| Section | Total |")
    w("|---|---|")
    w("| 1. albums without a year | %s |" % ctx["year_count_txt"])
    w("| 2. albums without a cover (empty `coverLid`) | %d |" % len(ctx["without_cover"]))
    w("| 3. single-album genres | %d (of %d exposed names) |" % (len(ctx["single"]), len(ctx["genre_names"])))
    w("| 4. near-duplicate artist groups | %d groups, %d names |" % (len(ctx["dup"]), sum(len(g["members"]) for g in ctx["dup"])))
    w("")

    # 1
    rows, bounded = ctx["year_rows"], ctx["year_bounded"]
    w("## 1. Albums without a year")
    w("")
    w("Method: `GET /api/v1/local/albums?filter=no-year` (%d page(s) of %d read; on an older server without the filter, the common tail of the `year:asc` and `year:desc` sorts)%s."
      % (ctx["year_pages"], PAGE, "; BOUND reached, the total is a minimum" if bounded else ""))
    w("Cross-check with `/local/mixes`: %d albums in total - %d albums counted in a listed decade = **%d** albums whose year is absent, empty or invalid (`yearOf` = 0), or whose decade holds fewer than 15 albums (not listed: on a small library this is an upper bound)."
      % (ctx["albums_total"], ctx["decade_sum"], ctx["albums_total"] - ctx["decade_sum"]))
    w("")
    w("Total: **%d**%s" % (len(rows), " (minimum)" if bounded else ""))
    w("")
    w("| # | id | album | artist |")
    w("|---|---|---|---|")
    for i, r in enumerate(rows[:EXAMPLES], 1):
        w("| %d | `%s` | %s | %s |" % (i, r["id"], md_cell(r["title"]), md_cell(r["artist"], 40)))
    w("")

    # 2
    w("## 2. Albums without a cover")
    w("")
    w("Method: `/local/albums` paginated (%d distinct albums read), empty `/cover?lid=` thumbnail = the album has no `coverLid` (no track with an embedded cover at indexing time)."
      % len(ctx["albums"]))
    w("Verification sample: HEAD `/cover?lid=` on %d distinct declared covers -> %d answer(s) other than 200%s."
      % (len(ctx["cover_sample"]), len(ctx["cover_broken"]), (": " + ", ".join("`%s` (%s, HTTP %s)" % (a["cover"], md_cell(a["title"], 30), st) for a, st in ctx["cover_broken"][:10])) if ctx["cover_broken"] else ""))
    w("")
    w("Total: **%d**" % len(ctx["without_cover"]))
    w("")
    w("| # | id | album | artist |")
    w("|---|---|---|---|")
    for i, r in enumerate(ctx["without_cover"][:EXAMPLES], 1):
        w("| %d | `%s` | %s | %s |" % (i, r["id"], md_cell(r["title"]), md_cell(r["artist"], 40)))
    w("")

    # 3
    names, odd, single, empty = ctx["genre_names"], ctx["genre_odd"], ctx["single"], ctx["genre_empty"]
    w("## 3. Single-album genres")
    w("")
    w("Method: `/local/genres` exposes %d normalised names (Meili facet bounded to the first 100 raw values in alphabetical order: last name `%s`, the genres beyond are not visible through the public API); for each name, `/local/songs?genre=` -> distinct albums."
      % (len(names), names[-1][0] if names else ""))
    w("Served names containing `;` or `/` or starting with `_`: %d%s. The RAW tag values (`Acoustic Rock;Blues Rock`, `bossa nova/samba`, `_Soundtrack`) are already split and filtered by `normalizeGenres` server side: not observable here, this count only covers what survives the normalisation."
      % (len(odd), (": " + ", ".join("`%s`" % n for n in odd[:EXAMPLES])) if odd else ""))
    if empty:
        w("Names whose `songs?genre=` filter returns no track: %d (%s)." % (len(empty), ", ".join("`%s`" % n for n, _ in empty[:10])))
    w("")
    w("Total: **%d**" % len(single))
    w("")
    w("| # | genre | tracks | album (id) | title |")
    w("|---|---|---|---|---|")
    for i, r in enumerate(single[:EXAMPLES], 1):
        w("| %d | %s | %d | `%s` | %s |" % (i, md_cell(r["genre"], 40), r["tracks"], r["album"], md_cell(r["title"], 50)))
    w("")

    # 4
    dup = ctx["dup"]
    w("## 4. Artists that only differ by case, accents or \"feat.\"")
    w("")
    w("Method: `/local/artists` paginated (%d artists), `matchNorm` of `backend/api/local_match.go` reimplemented (lower case, folded accents, edition qualifiers, `feat./ft.` tail, `&` -> `and`, punctuation); a group = several distinct names with the same normalised form. Reason: `feat.` when a name carries a feat. tail, else `case`, `accents`, `punctuation / &`."
      % len(ctx["artists"]))
    w("")
    w("Total: **%d** groups (%d names)" % (len(dup), sum(len(g["members"]) for g in dup)))
    w("")
    w("| # | normalised form | reason | names (id) |")
    w("|---|---|---|---|")
    for i, g in enumerate(dup[:EXAMPLES], 1):
        mem = ", ".join("%s (`%s`)" % (md_cell(m["name"], 45), m["id"]) for m in g["members"][:6])
        if len(g["members"]) > 6:
            mem += ", +%d" % (len(g["members"]) - 6)
        w("| %d | %s | %s | %s |" % (i, md_cell(g["key"], 40), g["why"], mem))
    w("")
    w("No write: this report changes neither the database, nor the index, nor the files. Run again: `python3 ops/library-lint.py` on the host.")
    w("")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    os.replace(tmp, path)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    program = os.environ.get("YTM_PROGRAM_DIR") or os.path.join(here, "program")
    default_out = os.path.join(program, "LIBRARY-LINT.md")
    ap = argparse.ArgumentParser(description="hygiene report of the local library (read-only, public API)")
    ap.add_argument("--url", default=os.environ.get("YTM_STAGING_URL") or "http://127.0.0.1:8081", help="base URL of the instance (default $YTM_STAGING_URL)")
    ap.add_argument("--resolve-ip", default=os.environ.get("YTM_RESOLVE_IP", ""), help="connect to this IP for a named host (SNI and Host kept); default $YTM_RESOLVE_IP")
    ap.add_argument("--out", default=default_out)
    args = ap.parse_args()

    t0 = time.time()
    api = Api(args.url, args.resolve_ip)
    log("library-lint: %s via %s:%d" % (args.url, api.ip, api.port))
    stats = api.get_json("/api/v1/stats/library")
    albums_total = int(stats.get("albums", 0) or 0)
    log("stats: %s" % json.dumps(stats))
    if albums_total <= 0:
        log("no album in stats/library: stop")
        return 2

    log("1/4 albums without a year")
    mixes = api.get_json("/api/v1/local/mixes")
    decade_sum = sum(int(d.get("albums", 0) or 0) for d in mixes.get("decades", []))
    year_rows, year_bounded, year_pages = section_year(api, albums_total)
    log("2/4 albums without a cover")
    albums, without_cover, cover_sample, cover_broken = section_cover(api, albums_total)
    log("3/4 genres")
    genre_names, genre_odd, single, genre_empty = section_genres(api)
    log("4/4 artists")
    artists, dup = section_artists(api)

    elapsed = time.time() - t0
    ctx = {
        "when": time.strftime("%Y-%m-%d %H:%M", time.gmtime()), "url": args.url.rstrip("/"), "version": stats.get("version", "?"),
        "tracks": int(stats.get("tracks", 0) or 0), "albums_total": albums_total, "artists_total": int(stats.get("artists", 0) or 0),
        "requests": api.requests, "elapsed": elapsed,
        "year_rows": year_rows, "year_bounded": year_bounded, "year_pages": year_pages, "decade_sum": decade_sum,
        "year_count_txt": ("%d" % len(year_rows)) + (" (minimum, bounded)" if year_bounded else "") + "; %d with an absent/empty/invalid year (mixes)" % (albums_total - decade_sum),
        "albums": albums, "without_cover": without_cover, "cover_sample": cover_sample, "cover_broken": cover_broken,
        "genre_names": genre_names, "genre_odd": genre_odd, "single": single, "genre_empty": genre_empty,
        "artists": artists, "dup": dup,
    }
    write_report(args.out, ctx)
    print("LINT %s: no year %d (mixes %d), no cover %d, single-album genres %d/%d, near-duplicate artists %d groups; %d requests, %.1f s -> %s"
          % (args.url, len(year_rows), albums_total - decade_sum, len(without_cover), len(single), len(genre_names), len(dup), api.requests, elapsed, args.out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except RuntimeError as e:
        log("ERROR: %s" % e)
        sys.exit(1)
