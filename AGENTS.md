# AGENTS.md: taking over the improvement loop

This file is for an AI agent (Claude Code or similar) that inherits this repository and its
autonomous improvement loop. It says where things are, which rules were learned by breaking
production, how one cycle runs end to end, and what "done" means. Read `README.md` first for what
the product is, `docs/OPERATIONS.md` for the commands, `CHALLENGES.md` for the incidents that come
back. The loop was run for 48 hours (58 promoted cycles, 74 staging chains) plus a cycle 59; its
lessons are condensed here and in `CHALLENGES.md`; the raw (French) journal is kept privately by the
maintainers.

## 1. Repository map

| Path | What it is |
|---|---|
| `main.go`, `*.go` at the root | the Go server entry: Echo router, cache policy, static ETag, SPA 404, healthcheck |
| `backend/api/` | every `/api/v1/*` handler: YouTube pages, local library (`local_*.go`), profiles and stats (`me_*.go`), acquisition (`acquire*.go`), audio proxy, response cache (`rescache*.go`) |
| `backend/_youtube/` | InnerTube client (`api.go`: player timeout, residential proxy) |
| `backend/db/` | GORM models (`me_models.go`: profiles, favorites, follows, playlists, play_events, now_playings, skip_events, acquire_jobs) |
| `app/` | SvelteKit SPA (adapter-static). `app/src/service-worker.ts` is the offline engine; `app/src/lib/` holds the player, queue, offline, resume and stats modules; `app/src/routes/` the pages |
| `app/src/lib/utils/frenchScreens.test.ts` | structural guard: no English UI word on the listed screens |
| `bridge/bridge.py` | local-first audio server: title + artist match against Meilisearch, `/localf` from disk, covers, `/vp` proxy, enqueue to yubal |
| `indexer/indexer.py` | tag walker that fills the `tracks`, `albums`, `artists` indexes |
| `yubal/` | yubal image overlay: deno runtime, bgutil po-token plugin, yt-dlp shim |
| `up.sh`, `deploy/` | the portable stack: `up.sh` (first run, update, logs), `deploy/compose.yml`, `deploy/.env.example`, `deploy/companion/config.toml`, `deploy/VERIFICATION.md` |
| `fixtures/` | `make-sample-library.sh` (18 CC0 synthetic tracks for a fresh install), `embed-cover.py` |
| `e2e/` | the browser harness: `run.sh`, `harness-lib.cjs` (shared helpers), `harness-core.cjs`, `harness-offline.cjs`, `harness-smoke.cjs`, `steps-c*.cjs` modules, `probe-deploy-survives.cjs` with its `probe-ds1-*.cjs` wrappers, `probe-postdeploy.cjs`, `fixtures.json`, `check-harness-headers.cjs`, `chrome-image/`, `ux-audit/`, `perf-audit/`, `access-audit/` |
| `ops/` | the loop: `stage-cycle.sh`, `finish-cycle.sh`, `promote.sh`, `smoke.sh`, `weekly.sh`, `monday.sh`, `journal.py`, `cleanup-harness-profiles.sh`, `library-lint.py`, `svelte-check.baseline`, `cron.weekly.example`, `env.sh` / `env.example` (host layout), `README.md` |
| `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` | request flows; deploy, rollback, health, backups, cron, alerts |
| `$YTM_PROGRAM_DIR` (not in the repository) | the program directory of a running loop: `CYCLES.md`, `CHANGELOG.md`, `DECISIONS.md`, `BACKLOG.md`, audits, brainstorms, `WEEKLY.md`, `ALERT.md` (section 4) |

Branch model (production): `agents/integration` is the reference branch; a lane is a worktree on
branch `agents/<lane>` created from integration; production runs the image built from an
integration commit and reports its short sha in `/api/v1/stats/library`. The `ship` branch is the
portable, documented export of that tree.

## 2. Invariants (each one was learned by breaking something)

Deployment and containers:

1. **Promote only through the ops scripts.** `ops/promote.sh` is the only writer of the production
   compose file and the only path that saves the verified tarball, tags the previous image and
   prints the rollback lines. `ops/finish-cycle.sh` is the only way to end a cycle. No ad hoc
   `/tmp/*-finish.sh`.
