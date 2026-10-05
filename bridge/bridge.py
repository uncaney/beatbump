"""
ytm-cache — auto-cache bridge, residential audio proxy, and LOCAL-FIRST server.

Local-first (cross-collection): at play time the bridge knows the track's
title+artist; it asks Meilisearch (which indexes the whole local library:
ytm/ytmusic/lidarr/soulseek) for a confident match and, if found, serves that
file straight from disk (/localf?p=<relpath>). Otherwise it proxies the live
stream through the residential gost and enqueues a Yubal download so next time
it's local. Matching is strong (normalized title equality + artist overlap) to
avoid playing the wrong version; misses just stream (safe).

Endpoints:
  /localf?p=<rel>[&itag=]   -> serve a library file from disk (Range)
  /vp?u=<enc gv url>        -> residential gost stream (Beatbump miss)
  /iv/videoplayback?&host=  -> residential gost stream (ytify miss fallback)
  /iv/api/v1/videos/<id>    -> match->rewrite audio to /localf?itag ; else passthrough ; sniff
  POST .../youtubei/v1/player-> match->rewrite audio to /localf ; else /vp ; sniff
  else                      -> transparent proxy
"""
import asyncio
import base64
import json
import os
import re
import time
import urllib.parse
from aiohttp import web, ClientSession, ClientTimeout, TCPConnector

COMPANION = os.environ.get("COMPANION_UPSTREAM", "http://companion:8282")
# iv-vp = logged-in (metube) player/playback sidecar. Fallback when the anonymous companion is walled
# (LOGIN_REQUIRED / no audio format). Returns a player response with a raw googlevideo audio-140 URL
# minted via the SAME gost egress the bridge's /vp uses, so /vp streams it (matching IP-lock).
IVVP = os.environ.get("IVVP_UPSTREAM", "http://iv-vp:5007")
INVIDIOUS = os.environ.get("INVIDIOUS_UPSTREAM", "http://invidious-app-t2s:3000")
YUBAL = os.environ.get("YUBAL_URL", "http://yubal:8000")
GOST = os.environ.get("GOST_PROXY", "http://gost:8888")
MEILI_URL = os.environ.get("MEILI_URL", "http://meili:7700")
MEILI_KEY = os.environ.get("MEILI_KEY", "")
LIBRARY = os.environ.get("LIBRARY_DIR", "/library")
VP_PUBLIC = os.environ.get("VP_PUBLIC_BASE", "https://ytify.ekaii.fr/vp")
LOCALF_PUBLIC = os.environ.get("LOCALF_PUBLIC_BASE", "https://ytify.ekaii.fr/localf")
# iv-vp progressive-audio endpoint: iv-vp downloads via metube AND serves the bytes, so no IP-locked
# googlevideo re-fetch (unlike /vp+gost, which races on egress IP). Used for the fallback path.
AUD_PUBLIC = os.environ.get("AUD_PUBLIC_BASE", "https://invidious.ekaii.fr/aud")
PORT = int(os.environ.get("PORT", "8789"))
DEBOUNCE_TTL = int(os.environ.get("DEBOUNCE_TTL", str(6 * 3600)))
LOCAL_TTL = int(os.environ.get("LOCAL_CACHE_TTL", "600"))

# --- p19 last-access logging ---
STATE_DIR = os.environ.get("STATE_DIR", "/app/state")
LA_PATH = os.path.join(STATE_DIR, "last_access.json")
LA_FLUSH_SECS = int(os.environ.get("LA_FLUSH_SECS", "60"))
_last_access = {}
_la_dirty = False


def _load_last_access():
    """Load last_access.json, dropping keys whose file no longer exists so the
    state file cannot grow without bound across the cache's lifetime."""
    global _last_access
    try:
        with open(LA_PATH) as fh:
            data = json.load(fh)
    except FileNotFoundError:
        _last_access = {}
        return
    except Exception as e:
        print(f"[la] load error: {e}", flush=True)
        _last_access = {}
        return
    if not isinstance(data, dict):
        _last_access = {}
        return
    base = os.path.realpath(LIBRARY)
    clean = {}
    for k, v in data.items():
        try:
            full = os.path.realpath(os.path.join(LIBRARY, k))
            if (full == base or full.startswith(base + os.sep)) and os.path.isfile(full):
                clean[k] = int(v)
        except Exception:
            pass
    _last_access = clean
    print(f"[la] loaded {len(_last_access)} entries (dropped {len(data) - len(clean)} stale)", flush=True)


