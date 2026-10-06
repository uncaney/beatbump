# Auto-imported by CPython at startup (placed on PYTHONPATH=/opt/ytm-shim).
# Yubal builds its yt-dlp options dict in-code and exposes no operator hook for
# --proxy / --extractor-args, so we patch YoutubeDL.__init__ to force in:
#   - egress through an HTTP proxy when YTM_YTDLP_PROXY is set (a residential
#     proxy, for instance); unset/empty = direct egress (the shipped default)
#   - po-tokens from the bgutil HTTP provider (YTM_POT_BASE_URL, default
#     http://bgutil:4416, the `bgutil` service of deploy/compose.yml); empty
#     disables the provider.
# This is the minimal, fork-free way to make yubal survive YouTube bot-detection.
import os


def _install_ytdlp_shim():
    try:
        import yt_dlp
    except Exception:
        return

    proxy = os.environ.get("YTM_YTDLP_PROXY", "").strip()
    pot_base = os.environ.get("YTM_POT_BASE_URL", "http://bgutil:4416").strip()

    _orig_init = yt_dlp.YoutubeDL.__init__

    def _patched_init(self, params=None, *args, **kwargs):
        params = dict(params or {})
        if proxy:
            params.setdefault("proxy", proxy)
        if pot_base:
            ea = dict(params.get("extractor_args") or {})
            ea.setdefault("youtubepot-bgutilhttp", {"base_url": [pot_base]})
            params["extractor_args"] = ea
        return _orig_init(self, params, *args, **kwargs)

    if not getattr(yt_dlp.YoutubeDL.__init__, "_ytm_patched", False):
        _patched_init._ytm_patched = True
        yt_dlp.YoutubeDL.__init__ = _patched_init


_install_ytdlp_shim()


# --- ytm-p18-resolve: register the album-resolver route into yubal's API router ----
# yubal_api builds its router in create_api_router() as
#   api_router = APIRouter(prefix=f"{base_path}/api")
#   api_router.include_router(health.router); ...
# We wrap APIRouter.include_router so that, the first time yubal includes a
# subrouter into the "<base>/api" router, we also include our resolve router.
# This is the pip-install-safe equivalent of editing create_api_router() /
# app.py — no yubal source is touched.
def _install_resolve_route():
    try:
        from fastapi import APIRouter
    except Exception:
        return

    orig = APIRouter.include_router
    if getattr(orig, "_ytm_resolve_wrapped", False):
        return

    import functools

    @functools.wraps(orig)
    def include_router(self, router, *args, **kwargs):
        try:
            prefix = getattr(self, "prefix", "") or ""
            if prefix.endswith("/api") and not getattr(
                self, "_ytm_resolve_added", False
            ):
                self._ytm_resolve_added = True
                from ytm_resolve_route import router as _resolve_router

                orig(self, _resolve_router)
        except Exception:
            import logging

            logging.getLogger("ytm-shim").exception(
                "failed to inject resolve route"
            )
        return orig(self, router, *args, **kwargs)

    include_router._ytm_resolve_wrapped = True
    APIRouter.include_router = include_router


_install_resolve_route()


# --- ytm-p20: make yubal's downloader retry FFmpeg post-processing failures ---
# yubal's retry loop only re-attempts on transient HTTP errors (403/429/5xx).
# The intermittent "unable to obtain file audio codec with ffprobe" (a bad/partial
# audio download that ffprobe can't read) is NOT retried, so a single flaky attempt
# leaves an extensionless junk file at the target path and the track is lost until
# the next play. Empirically these are transient (an immediate re-download of the
# same id succeeds). So we:
#   1) broaden _is_retryable_error to include the ExtractAudio/ffprobe failures, so
#      the existing 3x exponential-backoff loop recovers them; and
#   2) wrap download() to delete the extensionless leftover on final failure and
#      before each retry, so no junk lingers and retries start clean.
# Contained monkeypatch of yubal.services.download_service — no yubal source edited,
# success path untouched (only adds retries + cleans up failures).
_AUDIO_EXTS = {".opus", ".m4a", ".mp3", ".flac", ".ogg", ".oga", ".aac", ".wav", ".lrc"}
_EXTRACT_RETRY_MARKERS = (
    "unable to obtain file audio codec with ffprobe",
    "audio conversion failed",
    "postprocessing:",
    "error opening output file",
    "ffprobe",
)


def _remove_extensionless_leftover(output_path):
    """Delete a failed ExtractAudio leftover written to the extension-less target
    template. Never touches a real media file (guarded on non-audio suffix)."""
    try:
        p = output_path
        if p.exists() and p.is_file() and p.suffix.lower() not in _AUDIO_EXTS:
            p.unlink()
    except Exception:
        pass


def _install_yubal_download_hardening():
    try:
        from yubal.services import download_service as ds
    except Exception:
        return
    D = getattr(ds, "YTDLPDownloader", None)
    if D is None or getattr(D, "_ytm_dl_hardened", False):
        return

    _orig_retryable = D._is_retryable_error

    def _is_retryable_error(self, error_msg):
        if _orig_retryable(self, error_msg):
            return True
        m = (error_msg or "").lower()
        return any(marker in m for marker in _EXTRACT_RETRY_MARKERS)

    D._is_retryable_error = _is_retryable_error

    _orig_cleanup = D._cleanup_partial_downloads

    def _cleanup_partial_downloads(self, output_path):
        try:
            _orig_cleanup(self, output_path)
        except Exception:
            pass
        _remove_extensionless_leftover(output_path)

    D._cleanup_partial_downloads = _cleanup_partial_downloads

    _orig_download = D.download

    def download(self, video_id, output_path, cancel_token=None):
        try:
            return _orig_download(self, video_id, output_path, cancel_token)
        except Exception:
            # All retries exhausted (or non-retryable): make sure we don't leave
            # an unindexable extensionless junk file behind.
            _remove_extensionless_leftover(output_path)
            raise

    D.download = download
    D._ytm_dl_hardened = True


_install_yubal_download_hardening()