2. **Container operations by exact name only** (`$YTM_PROD_CONTAINER`, `$YTM_STAGING_CONTAINER`,
   `ytm-harness-<ts>`). Never `docker ps --filter ancestor=`: production and staging share the same
   image after a promotion, and that filter deleted production once.
3. **No image prune on a containerd image store.** Never `docker image prune`, `system prune`, or
   a scheduler that does it (Coolify "force cleanup" must be off or exclude `beatbump-ekaii*`). The
   tarballs in `image-backups/` are the real backup; `ops/smoke.sh` restores the tag from them.
4. **Never `docker run <app image> sh`**: the image is `FROM scratch`, the entrypoint is the
   server; you get an orphan container. Inspect with `docker create` + `docker cp`.
5. **Never read the production database file directly** with a writer. Reads use the SQLite URI
   `mode=ro` plus `PRAGMA query_only` (`ops/weekly.sh`, `ops/cleanup-harness-profiles.sh`);
   writes are a recorded decision, done as root after an online backup (decision 20 shows the exact
   form).
6. **DS1 probe mandatory** (`--ds1`) when `app/src/app.html`, `app/static/manifest.json`,
   `app/src/service-worker.ts`, `app/src/routes/+layout.svelte`, `+layout.ts`, `vite.config.*`,
   `svelte.config.js`, `app/scripts/svelteRuntimeChunk.ts`, or any file the service worker imports
   changed since the production sha. `finish-cycle.sh` computes this guard (closed by default: an
   unreadable production version also requires DS1) and refuses to promote without it.
7. **Secrets never in compose files or the repository.** `COMPANION_SECRET_KEY`, `YTM_ADMIN_TOKEN`
   and `YTM_REPORT_EMAIL` come from an `env_file` in mode 600 outside the tree; `environment:`
   wins over `env_file:` in compose, so never put them back in `environment:`. `weekly.sh` takes
   secrets by environment or stdin (`-`), never by file path.

Verification:

8. **Never merge on integration between the verification and the chain's "chain N on <sha>"
   line.** `stage-cycle.sh` builds HEAD at the moment of `docker build`; chain 57 promoted code
   nobody had verified.
9. **One vitest at a time per tree.** `svelteRuntimeChunk.test.ts` builds with rollup in a temp
   folder; two runs in the same tree make one fail.
10. **svelte-check 411 is a ceiling, never a target.** `ops/svelte-check.baseline` only goes down,
    by commit, in the same change that lowers the debt. Any rise blocks (`finish-cycle.sh` exit 3).
    Read the count: a rise of 2 once hid a wrong store name that broke every page.
11. **Every Playwright context sends `X-Ytm-Harness: 1`.** The server ignores those plays (stats,
    acquisition, now-playing, client-log) unless `YTM_STATS_INCLUDE_HARNESS=1` (staging only).
    `node e2e/check-harness-headers.cjs` is run by `stage-cycle.sh` and stops the chain if a
    context lacks the header. A stray diagnostic file in `e2e/` once stopped a chain: that is the
    guard working.
12. **A new harness step runs gated for one chain, then alone, then enabled.** Add it to its
    module's `C<N>_SKIP` set, play it with `HARNESS_ONLY=<name>` on staging, remove it from the set
    at the next chain. `report.json.gated` must be `[]` at most one chain after the step was added;
    `finish-cycle.sh` refuses (exit 3) a step gated two chains in a row unless `FINISH_ALLOW_GATED=1`.
13. **One browser at a time on the box.** `e2e/run.sh` refuses a second `ytm-harness-*` (exit 2)
    and waits for the build lock and for a 1-minute load under 60. No production harness during a
    staging build. Lanes never open a browser; the chain does.
14. **Wait 90 s after a promotion before the offline harness** (service worker install window);
    `probe-postdeploy.cjs` covers it.
15. Builds are serialised by `flock /tmp/beatbump-build.lock`, `npm ci` by `flock /tmp/npm-ci.lock`.
    Long scripts run detached with their own log (`nohup ... > log 2>&1 &`), never `a && b &` inside
    an ssh session. A script in use is replaced atomically (write a temp file, then `mv`).
16. Timestamps come from the box clock, `date -u`.

## 3. The cycle recipe

Pre-requisites: no chain running (`ls /tmp/ytm-stage-cycle<chain>.log` must not exist), the last
cycle's log ends with `FINISH <N-1> DONE`, the host layout is loaded (`ops/env.sh`, see
`ops/env.example`).

