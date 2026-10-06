# Changelog

All notable changes to this fork are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The version served at runtime
(`version` in `/api/v1/stats/library` and on `/about`) is stamped at build time;
release images carry `v<VERSION>+<git short sha>`, local builds the short sha.

The 1.0.0 entry condenses the 65 production promotions of the autonomous
improvement programme (2026-09-30 to 2026-10-05) whose French, per-promotion
log is kept in `docs/archive/CHANGELOG.md`, with the final report in
`docs/archive/FINAL-REPORT.md`.

## [Unreleased]

### Added

- Nothing yet.

### Changed

- Nothing yet.

### Fixed

- Nothing yet.

## [1.0.0] - 2026-10-06

First public release of the fork. Compared with upstream Beatbump (a SvelteKit
YouTube Music front end with a Go server), this release turns the app into a
self-hosted music service that owns its data: a local library indexed by
Meilisearch and served next to YouTube, automatic acquisition, a real offline
mode, personal rows and statistics, multi-device continuity, a French
interface, and the operations and browser-harness tooling that kept it in
production during the programme.

### Added

#### Library (own the data)

- Unified search over the local library and YouTube, with instant, typo-tolerant
  local suggestions ("daft pnk" finds Daft Punk) and direct play from the
  overlay; results header with All / Songs / Albums / Artists / Playlists chips,
  the local library in its own shelf, duplicates removed.
- Local **Artists**, **Albums**, **Songs** and **Genres** pages (grids, sort and
  filters remembered per page, infinite scroll, A-Z index on mobile), local
  artist, album and playlist pages (an album page is rebuilt from the index
  when its document is missing), playable genres, a Mixes page.
- Best copy served when a track exists both locally and online; quality score
  per track (codec, bitrate, sample rate) and transparent upgrade in place.
- Automatic acquisition: following an artist downloads its discography slowly
  through the yubal sidecar (po-token, rate limited, residential egress);
  download queue with pause / resume / retry; daily cap of 20 albums per
  profile with an explicit refusal; prefetch, share, download, mixes and the
  browser harness never trigger server acquisition (`X-Ytm-Prefetch`).
- Artist variants ("feat.", case, accents) grouped for display: "Also as" chips,
  "Play all" over the group, "+N variants" badge; duplicate album detection
  (two sources, editions such as Live / Remix / Demo kept apart) with a
  suggested copy, one copy per title in mixes and related rows.
- Library hygiene on the About page: albums without a year ("No year" chip),
  rare genres (collapsed section), close artist names; genre cleanup
  (composite values split, "Singer/Songwriter" and "AC/DC" kept whole,
  soundtracks grouped).
- "In your library" section in the player's Related tab (same artist, same
  genre; `GET /api/v1/local/related`); "You already own it" banner on a YouTube
  album present locally, pointing to the local copy.
- Play all / Shuffle on favourites, server playlists, local artists and genres;
  radio targeted at an album, an artist or the favourites; "Save the queue" as
  a playlist; listening history grouped by day with "Replay this day" and a CSV
  export.
- Album metadata on local tracks, album art fallback for tracks without an
  embedded image, initials placeholder when no image exists, covers served from
  a disk cache in the bridge sidecar.

#### Player and queue

- Audio served same-origin through the Go server (`/localf`, `/vp`, `/cover`
  to the bridge, `/aud` to iv-vp), next-track prefetch (+2 at low priority),
  non-library tracks streamed at full speed through iv-vp instead of a
  throttled proxy.
- Structured `player.json` errors (`{error, status, reason, videoId}` with
  400 / 404 / 502 / 504) surfaced as French toasts, one retry on 502 / 504,
  guarded auto-skip that never cascades; media element errors mapped the same
  way; one silent source reload on a decode error before any message, the
  cached copy purged only on a second online failure and never for pinned or
  local tracks.
- Queue: "Play next" and "Add to queue" on songs, albums, singles and
  playlists, "Clear the queue" (keeps the current track), swipe to remove,
  drag and drop by touch, mouse (250 ms and 6 px guard) and keyboard
  (Alt+arrows), "Already in the queue" notice with Dedupe Automix, removing
  the playing row plays its replacement, drags replayed on the updated queue.
- Radio by default (a real YouTube radio even for a local track), local
  continuation at the end of a local queue that stays in the same universe
  (decade, genre, year), playback context line ("Album: X · 4/14",
  Favourites, Queue, Offline) with "Back to the album" after a "Play next".
- Exact resume on reopen: queue, position and context restored paused
  ("Remember last track" on by default), "Resume the queue" pill, nothing
  acquired or cached before the first play, no double counting.