def _touch_access(rel):
    """Record now() as the last-access time for a library-relative path. Cheap
    (in-memory dict); persisted by the debounced flusher."""
    global _la_dirty
    if not rel:
        return
    _last_access[rel] = int(time.time())
    _la_dirty = True


def _save_last_access():
    global _la_dirty
    if not _la_dirty:
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = LA_PATH + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(_last_access, fh)
        os.replace(tmp, LA_PATH)
        _la_dirty = False
    except Exception as e:
        print(f"[la] save error: {e}", flush=True)


async def _la_flusher():
    while True:
        try:
            await asyncio.sleep(LA_FLUSH_SECS)
            _save_last_access()
        except asyncio.CancelledError:
            _save_last_access()
            break
        except Exception as e:
            print(f"[la] flusher error: {e}", flush=True)
# --- /p19 last-access logging ---

ID_RE = re.compile(r'^[A-Za-z0-9_-]{11}$')
REQ_DROP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
            'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
            'accept-encoding'}
RESP_DROP = {'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade'}
GV_RE = re.compile(r'googlevideo\.com/videoplayback')
CT = {'.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav'}
_STOP = re.compile(r'\b(official|video|audio|lyrics?|music|hd|4k|mv|visualizer|'
                   r'remaster(ed)?|explicit|topic|vevo)\b')

_recent = {}
_local_cache = {}