1. **Pick 1 to 3 backlog items** with disjoint files (one lane = one item or one coherent lot on the
   same files). Items come from the program directory's `BACKLOG.md`, the latest `audit-*-vN.md` and
   the latest `brainstorm-vN.md`. The lane that touches `e2e/` or `ops/` is the only one that may need the
   browser, after the running chain.
2. **One worktree per lane**, from integration, with a guarded `cd`:
   ```sh
   cd <checkout>/agents/integration || exit 1
   git worktree add ../<lane> -b agents/<lane> agents/integration
   cd ../<lane>/app || exit 1
   flock /tmp/npm-ci.lock npm ci
   ```
3. **Lane rules**: one commit per item, message citing the item id (`fix(home): ... (U13-5)`);
   `go vet ./... && go test ./...` (image `golang:1.24.5`, `-count=3` on `backend/api` because of
   global memos), `npx vitest run`, `npm run check` under the baseline; a structural test when the
   item is a rule (French text, button system, shell asset list); a harness step written in a
   `steps-c<N>-*.cjs` module (no side effect at load, everything in `run(deps)`, never `const URL`
   at module level, `deps.newHarnessContext` for contexts), gated. No browser, no image build, no
   container, no compose in a lane.
4. **Merge into integration**, one lane after the other, conflicts by hand, then Go + vitest +
   svelte-check on integration. One verification at a time. Do not merge again until the chain
   has printed its "chain N on <sha>" line.
5. **Write the journal text** `ops/journal/cycle-<N>.md` (format in `ops/README.md`, section
   `journal.py`): marker, optional `cycles:` line, heading, bullets. Tokens `{head}`, `{chain}`,
   `{date}`, `{time}`, `{now}`.
6. **Dry run, then run, the end of cycle**:
   ```sh
   FINISH_PARSE_ONLY=1 sh ops/finish-cycle.sh <cycle> <chain>            # arguments, SM2 guard ("DS1 requis"?), svelte-check guard, gated list
   nohup sh ops/finish-cycle.sh <cycle> <chain> [--ds1] --wait >/dev/null 2>&1 &
   grep -E "svelte-check|core=|DS1|GREEN|promote.sh exit|Report|FINISH" /tmp/ytm-finish-<cycle>.log
   ```
   `<chain>` = last chain number in `CYCLES.md` + 1. `--ds1` when the guard says so. `--wait` waits
   for a running harness (60 min max) instead of refusing. `--no-promote` plays the chain only.
   Exit codes: 0 done, 1 refused, 3 not green (nothing promoted), 4 `promote.sh` failed (ROLLBACK
   lines in the log). Last line: `FINISH <cycle> DONE`.
7. **After a green cycle**: `finish-cycle.sh` already ran `promote.sh`, `journal.py`,
   `probe-postdeploy.cjs` and the production harness in `full` tier. Read the production
   `report.json`, add the scores and the `PROD = <sha>` line to `CYCLES.md`, move the items to
   "Clos" in `BACKLOG.md`, validate alone and un-gate the new steps for the next chain.
8. **Queueing two cycles**: a small detached script waits for `FINISH <N-1> DONE` and for a marker
   file `/tmp/ytm-c<N>-ready` that you `touch` only once the merge is done and verified. Without the
   marker nothing starts.

## 4. Reading the outputs

`e2e/out/<timestamp>/report.json` (written by both harnesses and the smoke):

| Field | Meaning |
|---|---|
| `url`, `query`, `version` | target, search query, served sha (from `stats/library`) |
| `tier` | `chain` or `full` |
| `passed`, `failed`, `upstream`, `skipped` | counts; `upstream` failures (YouTube `next` "Invalid response", `ERR_INTERNET_DISCONNECTED`, `ERR_CERT_VERIFIER_CHANGED`, `net::ERR_*`) are not counted as failed; `skipped` = precondition not met (`SKIP <name> - <reason>`), never a failure |
| `envSkipped` | steps that need counted harness plays, not played because the target ignores harness plays (production); staging sets `YTM_STATS_INCLUDE_HARNESS=1` |
| `durationMs`, `budgetMs`, `overBudget` | run time against 8 min (`chain`) or 12 min (`full`) for the core |
| `firstSoundMs` | click to first sound in `play_from_search` (alert threshold 3 s) |
| `gotoCount`, `gotoWaitMs`, `gotoHow` | the `gotoQuiet` statistics |
| `gated` | steps skipped by a module `C<N>_SKIP` set or env; must return to `[]` |
| `skippedTier` | steps skipped by the tier |
| `steps[]` | `name`, `ok`, `detail`, `shot`, `durationMs`, `slow`, `upstream`, `rerun`, `firstDetail` |

