# Architecture

The README has the service diagram. This file follows a request through the system for each of
the important flows: playing a local track, playing a YouTube track, acquisition, the offline
cache, the service worker shell and its update, and a rollback.

## Components and their state

| Component | Code | State it owns |
|---|---|---|
| beatbump (Go, Echo, port 8080) | `main.go`, `backend/` | SQLite database (`BEATBUMP_DB_PATH`): profiles, favourites, follows, playlists, play events, skips, now-playing, acquire jobs; in-memory response caches |
| SvelteKit SPA | `app/` | built once into `build/`, served by the Go binary; browser state in localStorage (resume, settings, home cache) and in the service worker caches |
| service worker | `app/src/service-worker.ts` | caches `ytm-shell-<version>` (shell), `ytm-api` (network-first API, never `/api/v1/me/*`), `ytm-offline-audio` + `ytm-offline-meta` (tracks, index by videoId, pins, quota), `ytm-covers` (LRU) |
| Meilisearch | external image | indexes `tracks`, `albums`, `artists` |
| indexer | `indexer/indexer.py` | `/state/index_state.json` (mtimes); rebuilds the derived indexes when tracks appear |
| bridge | `bridge/bridge.py` | last-access log (loaded in the background after the listener is up) and cover cache in `STATE_DIR`; `/healthz` for the compose healthcheck; no database |
| invidious-companion | external image | YouTube session cache |
| yubal | `yubal/` overlay on the upstream image | its job queue; writes audio files into the music folder |
| optional: egress proxy (gost), bgutil po-token provider, iv-vp | external | none |

Identifiers: a local track is a `lid` (first 11 hex characters of `sha1(relative path)`), an album
`lb-<12 hex>` and an artist `la-<12 hex>`, derived from normalised names in the indexer and
mirrored exactly in Go (`backend/api/local_*.go`) so links resolve. A YouTube track is its 11
character `videoId`; a YouTube album is `MPREb_...`.

## Flow 1: play a local track

1. The user clicks a row of the library, or a search result that came from Meilisearch. The front
   end knows it is local because the id is a `lid`.
2. `app/src/lib/player.ts` (`getSrc`) routes every `lid` to the local player endpoint
   (`fetchLocalPlayer`), never to the YouTube `player.json` (cycle 56 fix). The Go handler reads
   the track document from Meilisearch and answers the stream URL `/localf?p=<relpath>` plus the
   cover `/cover?lid=<lid>`, both same-origin (`LOCALF_BASE`, `COVER_BASE`).
3. The browser's `<audio>` element requests `/localf?p=...` with a `Range` header. The Go audio
   proxy (`backend/api/audioproxy.go`, `RegisterAudioProxyRoutes`) streams it from the bridge
   (`COMPANION_URL`); gzip is skipped on audio paths. The bridge serves the file from
   `LIBRARY_DIR` with Range support (206, `Accept-Ranges`, `x-ytm-source: local`).
4. The service worker sees the request; if the track is in `ytm-offline-audio` it answers from
   the cache with its own Range handling; otherwise it lets it through and, after a counted play
   (half the track or two minutes, `listenLog`), caches it (`cache-audio` message) unless data
   saver is on.
5. After 30 s of playback the page posts `POST /api/v1/me/history`; the server records a
   `play_event` for the profile (cookie `bbp`, or an anonymous device profile) unless the request is
   a harness request. `PUT /api/v1/me/nowplaying` every 15 s and on pause feeds the "Resume from
   <device>" card on other devices.
6. If the library does not have a next track, the queue continues with `local/related`
   (same album, artist, decade, genre or mix, skips excluded, no repeat within three hours).

Health probes use exactly this path with a local lid (`stats/library`, then a Range on `/localf`
of the first `local/songs?limit=1` track): it never triggers an acquisition.

## Flow 2: play a YouTube track

1. The row carries a `videoId`. The front end calls `GET /api/v1/player.json?videoId=...`
   (uncached: signed URLs). A prefetch of the next track adds `X-Ytm-Prefetch: 1`.
2. The Go handler asks the companion through the bridge (`COMPANION_URL=http://bridge:8789`;
   the Go server calls `<bridge>/companion/youtubei/v1/player`, and the companion serves under the
   base path `/companion`, `deploy/companion/config.toml`). The bridge, before forwarding, tries a
   confident match of title + artist in Meilisearch; on a match it rewrites the audio format to
   `/localf?p=...` so the best local copy is served instead (the "best quality wins" rule); on a
   miss it forwards the YouTube answer with the stream rewritten to `/vp?u=<googlevideo url>`.
