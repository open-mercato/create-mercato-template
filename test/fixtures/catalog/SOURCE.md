# Catalog schema fixtures

## `mercato-template-1.json`: DRAFT

The catalog (`open-mercato/modules`) owns the schema of `mercato-template.json` and will publish it as `https://modules.openmercato.com/schema/mercato-template-1.json` (catalog Phase 1a step 1). On 2026-11-03 it is not published: that URL answers 404, and `open-mercato/modules` main (`5a591d63c666e0d719bb9ee70d6f3ae644407d34`) has no `mercato-template-1.json` and no manifest schema in `lib/schema/`.

So, as the spec's Phasing table says ("Vendored drafts written from the catalog spec, marked as drafts, replaced by the published files"), this file is a draft written from:

- the catalog spec, `docs/specs/2026-10-29-templates.md` at `5a591d6`, section "In-repo manifest: `mercato-template.json`" (fields and example);
- the patterns of `lib/schema/common.ts` at `5a591d6`: `ModuleId` for `modules[].id`, `NpmName` for the name part of `modules[].package`, `EnvName` for `env[].name`;
- this repo's spec for what the catalog does not fix yet: the `name` slug, `openMercato` as `<major>.<minor>.x`, the `when` grammar (Q3, proposed to the catalog as amendment 4).

Choices the catalog may change: `description` is 1 to 350 characters; `openMercato` and `description` are optional; `from` is any string, so an unknown `from` (a warning) still validates; `additionalProperties` is false everywhere, so a typo in the tool fails the test.

The draft marker is the `$comment` at the top. Release is blocked until this file is replaced by the published one (spec Step 12).
