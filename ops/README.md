# ops: operating scripts of the music stack

Staging chain, promotion, journal, smoke test, weekly measurements and the Monday routine of a Beatbump
instance. Everything runs ON the host that runs the stack (for a remote host:
`ssh -o ControlMaster=no -o ControlPath=none <host> '...'`, never a heredoc inside the ssh quotes: copy a script
to the host and run it). The scripts are POSIX `sh` (shellcheck clean, `scripts/release/ci-shellcheck.sh`) plus a
few Python 3 stdlib helpers.

## Layout: ops/env.sh

Every script sources `ops/env.sh`, the one place the layout comes from. A variable keeps the value already in
the environment, else the value of `$YTM_ENV` (default `ops/env.local`, git-ignored, `NAME=value` lines), else
the default of `env.sh`, which matches the shipped layout (`deploy/compose.yml`, data under `deploy/data`, one
checkout = the tree that is built). `ops/env.example` holds the values of the original production layout of
music.ekaii.fr (one checkout per role, Traefik on 127.0.0.1:443 with a broken hairpin, image `beatbump-ekaii`):

```
set -a; . ops/env.example; set +a          # use it as a whole for one shell
cp ops/env.example ops/env.local           # or copy it and edit (sourced by env.sh on every run)
```

| Variable | Default (shipped layout) | Meaning |
|---|---|---|
| `YTM_ROOT` | parent of `ops/` | checkout directory |
| `YTM_SRC_DIR` | `$YTM_ROOT` | git tree that `stage-cycle.sh` builds and `finish-cycle.sh` diffs |
| `YTM_PROD_URL` / `YTM_STAGING_URL` | `http://127.0.0.1:8080` / `:8081` | base URLs, any http(s) URL |
| `YTM_RESOLVE_IP` | empty | curl talks to this IP for a NAMED host (`--resolve`, SNI and Host kept): a host whose hairpin route is broken |
| `YTM_PROD_CONTAINER` | `<project>-beatbump-1` | the production app container (the only container these scripts recreate, by exact name) |
| `YTM_STAGING_PROJECT` / `YTM_STAGING_CONTAINER` | `beatbump-staging` / `<project>-beatbump-1` | staging compose project and container |
| `YTM_COMPOSE_SERVICE` | `beatbump` | app service in the production compose file |
| `YTM_IMAGE` | `beatbump` | image repository: `:local` = production, `:staging` = the candidate |
| `YTM_COMPOSE_FILE` / `YTM_COMPOSE_PROJECT` / `YTM_COMPOSE_ENV_FILE` | `deploy/compose.yml`, none, `deploy/.env` | production compose (`promote.sh` edits its healthcheck / env_file blocks) |
| `YTM_COMPOSE_OVERRIDE` | `ops/compose.image.yml` | extra `-f` on both compose commands: pins the app service on `<YTM_IMAGE>:<tag>` instead of `build:`; empty for a compose file that names its image |
| `YTM_STAGING_COMPOSE` / `YTM_STAGING_ENV_FILE` / `YTM_STAGING_OVERRIDE` | the production compose, `deploy/.env.staging`, `ops/compose.staging.yml` | staging instance: another `BEATBUMP_PORT`, its state under `deploy/data-staging` |
| `YTM_DATA_DIR`, `YTM_DB_DIR`, `YTM_STAGING_DB_DIR`, `YTM_IMAGE_BACKUPS`, `YTM_BACKUP_PREFIX` | under `deploy/data` | data root, databases, `promote.sh` rollback tarballs |
| `YTM_ALLOW_SKIPS` | `0` | `1` = a harness run with SKIP steps still counts as green (`finish-cycle.sh`, `weekly.sh`); `0` = every step must play (0 FAIL and 0 SKIP) |
| `YTM_ANALYTICS_SRC`, `YTM_ANALYTICS_WEBSITE_ID`, `YTM_ANALYTICS_HOST` | empty | optional page-view analytics of the staging build (Umami-compatible script URL, website id, host): `stage-cycle.sh` passes them as the `PUBLIC_ANALYTICS_*` build args; empty = no analytics script |
| `YTM_SECRETS_ENV_FILE` | `deploy/beatbump.env` | env_file `promote.sh` wires into the prod service (mode 600, holds `COMPANION_SECRET_KEY=`) |
| `YTM_HEALTHCHECK_LABEL` | `fr.ekaii.ytm.healthcheck` | image label saying the binary supports `-healthcheck` |
| `YTM_E2E_DIR` | `e2e/` | the harness (`run.sh`, fixtures, `out/`) |
| `YTM_PROGRAM_DIR` | `ops/program` | journal and alerts: `CHANGELOG.md`, `CYCLES.md`, `WEEKLY.md`, `ALERT.md`, `LIBRARY-LINT.md`, `logs/` |
| `YTM_LOG_DIR` | `/tmp` | chain and finish logs |
| `YTM_BUILD_LOCK` | `/tmp/beatbump-build.lock` | flock shared by the build, `promote.sh` and `e2e/run.sh` |
| `YTM_QUERY` | empty | harness search query; empty = the `query` key of the fixtures file |
| `HARNESS_RESOLVER`, `HARNESS_RESOLVE_IP`, `HARNESS_FIXTURES` | empty | Chrome host-resolver rules for a named host, the IP of the Node-side requests, another fixtures file (see `e2e/run.sh`) |
| `YTM_LIBRARY_DIR`, `YTM_ACQ_CONTAINER`, `YTM_ACQ_MOUNT`, `YTM_DISK_PATHS` | | `weekly.sh`: library volume, acquisition container (yubal) and its mount, paths whose free space is reported |
| `YTM_KUMA_CONTAINER`, `YTM_KUMA_MONITORS`, `YTM_KUMA_STATS_MONITOR` | | `weekly.sh`: Uptime Kuma container, monitor ids printed, the id whose DOWN state raises an alert |

