# Catalog fixtures

The catalog (`open-mercato/modules`) owns the schema of a catalog entry `templates/<owner>/<repo>.yml` (`template-1.json`), the schema of `mercato-template.json` (`mercato-template-1.json`) and the rules of the module inventory (`modulesFromModulesTs`). The files here are copies of what the catalog generates. Do not edit them by hand; copy them again from the catalog.

## Source

- Repository: `open-mercato/modules`, branch `feat/templates-catalog` (catalog Phase 1a steps 1 and 4), not merged to `main` yet.
- Schemas: branch tip `2332ca50d09b5a0fc94dc7677c2e1aa4aebb42d3`, files `test/schema/golden/template-1.json` and `test/schema/golden/mercato-template-1.json`. The catalog writes them from `lib/schema/template.ts` and `lib/schema/json-schema.ts` with `yarn vitest run test/schema/template.test.ts -u`, which calls `schemaFiles(DEFAULT_SITE_URL)` from `lib/emit/schemas.ts`, the same code as `yarn om emit`. They are the files the catalog will serve.
- Inventory fixtures: commit `0e77e8d2736c0f689841a0bf2a9511009cf78771`, directory `test/fixtures/templates/modules-from-modules-ts/`, copied whole into `modules-from-modules-ts/` here. Its own `SOURCE.md` describes the layout and the scaffold files it holds.
- Copied on 2026-11-04, byte for byte. A test checks the sha256 values below, so an edit fails it.

| File | sha256 |
| --- | --- |
| `template-1.json` | `d71cb563bcd365d8e4d2d8ea811ac79fb8de85e0e892501edb4a3792e1b0df72` |
| `mercato-template-1.json` | `920b2ab11e4905cb5d08498301a4c43a4d884e9d7a60bf852d66376fb6fa04de` |

## Check after the catalog deploys

The branch is pending merge, and the catalog does not serve the schemas yet. Once it deploys, compare these files with the published ones and copy them again if they differ:

- `https://modules.openmercato.com/schema/template-1.json`
- `https://modules.openmercato.com/schema/mercato-template-1.json`

Copy `modules-from-modules-ts/` again from the catalog's `main` after the merge too. The tests check the `$id` of both schemas and that neither has a `$comment` draft marker.

## How the tests use them

- `test/describe.test.cjs` validates the `describe` YAML against `template-1.json`, and the manifest against `mercato-template-1.json`.
- `test/inventory.test.cjs` validates the manifest against `mercato-template-1.json`, and runs the contract test: for each `<name>.ts` in `modules-from-modules-ts/`, it reads `<name>.ts` as `src/modules.ts` and the files of `<name>/` as `src/<file>`, and compares `{entries, unparsed}` with `<name>.json`. It also checks the sha256 values that the vendored `SOURCE.md` records for the scaffold files.
- `test/helpers/json-schema.cjs` is the validator. It knows every keyword of these schemas (`template-1.json` adds `allOf` with `if` and `then`: a status other than `active` needs `reason`, and `smoke.login: false` needs `ready` and at least one path) and throws on a keyword it does not know.

The plain-text rule (`PlainText` in the catalog: no URL, markdown, HTML, backticks, control characters or long dashes) is a runtime check that JSON Schema does not carry; `describe` applies it itself (`src/describe.ts`). The catalog's rule that a `raw.githubusercontent.com` screenshot comes from the entry's own repository is a runtime check too; `describe` prints no screenshots.
