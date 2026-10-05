# Operations

Deploy, roll back, check health, back up, schedule, read alerts, and the weekly report. This is
the English translation of `docs/archive/RUNBOOK.md` (written at cycle 36, French), updated for
cycle 59 (secrets in env files, cron installed, image-tag guard, content ETag on SPA routes).
Every command below exists in `ops/` or `e2e/`; a command that is not taken from a script is said
so.

Commands run **on the host that runs the containers**. The `ops/` scripts were written for one
production host: `ops/README.md` and `ops/env.example` (loaded as `ops/env.sh`) describe the host
layout they expect: the service root, the integration checkout, the staging compose, the database
and backup folders, the host names. Paths below are relative to the repository checkout unless
they are host paths printed by a script. For a fresh install, `up.sh` and `deploy/` (see
`README.md`) are the portable path; this file is the production loop.

## 0. Cheat sheet

```sh
# staging chain (build + core harness + offline harness), detached with its log; never promotes
nohup ops/stage-cycle.sh > /tmp/ytm-stage-cycle<N>.log 2>&1 &
grep -E "^(=== |PASS|FAIL|UPSTREAM|RETRY|Report|staging HTTP)" /tmp/ytm-stage-cycle<N>.log

# end of cycle in one command (chain, guards, DS1 if --ds1, promotion, journal, probe, prod harness)
FINISH_PARSE_ONLY=1 sh ops/finish-cycle.sh <cycle> <chain>           # read-only check of arguments and guards
nohup sh ops/finish-cycle.sh <cycle> <chain> [--ds1] --wait >/dev/null 2>&1 &
grep -E "svelte-check|core=|DS1|GREEN|promote.sh exit|Report|FINISH" /tmp/ytm-finish-<cycle>.log

# promotion alone (after a green chain, and a green DS1 when the guard applies)
sh ops/promote.sh <sha>

# post-deploy probe, then the production harness (full tier)
cd e2e && ./run.sh https://<host> "daft punk" probe-postdeploy.cjs
HARNESS_TIER=full ./run.sh https://<host> "daft punk" harness-core.cjs
HARNESS_TIER=full ./run.sh https://<host> "daft punk" harness-offline.cjs

# journal (CHANGELOG entry + CYCLES line) from ops/journal/cycle-<cycle>.md
python3 ops/journal.py <cycle> <sha> --chain <N> --dry-run
python3 ops/journal.py <cycle> <sha> --chain <N>

# health: HTTP smoke (13 checks, under 90 s, no browser) and the served version
sh ops/smoke.sh https://<host> [expected sha]
curl -s --resolve <host>:443:127.0.0.1 https://<host>/api/v1/stats/library
docker inspect -f '{{.Image}}' ytm-beatbump | cut -c8-19

# Monday measurements
sh ops/monday.sh                      # prod harness full + weekly.sh + smoke
WEEKLY_DRY_RUN=1 sh ops/weekly.sh     # print the line, write nothing

# rollback by one step (promote.sh prints the exact lines); general form:
docker tag beatbump-ekaii:prod-backup-<TS> beatbump-ekaii:local && cp docker-compose.yml.pre-sameorigin-<TS> docker-compose.yml && docker compose up -d --no-deps beatbump
```

## 1. The production layout in ten lines

1. One Go binary (`/app/beat-server`, port 8080, image `FROM scratch`) serves `/api/v1/*` and the
   static SvelteKit build.
2. Same-origin audio: `/localf`, `/vp`, `/cover` are reverse-proxied to the bridge
   (`COMPANION_URL`), `/aud/*` to iv-vp (`IVVP_URL`).
3. The local library is indexed in Meilisearch (`MEILI_URL`) by the indexer; acquisition by
   yubal.
4. Service worker: shell cache `ytm-shell-<version>`, `ytm-api` (network-first, never
   `/api/v1/me/*`), `ytm-offline-audio` + `ytm-offline-meta`, `ytm-covers`.
5. Network entry: reverse proxy (Traefik) and a bot wall in front of the container; from the host,
   `127.0.0.1:443` is the proxy.