Secrets (`YTM_ADMIN_TOKEN`, `WEEKLY_KUMA_KEY`) are read by `weekly.sh` only, from the environment or stdin, and
never written by any script.

## Content

| File | Role |
|---|---|
| `env.sh`, `env.example` | the layout (above) |
| `stage-cycle.sh` | staging chain: build of `$YTM_SRC_DIR` as `$YTM_IMAGE:staging` (under `flock $YTM_BUILD_LOCK`, `--build-arg VERSION=<short sha>`), staging restart, warm-up, header checks, harness core then offline. Promotes nothing. |
| `finish-cycle.sh` | generic end of cycle: chain, optional DS1 probe, `promote.sh`, `journal.py`, post-deploy probe, prod harness. The only way a cycle ends. |
| `promote.sh` | promotion of the tested staging image to production, with backup, healthcheck, smoke and rollback commands |
| `journal.py`, `journal/` | `CHANGELOG.md` entry and `CYCLES.md` line of a promotion, from `journal/cycle-<N>.md` (idempotent) |
| `smoke.sh` | smoke test: 11 HTTP checks in under 90 s, no browser, no acquisition (+ an optional browser check) |
| `weekly.sh` | Monday measurements: one line in `WEEKLY.md`, a block in `ALERT.md` when a threshold is crossed |
| `monday.sh` | Monday in one command: wait for a free host, prod harness full tier, `weekly.sh`, `smoke.sh` |
| `cron.weekly.example` | the two suggested crontab lines (`monday.sh`, daily `smoke.sh`). NOT installed by anything. |
| `cleanup-harness-profiles.sh` | counts the `harness-*` profiles per pattern and PRINTS their purge; `--execute` needs `YTM_CONFIRM=yes` |
| `library-lint.py` | read-only hygiene report of the library through the public API (`LIBRARY-LINT.md`) |
| `compose.image.yml`, `compose.staging.yml` | compose overrides of the shipped layout (named image tag; staging state apart) |
| `svelte-check.baseline` | error ceiling of the svelte-check guard of `finish-cycle.sh` |

## The harness Report line

Every harness entry point (`e2e/harness-core.cjs`, `harness-offline.cjs`, `harness-smoke.cjs`) prints one line,
then `report: <path>/report.json` (`e2e/run.sh`):

```
Report: P passed / F failed / U upstream / S skipped -> <out>/report.json
```

- `failed` counts the real failures; `upstream` the failures caused by YouTube or the network (`net::ERR_`,
  an invalid `next` answer): reported apart, never counted in `failed`;
- `skipped` counts the steps whose precondition the target cannot meet, each printed as
  `SKIP <name> - <precise reason>` and listed again on a `Report skipped:` line (a library without any mix
  card, no artist credited under two spellings, no album without a year, no YouTube-backed fixture...). A step
  that seeds what it needs through the public API (a harness profile, `X-Ytm-Harness: 1` so that stats stay
  clean) plays instead of skipping whenever it can;
- steps the tier does not play (`HARNESS_TIER=chain` skips the `full`-only steps) are printed as
  `SKIP <name> - tier full only` and listed in `report.skippedTier`, not in `skipped`; steps a target does not play
  by design (they need counted harness plays: `YTM_STATS_INCLUDE_HARNESS=1`, staging only) are listed on the
  `Report not played on this target:` line (`report.envSkipped`);
- `Report gated:` lists the steps a module gates (`C<N>_SKIP`), `none` normally.

