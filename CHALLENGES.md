# CHALLENGES.md: the problems that come back, and their fixes

Each entry: symptom, cause, fix, how to detect. All of them happened during the 48-hour program
(30 September to 2 October 2026) or cycle 59 (4 and 5 October); chain numbers and dates refer to
the program's `CYCLES.md` journal (kept privately by the maintainers). They are grouped by layer: deployment, front
end, harness, box, upstream, data.

## Deployment and rollback

### A. Scheduled Docker cleanup deletes the production image under the running container

- **Symptom.** `docker image ls beatbump-ekaii` no longer shows `:local` nor the
  `prod-backup-*` tags while the production container keeps running on orphan layers. Consequences: no
  rollback by tag, `docker compose up` fails for the service, the DS1 probe reports "same build
  served" (chain 76), tool images (golang, node, playwright) also vanish.
- **Cause.** Docker 29 with the containerd image store (overlayfs snapshotter) does not protect
  the image of a running container from a forced prune. Coolify's "Force Docker cleanup"
  (`force_docker_cleanup = true`, cron `0 0 * * *`, disk threshold 80 %) ran every night and pruned
  it on 1, 3 and 4 October.
- **Fix.** Three layers: `ops/promote.sh` saves every promoted image to a verified tarball
  (`docker save` to `.tmp.tar`, `gzip -1`, `gzip -t`, size over 10 MB, then `mv`; rotation of the
  three most recent only after a valid one); `ops/smoke.sh` check 0 (`prod_image_tag`) compares the
  container's image id to the `:local` tag every morning and reloads the tarball whose name carries
  that id when the tag is missing (with an `ALERT.md` block under `SMOKE_ALERT=1`); and the
  operator disables the forced cleanup or excludes `beatbump-ekaii*` (decision 3; an action in the
  Coolify UI). `finish-cycle.sh --ds1` falls back to the container's image when the tag is gone.
- **Detect.** `docker inspect -f '{{.Image}}' "$YTM_PROD_CONTAINER"` versus
  `docker image inspect -f '{{.Id}}' beatbump-ekaii:local`; `ops/smoke.sh` line `prod_image_tag`;
  `ls image-backups/`.

### B. A rollback freezes the browser on the new app shell (chains 78 and 80, fixed c59g)

- **Symptom.** After rolling back to the previous image, DS1 "verify rollback" fails on a 404 for
  `/_app/immutable/nodes/<n>.<hash>.js` requested by the page; `/home` still serves the HTML of
  the new build. The user journey survives because SvelteKit reloads on `version.json`, but every
  lazy chunk of the new shell is gone from the server.
- **Cause.** SPA routes (`/home`, `/search`, `/library/...`) are the HTML5 fallback of the Go
  static handler and carried only `Last-Modified` = build time. After a rollback the old build's
  `index.html` is not newer than the `If-Modified-Since` the browser learned from the new build, so
  the server answers 304 and the browser keeps the new shell. Invisible as long as the chunk
  hashes of the search page did not change between two builds; cycle 59 renamed almost every route
  (translation).
- **Fix.** `static_etag.go`: SPA routes carry the content ETag of `index.html`; with an
  `If-None-Match`, `If-Modified-Since` is ignored (RFC 9110, 13.1.3), so either build always serves
  a fresh shell in both directions, including a rollback to an older binary. Test
  `TestSpaRouteShellETagSurvivesRollback`.
- **Detect.** Keep the DS1 probe (`e2e/probe-deploy-survives.cjs`); it logs `CLIENT
  before-reload / after-reload / after-spa-search` with the entry script hash of the page. A 404
  requested by the page is blocking; one triggered by the service worker's background precache
  (`swNotFound`) is reported apart.

### C. Pages black or `/_app` 404 just after a deployment (cycles 26 and 27, fixed cec1510)

- **Symptom.** First navigation in a fresh context shows a black page; `failed.log` has 404 on
  `/_app/immutable/*`; `offline_badges` or `search_and_play` fail on production only, in the five
  minutes after a promotion, then pass.
- **Cause.** On activation each service-worker version deleted every other `ytm-shell-*` cache
  while a page of the other build could still be open, and the cache-first branch only covered the
  assets of its own build.