def norm(s):
    # strip YouTube noise words (official/video/4k/remaster/topic...) but KEEP
    # meaningful version info (remix/live/mix/acoustic) so we never match the
    # wrong version. feat.<...> is dropped (collaborators aren't part of identity).
    s = (s or "").lower()
    s = re.sub(r'\b(feat|ft)\.?\b.*', ' ', s)
    s = _STOP.sub(' ', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return ' '.join(s.split()).strip()


def _collapse(s):
    return re.sub(r'[^a-z0-9]', '', norm(s))


def title_match(play_title, play_author, hit):
    # Remove the library track's CLEAN artist tokens from the play title (handles
    # YouTube's "Artist - Title" prefix), then require the remaining title tokens
    # to EQUAL the library title's (version-safe: "Song (Remix)" != "Song").
    # Artist is confirmed via collapsed substring so concatenated channel names
    # like "MarkRonsonVEVO" still match "Mark Ronson".
    lib_title = set(norm(hit.get("title", "")).split())
    if not lib_title:
        return False
    lib_artist_tokens = set((norm(hit.get("artist", "")) + " " + norm(hit.get("albumArtist", ""))).split())
    core = set(norm(play_title).split()) - lib_artist_tokens
    if core != lib_title:
        return False
    la = _collapse(hit.get("artist", "")) or _collapse(hit.get("albumArtist", ""))
    cand = _collapse(play_author) + _collapse(play_title)
    return bool(la) and la in cand


async def meili_match(session, title, artist):
    body = {"q": ((title or "") + " " + (artist or "")).strip(), "limit": 12,
            "attributesToRetrieve": ["title", "artist", "albumArtist", "path", "qualityScore"]}
    try:
        async with session.post(MEILI_URL + "/indexes/tracks/search", json=body,
                                headers={"Authorization": "Bearer " + MEILI_KEY,
                                         "Accept-Encoding": "identity"},
                                timeout=ClientTimeout(total=10)) as r:
            data = json.loads(await r.read())
    except Exception as e:
        print("[meili] error:", e, flush=True)
        return None
    # Among ALL matching local copies, serve the highest-quality one (FLAC > opus > …).
    matches = [h for h in data.get("hits", []) if title_match(title, artist, h)]
    if not matches:
        return None
    best = max(matches, key=lambda h: h.get("qualityScore") or 0)
    if len(matches) > 1:
        print(f"[meili] {len(matches)} copies of '{title}' -> best q={best.get('qualityScore')}", flush=True)
    return best.get("path")


LID_RE = re.compile(r'[0-9a-f]{11}')


async def meili_by_lid(session, lid):
    body = {"q": "", "filter": f'lid = "{lid}"', "limit": 1,
            "attributesToRetrieve": ["title", "artist", "albumArtist", "path", "durationSec"]}
    try:
        async with session.post(MEILI_URL + "/indexes/tracks/search", json=body,
                                headers={"Authorization": "Bearer " + MEILI_KEY,
                                         "Accept-Encoding": "identity"},
                                timeout=ClientTimeout(total=10)) as r:
            hits = json.loads(await r.read()).get("hits") or []
            return hits[0] if hits else None
    except Exception as e:
        print("[meili] lid error:", e, flush=True)
        return None


def synthetic_player(vid, hit):
    # InnerTube-shaped player response that points Beatbump's player at /localf
    dur = int(hit.get("durationSec") or 0)
    url = LOCALF_PUBLIC + "?p=" + urllib.parse.quote(hit.get("path", ""), safe="")
    return {
        "playabilityStatus": {"status": "OK"},
        "videoDetails": {"videoId": vid, "title": hit.get("title") or "",
                         "author": hit.get("artist") or hit.get("albumArtist") or "",
                         "lengthSeconds": str(dur), "musicVideoType": "MUSIC_VIDEO_TYPE_ATV"},
        "streamingData": {"expiresInSeconds": "21600", "formats": [], "adaptiveFormats": [
            {"itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 128000,
             "url": url, "audioQuality": "AUDIO_QUALITY_MEDIUM", "audioSampleRate": "44100",
             "audioChannels": 2, "approxDurationMs": str(dur * 1000)}]},
    }


async def local_for(session, title, artist):
    key = norm(title) + "|" + norm(artist)
    now = time.time()
    c = _local_cache.get(key)
    if c and now - c[1] < LOCAL_TTL:
        return c[0]
    rel = await meili_match(session, title, artist)
    _local_cache[key] = (rel, now)
    return rel


async def enqueue(session, vid):
    now = time.time()
    for k in [k for k, v in _recent.items() if now - v > DEBOUNCE_TTL]:
        _recent.pop(k, None)
    if vid in _recent:
        return
    _recent[vid] = now
    try:
        async with session.post(f"{YUBAL}/api/jobs",
                                json={"url": f"https://music.youtube.com/watch?v={vid}"},
                                timeout=ClientTimeout(total=20)) as r:
            print(f"[cache] enqueue {vid} -> {r.status}", flush=True)
            if r.status >= 400:
                _recent.pop(vid, None)
    except Exception as e:
        print(f"[cache] enqueue {vid} failed: {e}", flush=True)
        _recent.pop(vid, None)


def maybe_enqueue(session, vid, rel):
    if vid and ID_RE.match(vid) and not rel:
        asyncio.create_task(enqueue(session, vid))


async def stream_via_gost(request, target_url):
    fwd = {k: v for k, v in request.headers.items() if k.lower() in ("range", "user-agent", "accept")}
    session = request.app["session"]
    try:
        async with session.get(target_url, headers=fwd, proxy=GOST, allow_redirects=True,
                               timeout=ClientTimeout(total=None, sock_connect=20, sock_read=60)) as up:
            resp = web.StreamResponse(status=up.status)
            for k, v in up.headers.items():
                if k.lower() not in RESP_DROP:
                    resp.headers[k] = v
            resp.headers["Access-Control-Allow-Origin"] = "*"
            await resp.prepare(request)
            async for chunk in up.content.iter_chunked(65536):
                await resp.write(chunk)
            await resp.write_eof()
            return resp
    except Exception as e:
        return web.Response(status=502, text=f"gost stream error: {e}")


def player_playable(data):
    """A companion/player response is usable only if it's OK AND carries an audio stream URL."""
    ps = ((data or {}).get("playabilityStatus") or {}).get("status")
    if ps and ps != "OK":
        return False
    af = ((data or {}).get("streamingData") or {}).get("adaptiveFormats") or []
    return any(str(f.get("mimeType", "")).startswith("audio") and f.get("url") for f in af)


async def ivvp_player(session, vid):
    """Logged-in fallback: iv-vp returns a player response (real-companion-first, else metube synth)
    with a raw googlevideo audio-140 url. Returns the dict if playable, else None."""
    try:
        async with session.post(IVVP + "/youtubei/v1/player", json={"videoId": vid},
                                timeout=ClientTimeout(total=75)) as up:
            if up.status != 200:
                return None
            d = await up.json()
        return d if player_playable(d) else None
    except Exception as e:
        print(f"[player] iv-vp fallback error {e}", flush=True)
        return None


def extract_cover(path):
    """Best-effort embedded cover art extraction (flac/mp3/mp4/ogg/opus)."""
    try:
        import mutagen
        from mutagen.flac import Picture
        f = mutagen.File(path)
    except Exception:
        return None
    if f is None:
        return None
    pics = getattr(f, "pictures", None)
    if pics:
        return (pics[0].mime or "image/jpeg", pics[0].data)
    tags = getattr(f, "tags", None)
    if not tags:
        return None
    try:
        for k in tags.keys():
            if k.startswith("APIC"):
                ap = tags[k]
                return (ap.mime or "image/jpeg", ap.data)
    except Exception:
        pass
    try:
        covr = tags.get("covr")
        if covr:
            c = covr[0]
            mime = "image/png" if getattr(c, "imageformat", None) == 14 else "image/jpeg"
            return (mime, bytes(c))
    except Exception:
        pass
    try:
        mbp = tags.get("metadata_block_picture")
        if mbp:
            pic = Picture(base64.b64decode(mbp[0]))
            return (pic.mime or "image/jpeg", pic.data)
    except Exception:
        pass
    return None


# --- c59d (decision 16 / PF5-1, PF5-7): /cover disk cache + extraction semaphore + 404 memo ---
# Before: every /cover re-opened the whole audio file with mutagen (p90 2.5 s, 404 at 917 ms).
# Now: cache dir on the mounted state volume (<lid>.<ext>), at most COVER_SEM_N concurrent
# extractions, 404 memoised COVER_MISS_TTL s in memory. Resize to COVER_MAX_PX only when
# Pillow is importable in the image (it is NOT today: the image is stored as extracted).
COVER_CACHE_DIR = os.environ.get("COVER_CACHE_DIR", os.path.join(STATE_DIR, "covers"))
COVER_MAX_PX = int(os.environ.get("COVER_MAX_PX", "600"))
COVER_SEM_N = int(os.environ.get("COVER_SEM_N", "4"))
COVER_MISS_TTL = int(os.environ.get("COVER_MISS_TTL", "3600"))
COVER_MISS_MAX = 4096
COVER_CC = "public, max-age=604800, immutable"
_COVER_EXT = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
              "image/webp": ".webp", "image/gif": ".gif"}
