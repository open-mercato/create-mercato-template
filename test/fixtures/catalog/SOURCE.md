# Catalog fixtures

The catalog (`open-mercato/modules`) owns the schema of a catalog entry `templates/<owner>/<repo>.yml` (`template-1.json`), the schema of `mercato-template.json` (`mercato-template-1.json`) and the rules of the module inventory (`modulesFromModulesTs`). The files here are copies of what the catalog generates. Do not edit them by hand; copy them again from the catalog.

## Release gate

Lifted on 2026-11-04. Spec Step 12 blocked the release until `template-1.json` and `mercato-template-1.json` were the files the catalog publishes. The catalog merged Phase 1a (`open-mercato/modules#16`, `320a6262c9c17de03384f8ce7867a007fc26c030`) and deployed it the same day; both URLs below now serve exactly the bytes vendored here.

`npm publish` still runs `scripts/release-gate.mts` (`prepublishOnly`). It refuses whenever a line starting with "Release blocked" is in this file, so a later copy that must wait for the catalog can put that line back here and in `AGENTS.md` and `CHANGELOG.md` (a test keeps the three in step).

To copy the files again after a catalog change:

1. Copy both schemas from the served URLs, byte for byte:
   - `https://modules.openmercato.com/schema/template-1.json`
   - `https://modules.openmercato.com/schema/mercato-template-1.json`
2. Copy `modules-from-modules-ts/` from the catalog's `main` (`test/fixtures/templates/modules-from-modules-ts/`).
3. Rewrite the Source section below: the deploy date, the `main` commit and the new sha256 values.
4. Run the tests.

## Source

- Served files: `https://modules.openmercato.com/schema/template-1.json` and `https://modules.openmercato.com/schema/mercato-template-1.json`, downloaded on 2026-11-04 after the catalog deploy of `open-mercato/modules` `main` `320a6262c9c17de03384f8ce7867a007fc26c030` (pages run of 2026-11-04 22:28 UTC), and identical byte for byte to the files vendored here.
- In the catalog they are written from `lib/schema/template.ts` and `lib/schema/json-schema.ts` (golden copies in `test/schema/golden/`, regenerated with `yarn vitest run test/schema/template.test.ts -u`, which calls `schemaFiles(DEFAULT_SITE_URL)` from `lib/emit/schemas.ts`, the same code as `yarn om emit`).
- Inventory fixtures: `test/fixtures/templates/modules-from-modules-ts/` at the same `main` commit, identical to `modules-from-modules-ts/` here (`diff -r` on 2026-11-04). Its own `SOURCE.md` describes the layout and the scaffold files it holds.
- A test checks the sha256 values below, so an edit fails it.

| File | sha256 |
| --- | --- |
| `template-1.json` | `d71cb563bcd365d8e4d2d8ea811ac79fb8de85e0e892501edb4a3792e1b0df72` |
| `mercato-template-1.json` | `920b2ab11e4905cb5d08498301a4c43a4d884e9d7a60bf852d66376fb6fa04de` |

The tests check the `$id` of both schemas and that neither has a `$comment` draft marker.

## How the tests use them

- `test/describe.test.cjs` validates the `describe` YAML against `template-1.json`, and the manifest against `mercato-template-1.json`.
- `test/inventory.test.cjs` validates the manifest against `mercato-template-1.json`, and runs the contract test: for each `<name>.ts` in `modules-from-modules-ts/`, it reads `<name>.ts` as `src/modules.ts` and the files of `<name>/` as `src/<file>`, and compares `{entries, unparsed}` with `<name>.json`. It also checks the sha256 values that the vendored `SOURCE.md` records for the scaffold files.
- `test/helpers/json-schema.cjs` is the validator. It knows every keyword of these schemas (`template-1.json` adds `allOf` with `if` and `then`: a status other than `active` needs `reason`, and `smoke.login: false` needs `ready` and at least one path) and throws on a keyword it does not know.

The plain-text rule (`PlainText` in the catalog: no URL, markdown, HTML, backticks, control characters or long dashes) is a runtime check that JSON Schema does not carry; `describe` applies it itself (`src/describe.ts`). The catalog's rule that a `raw.githubusercontent.com` screenshot comes from the entry's own repository is a runtime check too; `describe` prints no screenshots.
