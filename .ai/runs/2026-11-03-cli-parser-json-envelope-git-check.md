# Execution plan: Step 1, CLI parser, JSON envelope and Git check

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/cli-parser-json-envelope-git-check

## Goal

Ship Step 1 of the spec's Implementation Plan: a hand-written argument parser with the per-command flag matrix, the `--json` envelope, a top-level handler that keeps exit codes 0 to 4, `run`/`Executor` copied from `create-mercato-module`, and the Git check (`git-version`, `git-missing`, `git-unsafe-directory`). The three commands keep answering exit 2 "not implemented yet".

## Scope

- `src/cli.ts`: parser, flag matrix, help precedence, envelope, handler. `main()` returns the exit code.
- `bin/cli.cjs`: maps the returned code (0 to 4, else 1); keeps the catch path.
- `src/common.ts`: `run`, `Executor`, `RunOptions`, `safeCommandOutput` from `create-mercato-module` f83233d.
- `src/git.ts`: `checkGit`, version parse, dubious-ownership detection. Library only in Step 1; `prepare()` (Step 3) and `publish` (Step 9) call it.
- Tests: `test/cli.test.cjs` (updated), `test/git.test.cjs` (new), `test/bin.test.cjs` (returned code).
- Docs: `BACKWARD_COMPATIBILITY.md`, `docs/guide.md`, `CHANGELOG.md`, help text.
- Spec: line 3 status; the Step 1 findings of the scope-cohesion review.

## Non-goals

- No command implementation (Steps 3 to 10). No required-flag or value checks (`--expect` hex, `--use-case` set, text lengths, `--out`/`--from` stat): each comes with its command's step.
- No new runtime dependency.
- Scope-cohesion findings that do not change Step 1 are listed in the PR for later steps, not applied.

## Risks

- The parser and the envelope are protected surfaces from the first release; the decisions are written into the spec so later steps do not drift.

## Progress

PR: #2

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Spec

- [x] 1.1 Spec status line and Step 1 cohesion fixes : 2b07fd2

### Phase 2: Code

- [x] 2.1 run and Executor in src/common.ts : d6c5d1b
- [x] 2.2 Git check in src/git.ts with tests : 22de750
- [x] 2.3 Parser, flag matrix, envelope and handler in src/cli.ts and bin/cli.cjs with tests : c3e3100

### Phase 3: Docs

- [x] 3.1 BACKWARD_COMPATIBILITY.md, docs/guide.md and CHANGELOG.md : dc93b29

- [x] Post-review fix: email redaction, redaction test, command-first hint, boolean flag and -- messages : e79c76b