- **Fix.** The previous shell cache is kept (`shellCachesToDelete`, the last active one is
  remembered as `__ytm_last_shell__`), all of `/_app/immutable/` is served cache-first through
  `caches.match`, the hashed assets unchanged between builds are carried over, and a missing
  `/_app` asset is a `404 no-store` on the server (never the HTML shell).
- **Detect.** `probe-postdeploy.cjs` (fresh context every 20 s for 4 min: `notFound` and `errs`
  must be empty); the 90-second rule before the offline harness; DS1 `0 HTML under _app`.

### D. The production compose carried secrets in clear (decision 17)

- **Symptom.** `COMPANION_SECRET_KEY` visible in `docker-compose.yml` and in the staging compose
  copied from it; any log or report that prints the compose leaks it.
- **Fix.** `env_file:` pointing at a file in mode 600 outside any repository
  (`beatbump.env`, `beatbump-staging.env`), written by `promote.sh` idempotently (only if the file
  exists in mode 600 and carries the key); the clear line is removed from `environment:`. Compose
  gives `environment:` precedence over `env_file:`, so the clear line must never come back.
- **Detect.** `grep -c COMPANION_SECRET_KEY: docker-compose.yml` = 0;
  `docker compose config -q`.

### E. `docker ... --filter ancestor=` deleted production (30 September, 22:47 UTC)

- **Symptom.** The production container gone one minute after a cleanup of an orphan container.
- **Cause.** Production and staging run the same image after a promotion; a filter by image
  matches both. The orphan came from `docker run beatbump-ekaii:staging sh -c` on an image without
  a shell.
- **Fix.** Kill and remove by exact name only; inspect an image with `docker create` + `docker cp`.

## Front end (only a real browser sees these)

### F. Temporal dead zone from a top-level store subscribe across an import cycle (chains 45 and 46)

- **Symptom.** 104 page errors "Cannot access x before initialization" on every page; chain core
  2/18 then the browser closes. vitest green.
