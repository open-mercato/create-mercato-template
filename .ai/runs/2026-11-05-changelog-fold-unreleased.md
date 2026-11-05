# Fold the CHANGELOG Unreleased entries into 0.1.0

## Goal

0.1.0 has never been published to npm, so the three bullets under `## Unreleased` / `### Fixed` (#9 secret scan cost, the `scan-limit` error, #10 `credential-url`) ship in 0.1.0 itself. Fold them into the `## 0.1.0` entry, worded as what 0.1.0 does, not as fixes.

## Scope

- `CHANGELOG.md` only: remove `## Unreleased` and its `### Fixed`; extend `### What \`prepare\` checks` (the secret scan bullet, plus a bullet next to it for the scan cost and `scan-limit`).
- Every user-facing fact stays: the scan cost bound (every 1 MB input measured, constructed worst cases included, at most 4.3 s), the five rules on the linear-time matcher by name, `scan-limit` (exit 1, `ruleId` and the line, file refused, never exported unscanned), the `curl-auth-header` difference from Node's regex engine, `npm run bench:secret-scan` and the guide's Scan cost section, the `credential-url` reading rules.
- Grep showed no test or doc reads the `Unreleased` heading (only historical run plans in `.ai/runs/` mention it as prose), so no other file changes.

## Non-goals

- No code, test, version or guide change. No npm publish.
- Historical run plans in `.ai/runs/` that mention "CHANGELOG.md (Unreleased)" stay as written.

## Implementation Plan

### Phase 1: CHANGELOG

- 1.1 Fold the Unreleased bullets into the 0.1.0 entry in the present tense and remove the Unreleased section.

## Risks

- `test/release-gate.test.cjs` reads `CHANGELOG.md` for the `Release blocked` marker; the new text must not contain it.
- Wording drift: a fact lost in the rewrite. Mitigation: check each fact from the brief against the diff.

## Progress

PR: #20

> Convention: `- [ ]` pending, `- [x]` done. Append ` - <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: CHANGELOG

- [x] 1.1 Fold the Unreleased bullets into the 0.1.0 entry and remove the Unreleased section - 5cf95e1

Review fix (om-auto-review-pr nit): reworded the curl-auth-header sentence - 5b23991