Green, for `finish-cycle.sh` and `weekly.sh`: `F = 0`, `P` at least the minimum (core `FINISH_MIN_CORE`, default
50; offline `FINISH_MIN_OFF`, default 17) and `S = 0` unless `YTM_ALLOW_SKIPS=1`. A production target must show
0 FAIL and 0 SKIP; a fresh install (the sample library of `./up.sh --sample-library`, fixtures
`e2e/fixtures.sample.json`) may set `YTM_ALLOW_SKIPS=1` for the steps that need YouTube-backed fixtures. An older
three-field line (no `skipped`) counts as `S = 0`.

Run a harness by hand (one browser at a time on the host: `run.sh` refuses when a `ytm-harness-*` container
runs):

```
cd e2e && HARNESS_TIER=chain ./run.sh "$YTM_STAGING_URL" "" harness-core.cjs 2>&1 | grep -E "^(PASS|FAIL|SKIP|Report)"
HARNESS_FIXTURES=fixtures.sample.json ./run.sh http://127.0.0.1:8080 "" harness-offline.cjs     # sample library
HARNESS_ONLY=artist_aliases,albums_no_year_chip ./run.sh "$YTM_STAGING_URL" "" harness-core.cjs  # some steps only
```

## stage-cycle.sh

```
nohup sh ops/stage-cycle.sh > "$YTM_LOG_DIR/ytm-stage-cycle<N>.log" 2>&1 &
grep -E "^(=== |PASS|FAIL|SKIP|Report|staging HTTP)" "$YTM_LOG_DIR/ytm-stage-cycle<N>.log"
```

Always detached with its own log (`<N>` = chain number). Never a production harness while a chain runs. To edit
the script while a chain runs: write a temporary file, then `mv` (never in place). It also runs
`node e2e/check-harness-headers.cjs` before the core harness and stops when it is red (every browser context
must send `X-Ytm-Harness: 1`).

## finish-cycle.sh

```
FINISH_PARSE_ONLY=1 sh ops/finish-cycle.sh 42 45 --ds1        # arguments + SM2 guard of the moment, nothing launched
printf 'app/src/lib/utils/sharedJobs.ts\n' | FINISH_GUARD_TEST=- sh ops/finish-cycle.sh   # guard test
nohup sh ops/finish-cycle.sh <cycle> <chain> [--ds1] [--no-promote] [--wait] >/dev/null 2>&1 &
tail -f "$YTM_LOG_DIR/ytm-finish-<cycle>.log"                 # last line: FINISH <cycle> DONE
```

- refuses to start while a `ytm-harness-*` container runs (prints it), unless `--wait` (60 s steps, 60 min at
  most); refuses when `ytm-stage-cycle<chain>.log` already exists or `journal/cycle-<cycle>.md` is missing;
- svelte-check guard first: `npx svelte-check --threshold error` in `$YTM_SRC_DIR/app`, refusal (exit 3) when the
  error count is above `ops/svelte-check.baseline` or unreadable (`FINISH_SKIP_SVELTE_CHECK=1` skips it,
  `FINISH_SC_TEST=1` plays it alone); the baseline only goes down, by commit;
- chain: `stage-cycle.sh`; green = the two Report lines are green (see above) and the staging serves the sha of
  HEAD of `$YTM_SRC_DIR`;
- gated guard: a step gated at the previous chain (`ops/gated.prev`) and at this one is refused (exit 3) unless
  `FINISH_ALLOW_GATED=1`;
- `--ds1`: the SM2 sequence below (seed on the prod image, upgrade, rollback, staging back on the new image);
  green = empty `fails` in `e2e/out/ds1-upgrade.json` and `ds1-rollback.json` written during this run. Without
  `--ds1`, when the SM2 guard applies: no promotion (`DS1 REQUIRED`, reasons in the log, exit 3);
- then (unless `--no-promote`): `flock $YTM_BUILD_LOCK sh ops/promote.sh <sha>` (exit != 0 = stop, no journal),
  `journal.py <cycle> <sha> --chain <chain>`, post-deploy probe (4 min), prod harness core then offline
  (`HARNESS_TIER=full`);
- exit codes: 0 done, 1 refusal / usage, 3 not green (nothing promoted), 4 `promote.sh` failed.

Rule: only `finish-cycle.sh` ends a cycle. A need it does not cover becomes an option of the script (checked
with `FINISH_PARSE_ONLY=1` then `sh -n`), never a new one-off script in `/tmp`. To chain a cycle after a merge,
a small detached queue script waits (15 s steps, 1 to 2 h at most) for the `FINISH <N-1> DONE` line of the
previous cycle AND a marker file touched by whoever merged cycle N, then runs
`sh ops/finish-cycle.sh <N> <chain> [--ds1] --wait`. Without the marker nothing starts: the merge stays the human
decision.

## promote.sh

```
sh ops/promote.sh [expected short sha]
```

- expected version: the argument, else the version the staging container serves when it runs on
  `$YTM_IMAGE:staging` (the version only lives in the binary);
