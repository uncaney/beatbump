"""Album-resolver route for yubal_api (ytm p18 shim).

GET <base>/api/resolve/album?videoId=<id>

Read-only. Resolves the album a track belongs to, via the yubal YTMusicClient
(YTMusicClient.get_track -> ytmusicapi get_watch_playlist), and returns a
yubal-ingestable playlist URL so the beatbump play-hook can enqueue the whole
album to yubal /api/jobs:

    {"albumUrl": "https://music.youtube.com/playlist?list=<audioPlaylistId|browseId>"}
    {"albumUrl": null}   # track has no album / not resolvable

Loaded out-of-tree (yubal_api is pip-installed) from /opt/ytm-shim and
registered by the sitecustomize router-injection hook. See sitecustomize.py.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Query

from yubal.client import YTMusicClient
from yubal.utils.url import is_supported_url
from yubal_api.settings import get_settings

logger = logging.getLogger("yubal_api.resolve")

router = APIRouter(prefix="/resolve", tags=["resolve"])

_YTM_PLAYLIST_BASE = "https://music.youtube.com/playlist?list="


@lru_cache(maxsize=1)
def _client() -> YTMusicClient:
    """Lazily build one YTMusicClient (cookies if present), mirroring how
    PlaylistInfoService constructs its client."""
    settings = get_settings()
    cookies_path = settings.cookies_file if settings.cookies_file.exists() else None
    return YTMusicClient(cookies_path=cookies_path)


def _audio_playlist_id(client: YTMusicClient, browse_id: str) -> str | None:
    """Best-effort upgrade an album browseId (MPRE...) to its audioPlaylistId
    (OLAK5uy...), the actually-downloadable playlist id. ytmusicapi's raw
    get_album() carries audioPlaylistId; the yubal Album model drops it, so we
    read the raw dict off the wrapped client. Returns None on any failure."""
    try:
        raw = client._ytm.get_album(browse_id)
    except Exception:
        logger.debug("get_album(%s) failed", browse_id, exc_info=True)
        return None
    pid = raw.get("audioPlaylistId") if isinstance(raw, dict) else None
    return pid if isinstance(pid, str) and pid else None


@router.get("/album")
def resolve_album(
    video_id: Annotated[
        str, Query(alias="videoId", description="YouTube videoId of a track")
    ],
) -> dict[str, str | None]:
    """Resolve the album for a track. Never raises for the caller: any
    unresolvable case returns {"albumUrl": null}."""
    vid = (video_id or "").strip()
    if not vid:
        return {"albumUrl": None}

    client = _client()
    try:
        track = client.get_track(vid)
    except Exception:
        logger.debug("get_track(%s) failed", vid, exc_info=True)
        return {"albumUrl": None}

    browse_id = track.album.id if (track and track.album) else None
    if not browse_id:
        return {"albumUrl": None}

    # Prefer the downloadable audioPlaylistId; fall back to the browseId.
    list_id = _audio_playlist_id(client, browse_id) or browse_id
    url = f"{_YTM_PLAYLIST_BASE}{list_id}"
    if not is_supported_url(url):
        return {"albumUrl": None}
    return {"albumUrl": url}
