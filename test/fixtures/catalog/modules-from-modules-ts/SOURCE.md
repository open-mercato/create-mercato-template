# modulesFromModulesTs contract fixtures

The module inventory of a template is read twice: by the catalog (`lib/templates/modules-ts.ts`, `modulesFromModulesTs`) and by the save tool `create-mercato-template` (`src/inventory.ts`), which writes `modules` into `mercato-template.json`. Both must give the same answer (spec `docs/specs/2026-10-29-templates.md`, revision 7). These fixtures are that contract. `test/templates/modules-ts.test.ts` runs them here; the save tool vendors this directory as `test/fixtures/catalog/modules-from-modules-ts/` and runs them in its contract test.

## Layout

- `<name>.ts`: a `src/modules.ts`.
- `<name>/`: optional. Other files of the same app's `src/`, each read as `src/<file>` (for the relative import a loop over official modules reads).
- `<name>.json`: the expected result, `{"entries": [{"id", "from", "when"?}], "unparsed": [{"line", "reason"}]}`, with the files of `<name>/` present. `when` is absent for an unconditional entry. A reader that compares only `entries` may leave `<name>/` out: no fixture here has an entry that comes from it.

The expected files were written by the catalog parser and checked against the save tool's `src/inventory.ts` (create-mercato-template `main` at `536f1e7`, 2026-11-04), both alone (only `src/modules.ts`, entries) and with `<name>/` (entries and unparsed). All matched. Review a changed `.json` by hand; never regenerate it to make a test pass.

| Fixture               | What it covers                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scaffold-v0.9.0`     | The scaffold at tag `v0.9.0`: 70 entries, `ratelimit_probe` from `@app`, `example_customers_sync` on `module:example`, `storage_s3` and the enterprise pushes behind their flags, commented-out entries left out, the official modules loop. |
| `scaffold-e1a6f9de5`  | The scaffold at `e1a6f9de5`, the commit the spec's Problem Statement cites. Same entries, more commented-out lines.                                                                                                                          |
| `mixed-sources`       | A missing `from` (core), `@app`, an npm module, a path alias, an env flag through a `const`.                                                                                                                                                 |
| `many-entries`        | 120 entries, none dropped, in order.                                                                                                                                                                                                         |
| `conditions`          | `module:<id>`, `!`, the `else` of a one-term condition, nested `if`, `&&` with element access, an or (`\|\|`), the `else` of a compound condition, an unknown call.                                                                          |
| `unparsed-constructs` | Entries and additions the reader cannot follow: each is in `unparsed` with its line, and no source text is copied.                                                                                                                           |
| `order`               | `unshift`, a reassignment around a spread of the list, a spread of a local array, a dedupe loop over a local array, read-only uses.                                                                                                          |
| `no-list`             | No exported list of entries.                                                                                                                                                                                                                 |

## Vendored scaffold files

Byte-for-byte copies of `packages/create-app/template/src/` in `open-mercato/open-mercato`, fetched on 2026-11-04 with `curl -H "Accept: application/vnd.github.raw" https://api.github.com/repos/open-mercato/open-mercato/contents/packages/create-app/template/src/<file>?ref=<ref>`. A test checks the sha256 values below, so an edit fails it. Prettier ignores them, and tsconfig.json leaves this directory out of the type check.

| File                                               | Ref                 | Commit                                     | Upstream file                   | sha256                                                             |
| -------------------------------------------------- | ------------------- | ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------ |
| `scaffold-v0.9.0.ts`                               | tag `v0.9.0`        | `f451ce4c390087f90d5314e002e9d009d5339e08` | `modules.ts`                    | `b98091f35d5cff232e30237ff65db8c1bbd006ebda1ca9196704cf2ecdb9ca6e` |
| `scaffold-v0.9.0/official-modules.generated.ts`    | tag `v0.9.0`        | `f451ce4c390087f90d5314e002e9d009d5339e08` | `official-modules.generated.ts` | `be970d128cfe516c0cf66f7c39262c4681e6cb09a857124a9925aa95cb4881cf` |
| `scaffold-e1a6f9de5.ts`                            | `main` at e1a6f9de5 | `e1a6f9de51d04965ab6b7e4879b09ce6bf167e3d` | `modules.ts`                    | `21ae8f38bb0309daebffcd4dc0e14a25a6138c0140cbf5d7f33437efc1730721` |
| `scaffold-e1a6f9de5/official-modules.generated.ts` | `main` at e1a6f9de5 | `e1a6f9de51d04965ab6b7e4879b09ce6bf167e3d` | `official-modules.generated.ts` | `be970d128cfe516c0cf66f7c39262c4681e6cb09a857124a9925aa95cb4881cf` |

The `v0.9.0` `modules.ts` is also `test/fixtures/create-app/modules-0.9.0.ts.txt` (same sha256). Both scaffolds ship an empty official modules list, so the loop adds nothing; the unit tests cover a non-empty one. The upstream files hold long dashes in comments; this directory is outside `check-text` (`test/fixtures/`).