Next to it: `NN-<step>.png` (one per step, `NN-FAIL_<step>.png` on failure), `pageerrors.log`
(core), `failed.log` (failed network requests), `streams.json`. The chain log is
`/tmp/ytm-stage-cycle<chain>.log`; read it with
`grep -E "^(=== |PASS|FAIL|UPSTREAM|RETRY|Report|staging HTTP)"`.

The journals (program directory `YTM_PROGRAM_DIR` from `ops/env.sh`, outside the repository):

- `CYCLES.md`: one line per event, prefixed by the box clock. Lanes launched and delivered, merges,
  chains with scores, promotions with image id and tarball, incidents and the lesson. The
  `PROD = <sha>` lines are read by `weekly.sh` and `monday.sh` (expected version).
- `CHANGELOG.md`: only what is in production, one entry per promotion, written by `journal.py`
  from `ops/journal/cycle-<N>.md`.
- `BACKLOG.md`: `- [ ] P<n> <item> (raised cycle X ; blocked by ...) Verification: <one line>`,
  moved to "Clos" with the cycle and commit that closed it.
- `WEEKLY.md`: one line per `weekly.sh` run (11 columns, header explains each). `ALERT.md`: one
  block per threshold crossed; treat, then delete the block (it never empties itself).
- `audit-logic-vN.md`, `audit-ux-vN.md`, `audit-perf-vN.md`, `audit-features-vN.md`: read-only
  reports, each with a review of the previous version and a TOP 10. `brainstorm-vN.md`: ideas and
  the TOP 3 lanes per cycle.

## 5. Recording decisions

Anything that needs the owner's choice (language, product scope, a production component without
staging, a cost, a port to open, a change to production data) goes to `DECISIONS.md` in the program directory, never
into a lane. Pattern, kept since cycle 36:

- a row in the table: `| # | Subject | What is blocked | Recommended default | Changes current behaviour? | Effort (0/XS/S/M/L) | Urgency |`;
- a detail section `### <n>. <Subject>` with `Bloque` (what is blocked), `Preuves` (file:line,
  CYCLES line, audit id), `Defaut recommande`, `Effort`, `Apres un "oui"` (who does what);
- when applied: a line `TRANCHE le <date> (<mandate>) : <what was done, commit, rollback path>`.

"Yes" means apply the recommended default. Without an answer, nothing changes. The owner answers
with one word per number. On 4 October 2026 the owner delegated all 21 open decisions to their
recommended defaults; cycle 59 applied them. Keep the numbering (next is 23).

## 6. Audits and brainstorms

Rotation: UX audit on even weeks (captures with
`e2e/ux-audit/shots.cjs`, then read the images and `metrics.json`), logic audit on odd weeks (read
the git range since the last audit: profile leaks through shared caches, pagination, offline,
quota, acquisition rules, swallowed errors), perf audit monthly (`e2e/perf-audit/api-latency.sh`,
`log-latency.py` over the access logs). One brainstorm per month with a
read-only mandate and sections 0 (state, with the exact
commands that produce it), 1 (review of the previous brainstorm with proof per idea), 2 (new ideas
per journey, each with size, reusable code `file:line`, lane and a measurable verification), 3 (TOP
of 3 lanes per cycle, two cycles max, with the six chain rules copied in), 4 (what to stop doing),
5 (blocked ideas and new decisions). Every claim about code cites `file:line` at the integration
HEAD of the day.

Out of scope without a dedicated brainstorm: open decisions, the bridge, the indexer, any new home
row, page or mix name, any SvelteKit / Vite / Go upgrade.

## 7. When a chain is red

Triage in this order; most red chains of the program were 1 or 3, not 2.

