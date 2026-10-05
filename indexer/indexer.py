"""
ytm-indexer — walk the local music dirs, read tags (mutagen), upsert into Meilisearch.
- tracks index: one doc per file (id=sha1(relpath), lid=id[:11]).
- albums index : one doc per album (id=lb-<hash>) — derived by aggregating tracks.
- artists index: one doc per artist (id=la-<hash>) — derived.
Incremental by mtime. Derived indexes rebuilt (from Meili) whenever new tracks appear.

la-/lb- id recipe is mirrored EXACTLY in the Go backend so item links resolve:
  norm(s)      = lowercase, collapse whitespace
  artist_id(n) = "la-" + sha1(norm(n))[:12]
  album_id(aa,al) = "lb-" + sha1(norm(aa) + "\\x00" + norm(al))[:12]
"""
import os
import json
import time
import re
import hashlib
import urllib.request
import urllib.error

import mutagen

MEILI = os.environ.get("MEILI_URL", "http://meili:7700")
KEY = os.environ.get("MEILI_KEY", "")
ROOT = os.environ.get("MUSIC_ROOT", "/music")
SOURCES = [s.strip() for s in os.environ.get("SOURCES", "ytm").split(",") if s.strip()]
IDX = os.environ.get("INDEX", "tracks")
INTERVAL = int(os.environ.get("SCAN_INTERVAL", "1800"))
BATCH = int(os.environ.get("BATCH", "1000"))
STATE = "/state/index_state.json"
AUDIO = (".opus", ".m4a", ".mp3", ".flac", ".ogg", ".aac", ".wav")


def meili(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MEILI + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + KEY,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read() or b"{}")


def norm(s):
    return " ".join((s or "").lower().split())


def artist_id(name):
    return "la-" + hashlib.sha1(norm(name).encode()).hexdigest()[:12]


def album_id(album_artist, album):
    key = norm(album_artist) + "\x00" + norm(album)
    return "lb-" + hashlib.sha1(key.encode()).hexdigest()[:12]


def ensure_index(uid, settings):
    try:
        meili("GET", f"/indexes/{uid}")
    except urllib.error.HTTPError:
        meili("POST", "/indexes", {"uid": uid, "primaryKey": "id"})
        time.sleep(1)
    meili("PATCH", f"/indexes/{uid}/settings", settings)


def ensure_indexes():
    ensure_index(IDX, {
        "searchableAttributes": ["title", "artist", "albumArtist", "album"],
        "filterableAttributes": ["source", "videoId", "lid", "genre", "album", "albumArtist", "artist", "year", "qualityScore"],
        "sortableAttributes": ["album", "albumArtist", "artist", "year", "dateAdded", "durationSec", "title", "track", "qualityScore"],
        "pagination": {"maxTotalHits": 60000},
    })
    ensure_index("albums", {
        "searchableAttributes": ["album", "albumArtist"],
        "filterableAttributes": ["artistId", "albumArtist", "source"],
        "sortableAttributes": ["album", "albumArtist", "year", "trackCount", "dateAdded"],
        "pagination": {"maxTotalHits": 12000},
    })
    ensure_index("artists", {
        "searchableAttributes": ["name"],
        "filterableAttributes": ["source"],
        "sortableAttributes": ["name", "trackCount", "albumCount", "dateAdded"],
        "pagination": {"maxTotalHits": 3000},
    })


def first(v):
    if isinstance(v, list):
        return v[0] if v else None
    return v


def title_from_name(fn):
    n = os.path.splitext(fn)[0]
    return re.sub(r'^\d{1,3}\s*[-.]\s*', '', n).strip()


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def save_state(s):
    tmp = STATE + ".tmp"
    json.dump(s, open(tmp, "w"))
    os.replace(tmp, STATE)


LOSSLESS_EXT = {"flac", "alac", "wav", "aiff", "aif", "ape", "wv", "m4a"}  # m4a may be ALAC


def quality_score(f, path):
    """0-1000 codec/bitrate/samplerate quality score. FLAC/lossless > high-bitrate
    lossy > low-bitrate/YouTube opus. Drives 'serve the best copy' + upgrade hints."""
    info = getattr(f, "info", None) if f else None
    if not info:
        return 0
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    tname = type(f).__name__
    br = int(getattr(info, "bitrate", 0) or 0)        # bps
    sr = int(getattr(info, "sample_rate", 0) or 0)    # Hz
    bps = int(getattr(info, "bits_per_sample", 0) or 0)
    lossless = "FLAC" in tname or "ALAC" in tname or "WAVE" in tname or "AIFF" in tname or \
        ext in {"flac", "alac", "wav", "aiff", "aif", "ape", "wv"} or bps >= 16
    if lossless:
        score = 700
        if sr >= 88200:
            score += 150
        elif sr >= 48000:
            score += 60
        if bps >= 24:
            score += 150
        elif bps >= 16:
            score += 50
        return min(1000, score)
    kbps = br // 1000
    score = int(kbps * 1.7)  # 320k->544, 256k->435, 160k->272, 128k->217
    if ext == "opus" or "Opus" in tname:
        score += 60  # opus is more efficient per bit
    return max(40, min(660, score))