6. Production: container `ytm-beatbump`, image `beatbump-ekaii:local`, the production compose
   file, the SQLite folder.
7. Staging: container `ytm-beatbump-staging`, image `beatbump-ekaii:staging`, its own compose
   project (`ytm-staging`), its own database, its own host name.
8. Both join the external networks of the music stack and of the companion.
9. Reference code: the integration checkout (branch `agents/integration`).
10. The bridge, indexer and yubal have no staging: touching them is a maintenance window.

Camille's production layout (the concrete values the scripts were written against; the generic
form is in `ops/env.example`): service root `/srv/beatbump`; integration checkout
`agents/integration`; staging compose `agents/staging-compose.yml`; database `beatbump-db/`;
backups `image-backups/`; env files `beatbump.env` and `beatbump-staging.env` (mode 600);
hosts `music.ekaii.fr` and `staging-music.ekaii.fr`; box `docker-host`, reached with
`ssh -o ControlMaster=no -o ControlPath=none`.

## 2. Deploy

Recommended path since cycle 39: one detached command chains the staging chain, the guards, the
promotion and the production harness:

```sh
FINISH_PARSE_ONLY=1 sh ops/finish-cycle.sh <cycle> <chain> [--ds1]
nohup sh ops/finish-cycle.sh <cycle> <chain> [--ds1] [--no-promote] [--wait] >/dev/null 2>&1 &
grep -E "core=|DS1 fails|GREEN|promote.sh exit|Report|FINISH" /tmp/ytm-finish-<cycle>.log
```

