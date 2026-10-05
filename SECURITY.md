# Security policy

## Reporting a vulnerability

Please do not describe a security problem in a public issue or pull request.

- Email the maintainer at the address shown on the Forgejo organisation page,
  https://forgejo.ekaii.fr/Ekaii, or
- if no address is listed, open an issue on the canonical repository titled
  "Security: contact request" **without any detail**; the maintainer answers
  with a private channel (Forgejo has no confidential issues).

Include the version (the `version` field of `/api/v1/stats/library`, the
`VERSION` file, or the image tag), the steps to reproduce, and the impact you
see. You will get an acknowledgement within 7 days and a fix or a mitigation
within 30 days for issues rated high or critical; lower severities are batched
into the next release. Credit is given in `CHANGELOG.md` unless you prefer not
to be named.

The GitHub repository is a read-only mirror; reports sent there may be missed.

## Scope

In scope:

- the Go server (`main.go`, `backend/`): authentication of named profiles and
  the admin token, the `/vp`, `/aud`, `/localf`, `/cover` proxies and their
  allow-lists, the acquisition queue and its daily cap, server-side playlists,
  history and statistics, path handling of the local library;
- the SvelteKit application (`app/`): service worker caches, share targets,
  stored profile data, anything that can execute script from data;
- the sidecars shipped as images (`bridge/`, `indexer/`, `yubal/`) and the
  deploy stack (`deploy/compose.yml`, `up.sh`);
- the CI and release workflows (`.forgejo/workflows/`, `scripts/release/`).

Out of scope:

- YouTube, Invidious, Meilisearch, Navidrome and yubal upstream behaviour
  (report upstream, tell us if a change on our side is needed);
- the reverse proxy, the anti-bot wall and the network in front of a given
  deployment;
- denial of service through the acquisition queue beyond the documented cap,
  and findings that require an already-compromised host or admin token.

## Supported versions

Only the latest release (`CHANGELOG.md`, tag `vX.Y.Z`) and `main` receive fixes.

## Good to know

- Secrets are never committed; `deploy/.env.example` lists what a deployment
  needs and `deploy/.env` is git-ignored.
- Release images are built by `.forgejo/workflows/release.yml` from a tag; the
  tag must match `VERSION`, and every tool used by CI is pinned and verified
  against its published checksum (`scripts/release/ci-install-tools.sh`).
- The browser harness marks every request with `X-Ytm-Harness: 1` so it never
  writes into production statistics; `e2e/check-harness-headers.cjs` enforces
  it in CI.
