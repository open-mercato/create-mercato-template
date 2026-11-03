# Execution plan: Step 2, Stock table

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/stock-table

## Goal

Ship Step 2 of the spec's Implementation Plan: `scripts/build-stock-table.mts`, the generated and committed `src/stock/table.json` for the stable `create-mercato-app` versions 0.4.5 to 0.9.0, the lookups in `src/stock.ts` (by version, any-version match for an unknown version, stock lines, credential URLs, README hash), and the weekly `.github/workflows/stock-table.yml` check (Q14).

## Scope

- `src/env-file.ts`, `src/policy/credential-url.ts`, `src/stable-version.ts`: import-free parsers shared by the generator and the tool (Steps 7 and 8 reuse them).
- `src/stock.ts`, `src/stock/table.json`: lookups and the table, shipped in `dist/`.
- `scripts/build-stock-table.mts`: incremental generator, `--check` mode, `npm run stock-table`. Runs with Node's type stripping; not shipped.
- `.github/workflows/stock-table.yml`: `schedule` weekly and `workflow_dispatch`, `contents: read`, never on pull requests.
- Tests: `test/stock.test.cjs` with the hand-taken 0.9.0 fixture; `test/pack.test.cjs` checks the table ships.
- Docs: `docs/guide.md`, `CHANGELOG.md`, `AGENTS.md`; spec review note and the AGENTS.md spec-branch clause (Step 1 review nits).

## Non-goals

- No command uses the table yet: `prepare` reads it from Steps 3 to 8 (`stock {version, known}`, `stock-unknown`, env diff, credential URLs, README warning).
- No new runtime dependency.

## Risks

- The table is data the env rules depend on; a test fails when the committed file is not exactly the generator's output.

## Progress

PR: #3

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Code

- [x] 1.1 Shared parsers, stock lookups, generator, table and workflow : 3d81b45
- [x] 1.2 Tests and the 0.9.0 fixture : 1dd38f9

### Phase 2: Docs

- [x] 2.1 docs/guide.md, CHANGELOG.md, AGENTS.md and the spec review note : c1acb30