_COVER_EXTS = (".jpg", ".png", ".webp", ".gif")
_COVER_MIME = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}
_cover_sem = None
_cover_misses = {}      # lid -> expiry epoch
_cover_disk_ok = False
try:
    from PIL import Image as _PILImage  # optional; absent in the current image
    _HAVE_PIL = True
except Exception:
    _PILImage = None
    _HAVE_PIL = False


def _cover_init():
    global _cover_disk_ok
    try:
        os.makedirs(COVER_CACHE_DIR, exist_ok=True)
        probe = os.path.join(COVER_CACHE_DIR, ".write-probe")
        with open(probe, "w") as fh:
            fh.write("ok")
        os.remove(probe)
        _cover_disk_ok = True
    except Exception as e:
        _cover_disk_ok = False
        print(f"[cover] cache dir {COVER_CACHE_DIR} not writable ({e}); disk cache DISABLED", flush=True)
    print(f"[cover] disk cache {'on' if _cover_disk_ok else 'off'} dir={COVER_CACHE_DIR} "
          f"resize={'pillow ' + str(COVER_MAX_PX) + 'px' if _HAVE_PIL else 'none (no Pillow)'} "
          f"sem={COVER_SEM_N} miss_ttl={COVER_MISS_TTL}s", flush=True)


def _cover_cached_path(lid):
    for ext in _COVER_EXTS:
        p = os.path.join(COVER_CACHE_DIR, lid + ext)
        if os.path.isfile(p):
            return p
    return None


def _cover_miss_seen(lid):
    exp = _cover_misses.get(lid)
    if exp is None:
        return False
    if exp < time.time():
        _cover_misses.pop(lid, None)
        return False
    return True


