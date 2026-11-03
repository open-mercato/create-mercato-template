# Execution plan: Step 4, root checks and lockfile

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/root-checks-lockfile

## Goal

Ship Step 4 of the spec's Implementation Plan: the root rules of the rule table (`root-package-json`, `root-not-om-app`, `root-monorepo`, `root-workspaces`, `root-yarn-lock`, `root-package-manager`, `root-om-unresolved`, `root-om-mixed-lines`, `template-file`), a Yarn 4 lockfile reader on `yaml` 2.9.1, and `report.openMercato` and `report.enterprise.dependency`, all read from the pinned snapshot's files behind the internal `prepare()` entry point. The CLI command `prepare` keeps answering exit 2 "not implemented yet" until Step 8.

## Scope

- `package.json`: runtime dependency `yaml` at exactly `2.9.1`.
- `src/lockfile.ts`: Yarn 2+ lockfile reader (`__metadata` required, every entry with `version` and `resolution`), descriptor and name lookups, `major.minor` lines.
- `src/policy/root.ts`: the root rules and `template-file`, reading only the snapshot's file contents (the blobs of the pinned sha, or the worktree versions Step 3 admits under `includeUncommitted`).
- `src/prepare.ts`: runs the root checks after the snapshot; adds `stock`, `engines`, `packageManager`, `openMercato`, `enterprise: {dependency}` to the report (the catalog fields Step 3 deferred to this step); `checks-incomplete` text names what is still missing.
- Tests: every test named under Step 4, plus lockfile unit tests.
- Docs: `docs/guide.md`, `CHANGELOG.md` (Unreleased), `AGENTS.md`.

## Non-goals

- No CLI wiring of `prepare` (Step 8); `src/cli.ts` is unchanged.
- No module inventory, manifest or `enterprise.modules` (Step 5); no `enterprise-dependency` or `stock-unknown` notice (Step 8); no secret scan (Steps 6 and 7).

## Decisions

- A `yarn.lock` that cannot be read as a Yarn 2+ lockfile (YAML error, no `__metadata`, an entry without `version` or `resolution`) is `root-yarn-lock`, with a message saying why, as `root-package-json` covers an unreadable `package.json`.
- `root-not-om-app` checks `dependencies` only: an app needs core at run time.
- `root-om-mixed-lines` considers every lockfile entry named `@open-mercato/*` resolved from npm (`npm:` or `patch:`), so transitive packages count; workspace and link entries do not.
- `openMercato` is the core entry found by the `package.json` descriptor, else the only entry for the name, else the highest version.
- With no `yarn.lock`, `root-om-unresolved` and `root-om-mixed-lines` are not reported (one cause, one finding).

## Risks

- The fixture app golden `snapshotId` must not change: root checks add report fields, not files.
- Real Yarn 4 lockfiles are large; `yaml` parses them with the failsafe schema (all scalars strings) into Maps.

## Progress

PR: #5

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Code

- [x] 1.1 yaml dependency and the lockfile reader : bed6d4c
- [x] 1.2 Root checks and the report fields in prepare() : 4da6545

### Phase 2: Tests

- [x] 2.1 Step 4 tests and lockfile unit tests : c8ae94b

### Phase 3: Docs

- [x] 3.1 docs/guide.md, CHANGELOG.md and AGENTS.md : 926daa6
