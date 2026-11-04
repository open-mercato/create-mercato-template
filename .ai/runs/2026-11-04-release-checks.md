# Execution plan: Step 11, save then import contract test

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/release-checks

## Goal

Ship Step 11 of the spec's Implementation Plan: `test/release-e2e/local.mts` and a `release-checks` CI job that save a fresh `create-mercato-app` app with this tool (`prepare`, then `publish` to the gh shim), import it back with `create-mercato-app --app-url` through a loopback GitHub API, then install, initialize, build, start and sign in, on two legs: `create-mercato-app@0.9.0` and `@latest`.

## Scope

- `test/release-e2e/local.mts`: options (`--create-app`, `--database-url` on loopback only, `--results`), scaffold with `--preset empty --agents none --no-init-git`, an `@app` module, a declared env key with a comment, an ignored `.env` with a fake key assembled at run time, commit, `prepare --json`, `publish --json` to the shim, a loopback API on 127.0.0.1 answering only `GET /repos/<o>/<r>` and `GET /repos/<o>/<r>/tarball/<ref>`, the import with `OM_CREATE_APP_GITHUB_API_BASE_URL`, then the three Step 11 assertions and the full app run (install, initialize, build, start, sign in as the seeded admin).
- A guard preloaded into the create-mercato-app process: any `fetch` to a host other than the loopback API fails, so the import cannot reach api.github.com.
- `.github/workflows/test.yml`: a `release-checks` job, matrix of the two legs, a throwaway Postgres container with a password generated per run, no secrets, `permissions: contents: read`. Triggers stay pull_request, push to main and workflow_dispatch.
- `test/release-e2e/SOURCE.md`, `test/release-e2e/README.md`, `test/release-e2e/postgres-init.sql`: sources from create-mercato-module 5b7849c.
- Unit tests for the parts that run without network: option checks, the loopback API, the fetch guard, the env and secret checks (`test/release-local.test.cjs`).
- Docs: `docs/guide.md` (how to run the release checks locally), `CHANGELOG.md` (Unreleased), `AGENTS.md` status and routing, `package.json` script `test:release:local`, typecheck and lint cover the new `.mts`.

## Non-goals

- Step 12: no version bump, no npm release.
- No change to `prepare`, `publish`, `describe` or any protected surface.
- No `--template` leg (Phase 4).

## Risks

- `@latest` of create-mercato-app may break for reasons outside this repo: the assertions stay; the failing leg and its log go to the PR body for the spec owner, and the 0.9.0 leg stays required.
- A real GitHub or npm write: the job has no secrets and a read-only token, the shim refuses unknown commands, the import runs with a fetch guard and no `GITHUB_TOKEN`, and nothing calls `npm publish`.

## Progress

PR: #14

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Release checks

- [x] 1.1 test/release-e2e/local.mts with the loopback API and the fetch guard : 2527733
- [x] 1.2 Unit tests for the offline parts : 2527733
- [x] 1.3 release-checks job in the Tests workflow : 2527733

### Phase 2: Docs

- [x] 2.1 docs/guide.md, README.md and SOURCE.md in test/release-e2e, CHANGELOG.md and AGENTS.md : 2527733
- [x] Fix: api_keys enabled in the source app, signing secrets for production start : 905cda5
- [x] Review fixes: exit code, process groups, CI needs a database, http/https guard, isolated Git config : 92344e7