- Sleep timer (15 / 30 / 45 / 60 min, end of track, end of album, in 3 tracks,
  +10 min, 3 s fade) that holds on a locked iPhone; complete keyboard
  shortcuts with a "?" sheet; heart in the mini bar and the full-screen player;
  the whole last second of every track is played.
- Synchronised lyrics (lrclib.net): click a line to seek, auto-scroll that
  pauses when you scroll, A-/A+ persisted, last lyrics cached offline.
- Lock screen and headset: ±10 s, position updates on every jump, 512 px local
  cover, position 0 honoured, "previous" restarts the track after 3 s, a play
  command counts as a gesture for cross-device resume.
- Share from the full-screen player and from a local album (native share sheet,
  copied link otherwise) with link previews (title, artist, cover) for
  messengers and a start time; the video mode is hidden, this is a music player.

#### Offline (PWA)

- Service-worker audio cache: Range / 206, LRU quota from 500 MB to unlimited,
  keys per video id, in-flight de-duplication, the playing track protected
  from eviction, list reconciled with the Cache API, eviction broadcast to
  every tab.
- Offline page: albums, artists and recent views, Play all / Shuffle / Mixtape
  (target duration, no artist twice, not heard for 30 days, new seed), per
  album state ("9/12 ready") with "Complete", failed downloads with "Retry".
- Pinning of tracks and albums (never evicted), persistent storage requested at
  the first pin, "Storage protected: yes / no" and usage in Settings.
- "Keep offline" on local and YouTube albums, server playlists and favourites:
  two downloads at a time then pinning, "9/14 ready" progress, cancel from the
  toast, quota respected, survives navigation; "Ready offline" badge on rows
  and cards; evicted entries marked "To re-download" with per-row and global
  buttons.
- Sober first day: a track is cached (and the next one prefetched) only after
  a counted listen, with the "Kept offline (N MB)" line; data saver mode
  (no prefetch, no automatic cache); auto-cache switch and quota in Settings.
- "Free 500 MB" (oldest passing listens first, never pinned tracks, preview
  before confirming), "Prepare a pack" by size (100 / 250 / 500 MB) or by
  duration (30 min to 4 h) that cancels in under a second and checks the free
  space first, "Refresh my pack" (replaces only really listened tracks with
  tracks of the same duration, pinned ones untouched), weekend pack card,
  "Take 1 h of music" first-day card.
- Offline listens queued and sent back when the network returns (idempotent
  replay, client timestamp accepted within 7 days and 5 min of the server
  clock); "Offline" banner on online pages; account pages explain they need
  the server and show the local copy of the favourites.
- Installable app named "Musique": maskable icons, manifest shortcuts (Resume,
  Offline, Search, For you, Album of the day, Commute pack), Android
  `share_target` (YouTube links, app album links, Spotify / Deezer / Apple
  titles sent to search), install prompt at the right moment (after a first
  "Keep offline" or the third visit, compact bar after the first sound, 14-day
  snooze), `/bienvenue` install page with a QR code generated in the app and
  "Send to a friend".
- Deployment-safe service worker: the previous version's cache is kept, hashed
  files are served from the caches, the update toast ("Reload now") is
  deferred while music plays, routes carry the shell ETag so a rollback never
  freezes the browser on the new shell, a `deploy-survives` probe replays
  update and rollback on an installed profile before any promotion that
  touches the worker.

#### Home and discovery

- Personal rows loaded after the first paint and hidden when empty: Resume
  (last track plus the ten last listens), For you (varied: at most two tracks
  per album and three per artist), Recently acquired, Never played,
  Rediscover (much played more than 60 days ago, forgotten for 30), New from
  your artists (last 30 days), "Arrived in <month>", Album of the day, "An
  artist you never played", "Your week" card on Mondays.
- An album appears in one row only (fixed priority), at most four personal
  rows above the YouTube rows, the rest behind "More for you"; the home is
  painted instantly from a local cache (kept up to 24 h of inactivity, warmed
  at start-up) then refreshed; it no longer waits for YouTube and retries once
  with a "Retry" button.