- backup: `docker save` of the current prod image to `<tar>.tmp.tar`, `gzip -1`, `gzip -t`, size > 10 MB, then
  `mv` to its final name in `$YTM_IMAGE_BACKUPS`; the rotation (3 most recent) only runs once the new tarball is
  valid. A failed backup = `WARNING: image backup FAILED`, the `:local` tag put back, prod NOT recreated, exit 2;
- writes the healthcheck block of the prod service, idempotently, ONLY when the promoted image carries
  `$YTM_HEALTHCHECK_LABEL=1` (the image is `FROM scratch`: the probe is the binary itself,
  `/app/beat-server -healthcheck`, a GET of `stats/library` that exits 0 on 200 + `version`). Without the label
  (older image, rollback) an existing block is REMOVED: a binary without the flag would start a second server
  every 30 s;
  ```
  healthcheck:
    test: ["CMD", "/app/beat-server", "-healthcheck"]
    interval: 30s / timeout: 5s / retries: 3 / start_period: 20s
  ```
- wires `env_file: [$YTM_SECRETS_ENV_FILE]` into the prod service when that file exists, is mode 600 and holds
  `COMPANION_SECRET_KEY=`, and removes a clear-text `COMPANION_SECRET_KEY:` line from the compose file;
- copies the access log of the old container to `$YTM_PROGRAM_DIR/logs/access-<TS>-<old sha>.log` (10 kept),
  recreates only the app service (`--no-deps`), waits for HTTP 200 and `healthy` (75 s), checks the served
  version and a Range `/localf` on a local track, prints the exact rollback commands (dated tag and tarball),
  runs `smoke.sh` (HTTP + browser; `PROMOTE_SMOKE_BROWSER=0` for HTTP only);
- exit codes: 0 promoted and verified; 2 backup failed; 3 promoted but HTTP != 200, not healthy, version
  unreadable or different, or smoke failed (ROLLBACK lines printed, a block in `ALERT.md`). A caller must read
  the exit code: never lose it in a pipe (`promote.sh | grep` returns the status of grep).

After the promotion, `finish-cycle.sh` runs the post-deploy probe, waits 90 s, plays the prod harness core and
offline, then `journal.py`.

## Before the first promotion from this repository

The shipped bridge, yubal and Go server default to GENERIC behaviour: no egress proxy, no iv-vp, no invidious,
same-origin `/vp` audio. A production that relied on the old behaviour keeps it only if ITS compose file
(`YTM_COMPOSE_FILE`) sets, on the services below, the values it used to carry. `promote.sh` never strips them (it
only adds or keeps the healthcheck block, wires the env_file and removes a clear-text `COMPANION_SECRET_KEY`
line), so check them once, before the first promotion of an image built from this repository. The block is also
in `ops/env.example` (comment at the end); these are compose environment values, NOT ops variables:

| Service | Variable | Production value | Empty / absent means |
|---|---|---|---|
| bridge | `GOST_PROXY` | `http://gost:8888` | direct egress for `/vp` and `/iv/videoplayback` |
| bridge | `IVVP_UPSTREAM` | `http://iv-vp:5007` | no logged-in fallback |
| bridge | `INVIDIOUS_UPSTREAM` | `http://invidious-app-t2s:3000` | `/iv/*` answers 502 |
| bridge | `VP_PUBLIC_BASE` | `https://ytify.ekaii.fr/vp` | same-origin `/vp` |
| bridge | `AUD_PUBLIC_BASE` | `https://invidious.ekaii.fr/aud` | same-origin `/aud` |
| bridge | `LOCALF_PUBLIC_BASE` | `/localf` | read by `bridge/bridge.py`; prod serves `/localf` same-origin |
| yubal | `YTM_YTDLP_PROXY` | `http://gost:8888` | direct yt-dlp egress |
| beatbump | `RESIDENTIAL_PROXY` | `http://gost:8888` | direct egress for the InnerTube `next` lookups |
| beatbump | `YTM_PREFER_IVVP_AUDIO` | `1` | audio through `/aud/<id>` only when this is set and `IVVP_URL` is set |
| beatbump | `IVVP_URL`, `LOCALF_BASE`, `COVER_BASE` | `http://iv-vp:5007`, `/localf`, `/cover` | already in the production compose |

One more build-time value: the app ships WITHOUT any analytics script (it used to hard-code the production
Umami script, so every install reported there and an unreachable analytics host held the page load). The
production keeps its page views only when the build passes `PUBLIC_ANALYTICS_SRC`, `PUBLIC_ANALYTICS_WEBSITE_ID`
and `PUBLIC_ANALYTICS_HOST`: `stage-cycle.sh` does it from `YTM_ANALYTICS_*`, set in `ops/env.example`. Check in
the staging shell: `curl -s "$YTM_STAGING_URL/" | grep -c analytics.example.org` = 1 (the value sits in the inline
loader, which adds the script after the load event).

