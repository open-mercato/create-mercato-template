# Docs for the state after the 0.1.0 npm release

## Goal

Make every text that is wrong once `create-mercato-template@0.1.0` is on npm true for that state: `npx create-mercato-template <command>` is the main form everywhere, and one short section keeps the GitHub form as the way to try `main` before a release. The PR waits (draft, `do-not-merge`) until the package is on npm.

## Scope

Found by grep for `not on npm`, `npm release`, `github:open-mercato`, `in development`, `Nothing is published`, `Until then`, `--package` across `*.md`, `*.ts`, `*.cjs`, `*.mts`, `*.json`, `*.yml` (outside `node_modules`, `dist`, `.ai/runs`):

- `src/cli.ts:57` help line `Status: in development. Nothing is published to npm yet.` — removed (the help already names the npm form and `--version`). No unit test asserted it; add one in `test/cli.test.cjs` that the help does not say the package is unpublished.
- `README.md:15` the "not on npm yet" note, the nav link `#try-it-before-the-npm-release`, the section "Try it before the npm release" with "Run the commands from this repository on GitHub", the three `npx --package github:...` commands and "After the npm release, use ...".
- `docs/guide.md:3` the version note, the section "Try it before the npm release" (line 189) with its three commands, and the `retry` sentence about `--package github:...` before the release (line 208).
- `AGENTS.md:5` "Version 0.1.0 is prepared for the first release", "It is not on npm yet", "Until then the commands run from GitHub (...)".
- `docs/guide.md` Stock table section: add what happens to users when Open Mercato releases a version the table lacks.

Checked and left as they are: `CHANGELOG.md` (no repository rule asks for a changelog entry on a docs change: `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`; no release date added), the spec (a design record), `test/release-e2e/*` and `.github/workflows/test.yml` ("nothing is published to npm" there describes the test run, true after the release too), `src/publish.ts` "on GitHub" messages (unrelated).

## Stock table fact, as the source supports it

From `src/stock.ts` (`matchStock`, `isStockValue`, `newestStock`), `src/policy/env.ts`, `src/policy/warnings.ts` (`notices`), `src/policy/secrets.ts` (`scanCredentialUrls`), `scripts/build-stock-table.mts`, `src/stock/table.json` (0.4.5 to 0.9.0):

- Lookup is by the pinned `@open-mercato/core` version; a version not in the table gets `known: false` and the `stock-unknown` notice (never blocking).
- Values are then checked against every known version: an env value that only the new release ships is emptied in the generated `.env.example` and listed in `env.emptied` (one "Emptied in .env.example" line in the text output). There is no warning per emptied key: the brief's "warns about each of them" is not what the source does, so the guide does not say it.
- Declared env is compared with the newest known version: a key only the new release ships counts as declared env, with an `env-undocumented` warning when it has no comment or manifest description.
- A credential URL only the new scaffold contains is a `credential-url` error; a stock README only the new release ships is not recognized (`readme-stock` does not fire).
- Fix: `npm run stock-table`, commit the table, release the tool again.

## Non-goals

- No behaviour change beyond the help text line, no version bump, no tag, no release, no `npm publish`.
- No CHANGELOG entry, no date on `## 0.1.0`.

## Implementation Plan

### Phase 1: Help text

- 1.1 Remove the pre-release status line from the help and add a test

### Phase 2: Docs

- 2.1 README: npm form as the main way, short section for trying `main` from GitHub
- 2.2 Guide: version note, try-`main` section, retry sentence
- 2.3 Guide: what an Open Mercato release the stock table lacks does to `prepare`
- 2.4 AGENTS.md: status sentence after the release

## Risks

- The text is written for a state that does not exist yet; merging before the npm release would tell people to run a package that is not there. Mitigation: draft PR with `do-not-merge` and a first body line saying so.
- Anchor links: the README nav and the guide link the renamed section; check every `#try-...` anchor.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Help text

- [x] 1.1 Remove the pre-release status line from the help and add a test — 09d2565

### Phase 2: Docs

- [x] 2.1 README: npm form as the main way, short section for trying `main` from GitHub — 96c2174
- [x] 2.2 Guide: version note, try-`main` section, retry sentence — 94027de
- [x] 2.3 Guide: what an Open Mercato release the stock table lacks does to `prepare` — 80e8897, c077da8
- [x] 2.4 AGENTS.md: status sentence after the release — eba84b0