def build_doc(path, rel, source, mt):
    title = artist = albumartist = album = year = genre = None
    dur = 0
    track = 0
    try:
        f = mutagen.File(path, easy=True)
    except Exception:
        f = None
    if f:
        t = f.tags or {}
        title = first(t.get("title"))
        arts = t.get("artist") or []
        artist = "; ".join(arts) if arts else None
        albumartist = first(t.get("albumartist")) or (arts[0] if arts else None)
        album = first(t.get("album"))
        d = first(t.get("date")) or first(t.get("year"))
        year = str(d)[:4] if d else None
        genre = first(t.get("genre"))
        trk = first(t.get("tracknumber"))
        if trk:
            track = int((re.sub(r'\D', '', str(trk).split('/')[0]) or "0"))
        try:
            dur = int(f.info.length)
        except Exception:
            dur = 0
    fn = os.path.basename(path)
    if not title:
        title = title_from_name(fn)
    mv = re.search(r'\[([A-Za-z0-9_-]{11})\]', fn)
    h = hashlib.sha1(rel.encode()).hexdigest()
    doc = {
        "id": h, "lid": h[:11],
        "title": title, "artist": artist, "albumArtist": albumartist,
        "album": album, "year": year, "genre": genre, "track": track,
        "durationSec": dur, "dateAdded": int(mt),
        "qualityScore": quality_score(f, path),
        "path": rel, "source": source,
    }
    if mv:
        doc["videoId"] = mv.group(1)
    return doc


def scan():
    state = load_state()
    new_state = dict(state)
    batch = []
    stats = {}
    added = 0

    def flush():
        if batch:
            meili("POST", f"/indexes/{IDX}/documents", batch)
            batch.clear()
            save_state(new_state)

    for src in SOURCES:
        base = os.path.join(ROOT, src)
        if not os.path.isdir(base):
            continue
        st = stats.setdefault(src, {"files": 0, "new": 0})
        for root, _dirs, files in os.walk(base):
            for fn in files:
                if not fn.lower().endswith(AUDIO):
                    continue
                p = os.path.join(root, fn)
                try:
                    mt = os.path.getmtime(p)
                except OSError:
                    continue
                rel = os.path.relpath(p, ROOT)
                st["files"] += 1
                if state.get(rel) == mt:
                    continue
                batch.append(build_doc(p, rel, src, mt))
                new_state[rel] = mt
                st["new"] += 1
                if len(batch) >= BATCH:
                    flush()
    flush()
    save_state(new_state)
    added = sum(s["new"] for s in stats.values())
    print("[indexer] coverage:", json.dumps(stats), flush=True)
    return added


def rebuild_derived():
    """Aggregate albums + artists from all `tracks` docs in Meili (disk-free)."""
    albums = {}
    artists = {}
    offset = 0
    while True:
        res = meili("GET", f"/indexes/{IDX}/documents?limit=1000&offset={offset}"
                           "&fields=lid,title,artist,albumArtist,album,year,source,dateAdded")
        docs = res.get("results", [])
        if not docs:
            break
        offset += len(docs)
        for d in docs:
            album = d.get("album")
            aa = d.get("albumArtist") or d.get("artist")
            src = d.get("source") or "local"
            da = d.get("dateAdded") or 0
            if album and aa:
                aid = album_id(aa, album)
                a = albums.get(aid)
                if not a:
                    albums[aid] = {"id": aid, "album": album, "albumArtist": aa,
                                   "artistId": artist_id(aa), "year": d.get("year"),
                                   "trackCount": 1, "coverLid": d.get("lid"),
                                   "source": src, "dateAdded": da}
                else:
                    a["trackCount"] += 1
                    if da > a["dateAdded"]:
                        a["dateAdded"] = da
            if aa:
                rid = artist_id(aa)
                ar = artists.get(rid)
                if not ar:
                    artists[rid] = {"id": rid, "name": aa, "albums": set(), "trackCount": 0,
                                    "source": src, "dateAdded": da}
                artists[rid]["trackCount"] += 1
                if album:
                    artists[rid]["albums"].add(album)
                if da > artists[rid]["dateAdded"]:
                    artists[rid]["dateAdded"] = da
    art_docs = [{"id": a["id"], "name": a["name"], "albumCount": len(a["albums"]),
                 "trackCount": a["trackCount"], "source": a["source"], "dateAdded": a["dateAdded"]}
                for a in artists.values()]
    alb_docs = list(albums.values())
    for i in range(0, len(alb_docs), 5000):
        meili("POST", "/indexes/albums/documents", alb_docs[i:i + 5000])
    for i in range(0, len(art_docs), 5000):
        meili("POST", "/indexes/artists/documents", art_docs[i:i + 5000])
    print(f"[indexer] derived: albums={len(alb_docs)} artists={len(art_docs)}", flush=True)


if __name__ == "__main__":
    ensure_indexes()
    first_pass = True
    while True:
        t0 = time.time()
        try:
            added = scan()
            if added > 0 or first_pass:
                rebuild_derived()
            first_pass = False
        except Exception as e:
            print("[indexer] scan error:", e, flush=True)
        print(f"[indexer] pass done in {int(time.time() - t0)}s", flush=True)
        time.sleep(INTERVAL)