def _cover_miss_add(lid):
    now = time.time()
    if len(_cover_misses) >= COVER_MISS_MAX:
        for k in [k for k, v in _cover_misses.items() if v < now]:
            _cover_misses.pop(k, None)
        if len(_cover_misses) >= COVER_MISS_MAX:
            _cover_misses.clear()
    _cover_misses[lid] = now + COVER_MISS_TTL


def _cover_shrink(mime, data):
    """Resize to COVER_MAX_PX (JPEG q85) when Pillow is available; else return as is."""
    if not _HAVE_PIL:
        return mime, data
    try:
        import io
        im = _PILImage.open(io.BytesIO(data))
        im.load()
        if max(im.size) <= COVER_MAX_PX and mime in ("image/jpeg", "image/jpg"):
            return "image/jpeg", data
        im.thumbnail((COVER_MAX_PX, COVER_MAX_PX))
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=85, optimize=True)
        return "image/jpeg", out.getvalue()
    except Exception as e:
        print(f"[cover] resize failed ({e}); storing original", flush=True)
        return mime, data


def _cover_extract_and_store(full, lid):
    """Blocking (executor): extract embedded art, optionally shrink, write <lid>.<ext>
    atomically into the cache dir. Returns (mime, cached_path_or_None, data) or None."""
    cov = extract_cover(full)
    if not cov:
        return None
    mime, data = cov
    mime = (mime or "image/jpeg").lower().split(";")[0].strip()
    mime, data = _cover_shrink(mime, data)
    if not _cover_disk_ok or not lid:
        return (mime, None, data)
    ext = _COVER_EXT.get(mime)
    if not ext:
        return (mime, None, data)
    dest = os.path.join(COVER_CACHE_DIR, lid + ext)
    try:
        tmp = dest + f".tmp-{os.getpid()}-{time.monotonic_ns()}"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dest)
        return (mime, dest, data)
    except Exception as e:
        print(f"[cover] cache write failed for {lid}: {e}", flush=True)
        try:
            os.remove(tmp)
        except Exception:
            pass
        return (mime, None, data)


def _cover_file_response(path, state):
    ext = os.path.splitext(path)[1].lower()
    return web.FileResponse(path, headers={"Content-Type": _COVER_MIME.get(ext, "image/jpeg"),
                                           "Cache-Control": COVER_CC,
                                           "Access-Control-Allow-Origin": "*",
                                           "X-Ytm-Cover": state})


async def serve_cover(request):
    lid = request.query.get("lid")
    if not lid:
        return web.Response(status=400, text="missing lid")
    safe_lid = lid if LID_RE.fullmatch(lid) else None   # only well-formed lids touch the disk cache
    if safe_lid and _cover_disk_ok:
        cached = _cover_cached_path(safe_lid)
        if cached:
            return _cover_file_response(cached, "HIT")       # sendfile, no Meili, no mutagen
    if _cover_miss_seen(lid):
        return web.Response(status=404, text="no art", headers={"X-Ytm-Cover": "MISS"})
    hit = await meili_by_lid(request.app["session"], lid)
    if not hit or not hit.get("path"):
        _cover_miss_add(lid)
        return web.Response(status=404, text="not found", headers={"X-Ytm-Cover": "MISS"})
    full = os.path.realpath(os.path.join(LIBRARY, hit["path"]))
    if not full.startswith(os.path.realpath(LIBRARY) + os.sep):
        return web.Response(status=404, headers={"X-Ytm-Cover": "MISS"})
    sem = _cover_sem
    loop = asyncio.get_event_loop()
    if sem is not None:
        async with sem:
            res = await loop.run_in_executor(None, _cover_extract_and_store, full, safe_lid)
    else:
        res = await loop.run_in_executor(None, _cover_extract_and_store, full, safe_lid)
    if not res:
        _cover_miss_add(lid)
        return web.Response(status=404, text="no art", headers={"X-Ytm-Cover": "MISS"})
    mime, cached, data = res
    if cached:
        return _cover_file_response(cached, "MISS")
    return web.Response(body=data, headers={"Content-Type": mime,
                                            "Cache-Control": COVER_CC,
                                            "Access-Control-Allow-Origin": "*",
                                            "X-Ytm-Cover": "MISS"})
# --- /c59d ---