3. The stream then goes through `/vp` (the Go proxy, then the bridge, which fetches googlevideo
   through `GOST_PROXY` when set, with a strict allow-list on the URL). In Camille's production
   layout the Go server instead prefers `/aud/<videoId>` served by an iv-vp sidecar
   (`YTM_PREFER_IVVP_AUDIO`, `IVVP_URL`), because the companion's googlevideo URLs were throttled
   to about 18 KB/s without the n-sig transform; `/aud` downloads the audio once and serves it at
   full speed through the same residential egress. The portable stack has no iv-vp and sets
   `YTM_PREFER_IVVP_AUDIO=0`.
4. `PLAYER_TIMEOUT_SECONDS` (20 s) bounds the YouTube round trip; errors are structured JSON
   (`{error,status,reason,videoId}`, 400/404/502/504) and the player shows a toast, retries once
   on 502/504 and skips an unavailable track exactly once.
5. If `BEATBUMP_AUTOCACHE` is on and the play is not a prefetch nor a harness request, the server
   queues an acquisition of the track's album (flow 3), within the daily cap.
6. Radio: `next.json` (cached 10 min + 1 h stale) gives the YouTube radio; for a local track the
   bridge found an online twin so the radio works too. `related.json`, `search.json`, `home.json`
   and the local mixes are served from the response cache (`backend/api/rescache*.go`,
   `X-Ytm-Cache: HIT|MISS|STALE|BYPASS`), primed at boot (`WarmHome`, `WarmLocalMixes`).

## Flow 3: acquisition (the library builds itself)

Triggers, all server side (`backend/api/acquire*.go`, `player.go`):

- a play of a track not owned (`autoCacheOnPlay`): the album or playlist is queued once
  (`DEBOUNCE_TTL` on the bridge side, the `acquire_jobs` table on the Go side);
- a follow of a YouTube artist, or `POST /api/v1/me/acquire`: the discography, one job per album;
- a single track outside any album.

Cap: `YTM_ACQUIRE_DAILY_CAP` albums per profile per UTC day (20 by default, decision 8), counted in
`acquire_jobs`; past the cap plays are still served but nothing is queued and the explicit request
answers `429 {"error":"quota"}`. Harness requests never acquire (decision 4).

Path: the Go server (or the bridge, for a `/vp` miss) calls yubal's `POST /api/jobs` with a
`music.youtube.com` playlist or album URL (the yubal shim adds `GET /api/resolve/album?videoId=` to
resolve a track to its album). yubal runs yt-dlp with the proxy and po-token provider forced in
by `yubal/sitecustomize.py` (when `YTM_YTDLP_PROXY` and `YTM_POT_BASE_URL` are set), slowly, and
writes tagged files (opus by default, `YUBAL_AUDIO_FORMAT`, with lyrics and ReplayGain) under
`MUSIC_DIR/ytm`. The indexer's next scan (`SCAN_INTERVAL`, 5 min in the stack) indexes them; from
then on the bridge's match serves the local
copy and the "quality" compare can upgrade a lower-quality copy in place. `GET /api/v1/downloads`
and `me/acquire` expose the queue with pause / resume / retry per task. `weekly.sh` column (h)
reports downloads, failures and the day's requests.

## Flow 4: offline cache

The service worker owns a dedicated audio cache with an index document (`/__ytm_index__` in
`ytm-offline-meta`, one entry per videoId or lid: url, bytes, lastAccess, pinned, contentType) and
answers the page over `postMessage` (`cache-audio`, `uncache-audio`, `is-cached`, `list-audio`,
`pin-audio`, `set-audio-quota`, `abort-audio`, `now-playing`; the contract is the header comment of
`app/src/service-worker.ts`).

- Entering the cache: after a counted play (cycle 58), the prefetch of the next track, "Keep
  offline" on a track, album, playlist or mix (`offlineBatch.ts`, two downloads in parallel,
  cancellable with `abort-audio`), sized packs ("Take 1 hour", by duration, the weekend card).
- Staying: LRU eviction under the quota (`set-audio-quota`, default 2 GiB, "unlimited" allowed),
  pins never evicted, the now-playing track never evicted, `storage.persist()` requested.
- Serving: cache-first by URL, then by videoId when the signed URL changed; Range answered from
  the cached body. The Offline page lists what is ready, by album and artist, with "free up
  space", a failed-downloads list and retry.
- Pages: `/library/*` and the home are rendered from `ytm-api` (network-first) or from the home
  cache in localStorage when offline; `/api/v1/me/*` is never cached (profile data), and the pages
  show an offline message instead. A local queue restored offline whose current track is not
  cached stays paused with its context (cycle 57).
- Playing offline: a `lid` goes to the local player; if the service worker answers
  `{offline: true}` (not cached) the player shows "non disponible hors-ligne" and does not advance
  without a gesture.

## Flow 5: the service worker shell and the update

Build: SvelteKit adapter-static produces `build/` with hashed assets under `/_app/immutable/`
(cached one year, immutable) and non-hashed files (`index.html`, `manifest.json`, icons,
`version.json`, `service-worker.js`) served `no-cache` with a weak content ETag
(`static_etag.go`, 304 on `If-None-Match`). The version (`-X main.version=<sha>`) is reported by
`/api/v1/stats/library` and `/about`.

