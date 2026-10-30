# create-mercato-template: save an Open Mercato app as a template

Status: Draft for review. Date: 2026-10-30. Author: Wojtek Szyjka (builds). Reviewer and npm publisher: Piotr Karwatka.
Target path in this repo: `.ai/specs/2026-10-30-create-mercato-template.md`.
Parent spec: [Templates, revision 6, approved by Piotr Karwatka on 2026-10-29](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md) (called "the catalog spec" below). This spec is its Phase 2 (decision A12). Where the two differ, the catalog spec wins and this file is fixed.

## TLDR

- **Who needs it.** Agencies and developers who want to share a working Open Mercato app as a starting point, and the OM Cloud sandbox, which needs a stable command to save a sandbox app to GitHub.
- **Today.** No tool saves an app as a template. Pushing an app repo as is carries its history, its `.env` risks and no template flag. `open-mercato/create-mercato-template` exists, public and empty. The npm name `create-mercato-template` is free (npm 404 on 2026-10-30).
- **Proposed (future behavior).** A Node CLI, `npx create-mercato-template`, built like `create-mercato-module` (D2 = A), with three commands:
  - `prepare` builds an immutable, reviewed snapshot of one pinned commit, offline: file policy, secret scan, a regenerated `.env.example` and a generated `mercato-template.json` with the computed `modules` list.
  - `publish` pushes exactly that snapshot as a one-commit GitHub template repo (`is_template`, two topics), with a per-step report and `--resume`.
  - `describe` prints the catalog YAML for `templates/<owner>/<repo>.yml` and the CONTRIBUTING link.
- **Contract.** Stable `--json` output, exit codes 0 to 4, no prompts with `--json`, and no app code run. This is what the sandbox and agents depend on.
- **Delivery.** A bootstrap on `main`, pushed before this spec (Step 0), then eleven PR-sized steps that `om-auto-implement-spec` can build one by one, then a first release that Piotr publishes to npm.

## Open Questions (defaults applied until answered)

The pipeline builds with these defaults. Each one is reversible before the first release. ⚠ marks a default that needs a named owner's yes before release.

