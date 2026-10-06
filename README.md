# beatbump (self-hosted, own-your-data music app)

A fork of [Beatbump](https://github.com/giwty/Beatbump) (SvelteKit + Go) turned into a complete,
self-hosted music app. It plays your local library and the YouTube Music catalogue through one
interface, builds the local library from what you listen to, and works fully offline as an
installed PWA. The goal is feature parity with YouTube Music or Spotify on infrastructure you own.
The repository keeps the name `beatbump` to honour the upstream authors.

What makes it different:

- **Local and online, transparently.** One search returns your library and YouTube. When a track
  exists in both, the player serves the best copy without asking.
- **Best quality wins.** Every local track has a quality score (codec, bitrate, sample rate). If the
  copy being served is online or lower quality, a better one is fetched in the background and
  replaces it in place.
- **The library builds itself from listening.** Following an artist or liking a track queues a slow,
  quota-respecting download of the matching content. The more you listen, the more you own.
- **Full offline PWA.** The app shell, the pages you visited and every track you explicitly kept
  (or listened to for long enough) play with no network.
- **Own your data.** Profiles, favourites, follows, playlists, history and statistics live in a
  SQLite file on your server. Audio files live in a folder you control. Nothing leaves the box.

The user interface is in **French**, by decision of the owner (program decisions 1 and 5): the app was built for a French-speaking
circle, and a dictionary with browser detection was judged more costly than useful. All UI strings
live in the SvelteKit sources under `app/src` (Svelte markup, the toast and label modules, and the
`DROPDOWN_LABELS_FR` / `SHELF_TITLES_FR` tables in `app/src/lib/configs/dropdowns.config.ts` and
the search route). A structural test, `app/src/lib/utils/frenchScreens.test.ts`, scans those files
for English UI words. An i18n contribution would replace those literals with a lookup and extend or
retire that test; see `CONTRIBUTING.md`.

## Screenshots

No screenshots are committed yet. Run the app and take your own, or see the UX audit captures
produced by `e2e/ux-audit/shots.cjs` (not in the repository).

## Quick start

Requirements: Docker Engine with the compose plugin (`docker compose`), a Linux host, a folder of
music files (optional: the sample library is enough to try the app).

```sh
git clone <this repository> beatbump
cd beatbump
./up.sh --sample-library
```

Then open <http://localhost:8080>.

`up.sh` writes `deploy/.env` from `deploy/.env.example` on the first run, generates the three
secrets, creates `deploy/data/`, builds the images, starts the stack and waits for every container
to be healthy (`HEALTH_TIMEOUT`, 600 s by default). `--sample-library` fills an empty `MUSIC_DIR`
with 18 short CC0 synthetic tracks (`fixtures/make-sample-library.sh`) so the app has content.

To index your own music, set `MUSIC_DIR` in `deploy/.env` to your music folder (relative paths
resolve from `deploy/`; `MUSIC_DIR` is mounted read-only in the indexer and the bridge, and yubal
writes its downloads to `MUSIC_DIR/ytm`) and run `./up.sh` again. The indexer walks the folder,
reads the tags and fills Meilisearch every `INDEXER_SCAN_INTERVAL` seconds; the library pages fill
up as it goes. See `deploy/VERIFICATION.md` for what to check after the first start.

Other `up.sh` commands:

| Command | Effect |
|---|---|
| `./up.sh` | first run: create `deploy/.env` and `deploy/data`, build, start, wait for health; later runs: rebuild and restart |
| `./up.sh --sample-library` | same, and generate the sample library if `MUSIC_DIR` has no audio file |
| `./up.sh down [-v]` | stop the stack (`-v` also deletes the Meilisearch and companion volumes) |
| `./up.sh logs [service]` | follow logs |
| `./up.sh ps` | container status and health |
| `./up.sh update` | `git pull --ff-only`, rebuild with `--pull`, restart, wait for health |
| `./up.sh build` | rebuild the images only |

Environment overrides read by `up.sh`: `COMPOSE_PROJECT_NAME` (default `beatbump`; several
stacks can coexist), `BEATBUMP_PORT`, `MUSIC_DIR` and `BEATBUMP_BIND` (written into `deploy/.env`
on the first run), `HEALTH_TIMEOUT` (600 s), `BUILD_PARALLEL=1` to build the four images in
parallel (default: one at a time, kinder to a loaded host; `./up.sh build <service>` rebuilds one
image). The raw equivalent once `deploy/.env` exists:
`docker compose -p beatbump --project-directory deploy -f deploy/compose.yml up -d`.

## Requirements

| Item | Why |
|---|---|
| Docker Engine 24+ with `docker compose` v2 | every service runs as a container |
| Linux host (x86_64) | the app image is `FROM scratch` with a static Go binary and ffmpeg from Alpine |
| A music folder (read-only is fine) | indexed by `indexer/indexer.py`, served by `bridge/bridge.py` |
| Disk for Meilisearch and the SQLite database | the index of a 56 000-track library is a few hundred MB |
| Outbound HTTPS | YouTube playback through invidious-companion, lyrics through lrclib.net |
| Optional: a residential egress proxy and a po-token provider | YouTube blocks many datacenter IPs; see "Status and limits" |

Node 22 and Go 1.24 are only needed to build outside Docker (see "Testing").

## Configuration

All configuration is environment variables. `deploy/.env.example` is the reference file;
`./up.sh` copies it to `deploy/.env` (mode 600) on the first run and fills the secrets. Edit
`deploy/.env` afterwards, never the example. Relative paths resolve from `deploy/`.

### `deploy/.env` (what you edit)

| Variable | Default | Role |
|---|---|---|
| `BEATBUMP_PORT` | `8080` | host port published for the app (the only published port) |
| `BEATBUMP_BIND` | `0.0.0.0` | host address to bind (`127.0.0.1` = this machine only) |
| `MEILI_MASTER_KEY` | generated (64 hex) | Meilisearch master key (16 characters minimum); also used by beatbump, bridge and indexer |
| `COMPANION_SECRET_KEY` | generated (16 hex) | shared secret between beatbump and invidious-companion; **exactly 16 characters** (companion constraint, `up.sh` refuses otherwise) |
| `YTM_ADMIN_TOKEN` | generated (64 hex) | Bearer token for the operator-only endpoints (`GET /api/v1/client-log`) |
| `MUSIC_DIR` | `./data/music` | your music folder, mounted read-only; downloads go to `MUSIC_DIR/ytm`, the sample library to `MUSIC_DIR/sample` |
| `INDEXER_SOURCES` | `*` | top-level folders of `MUSIC_DIR` to index: `*` = all of them plus loose files at the root, or a list such as `ytm,lidarr,soulseek` |
| `INDEXER_SCAN_INTERVAL` | `300` | seconds between two library scans (new files appear after a scan) |
| `PUID`, `PGID` | the user running `up.sh` (1000:1000 when root) | uid:gid the containers run as; `deploy/data` is owned by them |
| `BEATBUMP_AUTOCACHE` | `true` | queue a yubal download of what you play when it is not in the library yet |
| `YTM_ACQUIRE_DAILY_CAP` | `20` | albums or playlists auto-acquired per profile per UTC day (`0` = unlimited) |
| `YTM_REPORT_EMAIL` | empty | contact shown on `/about` for reports (optional; without it the page offers "copy the diagnostic") |
| `BEATBUMP_VERSION` | `dev`, replaced by the git short sha when available | version reported by `/api/v1/stats/library` and baked into the image |
| `TZ` | `UTC` | timezone of yubal's scheduler |
| `YUBAL_AUDIO_FORMAT` | `opus` | download codec (`m4a`, `mp3`, `flac` also accepted by yubal) |
| `YUBAL_LOG_LEVEL` | `INFO` | yubal log level |
| `EGRESS_PROXY` | empty (direct) | HTTP proxy for every YouTube-facing call: companion, bgutil, yubal, the bridge's `/vp`, the app's background lookups (`http://user:pass@proxy:8080`) |
| `IVVP_UPSTREAM` | empty (disabled) | logged-in player sidecar (iv-vp protocol) used when the anonymous companion is walled; empty keeps audio on the app's `/vp` proxy |
| `INVIDIOUS_UPSTREAM` | empty (`/iv/*` answers 502) | Invidious instance behind the bridge's `/iv/*` routes (only an external ytify client uses them) |
| `COMPANION_IMAGE` | `quay.io/invidious/invidious-companion:latest` | pin a tag here if `latest` misbehaves |

`deploy/compose.yml` maps these onto each service and sets the wiring that never changes
(`COMPANION_URL=http://bridge:8789`: the bridge fronts the companion and adds the local-library
resolution; same-origin `LOCALF_BASE=/localf`, `COVER_BASE=/cover`; `YTM_PREFER_IVVP_AUDIO=0`
since the stack has no iv-vp; the companion under base path `/companion` with
`deploy/companion/config.toml`). The services expose more knobs than the `.env` file; the tables
below list every variable each one reads, as the code defines it, for an operator who writes their
own compose file.

### beatbump (Go server, `main.go` and `backend/`)

| Variable | Default | Role |
|---|---|---|
| `COMPANION_URL` | required | base URL of invidious-companion, or of the bridge that fronts it (`backend/_youtube/api/api.go`) |
| `COMPANION_SECRET_KEY` | required | API key shared with invidious-companion (`SERVER_SECRET_KEY` on the companion side) |
| `BEATBUMP_DB_PATH` | `/db` | directory of the SQLite database inside the container |
| `MEILI_URL` | required | Meilisearch base URL |
| `MEILI_KEY` | required | Meilisearch API key |
| `LOCALF_BASE` | | base path of local audio URLs; `/localf` keeps them same-origin |
| `COVER_BASE` | | base path of cover URLs; `/cover` keeps them same-origin |
| `IVVP_URL` | | sidecar that serves `/aud/<videoId>` (progressive audio); optional |
| `AUDIO_PUBLIC_BASES` | built-in table | mapping of public audio bases to proxy paths (`backend/api/audioproxy.go`) |
| `RESIDENTIAL_PROXY` | empty (direct) | outbound HTTP proxy for the background InnerTube `next` lookups (e.g. a residential egress proxy) |
| `PLAYER_TIMEOUT_SECONDS` | `20` | budget of one `player.json` call to YouTube |
| `BEATBUMP_AUTOCACHE` | `true` | a play of a track you do not own queues its acquisition; `false`, `0`, `no` or `off` disables |
| `YTM_ACQUIRE_DAILY_CAP` | `20` | acquisitions (albums) per profile per UTC day; `0` = no cap |
| `YTM_PREFER_IVVP_AUDIO` | `1` | `0` disables the switch of YouTube audio to `/aud` |
| `YTM_API_CACHE` | `1` | `0` disables the server response cache (`backend/api/rescache.go`) |
| `YTM_STATS_INCLUDE_HARNESS` | unset | `1` records plays made by the test harness (staging only) |
| `YTM_ADMIN_TOKEN` | unset | Bearer token for `GET /api/v1/client-log`; the route answers 404 while unset |
| `YTM_REPORT_EMAIL` | unset | "Report a problem" mailto link on `/about`; without it the page offers "Copy the diagnostic" |
| `YTM_VERSION` | `dev` | version reported by `/api/v1/stats/library` when the image was not built with `--build-arg VERSION=` |

### bridge (`bridge/bridge.py`, local-first audio and cover server)

| Variable | Default | Role |
|---|---|---|
| `PORT` | `8789` | listen port |
| `LIBRARY_DIR` | `/library` | root of the music files served by `/localf` |
| `MEILI_URL`, `MEILI_KEY` | `http://meili:7700`, empty | the index used for title + artist matching |
| `COMPANION_UPSTREAM` | `http://companion:8282` | invidious-companion |
| `INVIDIOUS_UPSTREAM` | empty (`/iv/*` answers 502) | Invidious API behind `/iv/*` (optional) |
| `IVVP_UPSTREAM` | empty (disabled) | logged-in player sidecar (optional) |
| `YUBAL_URL` | `http://yubal:8000` | acquisition service |
| `GOST_PROXY` | empty (direct) | egress proxy for `/vp` streams |
| `VP_PUBLIC_BASE`, `LOCALF_PUBLIC_BASE`, `AUD_PUBLIC_BASE` | `/vp`, `/localf`, `/aud` | public bases rewritten into player answers (same-origin relative paths) |
| `STATE_DIR` | `/app/state` | last-access log and cover cache |
| `COVER_CACHE_DIR` | `$STATE_DIR/covers` | on-disk cover cache |
| `COVER_SEM_N` | `4` | concurrent cover extractions |
| `COVER_MISS_TTL` | `3600` | seconds a missing cover is remembered |
| `COVER_MAX_PX` | `600` | target size (resizing needs Pillow, not in the image: covers are stored as is) |
| `DEBOUNCE_TTL` | `21600` | seconds before the same track is enqueued again |
| `LOCAL_CACHE_TTL` | `600` | seconds a local-match answer is cached |
| `LA_FLUSH_SECS` | `60` | last-access flush interval |

### indexer (`indexer/indexer.py`)

| Variable | Default | Role |
|---|---|---|
| `MUSIC_ROOT` | `/music` | mounted music folder |
| `SOURCES` | `*` | top-level folders of `MUSIC_ROOT` to index (`*` = discover them all) |
| `MEILI_URL`, `MEILI_KEY` | `http://meili:7700`, empty | target index (the indexer waits for Meilisearch instead of crash-looping) |
| `INDEX` | `tracks` | index name (albums and artists are derived) |
| `SCAN_INTERVAL` | `1800` | seconds between incremental scans (the compose file passes `INDEXER_SCAN_INTERVAL`) |
| `BATCH` | `1000` | documents per upsert |
| `STATE_DIR` | `/state` | `index_state.json` (mtimes) |

### yubal (`yubal/`, acquisition)

| Variable | Default | Role |
|---|---|---|
| `YTM_YTDLP_PROXY` | empty (direct) | proxy forced into every yt-dlp download (`EGRESS_PROXY` in the stack) |
| `YTM_POT_BASE_URL` | `http://bgutil:4416` | bgutil po-token provider (optional) |
| `YUBAL_*` | see `deploy/compose.yml` | yubal's own settings (`YUBAL_AUDIO_FORMAT`, `YUBAL_AUDIO_QUALITY`, `YUBAL_FETCH_LYRICS`, `YUBAL_REPLAYGAIN`, `YUBAL_TZ`, `YUBAL_LOG_LEVEL`) |

The yubal image is rebuilt from `ghcr.io/guillevc/yubal` (`--build-arg YUBAL_BASE=` to pin) with
deno, the bgutil plugin and the latest yt-dlp; rebuild it (`./up.sh build yubal`) when downloads
start failing in bulk.

## Architecture

```
            browser / installed PWA (service worker: shell, API, audio caches)
                                  |
                                  v  :8080
   +------------------------------------------------------------------+
   |  beatbump  (Go, Echo)  static SPA build + /api/v1/*               |
   |   - local pages, profiles, stats, mixes      -> Meilisearch       |
   |   - YouTube pages (search, home, next...)    -> bridge/companion  |
   |   - /localf /cover /vp (reverse proxy)       -> bridge            |
   |   - /aud/<id> (reverse proxy)                -> iv-vp (optional)  |
   |   - SQLite (profiles, favourites, history, acquire jobs)          |
   +------------------------------------------------------------------+
         |                 |
         v                 v
   +-----------+   +-----------------+   +---------------------------+
   | meili     |   | bridge (python) |   | invidious-companion       |
   | tracks,   |<--| match title +   |-->| (/companion base path)    |
   | albums,   |   | artist, serve   |   | YouTube player / streams  |
   | artists   |   | /localf from    |   +---------------------------+
   +-----------+   | disk, covers,   |          |  EGRESS_PROXY, bgutil po-tokens
         ^         | enqueue yubal   |          v
         |         +-----------------+       YouTube
         |                 |
   +-----------+           v
   | indexer   |   +-----------------+
   | tags ->   |   | yubal (yt-dlp)  |  slow acquisition of what you listen to
   | meili     |   | writes files    |  (deno, bgutil plugin, EGRESS_PROXY)
   +-----------+   +-----------------+
         ^                 |
         |                 v
       MUSIC_DIR  <--  MUSIC_DIR/ytm   (files appear, the indexer picks them up)
```

Request flows in detail, including offline playback, the service worker update and the rollback
path: `docs/ARCHITECTURE.md`.

## Features

### Search and playback

- Unified search over the local library and YouTube, with suggestions and typo-tolerant local
  suggestions.
- Immediate playback; the best copy is served when a track exists both locally and online.
- Persistent bottom player with queue, play/pause, next/previous, shuffle, repeat, sleep timer,
  keyboard shortcuts and MediaSession (lock screen) handlers.
- Clickable artist link from the player and every track row.

### Library

- Artists, Albums, Tracks, Genres pages as grids with sorting, filters, infinite scroll, an A-Z
  index on mobile, "no year" and "never played" filters.
- Full artist (top tracks and albums), album (tracklist) and playlist pages for local and YouTube
  content.
- Library hub with quick access to For you, Artists, Albums, Tracks, Genres, Favourites, Recent,
  Offline and Account.
- Mixes by decade, genre, year and crossovers; album and artist of the day; duplicate-album report.

### Radio and queue

- Starting a track starts an infinite radio of similar tracks (real YouTube radio, also for a local
  track whose online twin is found); local continuation inside the same decade, genre or mix.
- Prefetch of the next tracks for seamless transitions (measured gap: 29 ms median on cached local
  tracks).
- Queue actions: play next, add to queue, drag to reorder, clear, save the queue as a playlist.
- Tracks skipped twice are excluded from recommendations.

### Account and personal data

- Sign in by first name (multi-user profiles stored on the server, no password by owner's decision).
- Favourites, followed artists, server playlists, listening history: everything persists across
  sessions and devices. An anonymous device profile keeps the same features without signing in,
  and is merged into the named profile at sign-in.
- Resume across devices: "Resume from <device>" card, "Continue here" takes over the queue.

### Recommendations and statistics

- For you / Made for you: a mix built from your plays and favourites.
- Statistics: recent and most played, top by artist, streaks, listening clock (day x hour),
  decades, "Your year", CSV export, shareable week.

### Automatic acquisition

- Following an artist queues the progressive download of its discography into the local library
  (yt-dlp through yubal, po-tokens, rate limited, through a residential proxy).
- Playing a track you do not own queues it too (`BEATBUMP_AUTOCACHE`), capped per profile per day
  (`YTM_ACQUIRE_DAILY_CAP`).
- Download queue with pause / resume / retry per task.

### Quality

- Quality score per track (codec, bitrate, sample rate).
- Upgrade in place: a better copy replaces a lower-quality one in the background.

### Lyrics

- Synced lyrics from [lrclib.net](https://lrclib.net), from the player and the fullscreen view.

### Downloads, three ways

1. **Offline (in the app)**: the service worker caches the track for playback without network.
2. **To the device**: saves the real audio file (Downloads / Files) for tracks in the local library.
3. **Server side**: adds the track or discography to the local library (see Acquisition).

### Offline (PWA)

- App shell and already-visited data available offline; explicit "keep offline" per track, album,
  playlist or mix; pins never evicted; storage quota and "free up space"; sized packs ("1 hour",
  by duration) and a Friday weekend pack; data-saver mode.
- A track is auto-cached only after a counted play (half the track or two minutes), so a single
  skipped try never downloads 300 MB silently.
- After an update the app reloads once, at the end of the current track or on pause, never
  mid-song.

### Mobile

- Touch fullscreen player: Back, View artist, Download, Lyrics, close by swipe down; share target
  (Android) accepts YouTube, Spotify, Deezer and Apple Music links.

### Sharing

- Open Graph cards for link-preview robots (WhatsApp, Telegram, Signal, Discord...) on `/listen`,
  `/release` and `/playlist`; humans get the normal app.

## Updating and rollback

The app image is promoted, never rebuilt in production: the exact image that passed the staging
harness is tagged and started. `ops/promote.sh` does that and, before recreating the container,
saves the image to a verified tarball (`gzip -t`, size check), keeps the previous image under a
`prod-backup-<timestamp>` tag and the previous compose file under `docker-compose.yml.pre-*`. It
prints the two exact rollback commands (by tag and by tarball) at the end.

Why tarballs: a scheduled Docker cleanup once deleted the production image and its rollback tags
under the running container (containerd image store). Tarballs outside the Docker store are the
real backup; `ops/smoke.sh` restores the tag from the tarball every morning if it is missing.

Why a "deploy survives" probe: `e2e/probe-deploy-survives.cjs` keeps one persistent browser
profile across two builds (seed on the old build, verify after the upgrade, verify again after a
rollback). It is mandatory whenever `app.html`, `manifest.json`, the service worker, the root
layout or anything the service worker imports changed. It is what found the rollback bug fixed in
cycle 59 (SPA routes now carry the shell's content ETag, `static_etag.go`).

Full procedures: `docs/OPERATIONS.md`.

## Testing

Unit and static checks (run in each tree before merging):

```sh
# Go (the Dockerfile uses golang:1.24.5)
go vet ./... && go test ./...

# Front end
cd app && npm ci && npx vitest run
npm run check          # svelte-check; the error count must not exceed ops/svelte-check.baseline (411)
```

The svelte-check baseline is a ceiling inherited from upstream, never a target: a change may lower
it (commit the new number in the same change) and must never raise it.

End-to-end, in a real browser (Google Chrome in a Playwright container with `--network host`,
run from the host that serves the app; Docker is the only requirement):

```sh
cd e2e
./run.sh                                                  # http://127.0.0.1:8080, harness-core.cjs, fixtures query
./run.sh http://127.0.0.1:8080 "" harness-core.cjs        # ~100 steps: browse, play, queue, lyrics, stats...
./run.sh http://127.0.0.1:8080 "" harness-offline.cjs     # 20 steps: caching, pins, packs, offline playback
./run.sh http://127.0.0.1:8080 "" harness-smoke.cjs       # 5 steps in under 90 s
```

`run.sh [url] [query] [harness] [extra harness args...]`: the URL defaults to `YTM_URL` or
`http://127.0.0.1:8080`; an empty query uses the `query` key of the fixtures file. Options
(environment variables, forwarded to the container):

| Variable | Values | Effect |
|---|---|---|
| `HARNESS_TIER` | `chain` (default), `full` | `chain` skips four slow, never-regressing steps; `full` plays everything (used on production after a promotion) |
| `HARNESS_ONLY` | `a,b` | play only those steps (a new step is always played alone first) |
| `HARNESS_FIXTURES` | `<file>` | fixtures file instead of `e2e/fixtures.json` (the steps' tracks, album, artist, genre, robot UAs) |
| `HARNESS_RESOLVER` | `MAP *.example.org 127.0.0.1` | Chrome `--host-resolver-rules`, used only when the URL host is a name (a host whose hairpin NAT is broken) |
| `HARNESS_RESOLVE_IP` | `127.0.0.1` | where the harness's Node-side requests connect for that name (SNI and Host kept); defaults to the single IP of `HARNESS_RESOLVER` |
| `HARNESS_STATS_INCLUDE_HARNESS` | `0`, `1` | override the runtime probe that decides whether the target records harness plays (`YTM_STATS_INCLUDE_HARNESS=1` on the server); the steps that need counted plays are skipped otherwise and listed in `report.envSkipped` |
| `YTM_SMOKE_EXPECT` | `<sha>` | the version the smoke harness must see |
| `HARNESS_GOTO_QUIET_MS`, `HARNESS_GOTO_CAP_MS` | ms | the post-navigation quiet window (1500) and its cap (4000) |
| `YTM_RUN_SKIP_BUILD_WAIT`, `YTM_BUILD_LOCK`, `HARNESS_LOAD_MAX`, `HARNESS_WAIT_MAX` | | the guards: one browser at a time (exit 2), wait for the build lock, wait for a 1-minute load under 60 (15 min max) |
| `HARNESS_IMAGE`, `HARNESS_CHROME_IMAGE` | | image overrides (`mcr.microsoft.com/playwright:v1.47.0-jammy`, `ytm-harness-chrome:1.47.0` built from `e2e/chrome-image`) |

Each run writes `e2e/out/<timestamp>/report.json` (`passed`, `failed`, `upstream`, `skipped`,
`skippedTier`, `envSkipped`, `gated`, per-step duration, `firstSoundMs`) and one screenshot per
step; the last console line is `Report: N passed / M failed / K upstream / S skipped`. A step
whose precondition is not met (library too small, no owned YouTube track in the fixtures) prints
`SKIP <name> - <reason>` and never counts as a failure. `e2e/fixtures.json` pins the tracks, album,
artist and genre the harness uses so that no run triggers a new acquisition; on a fresh install
write your own fixtures file from your library (`/api/v1/local/songs`, `/api/v1/local/albums`) and
pass it with `HARNESS_FIXTURES`. Every browser context sends `X-Ytm-Harness: 1`;
`node e2e/check-harness-headers.cjs` verifies that statically. `e2e/harness-lib.cjs` holds the
shared helpers (`rawRequest`, `skip`, `requireLibrary`, `loadFixtures`).

## The autonomous loop

The repository ships the loop that produced it: a staging chain (`ops/stage-cycle.sh`: build,
restart staging, header checks, both harnesses), guards (svelte-check ceiling, harness header
check, gated-step check, deploy-survives probe), promotion with verified backups and a browser
smoke (`ops/promote.sh`, `ops/smoke.sh`), a journal (`ops/journal.py`), weekly measurements with
alert thresholds (`ops/weekly.sh`, `ops/monday.sh`) and a recipe for audits and brainstorms. In a
48-hour program (30 September to 2 October 2026) it ran 58 promoted cycles over 74 staging chains,
then a cycle 59 on 4 and 5 October that applied 21 pending product decisions by their recommended
defaults. `AGENTS.md` is the hand-over for an AI agent taking the loop over; `ops/README.md`
documents each script; the lessons are in `CHALLENGES.md` and `AGENTS.md`, and the raw (French)
journal of the program is kept privately by the maintainers.

## Status and limits

- **YouTube playback depends on invidious-companion and on your IP reputation.** Datacenter IPs
  are often blocked or throttled; the production setup uses a residential egress proxy and a
  bgutil po-token provider. yt-dlp must be kept current (YouTube changes its SABR and n-sig
  schemes; see `CHALLENGES.md`). Local playback never depends on YouTube.
- **French UI** (see the top of this file).
- **Single-box design.** One Go server, one SQLite file, one Meilisearch, one bridge. No
  horizontal scaling, no multi-tenant isolation; profiles are first names without passwords and
  the app is meant to sit behind your own reverse proxy and bot wall.
- The bridge, the indexer and yubal have no staging in the production layout; changing them is a
  maintenance window.
- The `ops/` scripts were written for one production host (its paths, host names and container
  names); `ops/README.md` and `ops/env.example` say how to adapt them. `up.sh` and `deploy/` are
  the portable part.
- Upstream merges need a re-patch: this fork diverged widely from Beatbump.

## Credits and license

- [Beatbump](https://github.com/giwty/Beatbump) by giwty, a continuation of
  [Beatbump by snuffyDev](https://github.com/snuffyDev/Beatbump): the SvelteKit front end and the
  Go server this fork grew from.
- [invidious-companion](https://github.com/iv-org/invidious-companion): the YouTube oracle.
- [Meilisearch](https://www.meilisearch.com/): the local library index.
- [yubal](https://github.com/guillevc/yubal) and [yt-dlp](https://github.com/yt-dlp/yt-dlp), with
  [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider): acquisition.
- [lrclib.net](https://lrclib.net): lyrics. [Playwright](https://playwright.dev): the harness.

This repository is derived from Beatbump by snuffyDev, published under the **GNU Affero General
Public License v3.0 (AGPL-3.0)**, through the giwty/Beatbump fork (which carries no license file of
its own). This repository keeps AGPL-3.0: the full text is in `LICENSE`, the attribution is in
`NOTICE`. If you run a modified version for other people over a network, the AGPL requires you to
offer them the corresponding source.

## Repository, mirror and releases

- Canonical repository: <https://forgejo.ekaii.fr/Ekaii/beatbump> (issues, pull requests, CI).
- GitHub mirror (read-only, updated by push mirror; a fork of giwty/Beatbump): https://github.com/uncaney/beatbump
- Releases are git tags `vX.Y.Z`. Release notes live in the root `CHANGELOG.md` (Keep a Changelog
  format, starting at 1.0.0). The release workflow publishes the images to the Forgejo container
  registry; `deploy/compose.images.yml` is the compose override that pulls those images instead of
  building locally.