Then, for the original production layout:

1. `set -a; . ops/env.example; set +a` (or an `ops/env.local` copy): `YTM_COMPOSE_OVERRIDE` and
   `YTM_STAGING_OVERRIDE` are EMPTY there (the production compose names its image `beatbump-ekaii:local` and the
   staging has its own compose file), `YTM_ALLOW_SKIPS=0` (production plays every step);
2. `docker compose -f "$YTM_COMPOSE_FILE" --env-file "$YTM_COMPOSE_ENV_FILE" config -q` and read the rendered
   environment of `bridge`, `yubal` and `beatbump` against the table;
3. a staging chain of this repository (`stage-cycle.sh`) green on the staging compose, which must carry the same
   values, then `finish-cycle.sh` (the SM2 guard will ask for `--ds1`: the production sha is unknown to this
   repository's history);
4. after the promotion: `smoke.sh "$YTM_PROD_URL" <sha>` and the prod harness (0 FAIL, 0 SKIP), and a look at
   `/vp`, `/aud` and the acquisition log (`docker logs --since 1h <yubal container>`) for the egress path.

## SM2 guard: when the deploy-survives probe is mandatory

The guard is CLOSED by default: the DS1 probe `deploy_survives` must pass (upgrade AND rollback) before
`promote.sh`, on top of green core and offline harness runs, as soon as one of these holds (`sm2_guard` of
`finish-cycle.sh`, one reason per line):

| Case | Printed reason | DS1 |
|---|---|---|
| prod `stats/library` without `version` (down, unreadable JSON) | `(prod version unreadable ...)` | required |
| served version that is not a 7 to 40 hex sha | `(prod version '...' is not a sha)` | required |
| sha unknown to `$YTM_SRC_DIR` or ambiguous (fix made elsewhere, image rebuilt outside the tree) | `(prod sha ... unknown ...)` | required |
| known sha that is not an ancestor of HEAD: the diff says nothing | `(prod sha ... is not an ancestor of HEAD ...)` | required |
| `git diff --name-only <prod>..HEAD` fails | `(git diff ... failed)` | required |
| `app/src/service-worker.ts` unreadable at HEAD (imports not computable) | `(imports of app/src/service-worker.ts unreadable at HEAD)` | required |
| a file of the `SM2_RE` pattern changed | the path | required |
| a file imported (transitively) by the service worker changed | `<path> (imported by the SW)` | required |
| prod sha ancestor of HEAD and no SM2 file changed | none (`no DS1 required`) | optional |

`SM2_RE`: `app/src/service-worker.ts`, `app/src/routes/+layout.svelte`, `app/src/routes/+layout.ts`,
`app/vite.config.*`, `app/svelte.config.js`, `app/scripts/svelteRuntimeChunk.ts` (names of the precached chunks),
`app/src/lib/utils/sharedJobs.ts`, `app/src/app.html`, `app/static/manifest.json`. The SW imports are read at
HEAD with `git show` (`$lib/...`, `./`, `../` specifiers, recursively; npm packages and virtual modules ignored).
Not covered: a version change of an npm package the SW imports (`app/package.json`, lockfile): play `--ds1` by
hand then.

1. Does the guard apply (read-only)?
   ```
   FINISH_PARSE_ONLY=1 sh ops/finish-cycle.sh <cycle> <chain>            # line "SM2 guard now"
   printf 'app/src/lib/utils/sharedJobs.ts\nbackend/api/me.go\n' | FINISH_GUARD_TEST=- sh ops/finish-cycle.sh
   FINISH_GUARD_TEST=/tmp/list FINISH_GUARD_PRODV=deadbee sh ops/finish-cycle.sh     # unknown sha -> exit 3
   ```
   `FINISH_GUARD_PRODV` replaces the prod sha (default HEAD: only the files count); `FINISH_GUARD_IG=<throw-away
   repo>` replaces `$YTM_SRC_DIR` (tests only).
2. Play DS1 (staging chain already green, no other browser running; the staging serves the prod image, then the
   new one; `stg` is the staging compose of your layout, `ytm_staging_compose` in `env.sh`):
   ```
   NEW=$(docker image inspect -f '{{.Id}}' "$YTM_IMAGE:staging")   # tested image (new build)
   OLD=$(docker image inspect -f '{{.Id}}' "$YTM_IMAGE:local")     # prod image
   up() { docker tag "$1" "$YTM_IMAGE:staging" && <staging compose> up -d 2>&1 | tail -1; sleep 25; curl -s "$YTM_STAGING_URL/api/v1/stats/library"; echo; }
   cd e2e
   up "$OLD"; ./run.sh "$YTM_STAGING_URL" "" probe-ds1-seed.cjs 2>&1 | grep -E "^\[ds1|FATAL"
   up "$NEW"; ./run.sh "$YTM_STAGING_URL" "" probe-ds1-verify-upgrade.cjs 2>&1 | grep -E "^\[ds1|FATAL"
   up "$OLD"; ./run.sh "$YTM_STAGING_URL" "" probe-ds1-verify-rollback.cjs 2>&1 | grep -E "^\[ds1|FATAL"
   up "$NEW"   # ALWAYS put it back: promote.sh promotes the :staging tag
   ```
   The `probe-ds1-*.cjs` files (one line each) fix the phase and require `probe-deploy-survives.cjs`, a
   PERSISTENT browser profile that goes through two builds. Run the sequence detached with its log.
3. Criterion: `[ds1 verify:upgrade] PASS` and `[ds1 verify:rollback] PASS` (empty `fails` in
   `e2e/out/ds1-*.json`): SW changed, no `_app` 404, pins kept, search usable, track resumed, at most 60 `_app`
   requests. A FAIL blocks the promotion; write it in `CYCLES.md`.
4. Check that `$YTM_IMAGE:staging` is back on `NEW` before `sh ops/promote.sh <sha of NEW>`.

## journal.py

```
python3 ops/journal.py 33 <promoted sha> --chain <N> --dry-run   # read
python3 ops/journal.py 33 <promoted sha> --chain <N>             # write
```

A new cycle = a new `journal/cycle-<N>.md` file, no code. Head of the file (meta lines):

```
<!-- marker: cycle 34 in prod -->
<!-- cycles: - {now}: chain {chain} ({head}) green; promoted (cycle 34: c34a + c34b). -->
<!-- cycles-marker: promoted (cycle 34: c34a + c34b) -->
## {date} {time} UTC (host clock): cycle 34 in prod (integration {head}): title
- bullet
```

Tokens: `{head}` (2nd argument), `{chain}` (`--chain`), `{date}` `{time}` `{now}` (`date -u` of the host). A token
without a value (an unknown `{xxx}` included) stops the script BEFORE any write. `<head>` must be a short sha
(`^[0-9a-f]{7,12}$`); `cycles-marker:` is mandatory when `cycles:` holds `{now}` / `{date}` / `{time}`; running the
same cycle again prints `already present, nothing to write` per file; `--dry-run` prints the exact lines that
would be appended. Both files live in `$YTM_PROGRAM_DIR`, created with a one-line header when absent.

## smoke.sh

```
sh ops/smoke.sh "$YTM_PROD_URL" [expected sha]
SMOKE_BROWSER=1 SMOKE_ALERT=1 sh ops/smoke.sh "$YTM_PROD_URL"
```

Checks: `stats/library` (200, `tracks > 0`, `version`, equal to the expected sha when given), `/home` shell with
its `_app` entry script, `/service-worker.js`, `share_target` in `/manifest.json`, `search.json` under 300 KB,
`local/albums?limit=1`, `local/related?seed=album:<id>`, Range `/localf` on a local track (206 +
`Accept-Ranges`), `/cover?lid=<album cover>` with `Cache-Control`, `og:title` card for a robot on
`/listen?id=<local track>`, `X-Ytm-Cache: HIT` on the 2nd call of `local/mixes`. One `OK` / `FAIL` line per
check, then `SMOKE <host> version=<v>: n ok, m failure(s) in s s`; exit 1 on a failure. Only LOCAL ids are used
(`player.json` only with a lid: no acquisition). Read-only, may run during a build. `YTM_RESOLVE_IP` is honoured.

- check 0, prod image guard: compares the image id of `$YTM_PROD_CONTAINER` with the `$YTM_IMAGE:local` tag.
  Tag missing (an image prune): `docker load` of the matching `$YTM_IMAGE_BACKUPS/<prefix>-*-<id>.tar.gz`, then
  check that the tag gives the container's id back (with `SMOKE_ALERT=1`, an "image restored" block in
  `ALERT.md`). Tag present but different: promotion in progress or drifted tag, nothing touched, explicit FAIL;