- Guided first visit without dead ends ("Launch a mix", "Tell me your first
  name"); the empty search box shows Resume, Trending and the five last
  searches.
- Mixes by decade, genre, decade x genre and release year (40 sampled tracks),
  "In your library" on Explore, Mix button on Explore, "Your artists" and
  "Keep offline" on every mix.
- Smart queue: skips are recorded, a track skipped twice in 30 days leaves
  For you and the continuation, no repeat within 3 hours, shuffle avoids the
  same artist twice in a row.
- The Related tab is back (YouTube moved it; detected by page type, hidden
  when empty); preloading of album / artist / playlist pages on hover or touch.

#### Statistics

- "Your month" (`/library/stats`): listens, minutes, tracks, artists,
  favourite hour (24 h histogram), local versus YouTube, top tracks / artists /
  albums over 7, 30 or 365 days; a listen counts after 30 s (or half of a short
  track), never on a track change.
- Listening streaks (current and record), day x hour grid, decades, yearly
  view (month, number-one artist and album, distinct albums, new artists),
  "Share my week" and "Share my year" with your own numbers only.
- IANA time zone for series, grid and year (DST handled), skips purged after
  90 days, history over the last 200 listens.

#### Identity and multi-device

- Sign in by first name (server-side profile); an anonymous local profile keeps
  the same features on the device. Giving a first name attaches the device's
  history, favourites, follows and playlists to the named profile (never
  merges two names, a single adoption even with two tabs, in-flight writes
  follow the name); "this device only" banner on History and Stats until then.
- Sign in / out seen by every tab (BroadcastChannel), state re-checked when the
  page comes back; one login lock per profile with a clear message and an
  automatic retry.
- Cross-device resume: each device publishes its queue, position and name every
  15 s while playing, at pause and when hidden (named profiles only, never
  offline); "Resume from <device>: title at m:ss" card on the home (nothing
  starts on its own), "Continue here" pauses the other device, device name
  editable in Account; `PUT` / `GET /api/v1/me/nowplaying`.
- Favourites written through one helper to IndexedDB and the server profile;
  server playlists (create, add, remove, delete) and follows persist across
  devices.

#### French interface

- The entire interface is in French with the informal address (search, menus,
  player, queue, Account, Library, Settings, Explore, error pages),
  `lang="fr"`, the app is called "Musique"; only YouTube data stays as it is.
- One word per concept (Pour toi, Radio, Mix, Mixtape, Garder hors-ligne),
  consistent units (Mo / Go), French error pages per status that never show
  raw YouTube text; a structural test prevents English words from returning
  on the programme's screens.

#### Mobile and accessibility

- 44 px touch targets throughout (the 12 px mobile root had collapsed every
  rem-based minimum), 16 px gutter, 12 px text floor, full-screen player that
  fits 390x844 and 360x780 without scrolling, swipe-down close, queue drawer
  reduced to its handle and inert when closed, progress line on the mobile
  mini bar.
- Contrast at or above 4.9:1 on disabled states and buttons (checked by the
  harness), one button system (solid, translucent, text; green reserved for
  states), named navigation icons, row thumbnails as "Play <title>" buttons,
  named carousel arrows, screen-reader announcement of track changes, visible
  focus, accessible kebab menus.

#### Packaging and release

- `deploy/compose.yml` and `up.sh` bring up the whole stack from a clone
  (beatbump, Meilisearch, indexer, bridge, invidious-companion, bgutil, yubal;
  secrets generated on the first run, health waited for), with
  `deploy/.env.example` documenting every variable and `deploy/VERIFICATION.md`
  what to check; `./up.sh --sample-library` fills an empty library with 18
  short CC0 synthetic tracks (`fixtures/make-sample-library.sh`);
  `deploy/compose.images.yml` switches the four images to the ones published
  on the Forgejo registry.
- English documentation: `README.md`, `CONTRIBUTING.md`, `AGENTS.md` (taking
  over the improvement loop), `CHALLENGES.md`, `docs/ARCHITECTURE.md`,
  `docs/OPERATIONS.md`, `SECURITY.md`; the `LICENSE` file (AGPL-3.0, as
  upstream).
- Images `beatbump`, `beatbump-bridge`, `beatbump-indexer` and
  `beatbump-yubal` published on `forgejo.ekaii.fr/ekaii/` by the release
  workflow on every `v*` tag (linux/amd64), with the release notes taken from
  this file and the deploy files attached.
- CI on Forgejo Actions: Go vet and tests, vitest and a svelte-check error
  ceiling (`ops/svelte-check.baseline`), shellcheck, Python byte-compilation
  and ruff, the harness header gate, and the compose configuration; a minimal
  Go check on the GitHub mirror.
- `VERSION` file, `scripts/release/` (tagging, release notes, image build,
  Forgejo release through the REST API), `SECURITY.md`, `.editorconfig`,
  `.gitattributes`, `.dockerignore`.

#### Operations and the improvement loop

- `ops/` scripts that ran the programme: `stage-cycle.sh` (build, then the
  core and offline harness on staging), `finish-cycle.sh` (svelte-check
  ceiling, repeated Go tests, service-worker guard with the `deploy-survives`
  probe, promotion, production harness), `promote.sh` (served version check,
  local track probe, image tarball backups outside the Docker store, container
  healthcheck block, access-log copy, browser smoke), `smoke.sh` (90 s, no
  acquisition), `weekly.sh` (one line per week: real usage, acquisition
  health, disk, backups, slowest endpoints, client errors; `ALERT.md` when a
  threshold is crossed), `monday.sh` (full production harness, weekly line,
  smoke), `journal.py`, `library-lint.py`, `cleanup-harness-profiles.sh`,
  `cron.weekly.example`.
- Container healthcheck carried by the binary itself (`beat-server
  -healthcheck`, the image is `FROM scratch`), build version stamped with
  `-ldflags -X main.version` (`YTM_VERSION` fallback) and served by
  `/api/v1/stats/library` and `/about`.
- Client error log (ring of 500 entries, no profile data, readable only with
  `YTM_ADMIN_TOKEN`, submissions rate limited per address), access log with
  cache state, latency script that excludes the harness, the healthcheck and
  the uptime monitor.
- Programme documents archived under `docs/archive/` (runbook, loop, decisions,
  backlog, audits, brainstorms, weekly lines).

#### Browser harness

- Real-browser Playwright harness in `e2e/`: `harness-core.cjs` (96 steps at
  the full tier on production, 98 on staging), `harness-offline.cjs` (20
  steps), `harness-smoke.cjs`, `run.sh` (one browser at a time, waits for a
  running build or a high load, real Google Chrome image for AAC / H.264,
  tiers `chain` / `full`, `HARNESS_ONLY`), fixed fixtures, enriched reports
  (tested version, durations, budgets, gated steps), YouTube failures
  classified `UPSTREAM`, one automatic retry on known fragile steps.
- Every Playwright context sends `X-Ytm-Harness: 1` (the server also
  recognises the fixture user agents), enforced by the static gate
  `e2e/check-harness-headers.cjs`; harness plays never reach production
  statistics or recommendations.
- Probes for the deploy-survives contract, the gap between tracks (29 ms
  median, gapless closed), request counts, bytes, failures and LCP per screen
  for the UX and performance audits.

### Changed

- Build: the Go server reports its version; the root `Dockerfile` takes
  `--build-arg VERSION=<git short sha>` and the deploy scripts verify the
  served version after a promotion.
- Settings: duplicate download options and dead options (Download Path,
  Ongoing Listening, Playback Updates URL) removed; one offline switch; help
  texts for Immersive Queue and Dedupe Automix; Re-sync disabled when the
  cache is empty; "Delete all playlists" hidden without a playlist and asks
  for confirmation.
- `playlist.json` accepts PL / OLAK / RDCLAK ids without the VL prefix; unknown
  sort on `local/*` answers 400 JSON; unknown `/api/*` routes answer 404 JSON
  (the service worker no longer caches the HTML shell as JSON); unknown app
  files answer 404 without caching.
- Related rows and continuation exclude by a normalised key (no duplicates by
  edition), caches split per exclusion.

### Fixed

- Fresh installs (found by running the full harness on a one-command install
  with the sample library):
  - the cold-start "For you" mix and the offline packs were empty on any
    library smaller than about 40k tracks (sample windows were drawn in a
    fixed range sized for a 54k-track library); they are now drawn inside the
    real track count;
  - every new profile logged a console 404 (`GET me/nowplaying` without a
    resume state now answers 204);
  - the app shipped a hard-coded third-party analytics script: page loads
    waited up to 45 s when that host did not answer, and every install sent
    page views to it. Analytics are now off by default and an optional build
    value (`PUBLIC_ANALYTICS_*`);
  - background "next track" lookups went through a host-specific proxy
    container and failed silently elsewhere (`RESIDENTIAL_PROXY` empty now
    means direct egress);
  - the bridge stat-ed every library file before listening (110 s on a NAS);
    it now listens at once and loads that state in the background;
  - `ops/library-lint.py` reported every album as having no year on a library
    smaller than one page.
  - the home showed no mix card for the first minutes, then possibly for a
    day: the mix list was cached at boot while the library was still being
    indexed. An empty mix list is now never cached, and `up.sh` waits for the
    first index pass before saying the stack is ready.
- Playback: pressing next skipped two or three tracks (auto-advance only on a
  known duration); clicking the paused current track did nothing; shuffle off
  fell back to YouTube with local ids; the mini-bar artist link toggled the
  full screen; two un-cancelled timers kept the full-screen player painted
  over the lyrics page; a restored queue counted a listen twice; "repeat one"
  counted every loop as a listen; a local queue restored offline with a track
  not in the cache started playing on its own with a misleading message.
- `<progress value={undefined}>` froze the whole app (Svelte 4 sets `value` as
  a DOM property, the setter throws out of `flush()`); indeterminate bar.
- Black screen after "Prepare 2 h": the Space card scrolled during the 150 ms
  page transition, which woke the outgoing page and froze the Svelte switch
  (`routeSettled.ts`); the same rule applied to rare genres and the album of
  the day shortcut.
- A local library id could reach the YouTube resolver ("offline playback
  impossible" then the next track played); local ids now only go to the local
  player with an explicit `LOCAL_NOT_FOUND` 404 and clear messages.
- Module import cycles at top level (TDZ on every page) found by a build test
  and fixed; a store subscribe at module head in an import cycle; `URL`
  shadowed by a local variable; `setTimeout` called with the wrong receiver
  (42 page errors per home visit on staging).
- Privacy: the favourites radio could be served from the shared cache to
  another profile for five minutes; the instant home cache is cleared on
  profile change; `me/*` responses are never cached by the service worker.
- Unknown artist id caused a Go panic and an "Internal Error" page; album
  year and duration were swapped for YouTube albums; the `get_queue` URL
  ("??") that caused a 500.
- Statistics polluted by the harness (134 plays on 62 throwaway profiles in
  36 h): every context now sends the header, the server recognises fixture
  user agents, the old rows were purged.
- Many layout defects from the UX audits: hidden play / pause button in the
  mini bar, drawer handle and kebab visible without hover, long titles
  ellipsised, orphan separators, buttons made unreadable by a global rule,
  artist hero under the top bar, toasts anchored above the mini bar.

### Security

- `/vp` restricted to `https`, `*.googlevideo.com` and `/videoplayback` (the
  open proxy was an SSRF); `/aud` requires an 11-character id; `/localf`
  rejects path traversal; `/cover` requires a valid local id.
- Upstream requests (including `Authorization`) are no longer dumped in the
  server logs; the client address is read only behind the reverse proxy.
- CSV export protected against formula injection; client error log reads
  gated by `YTM_ADMIN_TOKEN` and submissions rate limited; secrets moved to
  `0600` environment files; acquisition capped per profile and per day.

### Performance

- gzip on the shell, bundles and API (audio excluded); `Cache-Control` for
  hashed assets (immutable, one year), shell / worker / manifest (no-cache)
  and API (no-store); 304 revalidation of static files; vendor bundle
  444 KB to 137 KB on the wire, main application chunk 456 KB to 58 KB,
  peerjs and hls.js loaded on demand, stable chunking (Svelte runtime in its
  own file) so an update downloads only what changed.
- Server TTL cache for user-independent JSON (home 2 min, search 1 min,
  explore / trending / artist / album 5 min, next / related / suggestions,
  `X-Ytm-Cache: HIT | MISS | BYPASS`, `YTM_API_CACHE=0` to disable), `me/mix`
  computed in parallel and cached 60 s per profile, lyrics cached 24 h,
  lighter search and history payloads, missing covers memoised one hour, the
  home, `local/mixes` and artist aliases warmed at start-up; a blocked
  YouTube track fails in 20 s instead of 90 s.
- The page is mounted once (transition 1 s to 150 ms), the service worker
  precaches only the shell then batches the rest, keeps 200 covers, bounds
  its API cache (200 entries, under 300 KB) and writes the resume state only
  when the queue changes; the artists list is one index request with
  keep-alive; "Never played" is confirmed per batch; the first twelve covers
  of a list are loaded first.
- Covers served from a bridge disk cache (p90 365 ms to 14 ms); the gap
  between two cached local tracks measured at 29 ms median, 44 ms p90.

### Known limitations

- Images are built for linux/amd64 only (the root image copies the x86_64
  musl loader for ffmpeg, the yubal image downloads an x86_64 deno).
- The SvelteKit app inherits about 411 type errors from upstream; CI enforces
  a ceiling (`ops/svelte-check.baseline`) rather than zero.
- YouTube access needs the iv-vp / companion oracle and, in practice, a
  residential egress; see `CHALLENGES.md` and `docs/`.

[Unreleased]: https://forgejo.ekaii.fr/Ekaii/beatbump/compare/v1.0.0...main
[1.0.0]: https://forgejo.ekaii.fr/Ekaii/beatbump/releases/tag/v1.0.0
