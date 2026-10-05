#!/usr/bin/env python3
"""library-lint (B7-9, lane c44c): rapport d hygiene de la bibliotheque locale, LECTURE SEULE,
par l API publique de l app (staging par defaut). Python 3 stdlib uniquement, aucune base touchee.

    python3 library-lint.py                       # staging, ecrit program/LIBRARY-LINT.md
    python3 library-lint.py --out /tmp/x.md       # autre sortie
    python3 library-lint.py --host music.ekaii.fr # prod (lecture seule aussi)

Quatre sections, chacune : total + 30 premiers exemples avec ids.
  1. albums sans annee     : les docs sans attribut `year` sont en QUEUE des deux tris Meili
                             (year:asc ET year:desc) : l intersection des pages de queue les
                             identifie exactement. En plus : total - somme(decennies) de
                             /local/mixes (annee absente, vide ou invalide).
  2. albums sans pochette  : /local/albums pagine, miniature `/cover?lid=` vide (coverLid du doc) ;
                             un echantillon borne de HEAD /cover?lid= verifie les pochettes declarees.
  3. genres a un seul album: /local/genres (noms normalises, facette Meili bornee a 100 valeurs
                             brutes, ordre alphabetique) puis /local/songs?genre= -> albums distincts.
                             Noms contenant `;` ou `/` ou commencant par `_`. Les valeurs BRUTES
                             des tags ne sont pas exposees par l API publique (normalizeGenres cote
                             serveur) : seul ce qui survit a la normalisation est visible ici.
  4. artistes quasi-doublons : /local/artists pagine, matchNorm (backend/api/local_match.go)
                             reimplemente ci-dessous : casse, accents, "feat.", "&", ponctuation.
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

PAGE = 200          # limite max de pag() cote serveur
ALBUM_PAGES_MAX = 60  # 12 000 albums (maxTotalHits de l index)
TAIL_PAGES_MAX = 8    # 1 600 albums sans annee au plus, au dela : borne annoncee
COVER_HEAD_SAMPLE = 40
GENRE_PAGES_MAX = 5
EXAMPLES = 30


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- HTTP (SNI + Host explicites)
class Api:
    def __init__(self, host, ip, port, timeout=25):
        self.host, self.ip, self.port, self.timeout = host, ip, port, timeout
        self.ctx = ssl._create_unverified_context()
        self.conn = None
        self.requests = 0

    def _connect(self):
        sock = socket.create_connection((self.ip, self.port), self.timeout)
        self.conn = http.client.HTTPSConnection(self.ip, self.port, context=self.ctx, timeout=self.timeout)
        self.conn.sock = self.ctx.wrap_socket(sock, server_hostname=self.host)

    def raw(self, method, path, retries=2):
        last = None
        for attempt in range(retries + 1):
            try:
                if self.conn is None:
                    self._connect()
                self.conn.request(method, path, headers={"Host": self.host, "User-Agent": "library-lint/1 (c44c)", "Accept": "application/json"})
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
        raise RuntimeError("%s %s : %s" % (method, path, last))

    def get_json(self, path):
        st, body = self.raw("GET", path)
        if st != 200:
            raise RuntimeError("GET %s -> HTTP %d" % (path, st))
        return json.loads(body.decode("utf-8"))

    def head_status(self, path):
        st, _ = self.raw("HEAD", path, retries=1)
        return st


# ---------------------------------------------------------------- matchNorm (local_match.go) en Python
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
    """Albums sans attribut year : queue commune des tris year:asc et year:desc."""
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
        log("  annee : page de queue %d (offset %d) : %d/%d communs" % (k, off, len(inter), len(a)))
        if len(inter) < len(a) or off == 0:
            break
        if k == TAIL_PAGES_MAX:
            bounded = True
    # Les docs sans attribut sont en toute fin : l ordre de queue est stable, on classe par id.
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
            log("  pochettes : page %d/%d (%d albums)" % (p + 1, pages, len(albums)))
        if len(items) < PAGE:
            break
    seen = set()
    uniq = []
    for a in albums:
        if a["id"] and a["id"] not in seen:
            seen.add(a["id"])
            uniq.append(a)
    without = [a for a in uniq if not a["cover"]]
    # Echantillon borne : les pochettes declarees repondent-elles 200 ?
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
    log("  pochettes : %d albums lus, %d sans coverLid, HEAD echantillon %d -> %d non 200" % (len(uniq), len(without), len(sample), len(broken)))
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
            log("  genres : %d/%d examines, %d a un seul album" % (i + 1, len(names), len(single)))
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
        log("  artistes : %d/%d" % (min(off, total), total))
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
            why = "casse"
        elif len(folded) == 1:
            why = "accents"
        else:
            why = "ponctuation / &"
        dup.append({"key": k, "why": why, "members": sorted(members, key=lambda m: m["name"])})
    dup.sort(key=lambda g: (-len(g["members"]), g["key"]))
    return arts, dup


# ---------------------------------------------------------------- rapport
def write_report(path, ctx):
    L = []
    w = L.append
    w("# LIBRARY-LINT : hygiene de la bibliotheque locale (B7-9, lane c44c)")
    w("")
    w("Genere le %s UTC par `agents/ops/library-lint.py` contre `https://%s` (version servie `%s`), lecture seule par l API publique, %d requetes en %.1f s."
      % (ctx["when"], ctx["host"], ctx["version"], ctx["requests"], ctx["elapsed"]))
    w("Bibliotheque : %d pistes, %d albums, %d artistes (stats/library)." % (ctx["tracks"], ctx["albums_total"], ctx["artists_total"]))
    w("")
    w("| Section | Total |")
    w("|---|---|")
    w("| 1. albums sans annee (attribut `year` absent) | %s |" % ctx["year_count_txt"])
    w("| 2. albums sans pochette (`coverLid` vide) | %d |" % len(ctx["without_cover"]))
    w("| 3. genres a un seul album | %d (sur %d noms exposes) |" % (len(ctx["single"]), len(ctx["genre_names"])))
    w("| 4. groupes d artistes quasi-doublons | %d groupes, %d noms |" % (len(ctx["dup"]), sum(len(g["members"]) for g in ctx["dup"])))
    w("")

    # 1
    rows, bounded = ctx["year_rows"], ctx["year_bounded"]
    w("## 1. Albums sans annee")
    w("")
    w("Methode : Meili place les documents SANS attribut `year` en queue des deux tris `year:asc` et `year:desc` ; l intersection des pages de queue (%d page(s) de %d lues) les identifie exactement%s."
      % (ctx["year_pages"], PAGE, " ; BORNE atteinte (%d pages), le total est un minimum" % TAIL_PAGES_MAX if bounded else ""))
    w("Recoupement `/local/mixes` : %d albums au total - %d albums comptes dans une decennie = **%d** albums dont l annee est absente, vide ou invalide (`yearOf` = 0)."
      % (ctx["albums_total"], ctx["decade_sum"], ctx["albums_total"] - ctx["decade_sum"]))
    w("")
    w("Total (attribut absent) : **%d**%s" % (len(rows), " (minimum)" if bounded else ""))
    w("")
    w("| # | id | album | artiste |")
    w("|---|---|---|---|")
    for i, r in enumerate(rows[:EXAMPLES], 1):
        w("| %d | `%s` | %s | %s |" % (i, r["id"], md_cell(r["title"]), md_cell(r["artist"], 40)))
    w("")

    # 2
    w("## 2. Albums sans pochette")
    w("")
    w("Methode : `/local/albums` pagine (%d albums distincts lus), miniature `/cover?lid=` vide = l album n a pas de `coverLid` (aucune piste avec pochette integree a l indexation)."
      % len(ctx["albums"]))
    w("Echantillon de verification : HEAD `/cover?lid=` sur %d pochettes declarees distinctes -> %d reponse(s) autre(s) que 200%s."
      % (len(ctx["cover_sample"]), len(ctx["cover_broken"]), (" : " + ", ".join("`%s` (%s, HTTP %s)" % (a["cover"], md_cell(a["title"], 30), st) for a, st in ctx["cover_broken"][:10])) if ctx["cover_broken"] else ""))
    w("")
    w("Total : **%d**" % len(ctx["without_cover"]))
    w("")
    w("| # | id | album | artiste |")
    w("|---|---|---|---|")
    for i, r in enumerate(ctx["without_cover"][:EXAMPLES], 1):
        w("| %d | `%s` | %s | %s |" % (i, r["id"], md_cell(r["title"]), md_cell(r["artist"], 40)))
    w("")

    # 3
    names, odd, single, empty = ctx["genre_names"], ctx["genre_odd"], ctx["single"], ctx["genre_empty"]
    w("## 3. Genres a un seul album")
    w("")
    w("Methode : `/local/genres` expose %d noms normalises (facette Meili bornee aux 100 premieres valeurs brutes par ordre alphabetique : dernier nom `%s`, les genres au-dela ne sont pas visibles par l API publique) ; pour chaque nom, `/local/songs?genre=` -> albums distincts."
      % (len(names), names[-1][0] if names else ""))
    w("Noms servis contenant `;` ou `/` ou commencant par `_` : %d%s. Les valeurs brutes des tags (`Acoustic Rock;Blues Rock`, `bossa nova/samba`, `_Soundtrack`) sont deja decoupees et filtrees par `normalizeGenres` cote serveur : non observables ici, ce compte ne porte que sur ce qui survit a la normalisation."
      % (len(odd), (" : " + ", ".join("`%s`" % n for n in odd[:EXAMPLES])) if odd else ""))
    if empty:
        w("Noms dont le filtre `songs?genre=` ne renvoie aucune piste : %d (%s)." % (len(empty), ", ".join("`%s`" % n for n, _ in empty[:10])))
    w("")
    w("Total : **%d**" % len(single))
    w("")
    w("| # | genre | pistes | album (id) | titre |")
    w("|---|---|---|---|---|")
    for i, r in enumerate(single[:EXAMPLES], 1):
        w("| %d | %s | %d | `%s` | %s |" % (i, md_cell(r["genre"], 40), r["tracks"], r["album"], md_cell(r["title"], 50)))
    w("")

    # 4
    dup = ctx["dup"]
    w("## 4. Artistes qui ne different que par la casse, les accents ou \"feat.\"")
    w("")
    w("Methode : `/local/artists` pagine (%d artistes), `matchNorm` de `backend/api/local_match.go` reimplemente (minuscules, accents replies, qualificatifs d edition, queue `feat./ft.`, `&` -> `and`, ponctuation) ; un groupe = plusieurs noms distincts avec la meme forme normalisee. Motif : `feat.` si un nom porte une queue feat., sinon `casse`, `accents`, `ponctuation / &`."
      % len(ctx["artists"]))
    w("")
    w("Total : **%d** groupes (%d noms)" % (len(dup), sum(len(g["members"]) for g in dup)))
    w("")
    w("| # | forme normalisee | motif | noms (id) |")
    w("|---|---|---|---|")
    for i, g in enumerate(dup[:EXAMPLES], 1):
        mem = ", ".join("%s (`%s`)" % (md_cell(m["name"], 45), m["id"]) for m in g["members"][:6])
        if len(g["members"]) > 6:
            mem += ", +%d" % (len(g["members"]) - 6)
        w("| %d | %s | %s | %s |" % (i, md_cell(g["key"], 40), g["why"], mem))
    w("")
    w("Aucune ecriture : ce rapport ne modifie ni la base, ni l index, ni les fichiers. Relancer : `python3 agents/ops/library-lint.py` sur la box.")
    w("")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    os.replace(tmp, path)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.normpath(os.path.join(here, "..", "program", "LIBRARY-LINT.md"))
    ap = argparse.ArgumentParser(description="rapport d hygiene de la bibliotheque (lecture seule, API publique)")
    ap.add_argument("--host", default="staging-music.ekaii.fr")
    ap.add_argument("--ip", default="127.0.0.1", help="adresse joignable (Traefik local) ; SNI et Host = --host")
    ap.add_argument("--port", type=int, default=443)
    ap.add_argument("--out", default=default_out)
    args = ap.parse_args()

    t0 = time.time()
    api = Api(args.host, args.ip, args.port)
    log("library-lint : %s via %s:%d" % (args.host, args.ip, args.port))
    stats = api.get_json("/api/v1/stats/library")
    albums_total = int(stats.get("albums", 0) or 0)
    log("stats : %s" % json.dumps(stats))
    if albums_total <= 0:
        log("aucun album dans stats/library : arret")
        return 2

    log("1/4 albums sans annee")
    mixes = api.get_json("/api/v1/local/mixes")
    decade_sum = sum(int(d.get("albums", 0) or 0) for d in mixes.get("decades", []))
    year_rows, year_bounded, year_pages = section_year(api, albums_total)
    log("2/4 albums sans pochette")
    albums, without_cover, cover_sample, cover_broken = section_cover(api, albums_total)
    log("3/4 genres")
    genre_names, genre_odd, single, genre_empty = section_genres(api)
    log("4/4 artistes")
    artists, dup = section_artists(api)

    elapsed = time.time() - t0
    ctx = {
        "when": time.strftime("%Y-%m-%d %H:%M", time.gmtime()), "host": args.host, "version": stats.get("version", "?"),
        "tracks": int(stats.get("tracks", 0) or 0), "albums_total": albums_total, "artists_total": int(stats.get("artists", 0) or 0),
        "requests": api.requests, "elapsed": elapsed,
        "year_rows": year_rows, "year_bounded": year_bounded, "year_pages": year_pages, "decade_sum": decade_sum,
        "year_count_txt": ("%d" % len(year_rows)) + (" (minimum, borne)" if year_bounded else "") + " ; %d avec annee absente/vide/invalide (mixes)" % (albums_total - decade_sum),
        "albums": albums, "without_cover": without_cover, "cover_sample": cover_sample, "cover_broken": cover_broken,
        "genre_names": genre_names, "genre_odd": genre_odd, "single": single, "genre_empty": genre_empty,
        "artists": artists, "dup": dup,
    }
    write_report(args.out, ctx)
    print("LINT %s : sans annee %d (mixes %d), sans pochette %d, genres 1 album %d/%d, artistes quasi-doublons %d groupes ; %d requetes, %.1f s -> %s"
          % (args.host, len(year_rows), albums_total - decade_sum, len(without_cover), len(single), len(genre_names), len(dup), api.requests, elapsed, args.out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except RuntimeError as e:
        log("ERREUR : %s" % e)
        sys.exit(1)
