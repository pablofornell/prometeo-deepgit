# DeepGit: developer commands.
# Run `make` or `make help` to see the targets.

SHELL := /bin/bash
# A failed recipe must not leave a half-written target that counts as up to date (dist/index.html).
.DELETE_ON_ERROR:
.DEFAULT_GOAL := help

# rustup installs cargo in ~/.cargo/bin. A shell started before the install
# does not have it in PATH yet, so add it here (no effect if it is already there).
ifneq ($(wildcard $(HOME)/.cargo/bin/cargo),)
export PATH := $(HOME)/.cargo/bin:$(PATH)
endif

CARGO ?= cargo
NPM   ?= npm
NPX   ?= npx

# Windows appends .exe to the binary name.
ifeq ($(OS),Windows_NT)
EXE := .exe
else
EXE :=
endif

.PHONY: help install dev build bundle run \
        test test-ui test-rust \
        lint typecheck clippy fmt fmt-check check ci clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "; printf "Targets:\n"} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ---- Setup and run ----

install: ## Install the frontend dependencies (npm ci when a lockfile is present)
	@if [ -f package-lock.json ]; then $(NPM) ci; else $(NPM) install; fi

dev: ## Run the app in development mode (Vite + Tauri)
	$(NPM) run tauri dev

# The frontend bundle is rebuilt only when its sources are newer than dist/index.html.
# `tauri build` would otherwise run `npm run build` every time; that rewrites dist/ with new
# timestamps and makes cargo recompile (and fully LTO-relink) the app even when nothing changed.
# `find src` also lists directories: their mtime changes when a file is added, renamed or deleted.
# node_modules/.package-lock.json is rewritten by every `npm install`.
FRONTEND_SRC := $(shell find src) index.html package.json package-lock.json \
                tsconfig.json vite.config.ts $(wildcard node_modules/.package-lock.json)
NO_BEFORE_BUILD := --config '{"build":{"beforeBuildCommand":null}}'

dist/index.html: $(FRONTEND_SRC)
	$(NPM) run build

build: dist/index.html ## Build the optimized release binary (no installer bundles)
	$(NPX) tauri build --no-bundle $(NO_BEFORE_BUILD)
	@echo "Binary: target/release/deepgit$(EXE)"

bundle: dist/index.html ## Build the release binary and the installer bundles for the host OS
	$(NPX) tauri build $(NO_BEFORE_BUILD)

# `run` uses the fast-release profile (thin LTO, parallel codegen, incremental): close to release
# speed, but a code change rebuilds in seconds instead of minutes. `build`/`bundle` stay fully optimized.
run: dist/index.html ## Build a fast-release binary (only if something changed) and start the app
	$(CARGO) build --profile fast-release --bins --features tauri/custom-protocol -p deepgit
	./target/fast-release/deepgit$(EXE)

## ---- Tests ----

test: test-ui test-rust ## Run the unit tests (frontend + Rust)

test-ui: ## Run the frontend tests (vitest)
	$(NPM) test

test-rust: ## Run the Rust tests
	$(CARGO) test --workspace

## ---- Quality ----

typecheck: ## Type-check the frontend (strict TypeScript)
	$(NPX) tsc --noEmit

clippy: ## Lint the Rust code (warnings are errors)
	$(CARGO) clippy --workspace --all-targets -- -D warnings

lint: typecheck clippy fmt-check ## Type-check, lint and check the Rust formatting

fmt: ## Format the Rust code
	$(CARGO) fmt --all

fmt-check: ## Check the Rust formatting
	$(CARGO) fmt --all -- --check

check: lint test ## Lint plus unit tests (quick check before a commit)

ci: lint test ## Everything a CI run does: lint, tests, frontend build
	$(NPM) run build

## ---- Cleanup ----

clean: ## Remove build output (target/ and dist/); keeps node_modules
	$(CARGO) clean
	rm -rf -- dist