- `SMOKE_BROWSER=1`: 12th check `smoke_browser` = `e2e/harness-smoke.cjs` through `e2e/run.sh` under `timeout 240`
  (home + first personal row, playback of the fixture lid, service worker, served version = expected). When a
  `ytm-harness-*` already runs or `run.sh` refuses (exit 2): `SKIP smoke_browser ...`, not a failure. The 90 s
  HTTP budget does not count the browser;
- `SMOKE_ALERT=1`: a failure appends a block (the FAIL lines) to `$YTM_PROGRAM_DIR/ALERT.md`.

## weekly.sh and monday.sh

```
WEEKLY_DRY_RUN=1 sh ops/weekly.sh      # prints the line, writes nothing
sh ops/weekly.sh                       # appends the line to $YTM_PROGRAM_DIR/WEEKLY.md
{ printf 'WEEKLY_KUMA_KEY='; cat <key file>; echo; } | ssh <host> 'sh <checkout>/ops/weekly.sh -'
sh ops/monday.sh                       # the Monday routine (25 to 35 min on a quiet host)
```

- secrets: never a file path as argument (refused, exit 2). Sources: `WEEKLY_KUMA_KEY` and `YTM_ADMIN_TOKEN` in the
  environment, or `-` then `NAME=value` lines on stdin; removed from the environment of sub-processes and handed
  to curl with `-K -` (nothing in `ps`);
