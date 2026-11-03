# Usage and development guide

> **Status: in development.** `--help`, `--version` and the argument checks work today. The planned commands check their arguments, then exit with code 2 and change nothing. The design lives in the [Phase 2 spec](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md); where this guide and the spec differ, the spec wins until a command ships.

## Command reference

### `--help`, `--version`

`--help` (or `-h`, or no arguments) prints usage and exits 0. It counts wherever a flag is expected and wins over every other problem on the command line, so `prepare --bogus -h` prints help. It never counts as the value of a flag: `describe --summary --help` uses `--help` as the summary. Help is plain text, even with `--json`.

`--version` (or `-v`) prints the tool version and exits 0. It works only on its own; `prepare --version` or `--version prepare` is a usage error (exit 2).

### Arguments

Every command checks its arguments before it does anything else. A usage error exits 2 and changes nothing:

- an unknown command or an unknown flag;
- a flag given to a command that does not take it (`prepare --repo acme/app`);
- a flag without its value (`publish --from`);
- a flag given twice, except `--allow-file` and `--keep-env`, which repeat;
- both `--public` and `--private`;
- a second app directory for `prepare`, or any positional argument for `publish` and `describe`.

A flag that takes a value always takes the next argument, even when it starts with `-`. Write the value as a separate argument: `--out dir`, not `--out=dir`. The end-of-options marker `--` is not supported; write an app directory that starts with `-` as `./<name>`. Required flags and the checks on flag values (for example the `--use-case` list) come with each command.

### `--json`

With `--json` after a command, stdout carries exactly one JSON object and nothing else, also for a usage error, and the tool never prompts. Errors do not go to stderr. Every command prints this envelope (schema 1):

```json
{
  "schema": 1,
  "command": "prepare",
  "ok": false,
  "exitCode": 2,
  "tool": { "name": "create-mercato-template", "version": "0.0.0" },
  "failures": [{ "rule": "usage", "message": "prepare is not implemented yet. ..." }]
}
```

- `command` is `prepare`, `publish` or `describe`, or `null` when the command line does not start with one (`--json` alone, an unknown command, `--json prepare`). The command always comes first.
- `ok` is true exactly when `exitCode` is 0, and then `failures` is empty.
- Each failure has a `rule`. Today the rules are `usage` (exit 2), `internal` (exit 1, an error the tool did not expect; its message is redacted like command output, email addresses included, and no stack trace is printed) and the Git rules below. Each command adds its own fields when it ships.

Without `--json`, an error prints one message on stderr and nothing on stdout.

### Git

`prepare` and `publish` read Git when they ship, and check Git first:

| Rule | Exit | When | What to do |
|---|---|---|---|
| `git-missing` | 1 | `git` is not on `PATH`. | Install Git 2.40 or newer. |
| `git-version` | 1 | Git is older than 2.40, or `git --version` prints something the tool cannot read. 2.40 is the first version whose `git check-attr` reads attributes from a commit. | Update Git. |
| `git-unsafe-directory` | 1 | Git refuses the app as "dubious ownership" (the directory belongs to another user). | Check who owns the app. If you trust it, run `git config --global --add safe.directory <app>`. The tool never bypasses this check itself. |

The check runs only `git --version`, with `GIT_OPTIONAL_LOCKS=0`, so it reads nothing from any repository.

### `prepare [<app>] --out <dir>` (planned)

