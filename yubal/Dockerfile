# yubal (https://github.com/guillevc/yubal) + the bgutil PO-token plugin + deno.
# Built by deploy/compose.yml (service `yubal`); the base tag is overridable with
# --build-arg YUBAL_BASE=... . Runtime config: see deploy/.env.example (YUBAL_*,
# EGRESS_PROXY -> YTM_YTDLP_PROXY, bgutil -> YTM_POT_BASE_URL).
ARG YUBAL_BASE=ghcr.io/guillevc/yubal:latest
FROM ${YUBAL_BASE}

# Add the bgutil po-token provider plugin into yubal's venv so yt-dlp
# auto-discovers it (yt_dlp_plugins namespace). --no-deps so it can't drag
# yubal's pinned yt-dlp (2026.6.9) to a different version.
USER root
RUN /app/.venv/bin/python -m ensurepip --upgrade \
 && /app/.venv/bin/python -m pip install --no-cache-dir --no-deps "bgutil-ytdlp-pot-provider==1.3.1"

# P2b: install a JS runtime (deno) so yt-dlp's EJS signature/n-sig challenge
# solver (yubal already requests remote_components=["ejs:github"]) actually
# RUNS. Without a runtime the solver is skipped -> "Signature solving failed" /
# "n challenge solving failed" -> web audio format URLs come back throttled,
# the download is corrupt, and FFmpegExtractAudio dies with "unable to obtain
# file audio codec with ffprobe", leaving an extensionless junk file. This was
# the ~25-30% single-track download failure. yt-dlp auto-detects deno on PATH.
ARG DENO_VERSION=v2.1.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl ca-certificates \
 && curl -fsSL "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o /tmp/deno.zip \
 && unzip -o /tmp/deno.zip -d /usr/local/bin \
 && chmod +x /usr/local/bin/deno \
 && rm -f /tmp/deno.zip \
 && apt-get purge -y unzip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && /usr/local/bin/deno --version

# deno needs a writable cache dir; the runtime user is 1000 and $HOME may not be
# writable. Point it at /tmp and silence the update check.
ENV DENO_DIR=/tmp/.deno
ENV DENO_NO_UPDATE_CHECK=1

# Shim: yubal builds its yt-dlp opts dict in-code with no operator hook, so we
# monkeypatch YoutubeDL.__init__ to force egress proxy + the bgutil HTTP pot
# provider into every download. Imported automatically via PYTHONPATH.
COPY sitecustomize.py /opt/ytm-shim/sitecustomize.py
COPY ytm_resolve_route.py /opt/ytm-shim/ytm_resolve_route.py
ENV PYTHONPATH=/opt/ytm-shim

USER 1000:1000

# 2026-09-30: unpin yt-dlp (base yubal fige 2026.6.9, casse par SABR YouTube => 403). Latest au build; cron runtime le maintient.
USER root
RUN /app/.venv/bin/python -m pip install --no-cache-dir -U yt-dlp
USER 1000:1000