def serve_localf(request):
    p = request.query.get("p")
    if not p:
        return web.Response(status=400, text="missing p")
    full = os.path.realpath(os.path.join(LIBRARY, p))
    base = os.path.realpath(LIBRARY)
    if not (full == base or full.startswith(base + os.sep)) or not os.path.isfile(full):
        return web.Response(status=404, text="not found")
    ext = os.path.splitext(full)[1].lower()
    headers = {"Access-Control-Allow-Origin": "*",
               "Content-Type": CT.get(ext, "application/octet-stream"),
               "X-Ytm-Source": "local"}
    # dl=1 → force a real on-device file download (Content-Disposition)
    if request.query.get("dl"):
        from urllib.parse import quote
        headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(os.path.basename(full))
    print(f"[localf] {p}{' (dl)' if request.query.get('dl') else ''}", flush=True)
    _touch_access(p)
    return web.FileResponse(full, headers=headers)


def rewrite_player(data, rel):
    sd = data.get("streamingData") or {}
    for key in ("adaptiveFormats", "formats"):
        for f in (sd.get(key) or []):
            u = f.get("url")
            if not (u and f.get("mimeType", "").startswith("audio")):
                continue
            if rel:
                f["url"] = LOCALF_PUBLIC + "?p=" + urllib.parse.quote(rel, safe="")
            elif GV_RE.search(u):
                f["url"] = VP_PUBLIC + "?u=" + urllib.parse.quote(u, safe="")


def rewrite_player_aud(data, vid):
    """Fallback (companion walled, track not in library): point audio at iv-vp's /aud/<vid> which
    downloads via metube and serves the bytes — no IP-locked googlevideo re-fetch."""
    sd = data.get("streamingData") or {}
    for key in ("adaptiveFormats", "formats"):
        for f in (sd.get(key) or []):
            if str(f.get("mimeType", "")).startswith("audio") and f.get("url"):
                f["url"] = AUD_PUBLIC + "/" + vid


def rewrite_iv(data, rel):
    if not rel:
        return
    for key in ("adaptiveFormats", "formats"):
        for f in (data.get(key) or []):
            u = f.get("url")
            if not (u and str(f.get("type", "")).startswith("audio")):
                continue
            itag = f.get("itag")
            f["url"] = LOCALF_PUBLIC + "?p=" + urllib.parse.quote(rel, safe="") + (f"&itag={itag}" if itag else "")