Install: the SW precaches a short list (about 66 files) at install and the rest in deferred
batches; hashed assets unchanged since the previous build are carried over instead of
re-downloaded; the previous `ytm-shell-*` cache is kept (the last active one is remembered) so a
page of the previous build still finds its chunks; all of `/_app/immutable/` is cache-first; a
missing `/_app` asset is a `404 no-store` from the server and the SW refuses to cache HTML for an
asset.

Update: the page polls `version.json`; when a new SW is waiting the app shows a toast and reloads
once at the end of the current track or on pause, never mid-song ("apply at end of track"). After
the reload the new shell is served from its cache; API answers come network-first.

SPA routes: `/home`, `/search/...`, `/library/...` are the HTML5 fallback of the static handler;
unknown first segments (`spa_notfound.go`, `spaRoots`) get the shell with a real 404; link-preview
robots get an Open Graph card instead of the shell (`backend/api/og_preview.go`); every route
carries `index.html`'s ETag (see flow 6).

## Flow 6: deploy and rollback

1. `ops/stage-cycle.sh` builds the integration HEAD into `beatbump-ekaii:staging` with
   `--build-arg VERSION=<short sha>` under `flock`, restarts the staging compose project, warms
   it, checks headers, runs `check-harness-headers.cjs`, then the core and offline harnesses in
   `chain` tier.
2. `ops/finish-cycle.sh` reads the two `Report:` lines, applies the guards (svelte-check,
   gated steps, SM2) and, when the SM2 guard applies, plays DS1: the staging serves the production
   image, `probe-deploy-survives.cjs --phase=seed` installs the SW in a persistent profile, plays,
   pins an album; the staging serves the new image, `verify upgrade` reopens the same profile (SW
   updated, no `_app` 404 requested by the page, pins intact, resume restored, search usable,
   under 60 `_app` downloads); the staging goes back to the old image, `verify rollback` repeats
   the checks; the staging is restored on the new image.
3. `ops/promote.sh` tags `beatbump-ekaii:staging` as `beatbump-ekaii:local` (the exact tested
   image), after tagging the previous one `prod-backup-<TS>` and copying the compose file to
   `docker-compose.yml.pre-sameorigin-<TS>`; writes the healthcheck block when the image carries
   the `fr.ekaii.ytm.healthcheck=1` label and the `env_file` block when the 600 file exists; saves
   the verified tarball `image-backups/beatbump-prod-<TS>-<image id>.tar.gz` (then rotates to
   three); copies the previous container's access log; recreates the one service (`up -d
   --no-deps beatbump`); waits for `healthy` (75 s); checks HTTP 200, `stats/library` version, a
   Range on a local track; prints the two rollback lines; runs `smoke.sh` (HTTP and browser). Exit
   0 promoted, 2 backup failed (nothing promoted), 3 promoted but unhealthy (roll back).
4. Rollback by tag: `docker tag beatbump-ekaii:prod-backup-<TS> beatbump-ekaii:local && cp
   docker-compose.yml.pre-sameorigin-<TS> docker-compose.yml && docker compose up -d --no-deps
   beatbump`. By tarball when the tags were pruned: `docker load -i <tarball> && docker tag <id>
   beatbump-ekaii:local && ...`. Choose by image id (in `CYCLES.md` `PROD = ...` lines), not by
   time.
5. What the browser sees on a rollback: the old `index.html` has a different ETag, so the SPA
   route answers 200 with the old shell even though `Last-Modified` is older (c59g); the old SW
   version activates, its shell cache is still present (kept at the upgrade), and the new build's
   deferred chunks that the server no longer has are only requested by the new SW's background
   precache, which the DS1 probe reports apart. Without the ETag the browser kept the new shell on
   a 304 and the new shell's lazy chunks 404'd (chains 78 and 80).

## Request classification on the server

- Harness: `X-Ytm-Harness: 1`, UA `HeadlessChrome`, `playwright`, or the fixture UAs
  (`backend/api/me_stats.go`, `harnessRequest`): no history, no now-playing, no client-log, no
  acquisition, unless `YTM_STATS_INCLUDE_HARNESS=1`.
- Robots: link-preview UAs get the OG card (`og_preview.go`, dedicated cache of 200, never the
  fallback stored).
- Client IP: `X-Forwarded-For` trusted only from loopback or private networks (the reverse proxy),
  used for the client-log rate limit (30 POST/min).
- Access log: one JSON line per request (`logger.go`) with `uri`, `status`, `latency`,
  `user_agent`, `remote_ip`, `cache` and `mix_cache` verdicts; `e2e/perf-audit/log-latency.py`
  reads it (harness, healthcheck and Kuma excluded by default).
