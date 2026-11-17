# Commands for the pi-packages monorepo. `make` lists the targets.
#
# One npm workspace per published package. The root is private and never
# published: it exists for one lockfile, one `npm ci`, and `npm publish -w`.

PI    := pi-keeper pi-session-topic pi-shell-highlight
TSC   := $(CURDIR)/node_modules/.bin/tsc

.DEFAULT_GOAL := help

##@ General

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Setup

.PHONY: install
install: ## npm ci from the root (workspaces hoist into ./node_modules)
	npm ci

##@ Validation

.PHONY: check
check: typecheck test ## Everything that runs offline
	@echo "check: ok"

.PHONY: test
test: ## Test every package
	@for pkg in $(PI); do echo "test: $$pkg"; npm test --workspace $$pkg --if-present || exit 1; done

.PHONY: typecheck
typecheck: ## tsc --noEmit for every package
	@for pkg in $(PI); do \
	  echo "typecheck: $$pkg"; \
	  (cd $$pkg && $(TSC) --noEmit) || exit 1; \
	done

##@ Packaging

.PHONY: pack-dry
pack-dry: ## Show what each package would publish (no tarball written)
	@for pkg in $(PI); do npm pack --dry-run --workspace $$pkg; done

.PHONY: pack-check
pack-check: ## Fail if a tarball misses LICENSE, NOTICE, README, CHANGELOG or an entry point, or ships tests, scripts or docs
	@node scripts/check-pack.mjs $(PI)

.PHONY: pack
pack: ## Write a tarball per package into ./dist
	@mkdir -p dist
	@for pkg in $(PI); do npm pack --workspace $$pkg --pack-destination dist; done