- **Cause.** `SessionListService.subscribe(...)` added at the top level of `player.ts`, while
  `player.ts` is both inside the import cycle `player <-> sessionList` and the entry of dynamic
  imports (`sleepTimer`, `resumeState`, `nowPlayingSync`): `player` is evaluated before
  `sessionList`, the `const` is in its dead zone. The first fix named the store wrong ("list is not
  defined", 104 errors again) and svelte-check had risen from 411 to 413 without anyone reading it.
- **Fix.** Subscribe where the store is defined (`sessionList.ts`); a structural test of import
  cycles (`c48c`, extended to routes and `.svelte` in c52b); the svelte-check baseline as a hard
  gate.
- **Detect.** `pageerrors.log` with the same error on every page (a short Playwright probe that
  opens one page and prints `pageerror` events shows the chunk and the column); a rise of the
  svelte-check count.

### G. `<progress value={undefined}>` freezes the Svelte 4 scheduler (chain 60, fixed f74f7e8)

- **Symptom.** The "Espace" card shows a greyed selector and a button stuck on "Preparation...";
  then nothing in the app re-renders. `PAGEERROR non-finite double` twice. Four offline steps red.
- **Cause.** Svelte 4 sets `value` as a DOM property; the setter rejects `undefined`; the
  exception escapes `flush()` before `update_scheduled = false`, so every later update is dropped.
- **Fix.** Indeterminate bar (no `value` attribute) while planning; a jsdom component test that
  fails on the old sha (`vite.config.ts` aliases `svelte` to the browser build for `jsdom` tests).
- **Detect.** A control frozen on the screenshot with a `non-finite` page error; an app that stops
  reacting without a navigation error.

### H. `scrollIntoView` during the page crossfade freezes the outro (cycle 56, `routeSettled.ts`)

- **Symptom.** Black screen after "Preparer 2 h" (link `?pack=dur:7200`) on the installed Android
  PWA; no error anywhere; a reload fixes it.
- **Cause.** The root layout keys each page and crossfades it over 150 ms; during the fade the
  outgoing page stays in the flow at opacity 0. A `scrollIntoView` from an `onMount` of the new
  page scrolled the container, woke the outgoing home (infinite scroll grew from 2 965 to 4 049
  px), the re-render destroyed a child mid-outro and the Svelte 4 outro counter was never
  decremented: the old page stayed at opacity 0.
- **Fix.** `app/src/lib/routeSettled.ts`: scroll only once no `.app-transition-wrapper` is
  animating (rAF loop, 600 ms cap); applied to the Espace card, `genres#rares` and the album of the
  day shortcut. jsdom test red before.
- **Detect.** Harness step `weekend_pack_no_black_screen` (one wrapper, `scrollTop 0`); any new
  `scrollIntoView` in an `onMount` is a review flag.

### I. `timers.set = setTimeout` passes in Node, "Illegal invocation" in browsers (chain 35)

- **Symptom.** `no_page_errors` fails with 42 `TypeError: Illegal invocation`.
- **Cause.** `createPersistScheduler` called `timers.set` with `this` = an object; browsers check
  the receiver of `setTimeout`, Node does not.
- **Fix.** Wrap globals (`(ms, fn) => setTimeout(fn, ms)`); keep `no_page_errors`, and print
  the stack of the first page error when it fires (the fix came from reading it).

### J. A wrapper keyed on `$page.url.pathname` mounted every page twice (c48c)

- **Symptom.** The Account form is recreated 150 ms after a SPA navigation while a track starts:
  what was just typed is erased.
- **Cause.** The layout key changed twice per navigation (store update then URL).
- **Fix.** Key on `location.pathname` in `beforeUpdate`. Step `login_keeps_inflight_writes`.

### K. Global CSS button rule beats component styles (audit UX v9, fixed 273be55)

- **Symptom.** Nine buttons unreadable in production (black on dark, capitals) after a change
  that lengthened the global selector with `:not(.btn-reset):not(.btn-primary)...`.
- **Cause.** The selector's specificity went from (0,1,1) to (0,5,1) and beat every opt-out.
- **Fix.** Opt-outs inside `:where()` (specificity unchanged); a button system
  (`.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-reset`) loaded from the one stylesheet the
  app really uses (`global/redesign/modules/_button.scss`); harness step `buttons_readable`
  (text/background contrast on ten targets); a structural ratchet on bare buttons.

## Harness

### L. Harness selectors tied to UI strings break on translation (chain 75)

- **Symptom.** Core 75 PASS then a cascade (`local_suggestions`, `search_empty_state`, then the
  browser closes); offline 11/20 with `search_and_play` in timeout; zero page errors.
- **Cause.** The search opener was located by `aria-label*=earch` / `placeholder*=earch`;
  "Rechercher" contains neither.
- **Fix.** Selectors widened to the French labels in `harness-core.cjs` and `harness-offline.cjs`;
  prefer `data-testid` attributes for anything a translation may change.
- **Detect.** A chain that goes red right after a lane that touched labels; the first failing
  step is one that opens the search.

### M. Deny-word checks hit YouTube metadata (chain 77)

- **Symptom.** `french_origin_screens` fails on "The Pop Culture Shuffle", "Love Theme from
  Interstella", and on "SUITE" (rendered in capitals by CSS).
- **Cause.** Single English words in the deny list also occur in song titles; the regex was
  case-sensitive.
- **Fix.** Deny list reduced to interface phrases (36), the matched context printed in the detail,
  "Suite" matched case-insensitively. YouTube data is never translated and never checked.

### N. Harness traffic polluted production statistics and triggered acquisitions

- **Symptom.** 66 "active profiles" over seven days for 3 humans; 134 `play_events` from 62
  throw-away anonymous profiles, all on the fixture catalogue; Despacito and Gangnam Style
  acquired by the tests.
- **Cause.** `harnessRequest` only recognised the `HeadlessChrome` UA or the `X-Ytm-Harness: 1`
  header; Playwright contexts with a custom UA (iPhone, the capture scripts) sent neither. Every
  play of an unowned track queued an acquisition.
- **Fix.** Server: `harnessRequest` also recognises the fixture UAs and `playwright`; a harness
  play never triggers an acquisition (decision 4, 2a56778) and never writes history, now-playing
  or client-log. Harness: `X-Ytm-Harness: 1` on all 78 contexts (`newHarnessContext`,
  `HARNESS_HEADERS`, inline for stand-alone probes), `node e2e/check-harness-headers.cjs` blocking
  in `stage-cycle.sh`. Data: decision 20 purged the 134 rows after an online backup. Fixtures
  (`e2e/fixtures.json`) pin an already-owned track so no run acquires anything.
- **Detect.** During a production `full` run, `select count(*) from play_events where played_at >
  <run start>` in `mode=ro` must be 0; `weekly.sh` column (k) counts "profils humains" excluding
  fixture-only profiles.

### O. One vitest at a time per tree; never merge during the verification (chains 57 and c51)

- **Symptom.** `svelteRuntimeChunk.test.ts` red while another vitest runs in the same tree; a
  chain that built a sha nobody verified (`finish-cycle` announced d2e7eed, `stage-cycle` built
  bd51e7e merged twenty seconds earlier) and failed on two stale step contracts.
- **Cause.** The test builds with rollup in a temp folder; `stage-cycle.sh` reads HEAD at
  `docker build` time.
- **Fix.** Rules 8 and 9 of `AGENTS.md`; merge only after the "chain N on <sha>" line.

### P. The Playwright `request` context ignores `--host-resolver-rules` (chains 32 and 66)

- **Symptom.** `share_preview_and_owned` 404 and `artists_header_folded` "Connection timeout"
  while `curl` from the box gets the OG card.
- **Cause.** `--host-resolver-rules` is a browser flag; `context.request` resolves DNS itself and
  hits the broken hairpin NAT (public names resolve to the WAN).
- **Fix.** Node `https.request` to `127.0.0.1:443` with `servername` (SNI) and a `Host` header, or
  `fetch` from the page.

### Q. `page.route` does not see requests served by the service worker; `setOffline` does not cut them

- **Symptom.** A step that intercepts an API call never sees it; `me_pages_offline_message`
  still gets real data offline.
- **Fix.** Use a context with `serviceWorkers: "block"` for interception, or stub `fetch` in the
  page for the offline case; keep the SW for everything else.

### R. `networkidle` never arrives during playback (chain 18c)

- **Symptom.** Seven `page.goto` timeouts; the restoration at start-up loads the source and the
  SW caches the whole track.
- **Fix.** `gotoQuiet`: `domcontentloaded`, then the first of real `networkidle`, 1.5 s without a
  new request (the open audio stream does not count), or a 4 s cap (`HARNESS_GOTO_QUIET_MS`,
  `HARNESS_GOTO_CAP_MS`). Core went from 689 s to 446 s.

### S. A step that hangs, a module that throws at load (chains 47 to 50)

- **Symptom.** Core at 71 PASS then nothing: no `Report` line, the chain killed by its timeout;
  `finish-cycle` reads the offline report as the core and says NOT GREEN.
- **Cause.** `const URL = ...` in `steps-c45-core.cjs` shadowed the global; `new URL(URL)` threw
  "URL is not a constructor" before the step guard; `harness-core` did not catch module errors.
- **Fix.** `globalThis.URL`; every grafted module wrapped in try/catch (`FAIL module_<name>`);
  hard per-step timeout (3 x budget, 180 s minimum) so a hang becomes a FAIL and the run goes on.

### T. Gated steps left gated for more than one chain (chains 77, 61 to 63)

- **Symptom.** A step stays in `C<N>_SKIP` for several chains; nobody validated it; the promotion
  carries an unproven feature.
- **Fix.** Rule: gated for one chain, played alone with `HARNESS_ONLY=<name>`, enabled next
  chain. `report.json.gated` lists what is gated; `finish-cycle.sh` writes `ops/gated.prev` and
  refuses (exit 3) a step gated two chains in a row unless `FINISH_ALLOW_GATED=1`.

### U. Chromium without AAC: `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` in the harness only (1 October)

- **Cause.** The stock Playwright Chromium has no AAC decoder; `/aud` serves m4a.
- **Fix.** Real Google Chrome in the harness image (`e2e/chrome-image`, `PW_CHANNEL=chrome`),
  rebuilt by `run.sh` when pruned; the fallback prints a warning.

## The box

### V. Box load is the first cause of flake; Chromium dies and cascades (chains 30, 79, many)

- **Symptom.** `ERR_CERT_VERIFIER_CHANGED` then `ERR_INTERNET_DISCONNECTED` in `failed.log`,
  black page from step 1 (offline 9/17 on production, 17/17 twenty minutes before); or Chromium
  dies while closing a context and 33 steps fail "browser has been closed" (chain 79, load 32, no
  OOM). First sound at 19 s right after a deployment (cold start).
- **Cause.** A shared host at 1-minute load 35 to 50 (other unrelated services, containerd,
  a staging build in parallel).
- **Fix.** `run.sh` waits for the build lock and for a load under 60 (15 min max), refuses a
  second browser; no production harness during a build; `FLAKY_KNOWN` gives one automatic rerun
  to `offline_badges`, `mediasession_real_handlers`, `first_run_and_live_region`, `artist_page`,
  `resume_remote`, `queue_reorder_next`, `lyrics_from_player_mobile`, `lyrics_fast_after_open`
  (core) and `offline_badges`, `resume_remote`, `queue_reorder_next`, the two lyrics steps
  (offline); `UPSTREAM` classification for network and YouTube `next` errors; a step is added to
  `FLAKY_KNOWN` after being green on the same sha the chain before, never by raising a timeout.
- **Detect.** `cut -d' ' -f1 /proc/loadavg` at the time of the run; `report.json.upstream`;
  the same step green on the same sha in the previous chain.

### W. A detached chain dies with the ssh session; the shared ssh multiplexer saturates

- **Symptom.** `a && b && c &` over ssh: only the last link had `nohup`, the chain died with the
  session. ssh blocked over two minutes while lanes shared the ControlMaster.
- **Fix.** A script file, `nohup <script> > /tmp/<log> 2>&1 &`; `ssh -o ControlMaster=no -o
  ControlPath=none` from the operator's machine.

### X. Hairpin NAT and Traefik: test from the box with `--resolve`

- **Symptom.** From the box, `curl https://<host>/` goes to the WAN and returns another site's
  certificate.
- **Fix.** `curl --resolve <host>:443:127.0.0.1 https://<host>/...` (Traefik listens on
  127.0.0.1:443); the harness runs with `--network host` and
  `--host-resolver-rules=MAP *.<domain> 127.0.0.1`; an internal source IP also bypasses the bot
  wall's proof of work. Public names in uptime monitors running on the same host need `/etc/hosts` entries there.

### Y. Bridge start-up stat storm on a NAS (cycle 59, decision 16 window)

- **Symptom.** The bridge container recreated in 3 s but 502 on covers and player for 110 s.
- **Cause.** `_load_last_access()` stats 2 436 paths on the NFS mount at start-up before aiohttp
  listens.
- **Fix.** Done in this repository (`bridge/bridge.py`, `_load_last_access_bg`: the state file
  is read in an executor after the listener is up, and `/healthz` answers at once). The production
  bridge still runs the previous code until it is rebuilt from this tree: until then, expect about
  two minutes of unavailability per bridge restart and plan the window.
- **Detect.** `docker logs` of the bridge: time between start and the first request served; the
  compose healthcheck on `/healthz`; `df` under `timeout 10` on the music mount (a hung NFS mount
  also wedges Docker).

### Z. The first play right after a container start gives `MediaError`

- **Fix.** `stage-cycle.sh` warms the staging (three `home.json` + one `search.json`, then 20 s)
  before the harness; `promote.sh` probes `stats/library` and a Range on a local track.

## Upstream (YouTube)

### AA. yt-dlp pin versus YouTube's SABR and n-sig changes

- **Symptom.** 403 on every download (SABR), or "Signature solving failed" / "n challenge solving
  failed" with throttled web formats, corrupt downloads and `FFmpegExtractAudio` dying on an
  extensionless file (25 to 30 % single-track failures).
- **Cause.** yubal's base image pins yt-dlp (2026.6.9) and ships no JavaScript runtime for the EJS
  challenge solver; YouTube rotates its schemes.
- **Fix.** `yubal/Dockerfile`: unpin yt-dlp to latest at build time (the Dockerfile comment notes a
  runtime cron keeps it current on the original production host; that cron is not in this repository), install
  deno (`DENO_DIR=/tmp/.deno`), install `bgutil-ytdlp-pot-provider` with `--no-deps`, and
  `sitecustomize.py` forces the egress proxy (`YTM_YTDLP_PROXY`, empty = direct) and the bgutil
  po-token provider (`YTM_POT_BASE_URL`) into every `YoutubeDL`. Rebuild the yubal image
  (`./up.sh build yubal`) whenever downloads start failing in bulk; pin the base with
  `--build-arg YUBAL_BASE=` if a yubal release regresses.
- **Detect.** `weekly.sh` column (h): zero tracks downloaded with failures raises an `ALERT.md`
  block; `docker logs --since 168h "$YTM_ACQ_CONTAINER" | grep -c 'Downloaded:'`.

### AB. `/vp` throttled to 18 KB/s (n-sig not transformed) and IP reputation

- **Symptom.** `PIPELINE_ERROR_READ` for real users on tracks outside the library; first byte 4
  to 9 s on a never-heard track.
- **Cause.** The companion's googlevideo URLs keep an untransformed `n` parameter (client
  `TVHTML5_SIMPLY`); datacenter IPs are throttled or blocked.