async def handler(request):
    tail = request.match_info.get("tail", "")
    full = "/" + tail
    session = request.app["session"]

    if full == "/healthz":
        return web.Response(text="ok")
    if full == "/cover":
        return await serve_cover(request)
    if full == "/localf":
        return serve_localf(request)
    if full == "/vp":
        u = request.query.get("u")
        return await stream_via_gost(request, u) if u else web.Response(status=400, text="missing u")
    if full.startswith("/iv/videoplayback"):
        q = dict(request.query)
        host = q.pop("host", None)
        q.pop("fallback", None)
        if not host:
            return web.Response(status=400, text="missing host")
        return await stream_via_gost(request, "https://" + host + "/videoplayback?" + urllib.parse.urlencode(q))

    # ytify resolution: parse, match by title/artist, rewrite to /localf if cached
    if full.startswith("/iv/") and "/api/v1/videos/" in full:
        m = re.search(r"/api/v1/videos/([A-Za-z0-9_-]{11})", full)
        vid = m.group(1) if m else None
        fwd = {k: v for k, v in request.headers.items() if k.lower() not in REQ_DROP}
        fwd["Accept-Encoding"] = "identity"
        url = INVIDIOUS + full[3:] + (("?" + request.query_string) if request.query_string else "")
        async with session.get(url, headers=fwd, allow_redirects=False,
                               timeout=ClientTimeout(total=45)) as up:
            raw = await up.read(); ct = up.headers.get("Content-Type", ""); st = up.status
        if "application/json" in ct:
            try:
                data = json.loads(raw)
                rel = await local_for(session, data.get("title"), data.get("author"))
                maybe_enqueue(session, vid, rel)
                if rel:
                    _touch_access(rel)
                if rel:
                    rewrite_iv(data, rel)
                    print(f"[iv] {vid} -> local {rel}", flush=True)
                raw = json.dumps(data).encode()
            except Exception as e:
                print(f"[iv] error {e}", flush=True)
        r = web.Response(status=st, body=raw)
        r.headers["Content-Type"] = ct or "application/json"
        r.headers["Access-Control-Allow-Origin"] = "*"
        return r

    body = await request.read() if (request.body_exists and request.method not in ("GET", "HEAD")) else None

    # Beatbump resolution
    if "youtubei/v1/player" in full:
        # local pseudo-id (lid) from a "Your Library" search hit -> synthetic player
        req_vid = None
        if body:
            mb = re.search(rb'"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"', body)
            if mb:
                req_vid = mb.group(1).decode()
        if req_vid and LID_RE.fullmatch(req_vid):
            hit = await meili_by_lid(session, req_vid)
            if hit:
                print(f"[player] {req_vid} -> local-id {hit.get('path')}", flush=True)
                return web.json_response(synthetic_player(req_vid, hit),
                                         headers={"Access-Control-Allow-Origin": "*"})
        fwd = {k: v for k, v in request.headers.items() if k.lower() not in REQ_DROP}
        fwd["Accept-Encoding"] = "identity"
        url = COMPANION + full + (("?" + request.query_string) if request.query_string else "")
        async with session.post(url, headers=fwd, data=body, allow_redirects=False,
                                timeout=ClientTimeout(total=45)) as up:
            raw = await up.read(); ct = up.headers.get("Content-Type", ""); st = up.status
        try:
            data = json.loads(raw) if "application/json" in ct else {}
        except Exception:
            data = {}
        used_fb = False
        try:
            # anonymous companion walled (LOGIN_REQUIRED / no audio)? -> logged-in fallback via iv-vp
            if not player_playable(data) and req_vid and ID_RE.match(req_vid):
                cs = ((data.get("playabilityStatus") or {}).get("status")) or f"http{st}"
                fb = await ivvp_player(session, req_vid)
                if fb:
                    data = fb; st = 200; ct = "application/json"; used_fb = True
                    print(f"[player] {req_vid} -> iv-vp fallback (companion {cs})", flush=True)
            vd = data.get("videoDetails") or {}
            vid = vd.get("videoId") or req_vid
            rel = await local_for(session, vd.get("title"), vd.get("author"))
            maybe_enqueue(session, vid, rel)
            if rel:
                _touch_access(rel)
                rewrite_player(data, rel)                 # local library copy -> /localf
            elif used_fb and vid:
                rewrite_player_aud(data, vid)             # logged-in bytes via iv-vp /aud (no IP-lock)
            else:
                rewrite_player(data, rel)                 # healthy companion: raw gv url -> /vp
            raw = json.dumps(data).encode()
            print(f"[player] {vid} -> {'local ' + rel if rel else ('aud' if used_fb else 'vp')}", flush=True)
        except Exception as e:
            print(f"[player] error {e}", flush=True)
        r = web.Response(status=st, body=raw)
        r.headers["Content-Type"] = ct or "application/json"
        r.headers["Access-Control-Allow-Origin"] = "*"
        return r

    # transparent proxy
    if full.startswith("/iv/"):
        upstream, up_path = INVIDIOUS, full[3:]
    else:
        upstream, up_path = COMPANION, full
    url = upstream + up_path + (("?" + request.query_string) if request.query_string else "")
    fwd = {k: v for k, v in request.headers.items() if k.lower() not in REQ_DROP}
    try:
        async with session.request(request.method, url, headers=fwd, data=body,
                                   allow_redirects=False) as up:
            resp = web.StreamResponse(status=up.status)
            for k, v in up.headers.items():
                if k.lower() not in RESP_DROP:
                    resp.headers[k] = v
            await resp.prepare(request)
            async for chunk in up.content.iter_chunked(65536):
                await resp.write(chunk)
            await resp.write_eof()
            return resp
    except Exception as e:
        return web.Response(status=502, text=f"bridge upstream error: {e}")


async def on_startup(app):
    app["session"] = ClientSession(connector=TCPConnector(limit=0), auto_decompress=False)
    global _cover_sem
    _cover_sem = asyncio.Semaphore(COVER_SEM_N)
    _cover_init()
    _load_last_access()
    app["_la_task"] = asyncio.create_task(_la_flusher())


async def on_cleanup(app):
    t = app.get("_la_task")
    if t:
        t.cancel()
    _save_last_access()
    await app["session"].close()


def make_app():
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_route("*", "/{tail:.*}", handler)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=PORT)