1. **Harness contract** (most frequent). Symptoms: the failing step is new or was touched by this
   cycle; the detail mentions a selector, a label, a timeout on a click, a count; the step passed
   on the previous sha. Check `NN-FAIL_<step>.png` and `pageerrors.log`. Known shapes: UI string
   changed (translation), stale expectation (HIT vs STALE, a label), `page.route` that cannot see
   requests served by the service worker (use a context with `serviceWorkers: "block"`),
   Playwright `request` context that ignores `--host-resolver-rules` (use Node `https` to
   127.0.0.1 with SNI, or `fetch` from the page), `URL` shadowed in a module, a list-audio reader
   on a MessageChannel port alone. Fix the step, play it alone with `HARNESS_ONLY`, relaunch the
   chain.
2. **Product bug.** Symptoms: `pageerrors.log` has entries on every page (TDZ, "is not defined",
   "Illegal invocation"), several unrelated steps fail after one point, the screenshot shows a
   black page or a frozen control, the same failure on a dedicated probe. vitest is blind to most of
   these (Node has no DOM receiver checks, no import-cycle evaluation order, no Svelte scheduler):
   reproduce in a short Playwright probe (`e2e/probe-postdeploy.cjs` is the template; the
   program's one-off probes were dropped from the tree, their findings are in `CHALLENGES.md`),
   fix in a lane, add a jsdom or structural test that fails on the old sha.
3. **Box load.** Symptoms: `ERR_CERT_VERIFIER_CHANGED` then `ERR_INTERNET_DISCONNECTED` in
   `failed.log`, "browser has been closed" cascading over the remaining steps, click timeouts on
   steps green on the same sha the chain before, 1-minute load above 40 (`cut -d' ' -f1
   /proc/loadavg`). Not a regression: replay once. Three identical flakes on one step put it in
   `FLAKY_KNOWN` (one automatic rerun), never raise a timeout to hide it.
4. **Infrastructure.** Symptoms: `staging HTTP` not 200, `BUILD_FAIL`, DS1 "same build served"
   (the production image tag disappeared: restore from the tarball), `HARNESS_HEADER_CHECK_FAIL`,
   companion or YouTube answering errors on every `next`/`player` call (upstream, not the app),
   NFS mount hung (`df` not answering in 10 s). Fix the box, do not touch the code.

A `FAIL` that is not explained is a regression: P1 in the backlog, lane the same day, no
promotion. An `UPSTREAM` step is not counted; three Mondays in a row on the same step means a
determinism lane (move the dependency to `e2e/fixtures.json`).

## 8. Definition of done for a cycle

- Every lane merged into integration; integration verified once: Go green (`-count=3` on
  `backend/api`), vitest green, svelte-check at or under the baseline.
- `ops/journal/cycle-<N>.md` written before `finish-cycle.sh`.
- Staging chain green: core `Report: P passed / 0 failed`, offline `Report: P passed / 0 failed`,
  staging serving HEAD's sha, `check-harness-headers` green, `gated` empty or new this chain.
- DS1 upgrade and rollback `PASS` when the guard applies, staging back on the new image.
- `promote.sh exit 0`: tarball verified, healthcheck `healthy`, served version equals the sha,
  smoke green (HTTP and browser), rollback lines in the log.
- Production harness in `full` tier green (a step new to this cycle may be red on production only
  before the promotion, never after).
- `CHANGELOG.md` entry and `CYCLES.md` line written (`journal.py`), `PROD = <sha>` line with the
  production scores, backlog items moved to "Clos", new harness steps validated alone and
  un-gated, decisions that this cycle raised written in `DECISIONS.md`.
- `/tmp/ytm-finish-<cycle>.log` ends with `FINISH <cycle> DONE`.

## 9. Session hygiene (agent side)

- Model session limits are per model: when lanes die at birth or mid-way (429), relaunch them on
  another model and wait five minutes before retrying the same one. One commit per item limits
  the loss; relaunch with "resume" and the list of commits already made.
- A network cut on the operator's machine does not stop the box: runs continue; re-read
  `e2e/out/` and the chain logs before relaunching anything.
- Use `ssh -o ControlMaster=no -o ControlPath=none` when several agents share the box; the shared
  multiplexer saturates and blocks ssh for minutes.
- Audits and brainstorms are read-only sessions: no code, no container, no compose, no worktree,
  no browser. Their only output is the file.