- **Fix (production layout).** YouTube audio goes through `/aud/<id>` (an iv-vp sidecar that
  downloads then serves, at about 500 KB/s, same egress IP), `YTM_PREFER_IVVP_AUDIO` controls it;
  `PLAYER_TIMEOUT_SECONDS` 20 s bounds the wait; a residential egress proxy for everything YouTube.
  Decision 2 (fix n-sig in the bridge) was declined: the bridge has no staging. The portable stack
  (`deploy/compose.yml`) has no iv-vp and keeps audio on `/vp` with `YTM_PREFER_IVVP_AUDIO=0`;
  set `EGRESS_PROXY` to a residential proxy and `IVVP_UPSTREAM` if you run such a sidecar.

### AC. YouTube `next` answers "Invalid response" intermittently

- **Fix.** Classified `UPSTREAM` by the harness (not a failure); lyrics steps are in
  `FLAKY_KNOWN`. Three Mondays in a row on the same step means a determinism lane.

## Data

### AD. Meilisearch facet limits hide genres (decision 18)

- **Symptom.** The Genres page lists 100 values in alphabetical order (A to B plus a few);
  "Metal 26" while "Heavy Metal" has 54; a genre filter keeps only the combined tags present in
  the first 100 facet values (`Rock` 75 tracks instead of thousands, L11-1).
