# Execution plan: Step 8, Env diff, warnings and notices

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/env-diff-warnings-notices

## Goal

Ship Step 8 of the spec's Implementation Plan: the env diff and the regenerated root `.env.example`, `--keep-env`, the declared env in the manifest, every warning and notice of the rule table not built yet, `report.env`, `report.images`, `exceeds-import-limits`; remove the `checks-incomplete` notice and the root `.env.example` exclusion; wire `prepare` into the CLI with its flags and the `--json` envelope.

## Scope

- `src/policy/env.ts`: parse the root `.env.example` (blank, comment, assignment, commented assignment, anything else dropped with `env-line-dropped`); keep stock values of the matched version (any known version when unknown), keep `--keep-env` values that pass the secret scan on keys that do not look secret; empty the rest; `env-keep-secret`, `env-keep-unknown`; declared env with description and link; `env-undocumented`; `env-example-missing` (stock file of the matched version, none for an unknown one); `nested-env-example`.
- `src/policy/warnings.ts`: `image`, `executable-config`, `ai-content`, `seed-email`, `readme-missing`, `readme-stock`, `exceeds-import-limits`, and the notices `stock-unknown`, `enterprise-dependency`, `derived-from-template`.
- `src/policy/deny.ts`: the root `.env.example` excepted from `**/.env*`.
- `src/manifest.ts`: `env` in the manifest; a source `mercato-template.json` supplies `description`/`link` for keys without a comment.
- `src/prepare.ts`: `keepEnv` option, the generated `.env.example` (`origin: "generated"`) scanned with the rest, `report.env`, `report.images`, the new findings and notices; `checks-incomplete` removed.
- `src/cli.ts`: `prepare` dispatched to `prepare()` with `--out` (required), `--include-uncommitted`, `--allow-file`, `--keep-env`, `--json`; the envelope carries `out`, `snapshotId`, `report`, and `failures` (every error finding); exit 1 with findings; a human summary without `--json`. `toolVersion` moves to its own module to avoid a circular import.
- Tests: `test/env.test.cjs`, `test/warnings.test.cjs`, `test/prepare-cli.test.cjs` for every case named under Step 8; existing tests updated for the removed notice and exclusion. Secret-looking fixtures assembled from parts.
- Docs: `docs/guide.md`, `CHANGELOG.md` (Unreleased), `AGENTS.md` status and routing, help text.

## Non-goals

- Step 9 and later: `publish` and `describe` keep exiting 2 "not implemented yet".
- No change to the `snapshotId` algorithm or the deny list beyond the root `.env.example` exception.

## Risks

- A value leaking: env values never enter findings, messages or the report (key names and line numbers only); CLI tests through `bin/cli.cjs` assert stdout, stderr and the envelope hold no fixture secret and no seed email.
- The golden `snapshotId` of the fixture app changes because `.env.example` is now exported: expected and documented.

## Progress

PR: #11

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Code

- [x] 1.1 Env diff, generated .env.example and declared env : 4c3eb3e
- [x] 1.2 Warnings and notices : 4c3eb3e
- [x] 1.3 prepare on the CLI : 4c3eb3e
- [x] 1.4 Tests for every Step 8 case : 4c3eb3e, 0b2e020

### Phase 2: Docs

- [x] 2.1 docs/guide.md, CHANGELOG.md and AGENTS.md : 3697185
- [x] Post-review fix: multi-line .env.example values, no Git before usage errors : ddb05fd
- [x] Re-review minors: backtick values, escaped single quotes, regression fragment : 6318472