- columns: (a) prod harness: the LAST `full`-tier prod report per kind (core = step `perf_cold_home_requests`,
  offline = step `load_home`), its age (`WEEKLY_MAX_REPORT_AGE_D`, default 8 days), tier, `firstSound`, `gated`,
  and `skipped` when not zero; (b) cold home; (c) library stats; (d) Kuma monitors (with the key); (e)
  client-log (with the token, else the POST count of the access log); (f) usage 7 d (POST `me/history` of the
  access log, harness agents excluded, distinct IPs as an APPROXIMATION of active profiles); (g) acquisition
  (`docker logs` of `$YTM_ACQ_CONTAINER` over 168 h); (h) disk (`df` under `timeout 10`, NFS); (i) image
  backups; (j) slow API (p90 per `/api/` prefix); (k) retention 7 d, only with `WEEKLY_DB_RO=1` (read-only
  `sqlite3` `mode=ro` + `query_only` on the prod database; harness profiles excluded);
- alert block in `ALERT.md` when: a prod harness report has a failure (or a skip, unless `YTM_ALLOW_SKIPS=1`) or
  is missing, no `full` report or one older than the limit, a `gated` list that persists for a week, the served
  version differs from the last `PROD = <sha>` of `CYCLES.md`, a volume has less than 10 % free, zero download
  with failures, the stats monitor is DOWN. Reasons on stderr, stdout = the WEEKLY line only;
- `docker logs` only cover the life of the container (every promotion recreates it): the real window is printed;
- `monday.sh`: waits (at most `MONDAY_WAIT_MAX`, 1800 s) while a harness, a `finish-cycle.sh` or the build lock is
  busy, then prod harness `HARNESS_TIER=full` core + offline, `weekly.sh` with `WEEKLY_DB_RO=1`, `smoke.sh` HTTP
  with `SMOKE_ALERT=1` and the last `PROD = <sha>` as expected version. Log
  `$YTM_PROGRAM_DIR/logs/monday-<date>.log` (10 kept), summary on stdout; exit code = the worst of the three
  (`MONDAY_SKIP_HARNESS=1` for a quick test without a browser).

Scheduling: `cron.weekly.example` holds the two lines (Monday 06:00 UTC `monday.sh`, every day 06:30 UTC
`SMOKE_BROWSER=1 SMOKE_ALERT=1 smoke.sh`). Nothing installs them: the operator pastes them with `crontab -e` and
the real paths. Check: `crontab -l | grep -c 'monday.sh\|smoke.sh'` = 2. Reading: `tail -3 WEEKLY.md`,
`tail -5 ops/monday-cron.log`, `ls -l ALERT.md`.

## Harness profiles (cleanup-harness-profiles.sh)

The harness creates named profiles (id `u-<16 hex of sha1(lower-cased name)>`, `backend/api/me.go`
`MeLoginHandler`):

| Pattern | Origin | Where |
|---|---|---|
| `harness-blank-<ms>` | `steps-c38-core.cjs` `blank_profile_empty_states`, one per run | prod + staging |
| `harness-id-<ms>` | `harness-core.cjs` `identity_migration` | staging |
| `harness-take-<ms>` | `harness-core.cjs` `resume_take_over` | staging |
| `harness-remote-<id>` | `harness-core.cjs` `resume_remote` | prod + staging |
| `harness-skip-<ms>` | `steps-c42-core.cjs` `skips_exclusion_real` | staging |
| `harness-np`, `harness-days`, `harness-remote` | FIXED names reused on every run | prod + staging |
| other `harness-*` | counted apart, with examples | |

Default purge = `name GLOB 'harness-*'` EXCEPT the fixed names (`--include-fixed` adds them). Tables (GORM,
`backend/db/me_models.go`): `profiles`, and per `profile_id` `favorites`, `follows`, `playlists` (+
`playlist_items`), `play_events`, `now_playings`, `skip_events`. No API route deletes a profile: the purge is SQL.

