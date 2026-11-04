# Execution plan: Step 7, Secret scan and opaque files

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/secret-scan-opaque-files

## Goal

Ship Step 7 of the spec's Implementation Plan: the secret scan over every exported text file (the generated `mercato-template.json` included) with the bundled gitleaks v8.30.1 rules of Step 6 plus the extra rules, the credential URL check with the stock exceptions of Step 2, the `.yarnrc.yml` auth check, the opaque file check, and the `allowFiles` option of the internal `prepare()` entry point. Rules: `secret`, `credential-url`, `yarn-auth`, `opaque-file`, `allow-file-unused`.

## Scope

- `src/rules/extra.ts`: OpenAI `sk-proj-`, `sk-svcacct-`, `sk-admin-` keys without the `T3BlbkFJ` marker; Stripe webhook secrets `whsec_`; the `create-mercato-module` credential pattern as a floor.
- `src/policy/secrets.ts`: the matcher, following gitleaks v8.30.1 `detect.go`: keywords prefilter (case-insensitive), rule `path` filters and path-only rules, the secret group (or the first non-empty group), Shannon entropy as gitleaks computes it, allowlists with `regexTarget`, `stopwords`, `condition` and `AND` paths, the generic-rule dedupe; `credential-url` (exact stock URL of any known version, `$NAME`/`${NAME}` passwords exempt, `${POSTGRES_PASSWORD}` hint); `yarn-auth`. Findings carry `path`, `line`, `ruleId`; never the matched text.
- `src/policy/opaque.ts`: text detection (fatal UTF-8, no NUL), image and font signatures, archive and database extensions.
- `src/prepare.ts`: `allowFiles` option, `report.allowFiles [{path, used}]`, the scan wired after the manifest is generated, the `checks-incomplete` text updated.
- Tests: `test/secrets.test.cjs` (every test named under Step 7), with secret-looking fixtures built from parts at test time.
- Docs: `docs/guide.md`, `CHANGELOG.md` (Unreleased), `AGENTS.md` status line and routing.

## Non-goals

- Step 8: the `--allow-file` and `--keep-env` CLI flags, the env diff, the regenerated `.env.example`, the other warnings and notices. The CLI command `prepare` still exits 2 "not implemented yet"; the root `.env.example` stays excluded.
- No `gitleaks:allow` override (Q9: no override for a secret finding).
- No decoding passes (base64 and the like) that gitleaks can run.

## Risks

- A matched value leaking into a finding or message: findings are built from static text only, and tests assert that `report.json` and the returned result contain none of the fixture secrets.
- False positives on stock files: tests run the stock 0.9.0 `.env.example` and the stock credential URLs through the scanner.
- Regex cost on large text files: rules run only after the keyword prefilter.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Code

- [ ] 1.1 Extra rules, secret scan, credential URLs and yarn auth
- [ ] 1.2 Opaque files and the allowFiles option
- [ ] 1.3 Tests for every Step 7 case

### Phase 2: Docs

- [ ] 2.1 docs/guide.md, CHANGELOG.md and AGENTS.md
