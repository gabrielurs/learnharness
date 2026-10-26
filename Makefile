# Thin wrapper over the npm scripts plus the Docker sandbox setup.
# `make` alone lists the targets.

SANDBOX_IMAGE := $(shell sed -n 's/^export const SANDBOX_IMAGE = "\(.*\)";/\1/p' src/server/docker-runner.ts)

.DEFAULT_GOAL := help
.PHONY: help install dev fresh desktop test lint typecheck check build start sandbox clean

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	npm ci

dev: ## Dev server on http://127.0.0.1:3000 (loopback only)
	npm run dev

fresh: ## Fresh-user instance (no keys, no data) on :3005
	npm run dev:fresh

desktop: ## Electron app against the dev server
	npm run desktop:dev

test: ## Deterministic tests (no LLM, no network)
	npm test

lint: ## ESLint
	npm run lint

typecheck: ## tsc --noEmit
	npm run typecheck

check: typecheck test lint ## What CI runs: typecheck, test, lint

build: ## Production Next build
	npm run build

start: build ## Serve the production build on 127.0.0.1
	npm start

sandbox: ## Check Docker and pull the pinned C/C++ sandbox image
	@docker info >/dev/null 2>&1 || { echo "Docker is not running: start it first."; exit 1; }
	docker pull $(SANDBOX_IMAGE)

clean: ## Remove build output (.next, dist)
	rm -rf .next dist
