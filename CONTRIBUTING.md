# Contributing

Short version: branch from the integration branch, keep every check green, prove UI changes in the
real-browser harness, record product choices in the decisions file, write commits in the
imperative with the item id.

## Branches

- `agents/integration` is the reference branch; production is always an integration commit.
- One change = one branch `agents/<lane>` (a worktree in the production layout), created from
  integration. Keep files disjoint from other open branches; merge one branch at a time.
- The `ship` branch is the exported, documented tree. Tags `vX.Y.Z` are releases; notes go to the
  root `CHANGELOG.md` (Keep a Changelog).

## Checks to run before a merge

```sh
go vet ./... && go test -count=3 ./backend/api/ && go test ./...   # golang:1.24.5 (the Dockerfile's image)
cd app && npm ci && npx vitest run
npm run check        # svelte-check: errors must stay at or under ops/svelte-check.baseline (411)
```

The svelte-check number is a ceiling, never a target. If your change lowers it, lower the file in
the same commit. Run one vitest at a time in a tree.

Rules enforced by tests you may hit:

- `app/src/lib/utils/frenchScreens.test.ts`: the listed screens must not contain English UI
  words. The UI is French by the owner's decision; add French strings, or make the test aware of a
  legitimate match in its `ALLOW` list with a reason. An i18n contribution replaces the literals
  with a lookup and adapts this test.
- the import-cycle test (c48c, extended in c52b): no top-level `subscribe` across an import cycle
  on a dynamic-import entry.
- the bare-button ratchet: the count of buttons outside the button system can only go down.
- Go `TestSpaRootsMatchSvelteKitRoutes`: a new route needs its first path segment in `spaRoots`
  (`spa_notfound.go`).

## The harness

Any change visible in the browser needs a harness step, written in a `steps-c<N>-<topic>.cjs`
module under `e2e/`:

- no side effect at load, everything in `run(deps)`; use `deps.newHarnessContext` for contexts (the
  `X-Ytm-Harness: 1` header is mandatory, `node e2e/check-harness-headers.cjs` checks it);
- never `const URL` or `const Symbol` at module level;
- a step over 20 s declares its tier in a comment (`chain` only if it protects a journey that
  already regressed, else `{ tier: "full" }`);
- selectors on `data-testid`, not on labels;
- the step starts gated (`C<N>_SKIP`), is played alone with
  `HARNESS_ONLY=<name> ./run.sh <url> "daft punk" harness-core.cjs`, then enabled at the next
  chain.

Run the suites from `e2e/`: `./run.sh <url> "daft punk" harness-core.cjs`, then
`harness-offline.cjs`. `README.md` lists the tiers and options; `AGENTS.md` section 7 is the triage
order when a run is red.

## Commits

Imperative English (or French for product text, as the journal is), one commit per item, the item
id in the message: `fix(home): keep the resume card above the fold (U13-5)`. Reference the audit,
brainstorm or backlog id. Co-authorship lines go at the end of the message.

## Product decisions

Anything that needs the owner's choice (scope, language, a production component without staging,
production data, a cost) is not decided in a branch. Add a numbered row and a detail section to
`docs/archive/DECISIONS-PAUL.md` (pattern: what is blocked, evidence, recommended default, effort,
what happens after a "yes") and leave the current behaviour in place until it is answered.

## What not to touch

The production compose file (only `ops/promote.sh` writes it), the bridge, the indexer and yubal
outside a maintenance window (no staging), the production database file, the `docs/archive/`
contents (raw program archive, kept as is).