| #   | Question                                                                                                                                                                                                                                                                                                                                                              | Default applied                                                                                                                                                                                                                                                                                                                       | Owner                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Q1  | The repo description says "Create, edit, install the Open Mercato app templates". Does this tool also install or update templates?                                                                                                                                                                                                                                     | No. v1 saves only (`prepare`, `publish`, `describe`). Creating an app stays in `create-mercato-app --template` (catalog Phase 4). Updating a template repo (`publish --update`) is deferred (catalog A13). The repo description can be changed later by an org admin.                                                                   | Piotr ⚠                       |
| Q2  | License of this repo and package.                                                                                                                                                                                                                                                                                                                                     | MIT, as `create-mercato-module`. The local `main` already holds the MIT `LICENSE` (bootstrap commit c863b1c). Only the GitHub repo has no license yet (GitHub API, 2026-10-30), until Step 0 pushes. So this is a confirmation.                                                                                                                                                                                                                                              | Piotr ⚠                       |
| Q3  | Shape of `modules[].when` for a condition with several env flags (`OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_SSO`) or with no env flag (`example_customers_sync` is registered when `example` is enabled). The catalog example shows only one flag.                                                                                                | `when` follows a small grammar (see [Module inventory](#module-inventory)): env flag names and `module:<id>` terms, each optionally negated with `!`, joined with ` && `. One flag gives `"OM_ENABLE_STORAGE_S3"`, as in the catalog example; `example_customers_sync` gives `module:example`. A condition outside the grammar keeps its entry with `when: "custom"` and a `modules-unparsed` warning. No source code is copied into `when`. The grammar is proposed for the `when` schema in catalog Phase 1a step 1; the catalog's `mercato-template-1.json` decides the final shape, and the tool follows it.                          | Wojtek (catalog Phase 1a) ⚠   |
| Q4  | `package` on entries from `@open-mercato/core`.                                                                                                                                                                                                                                                                                                                       | Omitted, as in the catalog example: the core version is the template's own (`openMercato` in the manifest, the pinned version in the report). Every other npm `from` gets `package`.                                                                                                                                                 | Wojtek                        |
| Q5  | Official modules. The catalog spec says the parser "reads `official-modules.json` when `src/modules.ts` loads it". The scaffold `src/modules.ts` (v0.9.0 and main a447cc552) imports `officialModuleEntries` from `./official-modules.generated` and pushes them in a loop.                                                                                           | Follow the import that `src/modules.ts` makes: read the static array in `src/official-modules.generated.ts` from the snapshot. When the import cannot be read, the loop is `unparsed`. The same rule is proposed to the catalog parser (Phase 1a step 4) so both stay aligned.                                                           | Wojtek (both repos)           |
| Q6  | Enterprise (D5). The stock scaffolds of 0.8.0 and 0.9.0 depend on `@open-mercato/enterprise`, and their enterprise modules are off unless `OM_ENABLE_ENTERPRISE_MODULES` is set. A lockfile rule marks every stock app as "requires an Enterprise license".                                                                                                          | The report keeps two facts apart: `enterprise.dependency` (the lockfile resolves the package) and `enterprise.modules` (registered modules from it, each with its `when`). Neither blocks. A note goes to the catalog: key the computed mark on unconditional enterprise modules, not on the dependency. If D5 becomes "forbidden", key the block on unconditional enterprise modules too, or every stock app is blocked.                                 | Piotr (D5) ⚠                  |
| Q7  | When `prepare` finds an error, does it still write `<out>/tree`?                                                                                                                                                                                                                                                                                                      | No. It writes only `report.json`, with `snapshotId: null`. A platform that pushes `<out>/tree` with its own integration then has nothing unsafe to push.                                                                                                                                                                              | Wojtek                        |
| Q8  | A connection URL whose password is only a variable reference (`postgres://${DB_USER}:${DB_PASSWORD}@db/app`). Is that a credential?                                                                                                                                                                                                                                  | No, when the password part is only `$NAME` or `${NAME}`. With a default (`${NAME:-value}`) the default is the password and the normal rule applies.                                                                                                                                                                                    | Wojtek                        |
| Q9  | An override for a secret finding (`--allow-secret`).                                                                                                                                                                                                                                                                                                                  | None in v1. The catalog spec says the content scan never weakens. The author moves the value to `.env`.                                                                                                                                                                                                                               | Piotr                         |
| Q10 | A snapshot larger than the import limits planned for `--template` (catalog defaults: 50 MB, 5,000 files).                                                                                                                                                                                                                                                              | Warning `exceeds-import-limits`, not blocking. Phase 4 sets the final numbers.                                                                                                                                                                                                                                                        | Wojtek                        |
| Q11 | Approval for `publish` without `--json`.                                                                                                                                                                                                                                                                                                                              | On a TTY (`process.stdin.isTTY && process.stdout.isTTY`), a yes/no prompt that shows the repo, visibility, `snapshotId`, and the file and image counts computed from the verified `<out>/tree` (never read from the editable `report.json`), default no. Answering no: exit 1, rule `publish-declined`, nothing remote. `--expect <snapshotId>` replaces the prompt. No `--yes` flag. Without a TTY, `--expect` is required (exit 2).                                                                                                        | Wojtek                        |
| Q12 | Runtime dependencies. `create-mercato-module` has one (`typescript` 6.0.3).                                                                                                                                                                                                                                                                                         | Two: `typescript` 6.0.3 (AST of `src/modules.ts`, same pin as `create-mercato-module`) and `yaml` 2.9.1 (Yarn 4 lockfiles are YAML; `describe` prints YAML). Exact pins. The gitleaks rules are converted at build time, so no TOML parser ships.                                                                                    | Piotr                         |
| Q13 | Sandbox apps and Git. `prepare` pins `HEAD`, so the app must be a Git repo with a commit at its root.                                                                                                                                                                                                                                                                  | Required. `prepare` exits 1 with `not-git-repo` or `no-commit` and a hint (`git init`, `git add -A`, `git commit`). The sandbox action runs those itself when its app has no repo.                                                                                                                                                   | OM Cloud team ⚠               |
| Q14 | Keeping the stock env table current after each OM release.                                                                                                                                                                                                                                                                                                            | A weekly job in its own workflow, `.github/workflows/stock-table.yml` (`on: schedule` and `workflow_dispatch`, `permissions: contents: read`), fails when npm has a stable `create-mercato-app` version that the table lacks. It never runs on pull requests, so an OM release does not fail every PR. A maintainer runs the script and releases a patch. No automatic PR.                                                                                                                                                           | Wojtek                        |
| Q15 | Platforms.                                                                                                                                                                                                                                                                                                                                                            | Linux in CI, macOS by hand. Windows is not tested in v1; the exec bit check needs a POSIX file system.                                                                                                                                                                                                                                 | Wojtek                        |

## Problem Statement

The catalog spec holds the evidence ([Problem Statement](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#problem-statement)). In short: `--app` fails for every repo, the old awesome list is archived, and nothing turns an app into a clean, shareable template. Facts this spec adds, checked on 2026-10-30:

| Fact                                                                                                                                                                                                                                                  | Effect on this tool                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| On GitHub, `open-mercato/create-mercato-template` is public, empty (`size: 0`), with no license and `is_template: false`. npm has no `create-mercato-template`. The local clone already has the skeleton commits on `main`, the MIT `LICENSE` included.                                                                                                 | The repo needs its first push before any pipeline PR can target `main` (Step 0).                        |
| The stock `.env.example` (create-app template, v0.9.0 and main) has secret-named keys with stock values (`JWT_SECRET=change-me-dev-secret`, `AUTH_SECRET=change-me-dev-auth-secret`) and a credential URL (`DATABASE_URL=postgres://postgres:postgres@localhost:5432/open-mercato`). | Stock values must be recognized per version, or every stock app fails its own scan.                     |
| The stock `docker-compose.fullapp.yml` and `docker-compose.fullapp.dev.yml` hold `postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/...` (6 lines on main).                                                          | The stock table needs credential URLs from every stock file, not only `.env.example`.                   |
| The stock scaffold at v0.9.0 has 493 files and 21.8 MB, including 8 PNG files under `public/examples/`, 4 SVG files under `public/`, and a `preinstall` lifecycle script.                                                                                                       | A stock app always has warnings (images, executable config). "No findings" in tests means no errors.     |
| The stock scaffold has no root `README.md` at v0.9.0.                                                                                                                                                                                               | The README warning is "missing or stock", not only "stock".                                             |
| `src/modules.ts` registers `storage_s3` from `@open-mercato/storage-s3` behind `OM_ENABLE_STORAGE_S3`, and that package is not a dependency of the scaffold (v0.9.0 and main).                                                                       | A conditional module may have no lockfile entry. That cannot be an error.                               |
| `gitleaks` v8.30.1 (MIT, released 2026-03-21) has 222 rules, including `openai-api-key`, `stripe-access-token` (`sk_` and `rk_`), `slack-*` tokens and `slack-webhook-url`. Its `openai-api-key` rule only matches keys that contain the `T3BlbkFJ` marker. | Bundle and pin it, and add an OpenAI rule for `sk-proj-`, `sk-svcacct-` and `sk-admin-` keys without that marker. |

## Scope

In scope: `prepare`, `publish`, `describe`, the stock table, the bundled secret rules, the save then import contract test, the first release.

Out of scope here: the catalog schemas and validation (catalog Phase 1a), `create-mercato-app --template` (Phase 4), the sandbox button (Phase 3), the nightly smoke (Phase 1b), `publish --update`, `--submit-pr`, seed declarations (A13), subdirectory templates (A9), the agent guide for new apps (ships in the Phase 4 PR).

## Market references

| Tool                                      | What it does                                                                                              | What we take or skip                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Strapi `templates:generate`               | Deprecated. The command now prints "You can now copy an existing app and use it as a template." (strapi/strapi main, `packages/core/strapi/src/cli/commands/templates/generate.ts`). | A template is the whole app, not a reduced package. The value of a save tool is safety and a clean commit, not a new format. |
| GitHub "Use this template" and `/generate` | One fresh commit, no history.                                                                             | The template repo gets one commit too, so history never leaks.                                               |
| gitleaks                                  | Pattern rules with keywords, entropy and allowlists.                                                      | Its default ruleset, pinned and converted for offline use, with rule `path` filters and allowlist `regexTarget` and `condition` kept. We drop path-only allowlists and the global allowlist: every exported file is scanned. |
| `create-mercato-module`                   | `Executor` with argument arrays, `gh` for GitHub, a local `gh` shim for e2e, a credential scan before publishing. | Copied, not imported (catalog spec, "Shared by A and B").                                                    |

## Proposed Solution

```mermaid
flowchart LR
  A[Source app<br/>Git repo, pinned HEAD] -->|git ls-tree, cat-file<br/>no app code| P[prepare<br/>new]
  P --> O[(out/tree + out/report.json<br/>snapshotId)]
  O -->|verify hashes, --expect| U[publish<br/>new]
  U -->|gh repo create, git push one commit,<br/>PATCH is_template, topics| G[(GitHub template repo)]
  O --> D[describe<br/>new]
  U -.->|out/publication.json| D
  D -->|YAML + CONTRIBUTING link| C[PR to open-mercato/modules<br/>by the user]
  S[OM Cloud sandbox] -->|prepare --json| P
  S -.->|own GitHub integration<br/>pushes out/tree| G
```

Takeaway: `prepare` is the only command that reads the source app, and it reads it as Git data. `publish` reads only `<out>`, never the source app. The snapshot is the only thing a person reviews and the only thing pushed.

Alternatives considered:

| Alternative                                                  | Why it lost                                                                                                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy the working tree, filtered by `.gitignore`              | Picks up uncommitted work and files a rule forgot. The catalog spec requires the tree of one pinned sha.                                           |
| `git archive` as the export                                  | Honors `export-ignore` for free, but needs a tar reader at runtime and hides entry types. `ls-tree` plus `cat-file` gives modes and blob ids directly. |
| Run `yarn mercato` or import `src/modules.ts` to list modules | Runs app code. The catalog spec forbids it ("Every read is static").                                                                               |
| Depend on a gitleaks binary                                  | Not on `npx`, not offline, platform specific. A converted, pinned rule file is.                                                                     |
| Import shared code from `create-mercato-module`              | Its `dist/` exports are not a supported API (its `BACKWARD_COMPATIBILITY.md`). Small parts are copied.                                             |

## Architecture

Source layout (new repo, TypeScript compiled to CommonJS in `dist/`, as `create-mercato-module`):

| Path                                 | Job                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `bin/cli.cjs`, `src/cli.ts`          | Argument parsing by hand, the flag matrix, help, the JSON envelope, exit codes.                                          |
| `src/common.ts`                      | `run` and the `Executor` type, copied from `create-mercato-module`: argument arrays, capture timeout, no shell.          |
| `src/git.ts`                         | Pin `HEAD`, list the tree, read blobs in one `cat-file --batch`, `check-attr --source` for `export-ignore` and `filter`, worktree changes without `git status` ([Snapshot](#snapshot) step 5). |
| `src/snapshot.ts`                    | Build the file set, write `<out>`, hash, `snapshotId`, verify.                                                           |
| `src/prepare.ts`                     | The `prepare()` entry point that runs the snapshot and the policy. Tests call it from Step 3; the CLI calls it from Step 8. |
| `src/policy/*.ts`                    | One file per rule group: `root`, `entries`, `deny`, `opaque`, `secrets`, `env`, `warnings`.                               |
| `src/rules/gitleaks.json`            | Generated from gitleaks v8.30.1 by `scripts/build-secret-rules.mts`. Committed. Rules left out are listed, each with a reason, in the committed `scripts/secret-rules-skipped.json`. |
| `src/stock/table.json`, `src/stock.ts` | Generated stock table and its lookups. Committed.                                                                      |
| `src/lockfile.ts`                    | Yarn 4 lockfile reader (`yaml`).                                                                                          |
| `src/inventory.ts`                   | `src/modules.ts` inventory (`typescript` AST).                                                                            |
| `src/manifest.ts`                    | `mercato-template.json` writer and validator.                                                                             |
| `src/publish.ts`                     | Publication steps, `--resume`, `publication.json`.                                                                        |
| `src/describe.ts`                    | Catalog YAML.                                                                                                             |
| `scripts/*.mts`                      | Release-time generators (stock table, secret rules). Never shipped.                                                      |
| `test/*.test.cjs`, `test/release-e2e/` | Unit tests against `dist/`; local release checks with a `gh` shim and a loopback tarball API.                         |

Requirements at run time: Node 24 or newer (`engines`), Git 2.40 or newer (`check-attr --source`), and `gh` for `publish` only. Step 1 checks the Git minimum with a test; the version is a claim to confirm there. No `git` on `PATH` is `git-missing`.

Consumers: the OM Cloud sandbox (Phase 3) and agents call the CLI. `create-mercato-app` reads only `schema`, `env` and `openMercato` from the manifest and then removes it (catalog D3). The catalog reads the manifest as a hint and cross-check.

## CLI surface

### Commands and flags

```
npx create-mercato-template prepare [<app>] --out <dir> [--include-uncommitted] [--allow-file <path>]... [--keep-env <KEY>]... [--json]
npx create-mercato-template publish --from <dir> --repo <owner/name> (--public | --private) [--expect <snapshotId>] [--resume] [--json]
npx create-mercato-template describe --from <dir> [--repo <owner/name>] [--use-case <value>] [--summary <text>] [--when-to-use <text>] [--when-not-to-use <text>] [--json]
npx create-mercato-template --help | -h | --version | -v
```

| Flag                          | prepare  | publish                                     | describe | Notes                                                                                                                                                        |
| ----------------------------- | -------- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<app>`                       | optional |                                             |          | Defaults to the current directory. Must be the Git top level (A9).                                                                                           |
| `--out <dir>`                 | required |                                             |          | Must not exist, or be an empty directory. Must not be inside `<app>`.                                                                                        |
| `--include-uncommitted`       | yes      |                                             |          | A10. Recorded in `report.source.includeUncommitted`.                                                                                                         |
| `--allow-file <path>`         | yes      |                                             |          | Repeatable. Exact repo-relative path of an opaque file to export. Recorded in `report.allowFiles`.                                                          |
| `--keep-env <KEY>`            | yes      |                                             |          | Repeatable. Keeps a non-stock value in the generated `.env.example` after the checks. Recorded in `report.env.kept`.                                         |
| `--from <dir>`                |          | required                                    | required | A `prepare` output directory.                                                                                                                                |
| `--repo <owner/name>`         |          | required                                    | optional | GitHub owner (user or organization) and name. For `describe`, needed only when `<out>/publication.json` is absent; both given and different is exit 2.      |
| `--public`, `--private`       |          | exactly one                                 |          | D8.                                                                                                                                                          |
| `--expect <snapshotId>`       |          | required with `--json` or without a TTY     |          | 64 lower-case hex characters. Replaces the prompt (Q11).                                                                                                     |
| `--resume`                    |          | yes                                         |          | Continues only on an empty repo or one made from this snapshot.                                                                                              |
| `--use-case <value>`          |          |                                             | yes      | One of `crm`, `commerce`, `b2b-portal`, `partner-portal`, `operations`, `field-service`, `internal-tools`, `starter` (A3).                                  |
| `--summary <text>`            |          |                                             | yes      | Overrides the manifest description as the catalog `summary`. Plain text, 20 to 140 characters, else exit 2.                                                  |
| `--when-to-use <text>`        |          |                                             | yes      | The catalog `whenToUse`. Plain text of at most 240 characters that starts with `Use when ` and has at least 40 characters (catalog `lib/schema/descriptor.ts`), else exit 2. |
| `--when-not-to-use <text>`    |          |                                             | yes      | The catalog `whenNotToUse`. Plain text, at most 160 characters, else exit 2.                                                                                 |
| `--json`                      | yes      | yes                                         | yes      | One JSON object on stdout, nothing else on stdout, no prompts.                                                                                               |

A flag given to a command that does not take it, an unknown flag, a missing value or a repeated non-repeatable flag is a usage error (exit 2). Every flag is documented in `--help` and `docs/guide.md`.

`--help` (or `-h`, or no arguments) prints help and exits 0. `--version` (or `-v`) prints the version and exits 0. The short forms are protected flags too. `--help` and `-h` count only where a flag is expected, never as the value of a flag: `describe --summary --help` reads `--help` as the summary.

### Exit codes

As the catalog spec ([Save tool contract](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#save-tool-contract)):

| Code | Meaning                                                                                                                                                                       | Commands          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 0    | Done.                                                                                                                                                                         | all               |
| 1    | A check failed, the snapshot does not verify, or publication is refused. Each failure has a `rule` and a `path` when one applies. Remote reads may have happened; no remote change. Also a missing or unusable `git` and unexpected failures (`git-missing`, `git-unsafe-directory`, `io-error`, `internal`). | all               |
| 2    | Usage error.                                                                                                                                                                  | all               |
| 3    | GitHub auth missing: `gh` not installed or `gh auth status` fails.                                                                                                           | publish           |
| 4    | A GitHub step failed. The JSON says which steps finished.                                                                                                                     | publish           |

Precedence: 2 is decided before any Git read of the app and before any GitHub call; it may stat `--out`/`--from` and read `publication.json`. `publish` runs `verify` (1) before the auth check (3), and the auth check before any GitHub step (4).

### `--json` shape

Every command prints one object with this envelope:

```json
{
  "schema": 1,
  "command": "prepare",
  "ok": false,
  "exitCode": 1,
  "tool": { "name": "create-mercato-template", "version": "0.1.0" },
  "failures": [{ "rule": "secret", "ruleId": "stripe-access-token", "path": "src/lib/pay.ts", "line": 12 }]
}
```

- `failures` lists every `error` finding or `publish` refusal (exit 1, for example `{rule: "snapshot-modified", reason}`), the usage problem (exit 2, `rule: "usage"`, with `message`), the auth problem (exit 3, `rule: "github-auth"`) or the failed step (exit 4, `{rule: "github-step", step, detail?}`). Every `rule` is in the [Rule table](#rule-table). It is empty when `ok` is true.
- A top-level handler catches every error. A `CliError` keeps its exit code. Any other error is exit 1 with `rule: "internal"`. Under `--json` the handler always prints exactly one envelope, and never a stack on stdout; without `--json` it prints one message on stderr.
- No field ever carries a secret value, a matched string, an env value or an email address.
- `prepare` adds `out` (absolute path), `snapshotId` (or `null`) and `report` (the full `report.json` object).
- `publish` adds `snapshotId`, `repo` (`{fullName, url, visibility}` or `null`), `commit` (`{sha, tree}` or `null`), `steps` (`[{name, status, detail?}]` with `name` in `verify`, `create`, `push`, `template-flag`, `topics` and `status` in `done`, `failed`, `skipped`) and `retry` (a command string or `null`).
- `describe` adds `path` (`templates/<owner>/<repo>.yml`), `yaml` (string), `entry` (the same data as an object), `complete` (boolean), `missing` (field names) and `contributing` (URL).

## Data Model

There is no database. The data is files.

### Output directory

```
<out>/
  tree/               the files to publish, including the generated .env.example and mercato-template.json
  report.json         written last; publish refuses an <out> without it
  publication.json    written by publish; not part of the snapshot
```

### `report.json` (schema 1)

The catalog fields ([Snapshot](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#snapshot)), unchanged: `schema`, `tool {name, version}`, `source {head, dirty, includeUncommitted}`, `stock {version, known}`, `engines`, `packageManager`, `files [{path, mode, size, sha256, origin, generated?}]`, `snapshotId`, `findings [{rule, level, path, line?}]`, `notices`.

Definitions this spec adds to those fields: `source.dirty` is true when `uncommitted` is non-empty. `files[].origin` is one of `tree` (a blob of the pinned sha), `worktree` (read under A10) or `generated` (`.env.example`, `mercato-template.json`). Every finding has a `path`, as the catalog requires; a finding about the repo as a whole uses `"."`. A report with errors still lists `files`, so the reviewer sees what would have been exported.

Additive fields, so the sandbox can show the checklist from one file:

| Field          | Content                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `createdAt`    | ISO time. Not part of `snapshotId`.                                                                                                             |
| `tool.rules`   | `{source, count, skipped}`: the gitleaks tag and the sha256 of its config file, the number of bundled rules, and the ids left out with their reasons (`scripts/secret-rules-skipped.json`). |
| `openMercato`  | `{version, line}`: the pinned `@open-mercato/core` from `yarn.lock`, for example `0.9.0` and `0.9`.                                            |
| `uncommitted`  | `[{path, state}]`, `state` in `modified`, `added`, `deleted`, `untracked`. Always listed (A10).                                                 |
| `excluded`     | `[{pattern, paths}]`: deny list entries and `export-ignore`, with every excluded path.                                                         |
| `allowFiles`   | The `--allow-file` paths, each with `used: boolean`.                                                                                           |
| `env`          | `{kept: [KEY], emptied: [KEY], declared: [KEY], dropped: [line]}`. Key names and line numbers only.                                             |
| `images`       | `[{path, size}]`. Every image, anywhere.                                                                                                        |
| `modules`      | `{entries: [...manifest entries, plus line], unparsed: [{line, reason}]}`.                                                                     |
| `enterprise`   | `{dependency: boolean, modules: [{id, when?}]}` (Q6).                                                                                           |
| `totals`       | `{files, bytes}`.                                                                                                                               |

`findings[].level` is `error` or `warning`. Secret findings add `ruleId`. `notices` is a list of `{code, detail?}`; `code-only` is always present. Notices never block.

**`snapshotId`.** For each file, the line `<path>\t<mode>\t<sha256>\n`, with `mode` as Git writes it (`100644` or `100755`) and `sha256` in lower-case hex. Lines sorted by the UTF-8 bytes of `path`. `snapshotId` is the lower-case hex sha256 of the concatenated lines. Paths that are not valid UTF-8, or that have a tab, a newline, a backslash, a NUL, a leading `/` or a `.` or `..` segment, are refused earlier (`unsafe-path`), so the lines are unambiguous. This algorithm is a protected surface: the sandbox may recompute it.

### `mercato-template.json` mapping

The schema has one owner, the catalog (`lib/schema/`, published as `mercato-template-1.json`). The tool writes it and validates it in tests against a vendored copy.

| Field         | Source                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`      | `1`.                                                                                                                                                                                 |
| `name`        | `package.json` `name` without its scope when it is a slug (`^[a-z0-9]+(-[a-z0-9]+)*$`); else the app directory name made into a slug, with warning `manifest-name`.               |
| `description` | `package.json` `description` when it is plain text (no links, markdown, control characters or long dashes, the rule `create-mercato-module` uses); else omitted, warning `manifest-description`. |
| `openMercato` | `<line>.x` of the pinned core, for example `0.9.x`.                                                                                                                                 |
| `env`         | Declared env (see [Env diff](#env-diff-and-the-generated-envexample)).                                                                                                              |
| `modules`     | The inventory (see [Module inventory](#module-inventory)), in registration order. `when` uses the grammar defined there.                                                             |
| `createdWith` | `{tool: "create-mercato-template", version}`.                                                                                                                                       |

**Enterprise in the manifest (catalog check 8).** The manifest records the `@open-mercato/enterprise` dependency through the `modules` entries with `from: "@open-mercato/enterprise"` and their `package`. A dependency with no registered module is recorded in the report only (`enterprise.dependency`). This reading is a catalog amendment (see [Review notes](#review-notes)).

A `mercato-template.json` in the source app is replaced. Its `env[].description` and `link` are used for keys whose comment is missing. When `package.json` has `openMercatoTemplate` (an app created from a template, Phase 4), it is kept and the report gets notice `derived-from-template`.

### `publication.json`

`{schema: 1, snapshotId, repo: {fullName, url, visibility}, commit: {sha, tree}, steps, at}`. Written after each step, so `describe` and a retry can read it. Never contains a token.

### Stock table (`src/stock/table.json`)

Generated by `scripts/build-stock-table.mts` from each stable `create-mercato-app` tarball on npm (0.4.5 to 0.9.0 on 2026-10-30; prerelease tags such as `-develop.` and `-canary.` are skipped). Per version: the stock `.env.example` lines; each key with its stock values, active and commented; every credential URL string found in any text file under `template/`; and the sha256 of a stock root README when the version has one. Identical files are stored once and referenced by hash. The script is incremental: it fetches only versions the table lacks. It reads tarballs with `npm pack <spec> --pack-destination <tmp> --json` and the system `tar`, through `run` with argument arrays.

Lookup: the stock version is the pinned `@open-mercato/core` version (create-mercato-app releases in lockstep). A known version uses its own entry. An unknown version (newer than the tool, or a prerelease) matches values against any known version, sets `stock.known: false` and adds notice `stock-unknown`. No rule changes with version knowledge.

## Snapshot and security contract

This section restates the catalog's [Snapshot](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#snapshot) and [File policy](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#file-policy-blocking-unless-noted) as build rules. Nothing here weakens them.

### Snapshot

1. Resolve `<app>` with `realpath`. It must equal `git rev-parse --show-toplevel` (`app-not-repo-root`), have a commit (`no-commit`) and be a Git repo (`not-git-repo`). Git below 2.40 is `git-version`. No `git` on `PATH` is `git-missing`. Git's "dubious ownership" refusal is `git-unsafe-directory`, with a hint to check the owner and run `git config --global --add safe.directory <app>`; the tool never passes `-c safe.directory` itself.
2. Pin `HEAD` once with `git rev-parse HEAD`. Every later read names that sha, never `HEAD`.
3. List with `git ls-tree -r -z --full-tree -l <sha>`: mode, type, blob id, size, path. Read attributes with `git check-attr -z --stdin --source=<sha> export-ignore filter`. `export-ignore` files are excluded and listed under `excluded`.
4. Read contents with one `git cat-file --batch`, by blob id. Never from the working tree, except under A10.
5. Worktree changes, always listed (A10), without `git status`: it can run `core.fsmonitor` and `filter.<driver>.clean` for racily clean entries, which breaks "every read is static".
   - Tracked changes: `lstat` each path of the pinned tree in the worktree. A missing path is `deleted`. A regular file whose blob id, computed in JS (`sha1("blob <size>\0" + bytes)`, or sha256 when `git rev-parse --show-object-format` prints `sha256`), differs from the tree's blob id, or whose exec bit differs from the tree mode, is `modified`. Any other type where the tree has a file is `modified`.
   - Added: paths in the index (`git ls-files -z --cached`) that the pinned tree lacks.
   - Untracked: `git ls-files -z --others --exclude-standard` (the catalog's A10 command).
   - Without `--include-uncommitted`, the list goes to `report.uncommitted` and notice `uncommitted-not-exported`; no worktree content is exported.
   - With `--include-uncommitted`, each worktree file is opened once with `O_RDONLY | O_NOFOLLOW`. `fstat` on that descriptor must show a regular file, and `realpath` of its directory must equal `realpath(<app>)` joined with the path's directory, so no parent directory is a symlink. The bytes come from that one descriptor. A symlink, the file itself or a parent directory, is `entry-symlink`, and its content is never read; any other non-regular type is `entry-special`. The mode comes from the exec bit, with `origin: "worktree"`. A deleted tracked file leaves the snapshot.
6. Apply the rules below. With no `error` finding, write `<out>/tree/` with modes `0644` or `0755`, then `<out>/report.json` last. With any `error` finding, write only `report.json` with `snapshotId: null` (Q7); it still lists `files`. A failed read or write of `<out>` (`ENOSPC`, `EACCES`) is `io-error`.
7. The source app is never written: no Git command that writes (`add`, `stash`, `commit`, index refresh) runs on it. Every Git call runs with `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false` and `-c core.hooksPath=/dev/null`, so no monitor or hook configured in the repo runs.

### Rule table

The `rule` values are part of the JSON contract. The rows from `usage` down are command failures: they appear in `failures`, never in `report.findings`.

| Rule                         | Level   | Trigger                                                                                                                                                                           |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-git-repo`, `no-commit`, `app-not-repo-root`, `git-version`, `git-missing`, `git-unsafe-directory` | error | Step 1 above.                                                                                       |
| `io-error`                   | error   | Reading or writing `<out>` failed (`ENOSPC`, `EACCES` and the like). Exit 1.                                                                                                     |
| `internal`                   | error   | Any failure the tool did not expect. Exit 1, and the envelope is still printed under `--json`.                                                                                   |
| `root-package-json`          | error   | No readable root `package.json`.                                                                                                                                                  |
| `root-not-om-app`            | error   | `package.json` does not depend on `@open-mercato/core`.                                                                                                                           |
| `root-monorepo`              | error   | The Open Mercato framework monorepo: a `packages/core/package.json` named `@open-mercato/core`.                                                                                  |
| `root-workspaces`            | warning | The root `package.json` has `workspaces`. Allowed (the catalog excludes only the framework monorepo); listed for review.                                                         |
| `root-yarn-lock`             | error   | No root `yarn.lock`.                                                                                                                                                              |
| `root-package-manager`       | error   | `packageManager` is not `yarn@4.*`.                                                                                                                                               |
| `root-om-unresolved`         | error   | An `@open-mercato/*` dependency or dev dependency has no entry in `yarn.lock`.                                                                                                     |
| `root-om-mixed-lines`        | error   | Resolved `@open-mercato/*` versions span more than one `major.minor` line.                                                                                                        |
| `template-file`              | error   | A path ends in `.template` (the importer refuses these).                                                                                                                         |
| `modules-ts`                 | error   | `src/modules.ts` is missing or has a syntax error.                                                                                                                               |
| `entry-symlink`, `entry-submodule`, `entry-special` | error | Mode `120000` or a worktree symlink (the file or a parent directory); mode `160000`; a worktree entry of any other non-regular type. Listed by path; content never read. |
| `unsafe-path`                | error   | See `snapshotId`.                                                                                                                                                                 |
| `path-case-collision`        | error   | Two paths equal when lower-cased (they would overwrite each other on macOS and Windows).                                                                                         |
| `lfs-pointer`                | error   | `filter=lfs`, or a blob that starts with `version https://git-lfs.github.com/spec/v1`. The template would hold pointers, not files.                                              |
| `opaque-file`                | error   | See [Opaque files](#opaque-files).                                                                                                                                                |
| `secret`                     | error   | A bundled rule matched. Adds `ruleId`.                                                                                                                                            |
| `credential-url`             | error   | See [Secret scan](#secret-scan).                                                                                                                                                  |
| `yarn-auth`                  | error   | `npmAuthToken` or `npmAuthIdent` anywhere in `.yarnrc.yml`, whatever the value.                                                                                                  |
| `env-keep-secret`            | error   | `--keep-env` on a secret-looking key whose value is not stock.                                                                                                                    |
| `env-keep-unknown`           | error   | `--keep-env` names a key the source `.env.example` lacks.                                                                                                                         |
| `module-package-unresolved`  | error or warning | A module's npm `from` has no lockfile entry: error when unconditional (the app cannot build), warning when conditional (stock `storage_s3`).                             |
| `modules-unparsed`           | warning | A construct in `src/modules.ts` the inventory cannot read, or a condition outside the `when` grammar (entry kept with `when: "custom"`). One finding per construct, with its line. |
| `module-from-unknown`        | warning | A `from` that is neither `@app` nor an npm package name.                                                                                                                          |
| `image`                      | warning | Every image file, with size in the report: the image extensions under [Opaque files](#opaque-files) plus `svg`. An SVG is text and is scanned like any text.                   |
| `executable-config`          | warning | `.yarnrc.yml` `yarnPath` or `plugins`, `.github/workflows/*`, `package.json` lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, `postpack`, `prepublish`, `prepublishOnly`, `publish`, `postpublish`). |
| `ai-content`                 | warning | Exported files under `.ai/`, with a count.                                                                                                                                        |
| `seed-email`                 | warning | An email address outside `example.com`, `acme.com`, their subdomains and the reserved names `.test`, `.example`, `.invalid`, `localhost`, in a seed file (`src/modules/*/setup.ts`, any path with a `seed` segment or `seed` in the file name). Path and line only. |
| `readme-missing`, `readme-stock` | warning | No root `README.md`, or one equal to a stock README. Catalog validation makes the stock README an error.                                                                    |
| `env-example-missing`        | warning | No root `.env.example` in the source. The tool writes the stock file of the matched version, or none for an unknown version.                                                     |
| `env-undocumented`           | warning | A declared env key without a comment above it.                                                                                                                                    |
| `env-line-dropped`           | warning | A `.env.example` line the parser cannot read (for example a multi-line quoted value). Dropped from the generated file.                                                           |
| `nested-env-example`         | warning | A `.env.example` below the root. Excluded with the other `.env*` files.                                                                                                          |
| `allow-file-unused`          | warning | An `--allow-file` path that is not in the snapshot or is not opaque.                                                                                                              |
| `exceeds-import-limits`      | warning | More than 50 MB or 5,000 files (Q10).                                                                                                                                             |
| `manifest-name`, `manifest-description` | warning | See the manifest mapping.                                                                                                                                              |
| `usage`                      | error   | Exit 2, every command. Adds `message`.                                                                                                                                            |
| `github-auth`                | error   | Exit 3, `publish`: `gh` missing or `gh auth status` failing.                                                                                                                      |
| `snapshot-modified`          | error   | Exit 1, `publish`: `<out>` does not verify. Adds `reason`: `file-changed`, `file-added`, `file-missing`, `expect-mismatch`, `report-errors`, `report-missing`.                    |
| `publish-declined`           | error   | Exit 1, `publish`: the prompt (Q11) was answered no. Nothing remote.                                                                                                              |
| `repo-name-exists`           | error   | Exit 1, `publish`: the repo exists and `--resume` was not given.                                                                                                                  |
| `visibility-mismatch`        | error   | Exit 1, `publish`: the existing repo's visibility differs from `--public` or `--private`.                                                                                          |
| `repo-not-from-snapshot`     | error   | Exit 1, `publish --resume`: the repo is neither empty nor this snapshot's one commit.                                                                                              |
| `github-step`                | error   | Exit 4, `publish`: a GitHub step failed. Shape `{rule: "github-step", step, detail?}`, `step` in `create`, `push`, `template-flag`, `topics`, `detail` for example `repo-read` or `workflow-scope`. |

**Until Step 8: `prepare` is not on the CLI.** `main` is public, and `npx --package github:open-mercato/create-mercato-template` runs it, so safety cannot rest on "no release before Step 12". Steps 3 to 7 therefore build the checks behind an internal entry point, `prepare()` in `dist/prepare.js`, and their tests call it directly. Until Step 8:

- `create-mercato-template prepare` in `src/cli.ts` keeps answering exit 2 "not implemented yet", so no command on `main` writes an `<out>/tree` without the full scan.
- The entry point adds the notice `checks-incomplete` (`notices[].code`). It is not a finding and does not block, so Step 3 tests can assert a `snapshotId`.
- The root `.env.example` is not yet excepted from `**/.env*`: it is excluded like any other `.env*` file and listed under `excluded`, so no unfiltered env file is ever exported.
- In Steps 3 to 7, a test that says "exit 1" means the entry point returns an `error` finding and `snapshotId: null`. The CLI-level assertions (stdout, stderr, `--json`) run in Step 8.

Step 8 removes the notice and the `.env.example` exclusion, and wires `prepare` into `src/cli.ts`.

### Deny list

Exactly the catalog list ([File policy, check 3](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#file-policy-blocking-unless-noted)), held as data in `src/policy/deny.ts`, each entry with a test. Matching: an entry is anchored at the repo root unless it starts with `**/`; a trailing `/` matches a directory and everything below it; `*` matches within one path segment. So `/data/` excludes `data/x` and never `src/modules/x/data/entities.ts`. Only the root `.env.example` is excepted from `**/.env*` (from Step 8), and it is regenerated. Excluded files are counted and listed in `report.excluded`; they are not findings.

### Opaque files

A file is text when it decodes as UTF-8 with a fatal decoder and has no NUL byte. A non-text file is allowed only when its extension is an image (`png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`, `icns`) or a font (`woff`, `woff2`, `ttf`, `otf`, `eot`) and its first bytes match that format's signature. Archive extensions (`.zip`, `.tar`, `.tgz`, `.gz`, `.bz2`, `.xz`, `.7z`, `.rar`, `.jar`) and database extensions (`.sql`, `.dump`, `.bak`, `.sqlite`, `.sqlite3`, `.db`) are opaque even when the content is text. Every other non-text file is opaque. An opaque file is an error unless its exact path is given with `--allow-file`. A `.png` that holds a ZIP is opaque. Migrations written as code are text and unaffected.

### Secret scan

Runs on every exported text file, the generated `.env.example` and manifest included, whatever the version knowledge.

1. **Bundled gitleaks rules.** `scripts/build-secret-rules.mts` reads `config/gitleaks.toml` at tag v8.30.1 (pinned by tag and sha256 of the file) and writes `src/rules/gitleaks.json`. Per rule it keeps `id`, `regex`, `secretGroup`, `entropy`, `keywords`, the rule-level `path` filter (five rules in v8.30.1, for example `pkcs12-file`), and each rule allowlist with its `regexes`, `regexTarget` (`secret` by default, `match` or `line`), `stopwords` and `condition`. An allowlist keeps its `paths` only when `condition` is `AND`, because there they narrow it. Path-only allowlists and the global allowlist are dropped, so every exported file is scanned.
   - Conversion to JavaScript: a leading `(?i)` becomes the `i` flag, and other inline groups such as `(?i:...)` and `(?-i:...)` use the modifier syntax Node 24 supports. `\z` becomes `$(?![\s\S])` (5 lines in v8.30.1). `(?s` groups become the `s` flag, or `[\s\S]` for `(?s:.)` (2 lines). `(?P<name>` becomes `(?<name>` (1 line). POSIX classes such as `[[:alnum:]]` become explicit ranges (1 line).
   - The build fails on any rule it cannot convert, unless the rule id is listed in the committed `scripts/secret-rules-skipped.json` with a reason. The report records `tool.rules {source, count, skipped}`.
   - The build also fails if any of these ids is missing: `private-key`, `aws-access-token`, `github-pat`, `github-fine-grained-pat`, `github-oauth`, `github-app-token`, `github-refresh-token`, `npm-access-token`, `openai-api-key`, `stripe-access-token`, `slack-bot-token`, `slack-user-token`, `slack-app-token`, `slack-webhook-url`.
   - Matching runs on the whole file text, so a multi-line `private-key` matches; `line` is the line where the match starts. Keywords prefilter, case-insensitive, as in gitleaks. Entropy uses gitleaks' Shannon formula on the secret group. Stopwords are case-insensitive substrings of the secret group, as in gitleaks.
2. **Extra rules** (`src/rules/extra.ts`): OpenAI keys `sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}` without the marker; Stripe webhook secrets `whsec_[A-Za-z0-9]{24,}`; the `create-mercato-module` credential pattern as a floor (private keys, GitHub, npm, AWS, `sk_live_`/`rk_live_`, Slack `xox[abprs]-`, Google `AIza`).
3. **Credential URLs.** `scheme://user:password@host` with a non-empty password. Not a finding when the exact URL string appears in the stock files of any known version (catalog check 5: an app upgraded from 0.8 keeps its 0.8 compose URLs), or when the password part is only `$NAME` or `${NAME}` (Q8). The env-value rule stays per matched version (catalog check 6, see [Env diff](#env-diff-and-the-generated-envexample)). An exact match flags an app that changes only the database name in a stock compose URL (`.../my-app` with the stock `postgres` password). Until the catalog accepts amendment 6, the `credential-url` hint names the workaround: a variable reference with no default, such as `${POSTGRES_PASSWORD}`, which Q8 accepts.
4. **Yarn auth.** `yarn-auth` as in the rule table.

Findings carry `path`, `line` and, for rules, `ruleId`. No output, log or file ever contains the matched text. A test asserts that stdout, stderr, `report.json` and `--json` output contain none of the fixture secrets.

### Env diff and the generated `.env.example`

The source is the root `.env.example` from the snapshot. `.env` and every other `.env*` file are never read: they are denied before any read.

1. Parse each line as blank, comment, assignment (`KEY=VALUE`, optional `export `, optional quotes) or commented assignment (`# KEY=VALUE` with `KEY` matching `[A-Z_][A-Z0-9_]*`). Anything else is dropped with `env-line-dropped`.
2. For an assignment or commented assignment, keep the value only when (a) it equals a stock value of that key in the matched version (any known version when unknown), or (b) the key is in `--keep-env`, the value passes the secret scan, and the key does not look secret. A secret-looking key ends in `_SECRET`, `_KEY`, `_TOKEN` or `_PASSWORD`, or has one of those words as an underscore segment (so `DOCUMENTS_COLLAB_JWT_SECRET_V2` counts). Otherwise the value is emptied (`KEY=`, or `# KEY=` for a commented line) and the key goes to `report.env.emptied`.
3. Comments and blank lines are kept in order. They are scanned like any text.
4. Declared env: keys (active or commented) that the stock `.env.example` of the matched version lacks; for an unknown version, compared with the newest known version. Each becomes `{name, description?, link?}` in the manifest: `description` is the comment block directly above, joined into one line, with the first `https://` URL moved to `link`. A key without a comment gets `env-undocumented`. A description that the vendored manifest schema rejects is left out, with the same warning.

### Paid dependencies

`enterprise.dependency` is true when `yarn.lock` resolves `@open-mercato/enterprise`. `enterprise.modules` lists registered modules from it with their `when`. Notice `enterprise-dependency` when either is set. Never blocking (D5: allowed, but marked). The manifest records it through the enterprise `modules` entries (see the [manifest mapping](#mercato-templatejson-mapping)).

## Module inventory

Same rules as the catalog's planned `modulesFromModulesTs` ([catalog Data Model, "Module inventory"](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#catalog-entry-templatesownerrepoyml)), implemented with the `typescript` compiler API on the snapshot's `src/modules.ts`, offline, with no type checking and no module resolution beyond the one import below.

1. Find the exported array binding that holds `{id, from}` object literals (`enabledModules` in the scaffold). Read every object entry with a string `id` and any string `from`, `@app` included. A missing `from` means `@open-mercato/core`, as the scaffold's `ModuleEntry` type says.
2. Follow `push`, `unshift` and spread reassignments of that binding after the initial array, in source order.
3. An addition inside an `if` is conditional. Its `when` follows this grammar (Q3):

   ```
   when := TERM (" && " TERM)*
   TERM := "!"? (ENV_NAME | "module:" ID)
   ```

   - An identifier whose `const` initializer reads `process.env.NAME` (directly or through a call such as `parseBooleanWithDefault(process.env.NAME, false)`), or such a call written inline, becomes `NAME`.
   - `<binding>.some((x) => x.id === '<id>')` on the tracked binding becomes `module:<id>`.
   - `&&` and nested `if`s join with ` && `. `!` applies to one term; an `else` branch of a one-term condition negates it.
   - Any other condition (`||`, the `else` of a compound condition, an unknown call) keeps the entry with `when: "custom"` and adds a `modules-unparsed` warning with its line. No source text is copied into `when`.

   So `storage_s3` gets `OM_ENABLE_STORAGE_S3`, `sso` gets `OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_SSO`, `agent_examples` (`@app`) gets `OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_AGENTS`, and `example_customers_sync` gets `module:example`. The grammar is proposed for the `when` schema in catalog Phase 1a step 1, so the catalog parser and this tool give the same string.
4. A loop over an imported array (`for (const entry of officialModuleEntries) ... push(entry)`) reads that array from the imported file in the snapshot (`src/official-modules.generated.ts`), with the same object rules. A dedupe guard (`if (!enabledModules.some(... existing.id === entry.id))`) keeps the first entry per id (Q5).
5. No entry cap. Files above 2,000,000 bytes (the catalog's `MAX_PARSE_BYTES`) are `modules-unparsed` as a whole.
6. Any other construct that adds to the binding (a ternary, a function call, a loop of another shape, a computed `id`) is listed in `report.modules.unparsed` with its line and a `modules-unparsed` warning. Nothing is dropped silently.
7. `package`: for an npm `from` other than `@open-mercato/core` (Q4), the version Yarn resolved. First the descriptor from `package.json` (`dependencies`, then `devDependencies`) is looked up in `yarn.lock`; else a single lockfile entry for that name. Written as `<name>@<version>`. No entry gives `module-package-unresolved`.

The manifest entry is `{id, from, package?, when?}`. The report entry adds `line`.

## Publication

As the catalog's [Publication](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#publication). Every remote call goes through `gh` with argument arrays and the `run` timeout.

1. **`verify`** (local). `lstat` `<out>` and `<out>/tree`: neither may be a symlink. Read `<out>/report.json`. Walk `<out>/tree` with `lstat`: regular files only, and the path set equals `report.files`. Read each file once into memory (opened with `O_NOFOLLOW`) and check its `size`, `sha256` and exec bit against the report. Publication step 4 writes these same in-memory bytes; nothing is read from disk again. Recompute `snapshotId` from `report.files`; it must equal `report.snapshotId` and `--expect`. The report must have no `error` finding and a non-null `snapshotId`. Any failure is exit 1, rule `snapshot-modified` with `reason` in `file-changed`, `file-added`, `file-missing`, `expect-mismatch`, `report-errors`, `report-missing`. Without `--expect` on a TTY, the prompt (Q11) comes after `verify`, with counts from the verified tree.
2. **Auth.** `gh` missing or `gh auth status` failing is exit 3 with the `gh auth login` hint.
3. **Repo state** (reads only). `gh api repos/<owner>/<name>`. Only HTTP 404 means missing. Any other failure (network, 403, rate limit) stops before any remote change: exit 4, step `create` failed with `detail: "repo-read"`, and `retry`. Missing: continue, with or without `--resume`. Present without `--resume`: exit 1, `repo-name-exists`. A visibility different from the flag is exit 1, `visibility-mismatch`. Present with `--resume`: the content is checked on a clone in step 6, before any remote change. No `/commits` or `git/commits` read is made: GitHub answers HTTP 409 for those on an empty repo.
4. **Build the commit locally**, before any remote change. In a temporary build repo made with `git init --template=`, with `-c core.hooksPath=/dev/null` on every command: write the in-memory bytes from `verify` with `git hash-object -w --no-filters --stdin`, then `git update-index --index-info` with the report modes, then `write-tree`. Check that `git ls-tree -r <tree>` equals the report's paths and modes and the in-memory blob ids; else exit 1, `snapshot-modified`, reason `file-changed`. Then `commit-tree --no-gpg-sign`, so a signing setup never prompts. The tree sha is deterministic and is the one `--resume` compares. Author and committer: always the `gh api user` login with `<id>+<login>@users.noreply.github.com`, never the local Git identity, so a private email address never reaches a public repo (`CODE_REVIEW.md`, priority 2). `create-mercato-module` prefers the Git identity when set; this tool does not. Message: `Create template from snapshot <snapshotId>`, blank line, `Created with create-mercato-template <version>.` No source sha, no history.
5. **`create`**: `gh repo create <owner>/<name> --public|--private --description <manifest description>` (when it is one line of at most 350 characters). Skipped only when step 3 found the repo. A missing repo is created even with `--resume`.
6. **`push`**:
   - `gh repo clone <o>/<r> <tmp2> -- --no-checkout`. This works on an empty repo, writes no remote file to disk, and the e2e `gh` shim already routes the clone's push URL to its bare repo, as in `create-mercato-module`.
   - Decide the state in `<tmp2>`. No `origin/HEAD` means the repo is empty. Otherwise it matches only when `git rev-list --count origin/HEAD` is 1 and `origin/HEAD^{tree}` equals the local tree. A match skips the push. On a match, `commit` is `{sha: rev-parse origin/HEAD, tree: origin/HEAD^{tree}}` and `publication.json` is rewritten with it, because the commit built locally in step 4 has a new timestamp and so a sha GitHub does not have. Neither empty nor matching is exit 1, `repo-not-from-snapshot`; this can only happen with `--resume` on a repo found in step 3, so no remote change has been made.
   - Empty: `git -C <tmp2> fetch <build-repo> <commit>`, then `git -C <tmp2> push origin <commit>:refs/heads/main` with `-c credential.helper= -c credential.helper=!gh auth git-credential` and `-c core.hooksPath=/dev/null`. Never `--force`, never a `+` refspec.
   - A push rejected because the token lacks the `workflow` scope (a snapshot with `.github/workflows/*`) fails the step with `detail: "workflow-scope"` and the hint `gh auth refresh -s workflow`.
7. **`template-flag`**: `gh api --method PATCH repos/<o>/<r> -F is_template=true`, checked in the response. Idempotent.
8. **`topics`**: `gh repo edit <o>/<r> --add-topic open-mercato-template --add-topic open-mercato`. Adds, never replaces. Idempotent.

`publication.json` is rewritten after each step. On a failed step: exit 4, the step list, `repo` and `commit` when known, and `retry`: `npx create-mercato-template@<version> publish --from <dir> --repo <o>/<r> --<visibility> --expect <snapshotId> --resume`. No credential is written to the temporary repo, `<out>` or any output.

## describe

Reads `<out>/report.json`, the manifest in `<out>/tree`, and the repo from `publication.json` or `--repo`. No network.

```yaml
github: acme/b2b-portal
useCase: b2b-portal
summary: B2B self-service portal with quotes and customer accounts.
whenToUse: Use when B2B customers need to request quotes and manage their own accounts.
pricing: free
declares:
  env:
    - name: OPENAI_API_KEY
      description: Used by the AI assistant.
      link: https://platform.openai.com/api-keys
```

- `github` and the file path are lower-cased (catalog rule). Curator fields (`slug`, `status`, `reason`, `featured`) are never printed. `smoke` waits for Phase 1b.
- `summary` is `--summary`, else the manifest description when it is plain text of 20 to 140 characters; otherwise `summary` is missing. `useCase` is `--use-case`. `whenToUse` is `--when-to-use`. `whenNotToUse` is `--when-not-to-use`, optional, printed only when given. These rules follow the catalog's `lib/schema/descriptor.ts` (`summary` 20 to 140 characters, `whenToUse` starting with `Use when `, at least 40 characters).
- A missing required value (`useCase`, `summary`, `whenToUse`) prints a YAML comment placeholder (with the allowed values for `useCase`), sets `complete: false`, lists the field in `missing`, and exits 0, so `describe --from <dir>` works as the catalog contract shows.
- Then the [CONTRIBUTING link](https://github.com/open-mercato/modules/blob/main/CONTRIBUTING.md#templates). No `/submit` link before Phase 1b (A7). The anchor appears when catalog Phase 1a step 8 merges.
- A report with error findings, or no report: exit 1.

## Sandbox integration

What this repo guarantees for the [sandbox contract](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#sandbox-integration-abstract):

- Two call paths: `prepare --json --out <dir>` then the platform pushes `<out>/tree` itself; or `prepare --json` then `publish --json --from <dir> --expect <snapshotId>` where `gh` is signed in. No platform credential is passed to the tool.
- With `--json`: no prompt, one object on stdout, the exit codes above. A pinned version (`npx create-mercato-template@<exact>`) behaves the same for every user.
- The report carries what the checklist needs: errors, warnings, `code-only`, uncommitted files, emptied env keys, opaque files to allow, images with sizes, modules, Enterprise facts.
- A platform that pushes on its own must push only `<out>/tree`, set `is_template` and both topics, and should check `snapshotId` itself. With an error, `<out>/tree` does not exist (Q7).

## Edge Cases & Failure Scenarios

The catalog's [Edge Cases](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#edge-cases--failure-scenarios) apply. Tool-specific cases:

| Case                                                                 | Behavior                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| App is a subdirectory of a larger repo                               | Exit 1, `app-not-repo-root` (A9).                                                                                                                |
| Sandbox app with no Git repo or no commit                            | Exit 1, `not-git-repo` or `no-commit`, with the commands to fix it (Q13).                                                                       |
| `--out` exists and is not empty, or is inside the app                | Exit 2. Nothing is written.                                                                                                                      |
| `HEAD` moves while `prepare` runs                                    | No effect: every read names the pinned sha.                                                                                                      |
| `.gitattributes` with `eol=crlf` or a clean filter                   | `prepare` reads raw blobs; `publish` hashes with `--no-filters`. The template holds the committed bytes.                                         |
| Git LFS files                                                        | Exit 1, `lfs-pointer`.                                                                                                                           |
| `README.md` and `Readme.md` both tracked                             | Exit 1, `path-case-collision`.                                                                                                                   |
| Secret in a comment of `.env.example`                                | Found by the scan of the generated file. Exit 1.                                                                                                 |
| `DATABASE_URL` with a changed password                               | Value emptied in `.env.example`; the same URL anywhere else is `credential-url`.                                                                |
| `.yarnrc.yml` with `npmAuthToken: "${NPM_TOKEN}"`                    | Exit 1, `yarn-auth`. A template does not carry registry auth.                                                                                    |
| `src/modules.ts` built by a helper function                          | Entries the parser can read are listed; the rest are `modules-unparsed` warnings with lines.                                                     |
| Conditional module whose package is not installed (stock `storage_s3`) | Listed with `when` and no `package`; warning.                                                                                                  |
| App on a version newer than the tool                                 | All blocking checks run; unmatched stock values are emptied; notice `stock-unknown`.                                                            |
| `<out>` edited, a file added or removed, or the report edited        | `publish` exit 1, `snapshot-modified` with the reason. Nothing remote.                                                                         |
| `gh` signed in to an account without rights on the owner             | `create` fails: exit 4, step list, `retry`.                                                                                                      |
| Push rejected (branch protection, network)                           | Exit 4 with `repo` known and `commit` built; `--resume` pushes the same tree.                                                                    |
| Snapshot with `.github/workflows/*` and a token without the `workflow` scope | Exit 4, step `push` failed with `detail: "workflow-scope"` and the hint `gh auth refresh -s workflow`; `--resume` after the refresh.     |
| `create` failed, then `--resume`                                     | The repo is still missing, so `create` runs, then `push`.                                                                                       |
| `git` missing, or Git refuses the repo as "dubious ownership"        | Exit 1, `git-missing` or `git-unsafe-directory` with a hint. The tool never passes `-c safe.directory`.                                         |
| Disk full or no permission on `--out`                                | Exit 1, `io-error`. Under `--json`, still one envelope.                                                                                         |
| `--resume` on a repo someone pushed to                               | Exit 1, `repo-not-from-snapshot`.                                                                                                                |
| Visibility flag differs from the existing repo on `--resume`         | Exit 1, `visibility-mismatch`.                                                                                                                   |
| `describe` before the catalog has a Templates section in CONTRIBUTING | The link resolves to the file without the anchor; the YAML is still valid.                                                                      |

## Risks & Impact Review

| Risk                                                       | Impact                                                              | Mitigation                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A secret reaches a public repo                             | High and hard to reverse.                                           | One pinned tree, deny list before reads, regular files only, opaque files blocked, pinned rules plus extras, no override (Q9), `.env.example` regenerated, error snapshots have no tree (Q7). |
| False positives with no override                           | A legitimate template cannot be saved.                              | Per-rule gitleaks allowlists kept, stock exceptions per version, variable-only passwords (Q8), clear `path` and `line` so the author moves the value.                              |
| Inventory drift from the catalog parser                    | Page and manifest disagree.                                         | Same written rules; a contract test on the catalog's fixtures once Phase 1a step 4 lands; the catalog treats a mismatch as a warning and shows its own parse.                    |
| Save and import drift (`create-mercato-app`)               | Templates that do not create.                                       | Release-checks job: publish to the shim, import with `--app-url` (later `--template`), install, build, start, log in. Pinned and `@latest` legs.                                  |
| Stock table out of date                                    | More values emptied for new OM lines.                               | Weekly check job (Q14); unknown version changes no rule.                                                                                                                          |
| Enterprise mark wrong for every stock app                  | A misleading mark in the catalog.                                   | Two separate facts in the report (Q6); note to the catalog.                                                                                                                      |
| Publication half done                                      | A repo with no commit, or no flag.                                  | Ordered steps, commit built before any remote change, `publication.json`, `--resume` only on an empty or matching repo.                                                         |
| Single npm maintainer                                      | Release bottleneck.                                                 | Catalog spec: a second maintainer or npm Trusted Publishing before 1.0.                                                                                                           |

**Protected surfaces** (to go into this repo's `BACKWARD_COMPATIBILITY.md` in Step 1): commands, flags (`-h` and `-v` included) and exit codes; the `--json` envelope (schema 1); `report.json` (schema 1) and the `snapshotId` algorithm; `rule` values; the publication commit message format and topics; the `describe` YAML, which must validate against the catalog's `template-1.json`; the manifest, whose schema the catalog owns.

**Rollback.** Before 1.0, a bad release is deprecated on npm and fixed forward; the sandbox pins an exact version. A published template repo is the user's; the tool never deletes or rewrites one.

## Phasing

One phase in this repo: the catalog's Phase 2. It runs in parallel with catalog Phase 1a from 2026-11-02.

| Dependency                                         | Needed by | Until it lands                                                                     |
| -------------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| Catalog Phase 1a step 1: `template-1.json`, `mercato-template-1.json` | Steps 5 and 10 tests | Vendored drafts written from the catalog spec, marked as drafts, replaced by the published files. |
| Catalog Phase 1a step 4: `modulesFromModulesTs` fixtures | Step 5 contract test | Own fixtures from the scaffold at v0.9.0 and main a447cc552.                        |
| Catalog Phase 1a step 8: CONTRIBUTING Templates section | Step 10 link | Link to the file.                                                                   |
| Phase 4 (`--template`)                             | Step 11 later leg | The contract test uses `--app-url`.                                                 |

## Implementation Plan

Each step is one PR against `main`, built by `om-auto-implement-spec` with this spec as `Source doc:`. Each leaves the CLI working and the gate green: `npm run lint`, `npm run typecheck`, `npm test`, `npm pack --dry-run`. Tests are `node --test` against `dist/`; external commands go through fake executors, local bare repositories or the `gh` shim; no test touches github.com or npmjs.com. Every step updates `docs/guide.md` and `CHANGELOG.md` for what it adds. No release happens before Step 12.

### Step 0: Bootstrap (human, before the pipeline)

The GitHub repo is empty, so the pipeline has no `main` to target. A local clone holds the bootstrap on `main`, and `main` is pushed first, without this spec:

- `c863b1c`: `LICENSE` (MIT), `.gitignore`, `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`, `.ai/agentic.config.json` and the agent skills, adapted from `create-mercato-module` f83233d.
- `2709091`: the CLI skeleton. `package.json`, `tsconfig.json`, `eslint.config.mjs`, `bin/cli.cjs`, a `src/cli.ts` with `CliError`, the exit codes, `--help`/`-h`, `--version`/`-v` and exit 2 for the three commands, `test/cli.test.cjs`, `test/pack.test.cjs`, the Tests workflow, `README.md`, `CHANGELOG.md` and `docs/guide.md`.
- `bccbfd0` to `9a55125`: the fixes from the reviews of 2026-10-30. `.ai/agentic.config.json` with `"baseBranch": "main"` and validation `npm run lint`, `npm run typecheck`, `npm test`, `npm pack --dry-run`, the same list in `SDLC.md`; `.env.example` fixtures not ignored; no source maps in the package; a CI timeout; `bin/cli.cjs` keeps only exit codes 0 to 4 from a `CliError` (`test/bin.test.cjs`); `tsconfig.scripts.json`, so `npm run typecheck` covers `scripts/*.mts`.

So `main` is `c863b1c` followed by `2709091` to `9a55125`. Wojtek pushes it by name (`git push origin main`, never `--all`) after the owner's yes. This spec then goes as a PR against `main` from branch `docs/phase2-spec`, which adds only this file. Piotr reviews it there. After his yes, line 3 is changed in that PR to `Status: Approved by Piotr Karwatka on <date>.` and the PR merges, so the spec reads Approved from the moment it lands on `main`. No pipeline step starts before that merge.

The `LICENSE` is already MIT, so Q2 is a confirmation. After the push, once write or admin access is confirmed and with its own yes (it creates GitHub resources), the label taxonomy is created with the `ensure-label-taxonomy` block of `.ai/trackers/github.md`, or `om-setup-agent-pipeline` in label-only mode. Until then a missing label is a logged skip.

Tests: after the spec PR merges, `om-auto-implement-spec` resolves the spec by path on `main`; the config `baseBranch` is `main`.

### Step 1: CLI parser, JSON envelope and Git check

Remaining after the bootstrap (the bootstrap on `main` already ships `package.json`, `tsconfig.json`, `eslint.config.mjs`, `bin/cli.cjs`, `CliError`, the exit codes, help, `--version` and CI):

- `src/cli.ts`: the argument parser and the per-command flag matrix; `--help`/`-h` only where a flag is expected, never as the value of a flag; the JSON envelope; the top-level handler (a `CliError` keeps its code, any other error is exit 1 with `rule: "internal"`, and under `--json` the envelope is always printed). The three commands still answer exit 2 "not implemented yet" until their step (`prepare` until Step 8, see [Rule table](#rule-table)).
- `src/common.ts`: `run` and `Executor`, copied from `create-mercato-module`.
- The Git check: 2.40 or newer (`git-version`), `git` missing (`git-missing`), "dubious ownership" (`git-unsafe-directory`).
- `BACKWARD_COMPATIBILITY.md`: the protected surfaces listed under [Risks & Impact Review](#risks--impact-review).

Tests: unknown command, unknown flag, flag on the wrong command, missing value, both `--public` and `--private`: exit 2, and with `--json` one parsable object with `rule: "usage"`. Replace the `--json` unknown-option assertion in `test/cli.test.cjs`. `describe --summary --help` does not print help. A thrown non-`CliError` gives exactly one JSON object with `rule: "internal"` and exit 1. The Git check refuses a fake `git version 2.39.0`, accepts `2.40.0`, and reports `git-missing` when `git` is not on `PATH`. The `--version` and `npm pack --dry-run` tests already exist.

### Step 2: Stock table

`scripts/build-stock-table.mts`, `src/stock/table.json` for stable versions 0.4.5 to 0.9.0, `src/stock.ts` (lookup by version, any-version match, stock lines, credential URLs, README hash). A separate workflow, `.github/workflows/stock-table.yml` (`on: schedule` weekly and `workflow_dispatch`, `permissions: contents: read`, never on pull requests), runs `npm view create-mercato-app versions --json` and fails when a stable version is missing from the table (Q14).

Tests: the 0.9.0 entry equals a committed copy of `template/.env.example` and the credential URL list from the 0.9.0 tarball (fixture, no network); `JWT_SECRET=change-me-dev-secret` is stock for 0.9.0; an unknown version matches a value from any known version and reports `known: false`; the script, run on a local fixture tarball through a fake executor, adds only the missing version.

### Step 3: `prepare`, snapshot core

`src/git.ts`, `src/snapshot.ts`, `src/policy/entries.ts`, `src/policy/deny.ts`, `src/prepare.ts`; the internal entry point `prepare()` in `dist/prepare.js` with the options `app`, `out` and `includeUncommitted`, returning the result the `--json` envelope will carry (the CLI command stays exit 2 until Step 8); pinned `HEAD`, tree listing, `export-ignore`, blob reads, entry types, `unsafe-path`, `path-case-collision`, `lfs-pointer`, deny list, uncommitted listing, `<out>` rules, `report.json` with `files`, `excluded`, `uncommitted`, `snapshotId`, the `code-only` notice, `io-error`. Until Step 8 lands, the entry point adds the notice `checks-incomplete`, not a finding, and leaves the root `.env.example` out of the export (see [Rule table](#rule-table)).

A shared builder, `test/helpers/fixture-app.cjs`, writes a minimal valid OM app: `package.json` depending on `@open-mercato/core` with `packageManager: yarn@4.x`, a minimal `yarn.lock` that resolves it, `src/modules.ts` and `.env.example`. All later fixtures derive from it, so the root rules of Step 4 do not turn them into errors.

Tests (fixture repos built in a temp directory from the fixture app): `src/modules/x/data/entities.ts` kept while `/data/x` and `.env.local` are excluded and listed; a dirty working tree whose changes are not exported by default and are listed; the same with `--include-uncommitted` (modified, added, deleted, untracked; ignored `.env` never read); a symlink; an untracked file under a directory symlink that points outside the app (`entry-symlink`, content never read); a repo with `core.fsmonitor` and a clean filter set to scripts that leave a marker file (no marker after `prepare`); a submodule; a path with a tab; a path that is not valid UTF-8; a case collision; an LFS pointer; an `export-ignore` file; `snapshotId` equals a golden value for a fixed fixture; the source repo's index, refs and worktree hashes are unchanged after `prepare`; `--out` inside the app or not empty is a `CliError` with exit 2; the root `.env.example` is listed under `excluded` and absent from `<out>/tree`; `node bin/cli.cjs prepare . --out <dir>` still exits 2 "not implemented yet" and writes nothing.

### Step 4: Root checks and lockfile

`src/policy/root.ts`, `src/lockfile.ts` (`yaml` 2.9.1); the root rules, `root-workspaces`, `template-file`; `report.openMercato`, `report.enterprise.dependency`.

Tests: a mixed-line lockfile, a missing `yarn.lock`, Yarn 3, the framework monorepo (`packages/core/package.json` named `@open-mercato/core`), a `.template` file: each its error; root `workspaces` alone: warning `root-workspaces`, no error; the Step 3 fixture app passes the root checks.

### Step 5: Module inventory and manifest

`src/inventory.ts`, `src/manifest.ts`; `modules-ts`, `module-package-unresolved`, `modules-unparsed`, `module-from-unknown`; `mercato-template.json` in `tree/` with `name`, `description`, `openMercato`, `modules`, `createdWith` (env comes in Step 8); `report.modules`, `report.enterprise.modules`.

Tests: the scaffold `src/modules.ts` and `official-modules.generated.ts` at v0.9.0 and at main a447cc552 (vendored fixtures) give `ratelimit_probe` from `@app`, `example_customers_sync` with `when: "module:example"`, `agent_examples` (`@app`) with `OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_AGENTS`, `storage_s3` with `when: "OM_ENABLE_STORAGE_S3"` and no `package`, the five enterprise entries with their joined flags, and no entry from commented lines; a modules list with an `@app` module, a pinned npm module (`package` from `yarn.lock`) and an env-gated one; 120 entries, none dropped; a helper-function construct listed as `unparsed` with its line; an `||` condition: `when: "custom"` and a `modules-unparsed` warning with its line; a duplicate official entry kept once; the manifest validates against the vendored `mercato-template-1.json`. When the catalog's `modulesFromModulesTs` fixtures exist, a contract test runs them and compares.

### Step 6: Secret rule converter

`scripts/build-secret-rules.mts`, `scripts/secret-rules-skipped.json`, `src/rules/gitleaks.json`; `report.tool.rules`.

Tests: the rule build fails when a required id is removed from the input TOML; it fails on a construct it cannot convert in a rule not listed in `secret-rules-skipped.json`; each translation (`\z`, `(?s:.)`, `(?P<`, a POSIX class) matches and rejects fixture strings chosen for it; rule `path` filters and allowlist `regexTarget`, `condition` and `AND` paths survive the conversion; the converted file has the required ids.

### Step 7: Secret scan and opaque files

`src/rules/extra.ts`, `src/policy/secrets.ts`, `src/policy/opaque.ts`; `--allow-file`; `secret`, `credential-url`, `yarn-auth`, `opaque-file`, `allow-file-unused`.

Tests: OpenAI (`sk-proj-` with and without the marker), Stripe (`sk_live_`, `rk_live_`, `sk_test_`, `whsec_`), Slack (`xoxb-`, `xoxp-`, a `hooks.slack.com` webhook), GitHub PAT, npm token, AWS key and a private key, each hard-coded in a source file: exit 1 with `ruleId`, path and line; a changed `DATABASE_URL` password in source: `credential-url`; the stock `DATABASE_URL` and the stock compose URLs: no finding; a 0.8.0 stock compose URL in an app pinned to 0.9.0: no finding; a stock compose URL with only the database name changed: `credential-url` with the `${POSTGRES_PASSWORD}` hint; the stock 0.9.0 `.env.example`, passed to the scanner directly because the file is not exported before Step 8: no `secret` finding (its `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` value has entropy 4.13 and passes `generic-api-key` only through the stopwords `dev-` and `back`); a multi-line private key: found, with the line where it starts; `postgres://${U}:${P}@db/app`: no finding; `${P:-hunter2}` as password: finding; `.yarnrc.yml` with `npmAuthToken`: `yarn-auth`; a tracked `backup.sql`: `opaque-file`, then exported with `--allow-file backup.sql`; a ZIP named `logo.png`: `opaque-file`; stdout, stderr, `report.json` and `--json` contain none of the fixture secrets.

### Step 8: Env diff, warnings and notices

`src/policy/env.ts`, `src/policy/warnings.ts`; the generated `.env.example`, `--keep-env`, declared env into the manifest, every warning and notice in the rule table, `report.env`, `report.images`, `exceeds-import-limits`. Remove the `checks-incomplete` notice and the root `.env.example` exclusion, and wire `prepare` into `src/cli.ts` with its flags and the `--json` envelope; `--help` and `docs/guide.md` drop "(planned)" for it.

Tests: a stock 0.9.0 app gives no error and exactly the expected warnings (images: the PNG files under `public/examples/` and the SVG files under `public/`; the `preinstall` script; `readme-missing`; `storage_s3` unresolved), and its generated `.env.example` equals the stock file; a changed `JWT_SECRET`: emptied and listed; `--keep-env JWT_SECRET` with a non-stock value: `env-keep-secret`; `--keep-env APP_URL` with a custom URL: kept; a commented `# OPENAI_API_KEY=sk-proj-...`: `secret`; an unknown version: values emptied unless stock in any known version, notice `stock-unknown`; a declared key with a comment and a link, and one without (`env-undocumented`); `@open-mercato/enterprise` in the lockfile: notice, no error; a seed email outside example domains: warning with no address in output; a 5,001-file fixture: `exceeds-import-limits`; through `bin/cli.cjs`, the stock app exits 0 with one `--json` envelope, and the Step 7 secret fixtures exit 1 with none of the secrets in stdout, stderr or the envelope.

### Step 9: `publish`

`src/publish.ts`; the eight steps, prompt (Q11), `publication.json`, `retry`. Copy `test/release-e2e/gh-shim.mjs` from `create-mercato-module`. It already handles `repo create`, `repo edit --add-topic` and `repo clone` (which routes the push URL to the bare repo). Extend it with only what is missing: `api --method PATCH repos/<o>/<r>`, a `visibility` field in the `repos/<o>/<r>` answer (today it returns `private`), and a log of every mutating call. It needs no `/commits` or `git/commits` support.

Tests: a full publish to the shim gives one commit, the expected message, `is_template: true` and both topics, and the tree sha equals the locally computed one; a name clash: exit 1, `repo-name-exists`, no mutating call logged; a file edited after `prepare`, a file added, a report edited, a wrong `--expect`: exit 1, `snapshot-modified` with the reason, no remote call at all; a push failure (shim refuses once): exit 4 with `repo`, `commit`, steps and `retry`, then `--resume` succeeds and skips `create` and `push` correctly; the shim fails `repo create` once, then `--resume` creates and pushes; a push rejected for the `workflow` scope: exit 4 with `detail: "workflow-scope"`; `<out>/tree` replaced by a symlink: `snapshot-modified`; `commit.gpgsign=true` in the user Git config: no prompt, no signature; a `user.email` in the user Git config: the commit author and committer are still the noreply address; an unrelated repo with `--resume`: exit 1, `repo-not-from-snapshot`, no mutating call; a visibility mismatch; `gh` missing and `gh auth status` failing: exit 3; `--json` without `--expect`: exit 2; no token value in any output or file.

### Step 10: `describe`

`src/describe.ts`; YAML from the report, manifest and repo; `--use-case`, `--summary`, `--when-to-use`, `--when-not-to-use`, `--repo`; the CONTRIBUTING link; the new flags in `--help` and `docs/guide.md`.

Tests: with `--use-case` and `--when-to-use` the YAML validates against the vendored `template-1.json`, and the manifest against `mercato-template-1.json` (both replaced by the published files once catalog Phase 1a step 1 lands); without the two flags and with a manifest description of 20 to 140 characters: exit 0, `complete: false`, `missing` equals `["useCase","whenToUse"]`; a manifest description shorter than 20 characters puts `summary` in `missing`; a `--when-to-use` value without the `Use when ` prefix: exit 2; the path and `github` are lower-cased; no `/submit` link; no curator field; plain-text rules on `summary`; a report with errors: exit 1.

### Step 11: Save then import contract test

`test/release-e2e/local.mts` and a `release-checks` job (no secrets, read-only token): scaffold an app with `create-mercato-app@0.9.0` and with `@latest` (`--preset empty --agents none --no-init-git`, as the `create-mercato-module` checks do), add an `@app` module, a declared env key with a comment, and an ignored `.env` with a fake key; commit; `prepare`; `publish` to the shim; serve the bare repos through a loopback API that answers `GET /repos/<o>/<r>` and `GET /repos/<o>/<r>/tarball/<ref>`, the two URLs `ready-apps.ts` builds at v0.9.0 (lines 175 and 179), and run `create-mercato-app --app-url https://github.com/<o>/<r>/tree/<sha> --no-init-git` with `OM_CREATE_APP_GITHUB_API_BASE_URL` pointing at it (honored since 0.9.0, `ready-apps.ts`); then `cp .env.example .env`, install, initialize against a throwaway Postgres container, build, start, and log in as the seeded admin.

Tests: the job is green on both legs; the imported app's `src/modules.ts` inventory equals the source's (acceptance step 4); the imported `.env.example` holds no value that was not stock; the fake key from `.env` appears nowhere in the published repo. When Phase 4 ships, a third leg uses `--template owner/repo`.

### Step 12: First release (human)

Version `0.1.0`, `CHANGELOG.md`, README with the three commands and the sandbox call paths. Wojtek runs the gate and the release checks; Piotr publishes to npm with an explicit yes. Then the [v1 acceptance flow](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md#v1-acceptance-flow) is rehearsed with `--app-url` until Phase 4 ships. Release blocked until the vendored `template-1.json` and `mercato-template-1.json` are the published catalog files (no draft marker) and the `modulesFromModulesTs` contract test runs and passes. Test: `npm view create-mercato-template@0.1.0 version` answers `0.1.0`, and `npx create-mercato-template@0.1.0 --version` prints it on a clean machine.

## Review notes

- Evidence for this draft was read on 2026-10-30: the catalog spec at `open-mercato/modules` main 001fb48; `create-mercato-module` main f83233d (`src/publish.ts`, `src/repository-safety.ts`, `src/common.ts`, `test/release-e2e/`, `.github/workflows/test.yml`); `open-mercato` main a447cc552 and tag v0.9.0 (`packages/create-app/src/lib/ready-apps.ts`, `template/.env.example`, `template/src/modules.ts`, `template/package.json.template`, compose files); npm (`create-mercato-app` dist-tags `latest` 0.9.0, `create-mercato-template` 404, `yaml` 2.9.1, `typescript` latest 7.0.2); GitHub API (the empty repo, gitleaks v8.30.1 and its 222 rules, Strapi's deprecated command).
- `typescript` stays at 6.0.3, the `create-mercato-module` pin, although npm `latest` is 7.0.2. Moving to 7 needs its own check that the compiler API used here still exists.
- Review of 2026-10-30 (spec and repo review against catalog rev 6, om-modules main 001fb48) applied in this revision.
- Second review of 2026-10-30, before the first push, applied too: `main` is pushed before this spec (Step 0); `prepare` stays off the CLI until Step 8; the release waits for the published catalog schemas and the inventory contract test; `--resume` records the remote commit; a failed repo read is exit 4; the prompt refusal, the `publish` rules and the exit 4 shape are in the rule table; the precedence rule, the shim list, the stock table workflow, the commit author and the credential URL hint are corrected.
- The catalog spec puts every `verify` refusal (a changed, added or missing file, `--expect`, report errors) under rule `snapshot-modified`, next to its own `repo-name-exists` and `repo-not-from-snapshot`. This spec keeps that rule and adds a `reason` field rather than new rule names for those refusals. `visibility-mismatch` and `publish-declined` are new rules for refusals the catalog does not name.
- Not done yet: the scope-cohesion review by a fresh-context reviewer that `om-spec-writing` asks for. Run it before Step 1.

### Catalog amendments requested

The header says the catalog spec wins. These points differ from it on purpose and go to the catalog as amendments:

1. The catalog's Phase 2 step 3 test "a stock app with no findings" is read as "no error findings": a stock app always has image and executable-config warnings (evidence above).
2. Only the root `.env.example` is excepted from `**/.env*` and regenerated. A nested `.env.example` is excluded with the warning `nested-env-example`.
3. Q8: a connection URL whose password is only `$NAME` or `${NAME}` is not a credential.
4. Q3: the `when` grammar (`ENV_NAME` and `module:<id>` terms, `!`, ` && `, else `custom`), proposed for the `when` schema in catalog Phase 1a step 1.
5. Check 8 and Q6: the manifest records the Enterprise dependency through the enterprise `modules` entries; a dependency with no registered module is report-only. The computed mark, and a block if D5 becomes "forbidden", key on unconditional enterprise modules.
6. Check 5: compare only the stock `scheme://user:password@` part of a credential URL, so an app that changes only the host, port or database name keeps no false `credential-url`. Until then the tool matches the exact URL string, and the hint names the `${POSTGRES_PASSWORD}` workaround.
