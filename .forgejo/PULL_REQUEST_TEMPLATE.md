<!-- Describe the change and why it is needed. CI must be green (.forgejo/workflows/ci.yml). See CONTRIBUTING.md. -->

## What

## Why

## Checklist

- [ ] `go vet ./... && go test -count=3 ./backend/api/ && go test ./...` pass
- [ ] `cd app && npm ci && npx vitest run` passes; `npm run check` errors stay at or under `ops/svelte-check.baseline` (lower the file if your change lowers the count)
- [ ] Shell scripts pass `shellcheck -S error`; Python files byte-compile
- [ ] Browser-visible change: a `steps-c<N>-<topic>.cjs` harness step, contexts via `deps.newHarnessContext` (`node e2e/check-harness-headers.cjs`)
- [ ] Product choice needed: a row in `docs/archive/DECISIONS-PAUL.md`, current behaviour left in place
- [ ] Commit messages in the imperative with the item id; user-visible change noted under `[Unreleased]` in `CHANGELOG.md`
