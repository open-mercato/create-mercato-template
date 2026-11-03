# Execution plan: Step 6, Secret rule converter

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/secret-rule-converter

## Goal

Ship Step 6 of the spec's Implementation Plan: `scripts/build-secret-rules.mts` converts gitleaks `config/gitleaks.toml` at tag v8.30.1 (pinned by tag and by the sha256 of the file) into the committed `src/rules/gitleaks.json`, with the rules left out listed with a reason in the committed `scripts/secret-rules-skipped.json`, and `prepare()` records `report.tool.rules {source, count, skipped}`.

## Scope

- `scripts/build-secret-rules.mts`: a small strict TOML reader for the subset gitleaks uses (no new dependency), the RE2 to JavaScript regex translation (`(?i)` flag, inline modifiers, `\z`, `(?s` groups, `(?P<`, POSIX classes), rule and allowlist conversion as the spec's "Bundled gitleaks rules" item says, the required id check, `npm run secret-rules` and `--check`. Network only in a maintainer's run.
- `scripts/secret-rules-skipped.json`: committed, maintained by hand, each skipped id with its reason.
- `src/rules/gitleaks.json` (generated, committed, shipped) and `src/rules/gitleaks.ts` (types and the `tool.rules` summary).
- `src/prepare.ts`: `report.tool.rules`.
- Tests: `test/secret-rules.test.cjs` with the vendored v8.30.1 TOML under `test/fixtures/gitleaks/` (sha256 in `SOURCE.md`); `test/prepare.test.cjs` and `test/pack.test.cjs` additions.
- Docs: `docs/guide.md`, `CHANGELOG.md` (Unreleased), the `AGENTS.md` status line.

## Non-goals

- No scan: matching files, keywords, entropy, stopwords and findings are Step 7 (`src/policy/secrets.ts`, `src/rules/extra.ts`).
- The CLI command `prepare` still exits 2 "not implemented yet" (Step 8).
- No runtime dependency.

## Risks

- RE2 and JavaScript regex semantics differ in corners; the converter walks every pattern and fails on any construct it does not translate, instead of passing it through.
- A test fails when the committed `gitleaks.json` is not exactly the generator's output for the vendored TOML.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Code

- [ ] 1.1 Converter script, skipped list, generated rules and report.tool.rules
- [ ] 1.2 Tests and the vendored gitleaks v8.30.1 fixture

### Phase 2: Docs

- [ ] 2.1 docs/guide.md, CHANGELOG.md and AGENTS.md
