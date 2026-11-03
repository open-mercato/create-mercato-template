# Execution plan: Step 3, `prepare`, snapshot core

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/prepare-snapshot-core

## Goal

Ship Step 3 of the spec's Implementation Plan: the internal entry point `prepare()` in `dist/prepare.js` (options `app`, `out`, `includeUncommitted`) that pins `HEAD`, lists the tree, reads blobs, applies the entry rules and the deny list, lists worktree changes, writes `<out>` and returns the result the `--json` envelope will carry. The CLI command `prepare` keeps answering exit 2 "not implemented yet" until Step 8.

## Scope

- `src/git.ts`: Git reads for the snapshot (show-toplevel, pinned sha, object format, `ls-tree`, `check-attr --source`, one `cat-file --batch`, `ls-files --cached --stage` and `--others --exclude-standard`), every call with `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null`; byte-exact output through a buffer variant of `run` in `src/common.ts` (argument arrays, no shell).
- `src/policy/deny.ts`: the catalog deny list as data, with its matcher. Until Step 8 the root `.env.example` is excluded like any `.env*` file.
- `src/policy/entries.ts`: `entry-symlink`, `entry-submodule`, `entry-special`, `unsafe-path`, `path-case-collision`, `lfs-pointer`.
- `src/snapshot.ts`: the file set (tree, worktree under `includeUncommitted`), the worktree change listing without `git status` (`lstat`, blob ids computed in JS, `O_NOFOLLOW` reads with the parent `realpath` check), `snapshotId`, writing `<out>/tree` and `<out>/report.json` (Q7: only the report on an error), `io-error`.
- `src/prepare.ts`: the entry point. `<out>` rules before any Git read (exit 2): must not exist or be an empty directory, and must not be inside `<app>`, judged by `realpath` of `<out>` or of its nearest existing parent against `realpath(<app>)` (finding 11 of the PR #2 scope-cohesion review). Then `checkGit`, then `not-git-repo`, `no-commit`, `app-not-repo-root`, `git-unsafe-directory`. Notices `code-only`, `checks-incomplete` (until Step 8) and `uncommitted-not-exported`.
- `test/helpers/fixture-app.cjs`: the shared minimal valid OM app and fixture repo builder (Git with an isolated config, no network).
- `test/prepare.test.cjs`: every test named under Step 3, plus the `--out` symlink test.
- Docs: `docs/guide.md`, `CHANGELOG.md` (Unreleased), `AGENTS.md` status, spec review note for finding 11.

## Non-goals

- No CLI wiring of `prepare` (Step 8); `src/cli.ts` is unchanged.
- No root checks, lockfile, `stock`, `engines`, `packageManager`, `openMercato` in the report (Step 4); no inventory or manifest (Step 5); no secret scan, opaque files or `allowFiles` (Steps 6 and 7); no env diff, warnings or other notices (Step 8).
- No `verify` for `publish` (Step 9).

## Risks

- `snapshotId` is a protected surface: a pure-function golden test and a golden test on the fixture app pin it. The fixture app golden changes when Step 5 adds the generated manifest.
- Reading the source app must stay read-only: a test hashes `.git` and the worktree before and after `prepare`, and another sets `core.fsmonitor` and a clean filter to marker scripts.

## Progress

PR: #4

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Code

- [x] 1.1 Git reads and the byte-exact runner : 7fb85ab
- [x] 1.2 Deny list and entry rules : 9da3d6e
- [x] 1.3 Snapshot, worktree listing, snapshotId and the prepare() entry point : c1b8eb9

### Phase 2: Tests

- [x] 2.1 Fixture app builder and the Step 3 tests : 0fb3694

### Phase 3: Docs

- [x] 3.1 docs/guide.md, CHANGELOG.md, AGENTS.md and the spec review note : 90c4f72
- [x] Post-review fix: no lazy fetch, transports or replace refs; export-ignore directories; dangling --out symlink; per-segment parent check; test notes : 00261df
- [x] Post-review fix: --out below a dangling symlink is a usage error : 50e50fb
