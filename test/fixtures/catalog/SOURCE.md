# Catalog fixtures

The catalog (`open-mercato/modules`) owns the schema of a catalog entry `templates/<owner>/<repo>.yml` (`template-1.json`), the schema of `mercato-template.json` (`mercato-template-1.json`) and the rules of the module inventory (`modulesFromModulesTs`). The files here are copies of what the catalog generates. Do not edit them by hand; copy them again from the catalog.

## Release gate

Release blocked (spec Step 12) until the catalog serves these files.

Spec Step 12 blocks the release until `template-1.json` and `mercato-template-1.json` are the files the catalog publishes. They are not published yet: on 2026-11-04 both URLs below answer 404. `npm publish` runs `scripts/release-gate.mts` (`prepublishOnly`), which refuses while the line above is here. The same line is in `AGENTS.md` and under `## 0.1.0` in `CHANGELOG.md`, and a test keeps the three in step.

To lift the gate, after the catalog merges and deploys:

1. Copy both schemas again from the served URLs, byte for byte:
   - `https://modules.openmercato.com/schema/template-1.json`
   - `https://modules.openmercato.com/schema/mercato-template-1.json`
2. Copy `modules-from-modules-ts/` again from the catalog's `main`.
3. Rewrite the Source section below: the URLs, the deploy date, the `main` commit and the new sha256 values.
4. Run the tests, then remove the "Release blocked" line here, in `AGENTS.md` and in `CHANGELOG.md`, and turn the `blocked` assertion in `test/release-gate.test.cjs` around.

## Source

- Repository: `open-mercato/modules`, branch `feat/templates-catalog` (catalog Phase 1a steps 1 and 4), not merged to `main` yet.
- The branch and the commits below are local to the author's checkout on 2026-11-04 and not on GitHub yet, so they cannot be checked there. Push `feat/templates-catalog` (or open its PR) before this branch is reviewed. Until then the sha256 values below are the only record of the bytes.
- Schemas: branch tip `2332ca50d09b5a0fc94dc7677c2e1aa4aebb42d3`, files `test/schema/golden/template-1.json` and `test/schema/golden/mercato-template-1.json`. `template-1.json` last changed in `761d746` (the `ref` pattern follows the git ref name rules and refuses `pull/` refs); `mercato-template-1.json` has not changed since `2d2c8899d43a1a6e549d98bdfca1ae0525945ea3`. The catalog writes them from `lib/schema/template.ts` and `lib/schema/json-schema.ts` with `yarn vitest run test/schema/template.test.ts -u`, which calls `schemaFiles(DEFAULT_SITE_URL)` from `lib/emit/schemas.ts`, the same code as `yarn om emit`. They can still change before the catalog deploys.
- Inventory fixtures: commit `0e77e8d2736c0f689841a0bf2a9511009cf78771`, unchanged at the branch tip `2332ca5`, directory `test/fixtures/templates/modules-from-modules-ts/`, copied whole into `modules-from-modules-ts/` here. Its own `SOURCE.md` describes the layout and the scaffold files it holds.
- Copied on 2026-11-04, byte for byte. A test checks the sha256 values below, so an edit fails it.

| File | sha256 |
| --- | --- |
| `template-1.json` | `d71cb563bcd365d8e4d2d8ea811ac79fb8de85e0e892501edb4a3792e1b0df72` |
| `mercato-template-1.json` | `920b2ab11e4905cb5d08498301a4c43a4d884e9d7a60bf852d66376fb6fa04de` |

The tests check the `$id` of both schemas and that neither has a `$comment` draft marker. They cannot tell a branch copy from a published file; the release gate above does that.

## How the tests use them

- `test/describe.test.cjs` validates the `describe` YAML against `template-1.json`, and the manifest against `mercato-template-1.json`.
- `test/inventory.test.cjs` validates the manifest against `mercato-template-1.json`, and runs the contract test: for each `<name>.ts` in `modules-from-modules-ts/`, it reads `<name>.ts` as `src/modules.ts` and the files of `<name>/` as `src/<file>`, and compares `{entries, unparsed}` with `<name>.json`. It also checks the sha256 values that the vendored `SOURCE.md` records for the scaffold files.
- `test/helpers/json-schema.cjs` is the validator. It knows every keyword of these schemas (`template-1.json` adds `allOf` with `if` and `then`: a status other than `active` needs `reason`, and `smoke.login: false` needs `ready` and at least one path) and throws on a keyword it does not know.

The plain-text rule (`PlainText` in the catalog: no URL, markdown, HTML, backticks, control characters or long dashes) is a runtime check that JSON Schema does not carry; `describe` applies it itself (`src/describe.ts`). The catalog's rule that a `raw.githubusercontent.com` screenshot comes from the entry's own repository is a runtime check too; `describe` prints no screenshots.
