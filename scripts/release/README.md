# Release engineering

How the repository is published, built and released. The canonical repository
is `https://forgejo.ekaii.fr/Ekaii/beatbump` (Forgejo Actions, container
registry, releases); GitHub holds a read-only push mirror.

Contents:

1. [What is in this directory](#1-what-is-in-this-directory)
2. [Workflows](#2-workflows)
3. [Coordinator runbook: first publication](#3-coordinator-runbook-first-publication)
4. [Cutting a release](#4-cutting-a-release)
5. [Image builds: the runner cannot reach Docker](#5-image-builds-the-runner-cannot-reach-docker)
6. [Runner gotchas on forgejo.ekaii.fr](#6-runner-gotchas-on-forgejoekaiifr)
7. [Local equivalents](#7-local-equivalents)

## 1. What is in this directory

| File | Role |
| --- | --- |
| `fetch.sh` | download with resume, retries and SHA-256 check (used by the installers) |
| `ci-install-go.sh` | installs the Go toolchain named by `go.mod` (`toolchain` line) into `/usr/local/go`, links `go` into `/usr/local/bin` |
| `ci-install-tools.sh` | installs pinned `docker` CLI, `buildx`, `compose`, `buildctl`, `ruff`, `shellcheck` into a plain container, checksum-verified where the project publishes one |
| `ci-web-check.sh` | svelte-check gate: error count must not exceed `ops/svelte-check.baseline` (same rule as `ops/finish-cycle.sh`) |
| `ci-shellcheck.sh` | shellcheck on `up.sh`, `ops/*.sh`, `e2e/run.sh`, `fixtures/*.sh`, `scripts/release/*.sh` (blocking at `error`, warning report printed) |
| `ci-python.sh` | `py_compile` on every tracked `.py` outside `app/`, plus `ruff --select E9,F63,F7,F82` when ruff is present |
| `ci-compose.sh` | `docker compose config -q` on `deploy/compose.yml`, then with `deploy/compose.images.yml`, with a `.env` generated from `.env.example` |
| `check-version.sh TAG` | tag is `vX.Y.Z[-pre]`, equals `VERSION`, and `CHANGELOG.md` has `## [X.Y.Z] - date` with content |
| `changelog-notes.sh VERSION` | prints that CHANGELOG section (the release notes) |
| `build-images.sh TAG` | builds and pushes the four images (`beatbump`, `-bridge`, `-indexer`, `-yubal`) through `buildctl` (remote BuildKit) or `docker buildx` |
| `forgejo-release.sh TAG [ASSET...]` | creates or updates the Forgejo release through the REST API with curl, attaches assets |
| `tag.sh [--push] [TAG]` | local annotated tag after the checks above |

Related files owned by release engineering: `.forgejo/workflows/ci.yml`,
`.forgejo/workflows/release.yml`, `.forgejo/PULL_REQUEST_TEMPLATE.md`,
`.github/workflows/ci.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `CHANGELOG.md`,
`VERSION`, `Makefile`, `deploy/compose.images.yml`, `.dockerignore`,
`.editorconfig`, `.gitattributes`, `SECURITY.md`.

## 2. Workflows

### `.forgejo/workflows/ci.yml` (push on any branch, pull_request)

Six independent jobs, all `runs-on: ubuntu-latest` in a `node:22-bookworm`
container (node 22 is what the root `Dockerfile` builds with):

| Job | What it runs | Blocking rule |
| --- | --- | --- |
| `go` | `ci-install-go.sh`, `go vet ./...`, `go test -count=1 ./...`, `go test -count=3 ./backend/api/` (`CGO_ENABLED=0`, `GOFLAGS=-p=2`) | tests pass |
| `web` | `npm ci --legacy-peer-deps` in `app/`, `npx vitest run`, `ci-web-check.sh` | vitest green, svelte-check errors <= baseline |
| `shell` | apt `shellcheck`, `ci-shellcheck.sh` | no finding at severity `error` |
| `python` | pinned `ruff` (best effort), `ci-python.sh` | every `.py` compiles, no E9/F63/F7/F82 |
| `harness-headers` | `node e2e/check-harness-headers.cjs` | every Playwright context sends `X-Ytm-Harness` |
| `compose` | standalone compose binary, `ci-compose.sh` | both compose files resolve, override names only existing services |

Verified on 2026-10-05 against the `ship` tree in the same images CI uses:
Go 3 packages ok, vitest 71 files / 880 tests, svelte-check 411 errors
(baseline 411), shellcheck 0 errors (13 warnings), py_compile 41 files ok,
ruff selection clean.

Design choices worth knowing:

- No `actions/setup-go` / `actions/setup-node`: they append to `$GITHUB_PATH`,
  which makes a job die with `exitcode '2'` on this runner (section 6). The
  Go toolchain is fetched from `dl.google.com` with its `.sha256`; node comes
  from the container image.
- No `actions/cache`: the `docker-host-ubuntu` runner has `cache.enabled: false`,
  the action would only log a warning. If the cache is enabled one day, add
  `actions/cache@v4` on `~/go/pkg/mod` (key `go.sum`) and `~/.npm` (key
  `app/package-lock.json`).
- `concurrency` cancels a superseded run of the same ref. Jobs of one run do
  run in parallel (runner capacity 2); each has its own workspace volume. If
  two jobs ever corrupt each other's checkout (seen once on another repo),
  chain them with `needs:`.
- `actions/checkout@v4` resolves from `https://data.forgejo.org/actions/checkout`
  (the instance default `DEFAULT_ACTIONS_URL`); nothing else is fetched from
  an action marketplace.

### `.forgejo/workflows/release.yml` (push of a `v*` tag)

1. Job `images`: `check-version.sh "$GITHUB_REF_NAME"`, install `docker` CLI +
   `buildx` + `buildctl`, `docker login forgejo.ekaii.fr` with
   `REGISTRY_USER` / `REGISTRY_TOKEN`, `build-images.sh` (section 5 explains
   where the build actually runs), `docker logout`.
2. Job `release` (`needs: images`): `forgejo-release.sh` creates the release
   `beatbump vX.Y.Z` with the CHANGELOG section plus an "Images" paragraph,
   and attaches `deploy/compose.yml`, `deploy/compose.images.yml`,
   `deploy/.env.example` and `up.sh`. Re-running updates the release and
   replaces the assets. A tag with a `-` (for example `v1.1.0-rc1`) is
   marked pre-release.

Image names and tags (linux/amd64):

```
forgejo.ekaii.fr/ekaii/beatbump:vX.Y.Z           forgejo.ekaii.fr/ekaii/beatbump:latest
forgejo.ekaii.fr/ekaii/beatbump-bridge:vX.Y.Z    ...-bridge:latest
forgejo.ekaii.fr/ekaii/beatbump-indexer:vX.Y.Z   ...-indexer:latest
forgejo.ekaii.fr/ekaii/beatbump-yubal:vX.Y.Z     ...-yubal:latest
```

The root image is built with `--build-arg VERSION=vX.Y.Z+<short sha>`, which
is what `/api/v1/stats/library` and `/about` report. Every image carries the
`org.opencontainers.image.source|revision|version|created` labels; Forgejo
links a container package to the repository when `source` matches the
repository URL.

### `.github/workflows/ci.yml` (mirror)

Runs `go vet` and `go test` with `actions/setup-go@v5` on pushes to `main` and
on pull requests, so the mirror shows a green check. Forgejo ignores
`.github/workflows/` whenever `.forgejo/workflows/` exists, and GitHub ignores
`.forgejo/`. `.github/PULL_REQUEST_TEMPLATE.md` tells contributors that the
canonical repository is on Forgejo. The upstream `docker-image.yml` (push to
ghcr.io) was removed: on the mirror it would fail or publish an unwanted
package.

## 3. Coordinator runbook: first publication

Everything below is run by the coordinator with real tokens; nothing in the
repository holds a secret. Replace `$FORGEJO_TOKEN` by the admin token
(`FORGEJO_TOKEN=` value in `<admin token file>`, see memory) and
`$GH_TOKEN` by a GitHub token that can create repositories.

### 3.1 Create `Ekaii/beatbump` on Forgejo

```sh
F=https://forgejo.ekaii.fr/api/v1
H="Authorization: token $FORGEJO_TOKEN"

# organisation (skip when it exists: GET $F/orgs/Ekaii)
curl -fsS -X POST -H "$H" -H 'Content-Type: application/json' "$F/orgs" \
  -d '{"username":"Ekaii","full_name":"Ekaii","visibility":"public","repo_admin_change_team_access":true}'

# repository
curl -fsS -X POST -H "$H" -H 'Content-Type: application/json' "$F/orgs/Ekaii/repos" \
  -d '{"name":"beatbump","description":"Self-hosted music app that owns its data: fork of Beatbump with a local library, offline mode and automatic acquisition","private":false,"default_branch":"main","auto_init":false,"website":"https://music.ekaii.fr"}'

# Actions and packages are off on a fresh repository until enabled
curl -fsS -X PATCH -H "$H" -H 'Content-Type: application/json' "$F/repos/Ekaii/beatbump" \
  -d '{"has_actions":true,"has_packages":true,"has_issues":true,"has_pull_requests":true,"has_wiki":false,"has_projects":false,"allow_squash_merge":true,"allow_rebase":true,"allow_merge_commits":false}'
```

### 3.2 Push `ship` as `main`

From the box (the Forgejo container runs on docker-host and the public name
hairpins through the SFR box, so go through docker0 with `host-gateway`):

```sh
cd /srv/beatbump/agents/ship
docker run --rm --add-host forgejo.ekaii.fr:host-gateway \
  -v "$PWD:/src" -w /src -e GIT_TERMINAL_PROMPT=0 alpine/git:latest \
  -c safe.directory=/src -c http.extraHeader="Authorization: token $FORGEJO_TOKEN" \
  push https://forgejo.ekaii.fr/Ekaii/beatbump.git ship:main
```

(or from the Mac: `git push https://admin_ekaii:$FORGEJO_TOKEN@forgejo.ekaii.fr/Ekaii/beatbump.git ship:main`,
retry on a 504, the WAN path is sometimes slow for `git-receive-pack`).
The worktree's `.git` is a file pointing at `beatbump-src/.git/worktrees/ship`;
mount the main repository too if the container cannot resolve it
(`-v /srv/beatbump/beatbump-src/.git:/srv/beatbump/beatbump-src/.git:ro`
with the same absolute path).

Then on the box, point the worktree at the remote so `tag.sh --push` works:
`git remote add origin https://forgejo.ekaii.fr/Ekaii/beatbump.git` (credentials
via `-c http.extraHeader=...` at push time, never stored).

Check the first CI run: `curl -fsS -H "$H" "$F/repos/Ekaii/beatbump/actions/runs?limit=3"`
(the `tasks` endpoint is stale; the DB or the web UI are the truth).

### 3.3 Actions secrets

Create two access tokens in Forgejo (user settings > Applications > Manage
access tokens) for the account that will own the packages and releases
(`admin_ekaii`, or a dedicated `ekaii-bot` user added to the org with write
access; the registry push then shows that user as publisher):

| Secret | Token scopes | Used by |
| --- | --- | --- |
| `REGISTRY_TOKEN` | `write:package` (implies read) | `docker login forgejo.ekaii.fr` in `release.yml` |
| `REGISTRY_USER` | the token owner's login (optional; defaults to the tag pusher `github.actor`, which must then own `REGISTRY_TOKEN`) | same |
| `RELEASE_TOKEN` | `write:repository` | `forgejo-release.sh` (releases + assets) |
| `BUILDKIT_ADDR` | not a token: `tcp://<buildkitd>:1234`, see section 5 | `build-images.sh` |

One token with both `write:package` and `write:repository` can serve as both
secrets. Set them with the API (the value is write-only afterwards):

```sh
for s in REGISTRY_TOKEN RELEASE_TOKEN; do
  curl -fsS -X PUT -H "$H" -H 'Content-Type: application/json' \
    "$F/repos/Ekaii/beatbump/actions/secrets/$s" -d "{\"data\":\"$(cat /path/to/$s)\"}"
done
curl -fsS -X PUT -H "$H" -H 'Content-Type: application/json' \
  "$F/repos/Ekaii/beatbump/actions/secrets/REGISTRY_USER" -d '{"data":"admin_ekaii"}'
curl -fsS -X PUT -H "$H" -H 'Content-Type: application/json' \
  "$F/repos/Ekaii/beatbump/actions/secrets/BUILDKIT_ADDR" -d '{"data":"tcp://buildkitd:1234"}'
```

Package registry: `[packages] ENABLED` is on by default in `app.ini`; the
packages appear under `https://forgejo.ekaii.fr/Ekaii/-/packages` after the
first push. Package visibility follows the repository once linked.

### 3.4 GitHub mirror (fork of giwty/Beatbump, read-only)

```sh
G=https://api.github.com
GH="Authorization: Bearer $GH_TOKEN"

# fork keeps the "forked from giwty/Beatbump" relation; `organization` is optional
curl -fsS -X POST -H "$GH" -H 'Accept: application/vnd.github+json' \
  "$G/repos/giwty/Beatbump/forks" -d '{"name":"beatbump","default_branch_only":true}'
# wait a minute for the fork to materialise, then make it a mirror in all but name
OWNER=<github user or org>
curl -fsS -X PATCH -H "$GH" "$G/repos/$OWNER/beatbump" \
  -d '{"description":"Read-only mirror of https://forgejo.ekaii.fr/Ekaii/beatbump","homepage":"https://forgejo.ekaii.fr/Ekaii/beatbump","has_issues":false,"has_wiki":false,"has_projects":false,"default_branch":"main"}'

# push our history over the fork's main (histories diverged: force)
git push --force "https://x-access-token:$GH_TOKEN@github.com/$OWNER/beatbump.git" ship:main
```

Forks have Actions disabled until someone enables them (Settings > Actions >
"I understand my workflows, go ahead and enable them"); do it if you want the
green check from `.github/workflows/ci.yml`. The branch protection on GitHub
is unnecessary: nobody merges there.

### 3.5 Forgejo push mirror to GitHub

```sh
curl -fsS -X POST -H "$H" -H 'Content-Type: application/json' \
  "$F/repos/Ekaii/beatbump/push_mirrors" \
  -d "{\"remote_address\":\"https://github.com/$OWNER/beatbump.git\",\"remote_username\":\"$OWNER\",\"remote_password\":\"$GH_TOKEN\",\"interval\":\"8h0m0s\",\"sync_on_commit\":true}"
# first sync now, then check
curl -fsS -X POST -H "$H" "$F/repos/Ekaii/beatbump/push_mirrors-sync"
curl -fsS -H "$H" "$F/repos/Ekaii/beatbump/push_mirrors"
```

The GitHub token stored in the mirror needs `repo` (classic) or
"Contents: read and write" (fine-grained) on that one repository. Tags are
mirrored too, so a release tag lands on GitHub within the sync.

### 3.6 Tag v1.0.0 and verify

See section 4. Then:

```sh
curl -fsS -H "$H" "$F/repos/Ekaii/beatbump/releases/tags/v1.0.0" | python3 -m json.tool | head -40
curl -fsS -H "$H" "$F/packages/Ekaii?type=container" | python3 -c 'import json,sys; [print(p["name"], p["version"]) for p in json.load(sys.stdin)]'
docker manifest inspect forgejo.ekaii.fr/ekaii/beatbump:v1.0.0 >/dev/null && echo image ok
# served version of a container started from the image
docker run --rm -p 18080:8080 forgejo.ekaii.fr/ekaii/beatbump:v1.0.0 &
sleep 5; curl -fsS http://127.0.0.1:18080/api/v1/stats/library   # "version":"v1.0.0+<sha>"
```

## 4. Cutting a release

1. Update `CHANGELOG.md`: move the `[Unreleased]` entries under a new
   `## [X.Y.Z] - YYYY-MM-DD`, add the compare links at the bottom.
2. Write `X.Y.Z` into `VERSION`.
3. Commit, make sure CI is green on `main`.
4. `scripts/release/tag.sh --push` (or `make tag` then `git push origin vX.Y.Z`).
   The script refuses a dirty tree, a mismatch between the tag, `VERSION` and
   `CHANGELOG.md`, or an existing tag; the tag message is the CHANGELOG section.
5. Watch the `Release` workflow on Forgejo, then run the checks of section 3.6.

Re-running a failed release (same tag): fix, `git tag -d vX.Y.Z`, delete the
tag on Forgejo (`DELETE $F/repos/Ekaii/beatbump/tags/vX.Y.Z`) and the draft
release if one was created, re-tag. Images and release assets are overwritten
on a re-run; the release body is updated in place.

## 5. Image builds: the runner cannot reach Docker

`docker-host-ubuntu` (labels `ubuntu-latest`, `linux-x64`) is hardened:
`container.valid_volumes: []` and the runner strips `--privileged`,
`--pid=host`, `--network=host`, `--cap-add`, `--security-opt` and `--device`
from job and service containers. A job therefore has **no Docker socket and
cannot run docker:dind**. `release.yml` handles this by building with
**buildctl against a BuildKit daemon** named by the `BUILDKIT_ADDR` secret:
registry credentials come from the job's `docker login`, the build context is
streamed from the job, and BuildKit pushes to the registry itself.

Choose one of these setups (the coordinator does this once):

### Option A (recommended): a BuildKit daemon on docker-host, on the CI network

```sh
# on docker-host; the job network is the egress-filtered `forgejo-ci-jobs` bridge
docker run -d --name buildkitd --restart unless-stopped \
  --network forgejo-ci-jobs \
  --add-host forgejo.ekaii.fr:host-gateway \
  --privileged \
  -v buildkitd-cache:/var/lib/buildkit \
  moby/buildkit:v0.33.1 \
  --addr tcp://0.0.0.0:1234
docker exec buildkitd buildctl --addr tcp://127.0.0.1:1234 debug workers   # sanity
```

Then `BUILDKIT_ADDR=tcp://buildkitd:1234` (the container name resolves on
the job network). Verified on 2026-10-05: with exactly this image on a
throwaway network, `build-images.sh` built the bridge image through `buildctl`
from a `node:22-bookworm` client container (`PUSH=0`), the same tooling the
`images` job installs. Notes:

- Why not `moby/buildkit:v0.33.1-rootless`: docker-host runs Ubuntu 26.04 with
  `kernel.apparmor_restrict_unprivileged_userns=1`, and rootlesskit dies with
  `fork/exec /proc/self/exe: permission denied` even with
  `--security-opt apparmor=unconfined` (tested). Rootless would need an
  AppArmor profile granting `userns` to the container, or
  `--cap-add SYS_ADMIN`; the privileged daemon with no host mounts is the
  pragmatic choice on this box.

- `--add-host forgejo.ekaii.fr:host-gateway` is the hairpin fix: from the box
  the public name resolves to the WAN address, which the SFR box does not
  route back; `host-gateway` reaches Traefik on docker0. If the BuildKit host
  is another machine on the LAN, use the LAN address of docker-host instead
  (`--add-host forgejo.ekaii.fr:<lan ip of docker-host>`), never hardcode it in
  the workflow.
- The egress filter of `forgejo-ci-jobs` allows the internet and the Forgejo
  instance; traffic to `buildkitd` stays on the same bridge. If the filter
  rejects it, add an exception for the daemon's address in
  `/usr/local/sbin/forgejo-ci-egress.sh`.
- Anyone who can run a job on the instance-wide runner can also use this
  daemon's CPU (they cannot push without credentials). Scope it if that
  matters: `--network` to a dedicated bridge plus a runner registered for the
  `Ekaii` org only (`forgejo actions generate-runner-token --scope Ekaii`).
- Pushing large layers through the public edge has failed before (499 on big
  layers); through `host-gateway` the push goes straight to Traefik.
- The rootless image needs a kernel with user namespaces and `/dev/fuse`; if
  it refuses to start, the privileged variant `moby/buildkit:v0.33.1` with
  `--privileged` works but widens the attack surface of the box.

### Option B: a dedicated runner with a Docker socket

Register an org-scoped runner (`--scope Ekaii`, label `ekaii-docker`) whose
`config.yaml` has `container.valid_volumes: ["/var/run/docker.sock"]` and a
job network that reaches the registry, then change `runs-on: ubuntu-latest`
to `runs-on: ekaii-docker` in `release.yml` and mount the socket in the
`images` job:

```yaml
    container:
      image: node:22-bookworm
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
```

`build-images.sh` detects the reachable daemon (`docker info`) and uses
`docker buildx build --push` instead of buildctl. Only trusted repositories
may run on such a runner (a pull request from a fork would get the socket).

### Option C: build by hand on docker-host

`REGISTRY=forgejo.ekaii.fr IMAGE_NS=ekaii/beatbump scripts/release/build-images.sh v1.0.0`
after `docker login forgejo.ekaii.fr` (with `--add-host`-equivalent name
resolution: an `/etc/hosts` line to `10.0.0.1` or the LAN address while
pushing). Then run `forgejo-release.sh` locally with `RELEASE_TOKEN` set, or
let the `release` job do it after re-running the workflow with the images
already present (the `images` job is idempotent).

## 6. Runner gotchas on forgejo.ekaii.fr

Collected from earlier CI work on this instance; they shaped the workflows.

- Runner `docker-host-ubuntu` (`code.forgejo.org/forgejo/runner:13.2.0`, on
  docker-host): labels `ubuntu-latest:docker://node:20-bookworm` and
  `linux-x64`; `capacity: 2`; `timeout: 40m` per job; `cache.enabled: false`;
  job network `forgejo-ci-jobs` (egress filtered: internet and the Forgejo
  instance only, no LAN, no host, no other Docker networks); job containers
  get `--add-host forgejo.ekaii.fr:host-gateway`, which is why checkout,
  release API calls and registry logins work from a job.
- `runs-on` matches runner **labels** only, never names.
- A step that appends to `$GITHUB_ENV` or `$GITHUB_PATH` makes the job die
  with `exitcode '2'` right after the step (runner v13, container jobs).
  Use job-level `env:` and install tools into `/usr/local/bin`.
- `actions/upload-artifact@v4` is not supported; `@v3` is. Not used here.
- A job container image must have `node` on its PATH (JS actions are
  executed with `docker exec node ...`); `golang:*`, `python:*` and
  `koalaman/shellcheck` images do not, hence `node:22-bookworm` everywhere
  with tools installed by script.
- Long downloads inside a job get reset now and then: `fetch.sh` resumes and
  retries.
- The `actions/tasks` API is stale; `actions/runs` is live. Job logs on the
  host: `/srv/data/services/forgejo/data/gitea/actions_log/Ekaii/beatbump/<xx>/<task>.log.zst`.
- A new repository has `has_actions=false` until patched (section 3.1).
- Fork pull requests from first-time contributors wait for approval before
  their workflow runs (good: secrets never reach them anyway, Forgejo does not
  expose secrets to `pull_request` runs from forks).
- If every `ubuntu-latest` run sits in "Waiting", the runner container is gone
  or wedged: `docker ps --filter name=forgejo-runner-ubuntu` on docker-host,
  recreate it from `/home/docker-host/forgejo-runner-ubuntu` (registration
  persists in `.runner`).
- Workflow YAML was validated with PyYAML before commit; Forgejo also rejects a
  syntactically wrong workflow at push time with a red run named after the file.

## 7. Local equivalents

```sh
make ci                  # go, web (needs make web-deps once), shell, python, harness-headers, compose
make images TAG=v1.0.0   # build the four images locally, no push
make release-notes       # print the CHANGELOG section for VERSION
make check-version       # tag/VERSION/CHANGELOG consistency
make tag                 # annotated tag after the checks
```

Tool requirements: Go (version of `go.mod`), node 22, `shellcheck`,
`python3` (+ `ruff` optional), `docker compose` or `docker-compose`; `docker
buildx` or `buildctl` + `BUILDKIT_ADDR` for images.