It refuses to start if a `ytm-harness-*` container runs (unless `--wait`, 60 min max), if
`/tmp/ytm-stage-cycle<chain>.log` exists, or if `ops/journal/cycle-<cycle>.md` is missing. It
promotes only if the chain is green (two `Report: P passed / 0 failed` lines, core P >= 50,
offline P >= 17 by default, and the staging serving HEAD's sha), if the svelte-check count is at
or under `ops/svelte-check.baseline`, if no step is gated two chains in a row, and if DS1 passed
when the SM2 guard applies. Exit codes: 0 done, 1 refused, 3 not green (nothing promoted), 4
`promote.sh` failed. Last line of the log: `FINISH <cycle> DONE`.

### 2.1 Staging chain (`ops/stage-cycle.sh`)

Builds the integration HEAD under `flock /tmp/beatbump-build.lock` with
`--build-arg VERSION=$(git rev-parse --short HEAD)`, restarts the staging project, warms it
(three `home.json` and one `search.json`, then 20 s), checks `content-encoding` and
`cache-control` on `/home`, `home.json`, `/service-worker.js`, one hashed chunk, and a Range on
`/aud/<fixture>`, runs `node e2e/check-harness-headers.cjs` (stops if red), then
`HARNESS_TIER=chain timeout 900 ./run.sh <staging> "daft punk" harness-core.cjs` and the same
for `harness-offline.cjs`. It never promotes.

Pass criterion: no `FAIL` in core nor offline. `UPSTREAM` (YouTube `next`, the harness browser
losing the network) does not count. `RETRY` then `PASS` is green. A `FAIL` must be explained and
replayed before any promotion.

### 2.2 The SM2 guard and DS1

DS1 (`e2e/probe-deploy-survives.cjs`, one persistent browser profile across two builds) is
mandatory before `promote.sh` when any of these changed since the production sha:
`app/src/service-worker.ts`, `app/src/routes/+layout.svelte`, `+layout.ts`, `app/vite.config.*`,
`app/svelte.config.js`, `app/scripts/svelteRuntimeChunk.ts`, `app/src/lib/utils/sharedJobs.ts`,
`app/src/app.html`, `app/static/manifest.json`, or any file the service worker imports
(followed recursively). The guard is closed by default: an unreadable production version, a sha
unknown to integration or not an ancestor of HEAD also require DS1. Not covered: a version bump
of an npm package the SW imports; play `--ds1` by hand then.

```sh
FINISH_PARSE_ONLY=1 sh ops/finish-cycle.sh <cycle> <chain>      # prints "garde SM2 maintenant : ..."
printf 'app/src/lib/utils/sharedJobs.ts\n' | FINISH_GUARD_TEST=- sh ops/finish-cycle.sh   # exit 3 = DS1 required
```

`finish-cycle.sh --ds1` plays the sequence: staging on the production image, `probe-ds1-seed.cjs`;
staging on the new image, `probe-ds1-verify-upgrade.cjs`; staging back on the production image,
`probe-ds1-verify-rollback.cjs`; staging restored on the new image. Green = `[ds1
verify:upgrade] PASS` and `[ds1 verify:rollback] PASS` (`e2e/out/ds1-upgrade.json` and
`ds1-rollback.json` with an empty `fails`). A 404 requested by the page blocks; one triggered by
the SW's background precache (`swNotFound`) does not.

### 2.3 Promotion (`ops/promote.sh [sha]`)

In order: prints the staging image id and the expected version (the argument, else the version
the staging serves); copies the production compose to `docker-compose.yml.pre-sameorigin-<TS>`
(ten kept); sets the same-origin audio variables; writes or removes the `healthcheck` block
according to the image label `fr.ekaii.ytm.healthcheck`; adds the `env_file` block if the 600
env file exists and removes the clear `COMPANION_SECRET_KEY:` line; tags the current production
image `prod-backup-<TS>`; tags `beatbump-ekaii:staging` as `beatbump-ekaii:local`; saves the
verified tarball `image-backups/beatbump-prod-<TS>-<image id>.tar.gz` and only then rotates to
the three most recent; copies the previous container's access log to the program logs folder;
`docker compose up -d --no-deps beatbump`; waits for `healthy` (75 s); up to eight tries for HTTP
200 through the proxy; probes `stats/library` and a Range on a local track (no acquisition);
checks `version servie = <sha> OK`; prints the ROLLBACK lines; runs `smoke.sh` with the browser
smoke (`PROMOTE_SMOKE_BROWSER=0` to skip).

Exit codes: 0 `promotion <TS> OK`; 2 backup failed (`:local` put back on the previous image,
production not recreated, nothing rotated: check free space in the backups folder, retry); 3
promoted but unhealthy (HTTP not 200, version unreadable or different, healthcheck not healthy,
smoke failed): apply a ROLLBACK line. Read the exit code directly, never through a pipe
(`promote.sh | grep` returns grep's status).

### 2.4 After the promotion

`finish-cycle.sh` does these; by hand:

1. `cd e2e && ./run.sh https://<host> "daft punk" probe-postdeploy.cjs` (4 min, a fresh context
   every 20 s: `homeLen > 0`, `songs > 0`, `sw.ctl` true, `notFound` and `errs` empty).
2. Wait at least 90 s after the promotion before the offline harness (new SW install window).
3. `HARNESS_TIER=full ./run.sh https://<host> "daft punk" harness-core.cjs` then
   `harness-offline.cjs`. A step new to a cycle not yet promoted fails on production: expected.
4. Journal: write `ops/journal/cycle-<cycle>.md`, then `python3 ops/journal.py <cycle> <sha>
   --chain <N> --dry-run`, then without `--dry-run`. Add the production scores and a `PROD =
   <sha> ... image <id>, sauvegarde image-backups/...` line to `CYCLES.md` by hand (`weekly.sh`
   and `monday.sh` read the last `PROD = <sha>` as the expected version).

### 2.5 Automatic versus manual

Automatic: everything inside `stage-cycle.sh`, `finish-cycle.sh` and `promote.sh` above. The
decision stays human: launching `finish-cycle.sh` without `--no-promote` is the agreement to
promote if everything is green. Manual: that decision, the production scores in `CYCLES.md`, any
change to the production compose other than the variables `promote.sh` writes.

## 3. Roll back

### 3.1 By tag (fast, if the tag still exists)

`promote.sh` prints it; from the service root:

```sh
docker tag beatbump-ekaii:prod-backup-<TS> beatbump-ekaii:local && cp docker-compose.yml.pre-sameorigin-<TS> docker-compose.yml && docker compose up -d --no-deps beatbump
```

`prod-backup-<TS>` is the image that was in production just before promotion `<TS>`. List with
`docker image ls beatbump-ekaii`.

### 3.2 By tarball (if a cleanup deleted the tags)

```sh
docker load -i image-backups/beatbump-prod-<TS>-<SID>.tar.gz && docker tag <SID> beatbump-ekaii:local && cp docker-compose.yml.pre-sameorigin-<TS2> docker-compose.yml && docker compose up -d --no-deps beatbump
```

Naming: `<SID>` is the image **promoted** at `<TS>`, so the most recent tarball is the current
production; to go back one step take the previous one. Choose by image id, found in the
`CYCLES.md` `PROD = ...` lines, not by time. Only three tarballs are kept. Before loading:

```sh
T=image-backups/beatbump-prod-<TS>-<SID>.tar.gz
gzip -t "$T" && [ "$(wc -c < "$T")" -gt 10485760 ] && echo "tarball OK"
```

### 3.3 After a rollback, verify

- `docker inspect -f '{{.Image}}' ytm-beatbump | cut -c8-19` equals the target id.
- `stats/library` `version` equals the expected commit.
- Audio: a Range on `/localf` of a local track answers 206 with an audio content type.
- `probe-postdeploy.cjs`, then the production harness (an older image fails the steps added since:
  expected).
- `sh ops/smoke.sh https://<host> <target sha>` exits 0.
- Write the rollback in `CYCLES.md` (`PROD = <sha>`) and `CHANGELOG.md`.

Since c59g the browser never keeps the newer shell on a rollback (content ETag on SPA routes).
Rolling back to an image older than c59g still works: the new binary served the ETag, the old
one answers 200 to the `If-None-Match` it does not know.

## 4. Check health

Always from the host, with `--resolve` (hairpin NAT: public names resolve to the WAN):

- Page: `curl -s -o /dev/null -w "%{http_code}" --resolve <host>:443:127.0.0.1 -A "Mozilla/5.0 (Macintosh) Chrome/128" https://<host>/` gives 200.
- Version and library: `curl -s --resolve <host>:443:127.0.0.1 https://<host>/api/v1/stats/library` gives `{"tracks":...,"albums":...,"artists":...,"lastAdded":...,"version":"<sha>"}`.
- Server cache: header `X-Ytm-Cache` = `HIT` / `MISS` / `BYPASS` / `STALE`; `home.json` MISS then
  HIT or STALE; `local/related?seed=favorites` must stay `BYPASS`.
- Audio without acquisition: a local lid from `local/songs?limit=1`, `player.json?videoId=<lid>`
  with `X-Ytm-Prefetch: 1`, then a Range on the returned `/localf` URL: 206, `accept-ranges:
  bytes`, `x-ytm-source: local`. Never probe with a YouTube id you do not own: it acquires.
- Container: `docker inspect -f '{{.State.Health.Status}}' ytm-beatbump` = `healthy`
  (`/app/beat-server -healthcheck` every 30 s).
- Client error log: `GET /api/v1/client-log?limit=50` with `Authorization: Bearer <YTM_ADMIN_TOKEN>`
  (401 without or with a wrong token, 404 while the variable is unset).
- Server logs: `docker logs --since 168h ytm-beatbump` (one JSON line per request; `docker logs`
  does not accept `7d`). The window stops at the last promotion (container recreated);
  `promote.sh` copies the previous log to the program logs folder.
- Weekly line in one command: `WEEKLY_DRY_RUN=1 sh ops/weekly.sh` (about 1 s).
- Acquisition: `docker logs -t --since 168h ytm-yubal 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c 'download_service - Downloaded:'`.
- Disk: `timeout 10 df -h <service root> <music folder>` (NFS can hang; the timeout matters).
- Image guard: `sh ops/smoke.sh https://<host>` check 0 `prod_image_tag` (restores
  `beatbump-ekaii:local` from the tarball if the tag is missing; fails explicitly if it differs).
- External monitors (Camille's layout): Uptime Kuma monitors 86, 119, 106 and 167 (API
  `stats/library`, keyword `tracks`) with Discord alerts; Umami analytics. Staging is not
  monitored on purpose.

## 5. Environment variables

Production: the `beatbump` service of the production compose, written only by `promote.sh`, plus
the 600 env file. Staging: the staging compose plus its env file. Names only here; the full tables
with defaults are in `README.md`.

| Variable | Production | Staging |
|---|---|---|
| `COMPANION_URL`, `MEILI_URL`, `MEILI_KEY`, `BEATBUMP_DB_PATH`, `LOCALF_BASE`, `COVER_BASE`, `IVVP_URL`, `BEATBUMP_AUTOCACHE` | set | set |
| `COMPANION_SECRET_KEY`, `YTM_ADMIN_TOKEN` | env file (600) | env file (600) |
| `YTM_REPORT_EMAIL` | absent until the owner gives the address | absent |
| `YTM_STATS_INCLUDE_HARNESS` | absent | `"1"` |
| `YTM_VERSION`, `YTM_API_CACHE`, `YTM_PREFER_IVVP_AUDIO`, `PLAYER_TIMEOUT_SECONDS`, `RESIDENTIAL_PROXY`, `AUDIO_PUBLIC_BASES`, `YTM_ACQUIRE_DAILY_CAP` | absent (code defaults) | absent |

Rules: a secret is read from the vault or the 600 file, never written in a compose file, a log or a
report (`ls -l` is enough to prove the file); `environment:` beats `env_file:` in compose; the
build stamps the version with `ARG VERSION` (`--build-arg VERSION=$(git rev-parse --short HEAD)`).

## 6. Harness and probes

### 6.1 Mechanics (`e2e/run.sh`)

`run.sh [url] [query] [harness] [extra args]` from `e2e/` (URL defaults to `YTM_URL` or
`http://127.0.0.1:8080`; empty query = the fixtures' `query`). It refuses a second
`ytm-harness-*` (exit 2), waits for the build lock and for a 1-minute load under 60 (15 min max;
`YTM_RUN_SKIP_BUILD_WAIT=1` skips the lock wait only), runs
`docker run --rm --name ytm-harness-<TS> --network host` with the real Chrome image
(`ytm-harness-chrome:1.47.0`, rebuilt from `e2e/chrome-image` if pruned; else the stock Playwright
image with a warning about AAC), passes `--host-resolver-rules` from `HARNESS_RESOLVER` when the
URL host is a name (Camille's box: `MAP *.ekaii.fr 127.0.0.1`, with `HARNESS_RESOLVE_IP=127.0.0.1`
for the harness's own Node requests), mounts `HARNESS_FIXTURES` (default `e2e/fixtures.json`),
forwards `HARNESS_TIER`, `HARNESS_ONLY`, `HARNESS_STATS_INCLUDE_HARNESS`, `YTM_SMOKE_EXPECT`, and
removes the container on exit. Output: `e2e/out/<TS>/` with `report.json`, one PNG per step,
`pageerrors.log`, `failed.log`, `streams.json`; last line `report: <path>/report.json`. The
`Report:` line reads `N passed / M failed / K upstream / S skipped` (a skipped step is a
precondition not met, never a failure).

### 6.2 Files and what they prove

| File | Proves | Duration |
|---|---|---|
| `harness-core.cjs` + `steps-c*.cjs` | the main journeys in a real browser: home, search, play (hooked `HTMLMediaElement.play`), next, lyrics, artist, album, library, settings, errors, perf, stats, resume, identity, MediaSession, French screens; about 100 steps in `full` | 8 to 12 min (`chain` budget 8 min, `full` 12 min) |
| `harness-offline.cjs` + offline step modules | auto-cache after a counted play, prefetch, offline playback, pins, keep album, packs, free up, device download; 20 steps | 2 to 4 min |
| `harness-smoke.cjs` | home row painted, a local track plays, SW active, served version, under 90 s | 15 s |
| `probe-postdeploy.cjs` | the deployment window: shell rendered, first SPA navigation, SW controller, `_app` 404s, page errors | 4 min (`--minutes`) |
| `probe-deploy-survives.cjs` (via `probe-ds1-*.cjs`) | one profile across two builds: upgrade and rollback | 3 phases |
| `ux-audit/shots.cjs` | mobile 390x844 and desktop 1280x900 captures with `metrics.json` (targets under 44 px, contrast, text under 12 px, manifest) | variable |
| `perf-audit/api-latency.sh`, `perf-audit/log-latency.py` | curl timings of the API; latency percentiles and cache hit rate from the access logs (harness, healthcheck and Kuma excluded) | short |

The program's one-off probes (`probe-gap.cjs` and the bug probes) were dropped from the tree;
their results live in `docs/archive/` (`GAP-MEASURE.md`: 29 ms median between cached local
tracks) and in `CHALLENGES.md`.

### 6.3 Rules

One browser at a time on the host; no production harness during a staging build; 90 s after a
promotion before the offline harness; a step new to an unpromoted cycle fails on production by
design.

### 6.4 Known transients

YouTube `next` "Invalid response" (UPSTREAM); the harness browser losing the network under load
(`ERR_CERT_VERIFIER_CHANGED`, `ERR_INTERNET_DISCONNECTED`); the post-promotion window (black page
on the first navigation, badge missing); first play after a container start (`MediaError`, hence
the warm-up); `queue_reorder_next` jump 1 to 4 once (never reproduced). `CHALLENGES.md` has the
full list with fixes.

## 7. Backups

| What | Where | How | Restore |
|---|---|---|---|
| Production image | `image-backups/beatbump-prod-<TS>-<id>.tar.gz`, three kept | `promote.sh`, verified (`gzip -t`, over 10 MB) before rotation | section 3.2 |
| Previous image tag | `beatbump-ekaii:prod-backup-<TS>` | `promote.sh` | section 3.1 |
| Production compose | `docker-compose.yml.pre-sameorigin-<TS>`, ten kept | `promote.sh` | `cp` then `up -d --no-deps beatbump` |
| SQLite database | `image-backups/beatbump-db-before-<reason>-<TS>.sqlite` | SQLite online `backup` API before any write to production data (decision 20 shows the script) | stop the service, copy the file over `beatbump.db`, start |
| Access logs | program logs folder, `access-<TS>-<sha>.log`, ten kept | `promote.sh` before recreating the container | read with `e2e/perf-audit/log-latency.py` |
| Bridge image | `ytm-cache:bak-<lane>` tag plus a tarball, `bridge.py.bak-<lane>` | by hand before a maintenance window | `docker tag`, recreate |
| Old production tree | `image-backups/beatbump-src-<TS>.tar.gz` | decision 22 | not needed |

The music folder itself is not backed up by these scripts: it is the user's data on their own
storage (a NAS in Camille's layout).

## 8. Cron and the weekly report

Installed since 4 October (decision 19), two lines in the host user's crontab, the host is in
UTC (`ops/cron.weekly.example` has the exact lines):

```
0 6 * * 1 /bin/sh <checkout>/ops/monday.sh >> <checkout>/ops/monday-cron.log 2>&1
30 6 * * * SMOKE_BROWSER=1 SMOKE_ALERT=1 /bin/sh <checkout>/ops/smoke.sh https://<host> >> <checkout>/ops/smoke-cron.log 2>&1
```

`monday.sh` waits for a free host (no harness, no `finish-cycle.sh`, build lock free; 30 min
max), runs the production harness in `full` tier (core then offline), `weekly.sh` with
`WEEKLY_DB_RO=1` (read-only retention column), then `smoke.sh` with `SMOKE_ALERT=1` and the last
`PROD = <sha>` as the expected version. Full log in the program logs folder
(`monday-<date>.log`, ten kept); the cron log gets the summary. Exit code = the worst of the
three. `MONDAY_SKIP_HARNESS=1` for a quick test without a browser.

`weekly.sh` appends one line to `WEEKLY.md` (11 columns: production harness with tier, age,
first sound and gated list; cold home requests; library size and served version; Kuma; client-log;
usage 7 days; acquisition; disk; image backups; slow API p90; retention 7 days) and a block to
`ALERT.md` when: a harness report is under 100 % or missing, no `full` report or one older than
`WEEKLY_MAX_REPORT_AGE_D` (8 days), a step gated for over a week, the served version differs from
the last `PROD = <sha>`, a volume under 10 % free or `df` hung 10 s, zero downloads with
acquisition failures, Kuma monitor 167 DOWN (only with the key). Secrets: `WEEKLY_KUMA_KEY` and
`YTM_ADMIN_TOKEN` by environment or by stdin with the `-` argument, never a file path.

Reading, every Monday (two minutes): `tail -2 WEEKLY.md`; `ls -l ALERT.md`. An `ALERT.md` block
means a repair session: treat it, then delete the block (it never empties itself). Thresholds that
trigger a lane: a `FAIL` outside upstream; `_app requests` over 80 or `me/mix` over 1; `lastAdded`
over two days (acquisition stopped); a monitor DOWN or a doubled response time; client-log up by
50 % or a new `kind` after a promotion; zero active human profiles two Mondays in a row is a
question to the owner, not a lane.

Daily `smoke.sh` at 06:30 UTC: 13 HTTP checks plus the browser smoke (skipped, not failed, if a
harness is running); check 0 restores the production image tag from the tarball after the
midnight cleanup if needed; an `ALERT.md` block on failure.

## 9. Maintenance of components without staging

The bridge (`ytm-cache`), the indexer and yubal are production-only. For a change: prepare the
patch in a copy, save the image under a tag and a tarball, pick a window (the bridge is
unavailable about two minutes at start-up on a large NAS library, see `CHALLENGES.md` Y), apply,
replay the core and offline harness, keep the rollback command. The companion secret rotation is
the same kind of window.

Meilisearch index settings are production data: a `PATCH /indexes/tracks/settings` is recorded as
a decision with its rollback (decision 18: facet limit 1000 and genre sorted by count).

## 10. Known incidents (dated)

- 30 September 22:47 UTC: `--filter ancestor=` removed `ytm-beatbump`; recreated in one minute.
  Rule: exact names only.
- 1 October 00:12 UTC: an image prune (Coolify) removed the production image, the backup tags and
  the tool images under the running container; tarballs outside the store since.
- 1 October 00:36 UTC: `PIPELINE_ERROR_READ` (`/vp` throttled) and Chromium without AAC; audio to
  `/aud`, harness on real Chrome.
- 1 October (audit UX v9): the global button selector reached specificity (0,5,1) and made nine
  buttons unreadable; opt-outs in `:where()`.
- 1 October (audit L8-1): `local/related?seed=favorites` served from the shared cache to every
  profile; `CacheResponseUnless`.
- 1 October 17:38 UTC: the SW deleted the previous shell cache at activation (origin of the black
  pages of cycles 26 and 27); fixed cec1510, DS1 probe born.
- 2 October 00:40 UTC: the queue drawer's `display:contents` wrapper broke `height:inherit`
  (empty queue on desktop); flex column wrapper.
- 2 October 00:58 and 01:23 UTC: TDZ from a top-level subscribe across an import cycle, then a
  wrong store name hidden by an unread svelte-check rise.
- 2 October 09:58 UTC: `<progress value={undefined}>` froze the Svelte scheduler.
- 2 October 14:52 UTC: black screen after "Preparer 2 h" (`scrollIntoView` during the crossfade);
  local lids reaching the YouTube resolver.
- 3 and 4 October 00:00 UTC: Coolify forced cleanup pruned the production image again under the
  running container; `smoke.sh` tag guard; decision 3 for the owner.
- 4 October 21:27 UTC: bridge restart unavailable 110 s (start-up stat storm on the NAS).
- 4 October 22:13 UTC (chain 75): harness search selectors broke on the French labels.
- 5 October 00:03 and 01:32 UTC (chains 78 and 80): rollback kept the new shell (SPA routes
  without ETag); fixed c59g.
- 5 October 00:44 UTC (chain 79): Chromium died under load, 33 steps "browser has been closed".