Builds a reviewed snapshot of one pinned commit of the app. Flags: `--include-uncommitted`, `--allow-file <path>` (repeatable), `--keep-env <KEY>` (repeatable), `--json`. See the spec, [CLI surface](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md#cli-surface).

The command still exits 2 "not implemented yet" and writes nothing. Its snapshot core, root checks, module inventory and manifest are built and tested behind an internal entry point, `prepare()` in `dist/prepare.js`, which is not a supported API; the command is wired to it, with every check, in spec Step 8. Until then the entry point adds the notice `checks-incomplete` and excludes the root `.env.example`. What the entry point does today:

- **The app and `--out`, before any Git read (exit 2).** `<app>` (default: the current directory) must be an existing directory. `--out` must not exist, or be an empty directory, and must not be inside the app; a symlink to a missing directory is refused. "Inside" compares the real path of `--out`, or of its nearest existing parent when `--out` does not exist yet, with the real path of the app, so a `--out` reached through a symlink into the app is refused too.
- **Git.** Then the Git check above, then: the app is a Git repository (`not-git-repo`), at the top level of that repository (`app-not-repo-root`), with a commit (`no-commit`). Each is an `error` finding at path `.` with the commands to fix it.
- **One pinned commit.** `HEAD` is pinned once; every later read names that sha. Files come from `git ls-tree` of that commit and their bytes from one `git cat-file --batch`, never from the working tree. Every Git call runs with `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false` and `-c core.hooksPath=/dev/null`, and none converts content, so no monitor, filter or hook configured in the app runs and the app is never written. Lazy fetching, every transport and replace refs are turned off too: a partial clone with missing blobs fails (exit 1) instead of downloading them, and the bytes are always the pinned commit's own.
- **Excluded files.** Files marked `export-ignore` in the commit's `.gitattributes` (directly or through a parent directory, as `git archive` does), and files on the deny list, are left out before anything reads them and listed in `report.excluded` by pattern. The deny list is the catalog's: `**/.env*`, `/.mercato/*`, `**/node_modules/`, `/.yarn/cache/`, `/.yarn/install-state.gz`, `/public/uploads/`, `/storage/`, `/data/`, `**/*.pem`, `**/.npmrc`, `**/.mcp.json`, `**/.claude/`, `**/.codex/` and the agent state files under `/.cursor/`, `/.agents/skills/` and `/.ai/` (full list in `src/policy/deny.ts`). An entry is anchored at the repository root unless it starts with `**/`, so `/data/` never touches `src/modules/x/data/`.
- **Errors** (no `<out>/tree`): a symlink (`entry-symlink`), a submodule (`entry-submodule`), any other non-regular entry (`entry-special`), a path that is not valid UTF-8 or has a tab, a newline, a backslash, a leading `/` or a `.` or `..` segment (`unsafe-path`), two paths equal when lower-cased (`path-case-collision`), and a Git LFS pointer (`lfs-pointer`).
- **Root checks** (each an `error` unless noted), read from the files of the snapshot only, never from the working tree unless `--include-uncommitted`: no readable root `package.json` (`root-package-json`); `package.json` does not list `@open-mercato/core` under `dependencies` (`root-not-om-app`); the Open Mercato framework monorepo, a `packages/core/package.json` named `@open-mercato/core` (`root-monorepo`); `packageManager` is not `yarn@4.x` (`root-package-manager`); no root `yarn.lock`, or one that is not a Yarn 2+ lockfile (a Yarn 1 file, invalid YAML, YAML aliases, or larger than 16 MB) (`root-yarn-lock`); an `@open-mercato/*` dependency or dev dependency whose `package.json` range has no entry in `yarn.lock`, so a lockfile left out of date by a version bump is caught too (a package that `resolutions` overrides is looked up by name) (`root-om-unresolved`); the resolved framework packages on more than one `major.minor` line (`root-om-mixed-lines`). The framework packages are `@open-mercato/core`, every `@open-mercato/*` package linked to it through the lockfile's dependencies (transitive ones included), and every `@open-mercato/*` package with an entry on core's line; a package released on its own line that no framework package uses, such as `@open-mercato/client`, does not count. A git or URL range is looked up by name, and no finding ever prints a range, since a URL range can hold a credential; a path ending in `.template`, which the template importer refuses (`template-file`). A root `package.json` with `workspaces` is a `warning`, `root-workspaces`: allowed, listed for review. A file left out by `export-ignore` or the deny list is not in the snapshot, so an export-ignored `yarn.lock` is `root-yarn-lock`.
- **Module inventory.** The modules the app registers are read from the snapshot's `src/modules.ts` with the TypeScript parser, statically: no type checking, no app code run. A missing `src/modules.ts`, or one with a syntax error, is an `error`, `modules-ts`. The reader finds the exported array of `{id, from}` entries (`enabledModules` in the scaffold; a missing `from` means `@open-mercato/core`), then follows `push`, `unshift` and `list = [...list, ...]` on it in source order, and a loop over an imported array (`for (const entry of officialModuleEntries)`, read from `src/official-modules.generated.ts` in the snapshot; its dedupe guard keeps the first entry per id). Commented-out entries are not modules. An addition inside an `if` gets a `when`: env flags read through `process.env.NAME` (directly or in a call such as `parseBooleanWithDefault(process.env.NAME, false)`, inline or in a `const`) and `module:<id>` for `list.some((x) => x.id === '<id>')`, each optionally negated with `!`, joined with ` && ` (nested `if`s too; the `else` of a one-term condition negates it). So the scaffold's `storage_s3` gets `OM_ENABLE_STORAGE_S3`, `sso` gets `OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_SSO` and `example_customers_sync` gets `module:example`. Any other condition (`||`, an unknown call) keeps the entry with `when: "custom"`. Anything the reader cannot follow is listed: a helper function the list is passed to, a ternary, a computed `id`, a loop of another shape, an import it cannot read, a file above 2,000,000 bytes or nested too deeply to parse, and any use of the list other than a read. Reads are read-only array methods (`some`, `map`, `filter`, `find` and the like) whose callbacks and results do not change an entry, `length`, `typeof`, `Array.isArray`, `JSON.stringify`, a spread copy, an export, and a `for...of` loop that does not change its entries; `forEach`, a mutating method, an assignment, an alias, a `return` and passing the list on are not. It is listed in `report.modules.unparsed` with its line; each such construct, and each `custom` condition, is a `modules-unparsed` warning with its line. Nothing is dropped silently, there is no entry cap, and no source text is copied into the report. A `from` that is neither `@app` nor an npm package name is a warning, `module-from-unknown`, when it looks like a path or alias (`./modules/x`, `~/x`); any other `from` (a URL, a line break) is never copied into the manifest and the entry is `modules-unparsed`.
- **Module packages.** For an npm `from` other than `@open-mercato/core`, `package` is `<name>@<version>` as `yarn.lock` resolves it: the `package.json` range (`dependencies`, then `devDependencies`) first, else the only lockfile entry for that name. None found is `module-package-unresolved`: an `error` for an unconditional module (the app cannot build), a `warning` for a conditional one (the stock `storage_s3`, whose package the scaffold does not install).
- **Manifest.** `<out>/tree/mercato-template.json` is generated (`origin: "generated"`, `generated: true` in `report.files`) and replaces one from the app: `schema: 1`; `name`, the `package.json` name without its scope when it is a lower-case slug, else the app directory name made into one, with the warning `manifest-name`; `description`, the `package.json` description when it is plain text (no links, markdown, HTML, control characters or long dashes) of at most 350 characters, else left out with the warning `manifest-description`; `openMercato`, the pinned core line as `0.9.x`; `modules`, the inventory in registration order as `{id, from, package?, when?}`; `createdWith {tool, version}`. The declared `env` comes with spec Step 8. The schema belongs to the catalog (`mercato-template-1.json`); the tests validate the manifest against a vendored copy, a draft until the catalog publishes the file.
- **Uncommitted changes** are always listed in `report.uncommitted` (`modified`, `added`, `deleted`, `untracked`), found without `git status`: each tracked path is compared with the commit by hashing it in JS, the index gives added files, `git ls-files --others --exclude-standard` gives untracked ones (ignored files such as `.env` are never listed or read, and neither are paths on the deny list or marked `export-ignore`; with `--include-uncommitted` those are listed under `excluded`). By default they are not exported, with the notice `uncommitted-not-exported`. With `--include-uncommitted` the worktree version is exported (`origin: "worktree"`) and deleted files leave the snapshot; each file is opened once without following symlinks, and a file under a directory that is a symlink is `entry-symlink`, its content never read.
- **Output.** With no error: `<out>/tree/` (modes `0644` and `0755`) and then `<out>/report.json`. With an error: only `report.json`, with `snapshotId: null`; it still lists `files`. A failed write of `<out>` is exit 1, rule `io-error`, and a partly written `tree/` is removed. `report.json` (schema 1) holds today `schema`, `tool`, `createdAt`, `source {head, dirty, includeUncommitted}`, `stock {version, known}` (the stock table entry of the pinned core version; `known: false` when the table lacks it), `engines` and `packageManager` (from `package.json`), `files [{path, mode, size, sha256, origin, generated?}]`, `snapshotId`, `findings [{rule, level, path, line?, message?}]`, `notices` (always `code-only`), `openMercato {version, line}` (the `@open-mercato/core` that `yarn.lock` pins from the registry, for example `0.9.0` and `0.9`; `null` when core is unresolved, a `link:` or workspace, or an npm alias to another package), `uncommitted`, `excluded [{pattern, paths}]`, `modules {entries: [{id, from, package?, when?, line}], unparsed: [{line, reason}]}`, `enterprise {dependency, modules}` (`dependency`: `yarn.lock` resolves `@open-mercato/enterprise`; `modules`: the registered modules from it, each with its `when`; never blocking) and `totals {files, bytes}`; later steps add the other fields.
- **`snapshotId`.** For each file the line `<path>\t<mode>\t<sha256>\n`, sorted by the UTF-8 bytes of the path; `snapshotId` is the lower-case hex sha256 of those lines. Anyone can recompute it from `report.files`.

### `publish --from <dir> --repo <owner/name> (--public | --private)` (planned)

Pushes exactly the snapshot in `<dir>` as a one-commit GitHub template repository. Flags: `--expect <snapshotId>`, `--resume`, `--json`.

### `describe --from <dir>` (planned)

Prints the catalog entry for the published template. Flags: `--repo <owner/name>`, `--use-case <value>`, `--summary <text>`, `--when-to-use <text>`, `--when-not-to-use <text>`, `--json`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | A check failed, the snapshot does not verify, or publication is refused. No remote change. Also a missing or too old `git` and unexpected errors (`internal`). |
| 2 | Usage error. Today also: the command is not implemented yet. |
| 3 | GitHub auth missing (`gh` not installed or `gh auth status` fails). `publish` only. |
| 4 | A GitHub step failed. The JSON says which steps finished. `publish` only. |

## Try the GitHub version

Run directly from this repository:

```bash
npx --package github:open-mercato/create-mercato-template create-mercato-template --help
```

## Development

```bash
git clone https://github.com/open-mercato/create-mercato-template.git
cd create-mercato-template
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

The implementation is strict TypeScript under `src/`, compiled to `dist/`; the small CommonJS bin only starts the compiled CLI. Tests run with `node --test` against `dist/`. Tests that read Git build fixture repositories in a temp directory with `test/helpers/fixture-app.cjs`, which writes a minimal valid Open Mercato app (`package.json` on `@open-mercato/core` with `packageManager: yarn@4.x`, a Yarn 4 `yarn.lock`, `src/modules.ts`, `.env.example`) and runs Git with an isolated configuration. External commands run through `run` or an injected `Executor` (`src/common.ts`, argument arrays, never a shell), so tests replace them with fake executors, a fake `git` on `PATH`, local Git repositories or a local `gh` shim; no test touches github.com or npmjs.com.

The module inventory tests read vendored copies of the scaffold's `src/modules.ts` and `src/official-modules.generated.ts` at open-mercato `v0.9.0` and `main` `a447cc552` (`test/fixtures/scaffold/`, byte for byte, refs and sha256 in `SOURCE.md` there), and validate the manifest against `test/fixtures/catalog/mercato-template-1.json`, a draft written from the catalog spec until the catalog publishes its schema. A small validator in `test/helpers/json-schema.cjs` covers the keywords those schemas use.

### Stock table

The tool recognizes the values a fresh `create-mercato-app` scaffold ships with, so a stock app does not fail its own checks. `src/stock/table.json` holds, for every stable `create-mercato-app` version on npm (0.4.5 to 0.9.0 today; prereleases such as `-canary-` and `-develop.` are skipped): the stock `.env.example` (identical files stored once, by sha256), each key with its stock values, active and commented, every credential URL string (`scheme://user:password@host`) in any text file of the scaffold, and the sha256 of a stock root `README.md` when there is one. `src/stock.ts` looks entries up by the app's pinned `@open-mercato/core` version, which releases in lockstep with `create-mercato-app`. An unknown version (newer than the tool, or a prerelease) is matched against every known version and reported as `known: false`; no check changes because of it. The commands use the table from the steps that ship them.

The table is generated and committed, never edited by hand:

```bash
npm run stock-table             # add the stable versions the table lacks, then commit src/stock/table.json
npm run stock-table -- --check  # only list them; exit 1 when one is missing
```

The script (`scripts/build-stock-table.mts`, not shipped) is incremental: it runs `npm view create-mercato-app versions --json`, downloads only the missing versions with `npm pack <spec> --pack-destination <tmp> --json` and unpacks them with the system `tar`, all with argument arrays. It writes plain ASCII JSON in a fixed order; a test fails when the committed file is not in that format, and another checks the 0.9.0 entry against a copy taken by hand. The weekly `Stock table` workflow (`.github/workflows/stock-table.yml`, also started by hand) runs the `--check` form and fails when npm has a stable version the table lacks; it never runs on pull requests. A maintainer then runs the script, commits the table and releases a patch.

Work is planned as PR-sized steps in the [Phase 2 spec](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md#implementation-plan). The agent pipeline settings are in `.ai/agentic.config.json`, and the process is in `SDLC.md`.

Contributions are welcome. Keep changes focused, add tests for changed behavior, and include validation results in your pull request.
