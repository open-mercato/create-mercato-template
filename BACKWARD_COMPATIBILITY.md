# Backward compatibility

Surfaces other people, the Open Mercato Cloud sandbox, agents and the catalog depend on. A breaking change to any of them needs the path listed, a note in the release notes, and a version bump (minor while the tool is `0.x`, major afterwards).

| Surface | Where | Breaking change | Required path |
|---|---|---|---|
| CLI commands, flags and exit codes | `src/cli.ts`, `docs/guide.md` | Removing or renaming a command or flag, changing a default, changing the meaning of exit codes 0-4 | Keep the old spelling working for one release with a warning, or document the break in the release notes and bump the version |
| `--json` output | `src/cli.ts` | Renaming, removing or retyping a field of the envelope (`schema: 1`, `command`, `ok`, `exitCode`, `tool`, `failures`) or of a command's additions; printing anything else on stdout | New fields are additive; a shape change needs a new `schema` |
| Finding `rule` values | `src/policy/` | Renaming or removing a `rule`, changing its level from warning to error without a release note | New rules are additive; the sandbox and agents match on these names |
| `report.json` | `src/snapshot.ts` | Changing `schema: 1` fields or the `snapshotId` algorithm (sorted `<path>\t<mode>\t<sha256>\n` lines, sha256) | The sandbox may recompute `snapshotId`; an algorithm change needs a new `schema` |
| `mercato-template.json` | `src/manifest.ts` | Writing a manifest that the catalog's `mercato-template-1.json` rejects | The catalog owns the schema; follow its version. `create-mercato-app` reads `schema`, `env` and `openMercato` |
| Generated `.env.example` | `src/policy/env.ts` | Keeping a value the rules now empty, or emptying a stock value | Apps created from templates copy it to `.env`; rule changes need a release note |
| `publication.json` and the template commit | `src/publish.ts` | Changing the commit message format (`Create template from snapshot <snapshotId>`), the one-commit layout or `publication.json` fields | `--resume` and the catalog may read them; old repositories must stay resumable |
| Repository topics | `src/publish.ts` | Removing or renaming the `open-mercato-template` or `open-mercato` topic | The catalog and GitHub search find templates by them; add new topics next to them |
| `describe` output | `src/describe.ts` | Renaming or removing a field, or printing YAML the catalog's `template-1.json` rejects | The catalog takes this YAML as `templates/<owner>/<repo>.yml`; a test checks it against a vendored copy of the schema |
| Runtime requirement | `package.json` `engines`, the Git minimum | Raising the minimum Node or Git version | Release notes and a version bump |

`dist/` module exports are not a supported programmatic API; only the CLI is.
