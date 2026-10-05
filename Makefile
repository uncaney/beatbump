# Convenience targets mirroring .forgejo/workflows/ci.yml and release.yml.
# Each target calls the same script CI calls, so a green `make ci` locally
# means a green CI (tools permitting: go, node 22, shellcheck, python3,
# docker compose; ruff and buildx optional).
SHELL := /bin/bash
.DEFAULT_GOAL := help

VERSION := $(shell tr -d '[:space:]' < VERSION)
TAG ?= v$(VERSION)

.PHONY: help ci go web web-deps shell python harness-headers compose \
        images release-notes check-version tag

help: ## List the targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

ci: go web shell python harness-headers compose ## Everything CI runs

go: ## go vet + go test ./... (CGO off, -count=1)
	CGO_ENABLED=0 go vet ./...
	CGO_ENABLED=0 go test -count=1 ./...

web-deps: ## npm ci in app/
	cd app && npm ci --legacy-peer-deps --no-audit --no-fund

web: ## vitest run + svelte-check ceiling (needs app/node_modules)
	cd app && npx vitest run
	scripts/release/ci-web-check.sh

shell: ## shellcheck on up.sh, ops/*.sh, e2e/run.sh, fixtures/*.sh, scripts/release/*.sh
	scripts/release/ci-shellcheck.sh

python: ## py_compile (+ ruff when installed) on the sidecar and ops python
	scripts/release/ci-python.sh

harness-headers: ## Every Playwright context must send X-Ytm-Harness
	node e2e/check-harness-headers.cjs

compose: ## docker compose config on deploy/compose.yml (+ images override)
	scripts/release/ci-compose.sh

images: ## Build the four images locally without pushing (PUSH=0), tag $(TAG)
	PUSH=0 LATEST=0 scripts/release/build-images.sh $(TAG)

release-notes: ## Print the CHANGELOG section for $(TAG)
	scripts/release/changelog-notes.sh $(TAG)

check-version: ## Tag $(TAG) must match VERSION and CHANGELOG.md
	scripts/release/check-version.sh $(TAG)

tag: ## Create the annotated tag $(TAG) (clean tree, VERSION and CHANGELOG checked)
	scripts/release/tag.sh $(TAG)