- **Cause.** Default `maxValuesPerFacet` = 100, sorted alphabetically.
- **Fix.** Server side, the exact value is always in the filter (7ccd733) and facet-search is
  used; index side,
  `PATCH /indexes/tracks/settings {"faceting":{"maxValuesPerFacet":1000,"sortFacetValuesBy":{"genre":"count"}}}`
  (applied 5 October: 109 to 462 genres). Rollback: `maxValuesPerFacet` 100, `"*":"alpha"`.
- **Detect.** `GET /api/v1/local/genres` count; `ops/library-lint.py` section 3.

### AE. Cross-profile cache leak (audit L8-1, cycle 29)

- **Symptom.** `local/related?seed=favorites` of one profile served to everyone for five minutes.
- **Cause.** A shared response cache keyed on the URL only.
- **Fix.** `CacheResponseUnless` (per-profile seeds answer `X-Ytm-Cache: BYPASS`), home cache
  cleared at login/logout, a two-profile Go test. Any new cached route that reads the profile
  cookie must use it.
- **Detect.** `X-Ytm-Cache` header on a per-profile route must be `BYPASS`.

### AF. Flaky Go tests from global memos

- **Symptom.** `TestLocalMixExcludesCopies` red 3 runs out of 10 on the same sha.
- **Cause.** `trackKeyMemo` is a package-level memo; tests reuse a lid.
- **Fix.** `resetTrackKeyMemo` in the fixtures; `go test -count=3 ./backend/api/` in the
  verification.

### AG. Covers extracted on every request (decision 16, c59d)

- **Symptom.** `/cover` p90 2.5 s, p99 8 s in bursts on the home page.
- **Fix.** On-disk cover cache in the bridge (`COVER_CACHE_DIR`, `X-Ytm-Cover: HIT|MISS`),
  semaphore of 4 extractions, 404 remembered one hour (bridge and Go proxy), `Cache-Control`
  immutable 7 days, LRU cover cache in the service worker. p90 365 ms to 14 ms warm.
