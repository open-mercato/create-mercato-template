# Execution plan: Step 5, module inventory and manifest

Source doc: .ai/specs/2026-10-30-create-mercato-template.md
Branch: feat/module-inventory-manifest

## Goal

Ship Step 5 of the spec's Implementation Plan: the static module inventory of the snapshot's `src/modules.ts` (`typescript` AST, no type checking, no app code run), the generated `mercato-template.json` in `<out>/tree/` (`schema`, `name`, `description`, `openMercato`, `modules`, `createdWith`; `env` comes in Step 8), the rules `modules-ts`, `module-package-unresolved`, `modules-unparsed`, `module-from-unknown`, `manifest-name` and `manifest-description`, and the report fields `modules` and `enterprise.modules`, all behind the internal `prepare()` entry point. The CLI command `prepare` keeps answering exit 2 "not implemented yet" until Step 8.

## Scope

- `src/inventory.ts`: the inventory rules of the spec's "Module inventory" section (items 1 to 7) and the `when` grammar (Q3).
- `src/manifest.ts`: the manifest mapping (`name`, `description`, `openMercato`, `modules`, `createdWith`), serialization, and the generated file record.
- `src/policy/root.ts`: return the parsed `package.json` and lockfile and a package resolver for `package` (spec item 7), so the lockfile is read once.
- `src/prepare.ts`: run the inventory after the root checks, add the manifest to the file set (replacing a source `mercato-template.json`), `report.modules`, `report.enterprise.modules`; the `checks-incomplete` text names what is still missing.
- Test fixtures: `src/modules.ts` and `src/official-modules.generated.ts` of the create-app template at open-mercato v0.9.0 and main a447cc552, byte for byte, with `SOURCE.md` naming the ref, path and sha256; the catalog's `mercato-template-1.json` (draft, see Decisions).
- Tests: every test named under Step 5, plus rule unit tests.
- Docs: `docs/guide.md`, `CHANGELOG.md` (Unreleased), `AGENTS.md` status line and routing.

## Non-goals

- No CLI wiring of `prepare` (Step 8); `src/cli.ts` is unchanged.
- No `env` in the manifest, no reuse of a source manifest's env descriptions, no `derived-from-template` or `enterprise-dependency` notice (Step 8).
- No secret scan of the generated manifest yet (Step 7 scans every exported text file, the manifest included).

## Decisions

- The catalog has not published `mercato-template-1.json` (404 at `https://modules.openmercato.com/schema/mercato-template-1.json`, absent from `open-mercato/modules` main 5a591d6 on 2026-11-03). Per the spec's Phasing table, the vendored file is a draft written from the catalog spec's manifest section and its `lib/schema/common.ts` patterns (`ModuleId`, `NpmName`, `EnvName`), marked as a draft in its `$comment` and in `SOURCE.md`, and replaced by the published file before release (Step 12 gate). The PR says so.
- Draft schema choices: `schema`, `name`, `modules` and `createdWith` required; `openMercato` optional (absent when core is not a registry package); `description` plain text of 1 to 350 characters (the length `publish` accepts as a repository description); `from` any string up to 214 characters, so an unknown `from` (a warning) still validates.
- Tests validate with a small JSON Schema subset validator in `test/helpers/` (no new dependency).
- The inventory binding is the first exported `const` (or `let`) array that holds an object literal with an `id` property.
- An entry with an `id` that is not a string literal, or a string that is not a catalog module id, is `modules-unparsed` (listed, never dropped silently).
- A reference to the binding that can change it outside the recognized constructs (passed to a function, assigned, a mutating method other than a recognized `push`/`unshift`) is one `modules-unparsed` warning with its line. Read-only uses (`some`, `map`, `length`, `export`) are ignored.
- Terms are deduplicated when nested conditions repeat one (`A` inside `if (A && B)` gives `A && B`).
- Official module entries read through the loop carry the line of the `for` statement in `src/modules.ts`.
- `package`: only when the lockfile was read; with no readable `yarn.lock` the root rule already reports the cause, so no `module-package-unresolved` is added. Several lockfile entries for a name not in `package.json` resolve to none, as spec item 7 says ("a single lockfile entry").
- The fixture app's golden `snapshotId` changes once, because the export now holds the generated `mercato-template.json`.

## Risks

- Inventory drift from the catalog's future `modulesFromModulesTs`: the contract test runs the catalog fixtures once they exist (skipped until then, with the reason).
- The draft schema may differ from the published one; the Step 12 release gate requires the published file.

## Progress

PR: #6

> Convention: `- [ ]` pending, `- [x]` done. Append ` : <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fixtures

- [x] 1.1 Vendored scaffold fixtures and the draft manifest schema : ad97699

### Phase 2: Code

- [x] 2.1 Module inventory (src/inventory.ts) : 2d9ec0f
- [x] 2.2 Manifest and prepare() wiring (src/manifest.ts, src/prepare.ts, src/policy/root.ts) : 49f5746

### Phase 3: Tests

- [x] 3.1 Step 5 tests : 7a3871a

### Phase 4: Docs

- [x] 4.1 docs/guide.md, CHANGELOG.md and AGENTS.md : 837e7d3
- [x] Post-review fix: deep nesting is unparsed, every unsafe use of the list unparsed (wrappers, aliases, element access, loops, shadowing, self-spread), linear dedupe, path-like unknown from, no identifiers in reasons, slug accents : ca8d79b