```
sh ops/cleanup-harness-profiles.sh                    # prod: counts per pattern + the SQL, read-only
sh ops/cleanup-harness-profiles.sh --staging          # staging ($YTM_STAGING_DB_DIR)
YTM_CONFIRM=yes sh ops/cleanup-harness-profiles.sh --staging --execute
```

`--execute`: `YTM_CONFIRM=yes`, write access to the database, its `-wal`, `-shm` and directory. Production:
refused unless root (a manual decision). The database files are usually owned by the container's user: root or a
`chown` is needed for staging too.

## library-lint.py

```
python3 ops/library-lint.py                              # $YTM_STAGING_URL, writes $YTM_PROGRAM_DIR/LIBRARY-LINT.md
python3 ops/library-lint.py --url "$YTM_PROD_URL"         # any instance, read-only too
python3 ops/library-lint.py --url http://127.0.0.1:8080 --out /tmp/LIBRARY-LINT.md
```

Stdlib only, read-only through the public API (`stats/library`, `local/mixes`, `local/albums`, `local/songs`,
`local/genres`, `local/artists`, HEAD `/cover`), `YTM_RESOLVE_IP` honoured for a named host. Four sections with a
total and 30 examples each: albums without a year (`local/albums?filter=no-year`), albums without a cover,
single-album genres, near-duplicate artists (`matchNorm` of `backend/api/local_match.go` reimplemented: case,
accents, `feat.`, `&`, punctuation). Limits stated in the report: the raw genre tag values are normalised server
side and the facet is bounded to 100 values.

## Harness conventions

- Tiers: `HARNESS_TIER=chain` (default; `stage-cycle.sh`) skips the slow, never-regressed `full`-only steps
  (`resume_take_over`, `buttons_readable`, `recent_by_day`, `french_program_screens`, `pack_refresh_preview`);
  `full` (prod harness after a promotion, `monday.sh`) plays everything. Budgets: 8 min `chain`, 12 min `full`
  (core), 5 min offline.
- `HARNESS_ONLY=a,b` plays those steps only. A new step is played ALONE before it enters a chain, runs gated
  (`C<N>_SKIP` of its module) for one chain at most, and declares its tier; a step over 20 s justifies its tier in a
  comment.
- In a step module: never `const URL` nor `const Symbol` (`deps.URL` is the base string; the constructor is
  `globalThis.URL`); every browser context goes through `deps.newHarnessContext` (or carries
  `X-Ytm-Harness: 1` inline), checked by `node e2e/check-harness-headers.cjs`.
- Preconditions: `skip(reason)` / `requireLibrary(n, what)` / `requireMixCards()` of `e2e/harness-lib.cjs` end a
  step as SKIP with its reason. On a small library (fewer than 2000 tracks) the offline packs finish in a second
  or two: the offline steps that must act while a pack runs hold every audio request of their own context
  (`slowAudioContext`, the service worker's fetches included); nothing changes on a larger library.
- `gotoQuiet(page, url)`: navigation in `domcontentloaded`, then the FIRST of a real `networkidle`, 1.5 s without
  a new request (the open audio stream does not count) or the 4 s cap (`HARNESS_GOTO_QUIET_MS`,
  `HARNESS_GOTO_CAP_MS`); measured in `report.gotoCount` / `gotoWaitMs` / `gotoHow`.
- `report.json` carries `gated` (steps a module skipped in this run: `{ module, step, source }`), `skippedTier`,
  `envSkipped`, `firstSoundMs` and per step `durationMs`, `slow`, `upstream`, `rerun` (known-flaky steps get one
  automatic rerun) and `skipped`.

## Server notes the scripts rely on

- Access log (`logger.go`): one JSON line per request with `"cache"` (`X-Ytm-Cache`: HIT / STALE / MISS / BYPASS)
  and `"mix_cache"` (`X-Ytm-Mix-Cache` on `me/mix`); `weekly.sh` and `e2e/perf-audit/log-latency.py` read it.
  `log-latency.py` excludes the container healthcheck, Uptime Kuma, the harness and curl / python probes by
  default (`--all` keeps everything, `--bots` keeps only them).
- Caches (`backend/api/rescache_routes.go`): `home.json` 2 min + 24 h stale, warmed at start; `local/mixes` 5 min
  + 24 h, warmed; `search.json` / `next.json` 10 min + 1 h stale; a `/cover` 404 is remembered 1 h per lid.
- `X-Ytm-Harness: 1` (or the HeadlessChrome agent) keeps a request out of the play statistics
  (`harnessRequest`, `backend/api/me_stats.go`); a staging may count them with `YTM_STATS_INCLUDE_HARNESS=1`
  (`ops/compose.staging.yml`), which the steps that need counted plays require.
- `GET /api/v1/me/nowplaying` answers 204 when the profile has no resume state (404 before this repository).
