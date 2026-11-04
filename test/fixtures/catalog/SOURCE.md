# Catalog schema fixtures

## `mercato-template-1.json`: DRAFT

The catalog (`open-mercato/modules`) owns the schema of `mercato-template.json` and will publish it as `https://modules.openmercato.com/schema/mercato-template-1.json` (catalog Phase 1a step 1). On 2026-11-03 it is not published: that URL answers 404, and `open-mercato/modules` main (`5a591d63c666e0d719bb9ee70d6f3ae644407d34`) has no `mercato-template-1.json` and no manifest schema in `lib/schema/`.

So, as the spec's Phasing table says ("Vendored drafts written from the catalog spec, marked as drafts, replaced by the published files"), this file is a draft written from:

- the catalog spec, `docs/specs/2026-10-29-templates.md` at `5a591d6`, section "In-repo manifest: `mercato-template.json`" (fields and example);
- the patterns of `lib/schema/common.ts` at `5a591d6`: `ModuleId` for `modules[].id`, `NpmName` for the name part of `modules[].package`, `EnvName` for `env[].name`;
- this repo's spec for what the catalog does not fix yet: the `name` slug, `openMercato` as `<major>.<minor>.x`, the `when` grammar (Q3, proposed to the catalog as amendment 4).

Choices the catalog may change: `description` is 1 to 350 characters; `openMercato` and `description` are optional; `from` is any string, so an unknown `from` (a warning) still validates; `additionalProperties` is false everywhere, so a typo in the tool fails the test.

The draft marker is the `$comment` at the top. Release is blocked until this file is replaced by the published one (spec Step 12).

## `template-1.json`: DRAFT

The catalog owns the schema of a catalog entry `templates/<owner>/<repo>.yml` and will publish it as `https://modules.openmercato.com/schema/template-1.json` (catalog Phase 1a step 1, "JSON Schemas" in the catalog spec's published files table). On 2026-11-04 it is not published: `open-mercato/modules` main (`5a591d63c666e0d719bb9ee70d6f3ae644407d34`) has no `template-1.json` and no template schema in `lib/schema/` (it has `descriptor.ts`, `common.ts`, `json-schema.ts` and the module schemas only).

So, as the spec's Phasing table says, this file is a draft written from:

- the catalog spec, `docs/specs/2026-10-29-templates.md` at `5a591d6`, section "Catalog entry: `templates/<owner>/<repo>.yml`" (the field table: `github`, `ref`, `useCase`, `summary`, `whenToUse`, `whenNotToUse`, `links`, `screenshots`, `pricing`, `declares`, `smoke`, `slug`, `status`, `reason`, `alternatives`, `supersededBy`, `featured`), and decision A3 (the `useCase` list);
- the primitives of `lib/schema/common.ts` at `5a591d6`: `GithubRepo` for `github`, `EnvName` for `declares.env[].name`, `Host` for `declares.hosts`, `HttpsUrl` (as `^https://`, at most 300 characters) for links;
- the rules of `lib/schema/descriptor.ts` at `5a591d6` that the catalog spec says templates reuse ("as modules"): `summary` 20 to 140 characters, `whenToUse` at most 240 characters starting with `Use when ` and at least 40 characters, `whenNotToUse` at most 160, `links {docs, support, demo}` (`support` may be `mailto:`), the `screenshots` `src` pattern and `alt` 10 to 120 characters, at most 6 screenshots, the `status` enum, `reason` at most 200 characters, `alternatives` at most 5, `declares` lists at most 30 entries, `smoke.paths` at most 5 with the module path pattern.

Guesses the catalog may change, each listed in the Step 10 PR for the spec owner:

- Required fields: `github`, `useCase`, `summary`, `whenToUse` (the catalog table marks only `github` and `useCase` required; `summary` and `whenToUse` are required in `descriptor.ts` and in this repo's spec).
- `pricing` is the enum `["free"]` ("`free` only in v1") and optional, as in `descriptor.ts` (where it has a default).
- `declares.env[]` is `{name, description, link?}` with `description` required (the catalog table writes `{name, description, link?}`); `description` is 1 to 240 characters, `link` follows `HttpsUrl`. In `descriptor.ts` a module's `declares.env` is a list of names, not objects.
- `github` keeps the `GithubRepo` pattern, which allows upper case; the lower-case rule of the file path is enforced by `describe`, not by this schema.
- `ref` is a string of 1 to 250 characters of `[A-Za-z0-9._/-]`; the catalog has no ref pattern yet.
- `smoke` is `{paths?, login?, ready?}` (Phase 1b); `ready` uses the `RoutePath` pattern of `common.ts`.
- Curator fields: `slug` is a lower-case slug of at most 64 characters; `alternatives` and `supersededBy` are `owner/repo` names (`GithubRepo`), as a template has no npm locator. `replaces`, `renamedFrom`, `enterprise`, `aliases`, `tags`, `kind`, `category` and `providers` of `descriptor.ts` are not template fields.
- `additionalProperties` is false everywhere, so a field the tool should not print fails the test.
- The plain-text rule (`PlainText`: no URL, markdown, HTML, backticks, control characters or long dashes) is a runtime check in the catalog that JSON Schema does not carry, as for `descriptor-1.json`; `describe` applies it itself (`src/describe.ts`).

The draft marker is the `$comment` at the top. Release is blocked until this file is replaced by the published one (spec Step 12).
