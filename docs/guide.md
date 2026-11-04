# Usage and development guide

> **Version 0.1.0.** `--help`, `--version` and the three commands, `prepare`, `publish` and `describe`, work. The package is not on npm yet: until it is, run the commands from GitHub as [Try it before the npm release](#try-it-before-the-npm-release) shows. The examples below use the npm form, `npx create-mercato-template <command>`. The design lives in the [Phase 2 spec](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md).

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
  "tool": { "name": "create-mercato-template", "version": "0.1.0" },
  "failures": [{ "rule": "usage", "message": "describe needs --from <dir>: a prepare output directory. ..." }]
}
```

- `command` is `prepare`, `publish` or `describe`, or `null` when the command line does not start with one (`--json` alone, an unknown command, `--json prepare`). The command always comes first.
- `ok` is true exactly when `exitCode` is 0, and then `failures` is empty.
- Each failure has a `rule`: `usage` (exit 2), `internal` (exit 1, an error the tool did not expect; its message is redacted like command output, email addresses included, and no stack trace is printed), the Git rules below, `io-error`, and for `prepare` every `error` finding of its report (see below). Each command adds its own fields: `prepare` adds `out`, `snapshotId` and `report`; `publish` adds `snapshotId`, `repo`, `commit`, `steps` and `retry`; `describe` adds `path`, `yaml`, `entry`, `complete`, `missing` and `contributing` (see below). No field ever holds a secret, a matched string, an env value or an email address.

Without `--json`, an error prints one message on stderr and nothing on stdout.

### Git

`prepare` and `publish` read or run Git, and check Git first:

| Rule | Exit | When | What to do |
|---|---|---|---|
| `git-missing` | 1 | `git` is not on `PATH`. | Install Git 2.40 or newer. |
| `git-version` | 1 | Git is older than 2.40, or `git --version` prints something the tool cannot read. 2.40 is the first version whose `git check-attr` reads attributes from a commit. | Update Git. |
| `git-unsafe-directory` | 1 | Git refuses the app as "dubious ownership" (the directory belongs to another user). | Check who owns the app. If you trust it, run `git config --global --add safe.directory <app>`. The tool never bypasses this check itself. |

The check runs only `git --version`, with `GIT_OPTIONAL_LOCKS=0`, so it reads nothing from any repository.

### `prepare [<app>] --out <dir>`

Builds a reviewed snapshot of one pinned commit of the app, offline and without running app code: `<out>/tree/` (the files to publish) and `<out>/report.json`. Review both before you publish.

```bash
npx create-mercato-template prepare --out ../my-template
npx create-mercato-template prepare ./my-app --out ../my-template --allow-file seed/demo.sqlite --keep-env APP_URL --json
```

| Flag | Meaning |
|---|---|
| `<app>` | The app directory, the top level of its Git repository. Default: the current directory. |
| `--out <dir>` | Required. A new or empty directory outside the app. |
| `--include-uncommitted` | Export the working tree version of changed and untracked files. They are always listed in `report.uncommitted`. |
| `--allow-file <path>` | Repeatable. Export this opaque file (exact repo-relative path). Recorded in `report.allowFiles`. |
| `--keep-env <KEY>` | Repeatable. Keep the non-stock value of `KEY` in the generated `.env.example`, when the key does not look secret and the value passes the secret scan. Recorded in `report.env.kept`. A value that is not a key name is exit 2. |
| `--json` | Print one envelope on stdout and nothing else (see [`--json`](#--json)). |

Exit 0: the snapshot is written; the report may still hold warnings and notices. Exit 1: an `error` finding (only `report.json` is written, with `snapshotId: null`), a Git problem or `io-error`. Exit 2: a usage problem, decided before any Git read. Without `--json`, `prepare` prints a summary on stdout: the `snapshotId` or the error count, every error and warning with its rule, path, line and hint, the emptied and kept env keys, and the notices; on exit 1 it also prints one error line on stderr. With `--json`, the envelope adds `out` (absolute), `snapshotId` (or `null`) and `report` (the whole `report.json`), and `failures` lists every `error` finding with its `rule`, `path`, `line`, `ruleId` and `message`.

What it does, in order:

- **The app and `--out`, before any Git read (exit 2).** `<app>` (default: the current directory) must be an existing directory. `--out` must not exist, or be an empty directory, and must not be inside the app; a symlink to a missing directory is refused. "Inside" compares the real path of `--out`, or of its nearest existing parent when `--out` does not exist yet, with the real path of the app, so a `--out` reached through a symlink into the app is refused too.
- **Git.** Then the Git check above, then: the app is a Git repository (`not-git-repo`), at the top level of that repository (`app-not-repo-root`), with a commit (`no-commit`). Each is an `error` finding at path `.` with the commands to fix it.
- **One pinned commit.** `HEAD` is pinned once; every later read names that sha. Files come from `git ls-tree` of that commit and their bytes from one `git cat-file --batch`, never from the working tree. Every Git call runs with `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false` and `-c core.hooksPath=/dev/null`, and none converts content, so no monitor, filter or hook configured in the app runs and the app is never written. Lazy fetching, every transport and replace refs are turned off too: a partial clone with missing blobs fails (exit 1) instead of downloading them, and the bytes are always the pinned commit's own.
- **Excluded files.** Files marked `export-ignore` in the commit's `.gitattributes` (directly or through a parent directory, as `git archive` does), and files on the deny list, are left out before anything reads them and listed in `report.excluded` by pattern. Only the root `.env.example` is excepted from `**/.env*`: it is read and regenerated (see the env diff below); a `.env.example` below the root is excluded, with the warning `nested-env-example`. The deny list is the catalog's: `**/.env*`, `/.mercato/*`, `**/node_modules/`, `/.yarn/cache/`, `/.yarn/install-state.gz`, `/public/uploads/`, `/storage/`, `/data/`, `**/*.pem`, `**/.npmrc`, `**/.mcp.json`, `**/.claude/`, `**/.codex/` and the agent state files under `/.cursor/`, `/.agents/skills/` and `/.ai/` (full list in `src/policy/deny.ts`). An entry is anchored at the repository root unless it starts with `**/`, so `/data/` never touches `src/modules/x/data/`.
- **Errors** (no `<out>/tree`): a symlink (`entry-symlink`), a submodule (`entry-submodule`), any other non-regular entry (`entry-special`), a path that is not valid UTF-8 or has a tab, a newline, a backslash, a leading `/` or a `.` or `..` segment (`unsafe-path`), two paths equal when lower-cased (`path-case-collision`), and a Git LFS pointer (`lfs-pointer`).
- **Root checks** (each an `error` unless noted), read from the files of the snapshot only, never from the working tree unless `--include-uncommitted`: no readable root `package.json` (`root-package-json`); `package.json` does not list `@open-mercato/core` under `dependencies` (`root-not-om-app`); the Open Mercato framework monorepo, a `packages/core/package.json` named `@open-mercato/core` (`root-monorepo`); `packageManager` is not `yarn@4.x` (`root-package-manager`); no root `yarn.lock`, or one that is not a Yarn 2+ lockfile (a Yarn 1 file, invalid YAML, YAML aliases, or larger than 16 MB) (`root-yarn-lock`); an `@open-mercato/*` dependency or dev dependency whose `package.json` range has no entry in `yarn.lock`, so a lockfile left out of date by a version bump is caught too (a package that `resolutions` overrides is looked up by name) (`root-om-unresolved`); the resolved framework packages on more than one `major.minor` line (`root-om-mixed-lines`). The framework packages are `@open-mercato/core`, every `@open-mercato/*` package linked to it through the lockfile's dependencies (transitive ones included), and every `@open-mercato/*` package with an entry on core's line; a package released on its own line that no framework package uses, such as `@open-mercato/client`, does not count. A git or URL range is looked up by name, and no finding ever prints a range, since a URL range can hold a credential; a path ending in `.template`, which the template importer refuses (`template-file`). A root `package.json` with `workspaces` is a `warning`, `root-workspaces`: allowed, listed for review. A file left out by `export-ignore` or the deny list is not in the snapshot, so an export-ignored `yarn.lock` is `root-yarn-lock`.
- **Module inventory.** The modules the app registers are read from the snapshot's `src/modules.ts` with the TypeScript parser, statically: no type checking, no app code run. A missing `src/modules.ts`, or one with a syntax error, is an `error`, `modules-ts`. The reader finds the exported array of `{id, from}` entries (`enabledModules` in the scaffold; a missing `from` means `@open-mercato/core`), then follows `push`, `unshift` and `list = [...list, ...]` on it in source order, and a loop over an imported array (`for (const entry of officialModuleEntries)`, read from `src/official-modules.generated.ts` in the snapshot; its dedupe guard keeps the first entry per id). Commented-out entries are not modules. An addition inside an `if` gets a `when`: env flags read through `process.env.NAME` (directly or in a call such as `parseBooleanWithDefault(process.env.NAME, false)`, inline or in a `const`) and `module:<id>` for `list.some((x) => x.id === '<id>')`, each optionally negated with `!`, joined with ` && ` (nested `if`s too; the `else` of a one-term condition negates it). So the scaffold's `storage_s3` gets `OM_ENABLE_STORAGE_S3`, `sso` gets `OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_SSO` and `example_customers_sync` gets `module:example`. Any other condition (`||`, an unknown call) keeps the entry with `when: "custom"`. Anything the reader cannot follow is listed: a helper function the list is passed to, a ternary, a computed `id`, a loop of another shape, an import it cannot read, a file above 2,000,000 bytes or nested too deeply to parse, and any use of the list other than a read. Reads are read-only array methods (`some`, `map`, `filter`, `find` and the like) whose callbacks and results do not change an entry, `length`, `typeof`, `Array.isArray`, `JSON.stringify`, a spread copy, an export, and a `for...of` loop that does not change its entries; `forEach`, a mutating method, an assignment, an alias, a `return` and passing the list on are not. It is listed in `report.modules.unparsed` with its line; each such construct, and each `custom` condition, is a `modules-unparsed` warning with its line. Nothing is dropped silently, there is no entry cap, and no source text is copied into the report. A `from` that is neither `@app` nor an npm package name is a warning, `module-from-unknown`, when it looks like a path or alias (`./modules/x`, `~/x`); any other `from` (a URL, a line break) is never copied into the manifest and the entry is `modules-unparsed`.
- **Module packages.** For an npm `from` other than `@open-mercato/core`, `package` is `<name>@<version>` as `yarn.lock` resolves it: the `package.json` range (`dependencies`, then `devDependencies`) first, else the only lockfile entry for that name. None found is `module-package-unresolved`: an `error` for an unconditional module (the app cannot build), a `warning` for a conditional one (the stock `storage_s3`, whose package the scaffold does not install).
- **Manifest.** `<out>/tree/mercato-template.json` is generated (`origin: "generated"`, `generated: true` in `report.files`) and replaces one from the app: `schema: 1`; `name`, the `package.json` name without its scope when it is a lower-case slug, else the app directory name made into one, with the warning `manifest-name`; `description`, the `package.json` description when it is plain text (no links, markdown, HTML, control characters or long dashes) of at most 350 characters, else left out with the warning `manifest-description`; `openMercato`, the pinned core line as `0.9.x`; `env`, the declared env (below), left out when there is none; `modules`, the inventory in registration order as `{id, from, package?, when?}`; `createdWith {tool, version}`. The schema belongs to the catalog (`mercato-template-1.json`); the tests validate the manifest against a copy of the file the catalog generates.
- **Secret scan** (each an `error`, with no override). Every exported text file is scanned, the generated `.env.example` and `mercato-template.json` included, whatever its extension, and whatever the stock version knowledge. `secret`: a bundled gitleaks rule (see [Secret rules](#secret-rules)) or an extra rule matched; the finding adds `ruleId` and `line`, the line where the match starts, so a multi-line private key is found at its first line. The matcher follows gitleaks v8.30.1 for one file: a rule runs only when the text has one of its keywords (case-insensitive) and, for a rule with a `path`, only on files whose path matches; a rule with only a `path` (`pkcs12-file`) is a finding on any exported file whose path matches, with no line; the secret is the rule's `secretGroup`, or else the first non-empty group; a secret whose Shannon entropy (gitleaks' formula) is at most the rule's `entropy` is dropped; an allowlist tests its regexes on the secret, the match or the line (`regexTarget`) and its stopwords on the secret, and with `condition = "AND"` every part it has, its paths included, must hold; a `generic-api-key` finding is dropped when another rule found a secret on the same line that contains it. A `gitleaks:allow` comment is not honored, and, unlike gitleaks, no decoding pass runs: base64, hex or percent encoded text is not decoded and scanned again. The extra rules (`src/rules/extra.ts`): `openai-api-key-unmarked` (OpenAI `sk-proj-`, `sk-svcacct-` and `sk-admin-` keys without the `T3BlbkFJ` marker that the gitleaks rule needs), `stripe-webhook-secret` (`whsec_`), and the credential pattern of `create-mercato-module` as a floor, one rule per family (`floor-private-key`, `floor-github-token`, `floor-npm-token`, `floor-aws-access-key`, `floor-stripe-live-key`, `floor-slack-token`, `floor-google-api-key`), each with the allowlists of its gitleaks family (so the AWS documentation key ending in `EXAMPLE` passes). An extra rule's finding is dropped when a bundled finding that survived the generic filter is on the same line, so one value gives one finding, never none. `credential-url`: `scheme://user:password@host` with a non-empty password. The userinfo ends at the last `@` before the first `/`, `?` or `#` (outside a `${...}` reference), as a browser reads the URL, so a password may hold a raw `@`, and an `@` in a path or query (`https://registry.npmjs.org/@scope/pkg`, `?to=a@b.com`) is not one; when that part has no `@`, a password with a raw `/`, `?` or `#` (`redis://:abc#123@host`, `postgres://u:a/b@h/db`) runs to the next `@`, unless the text after the `:` reads as a port (digits, `$NAME`, `${...}` or `{...}` placeholders, or the word `port`: `https://x.com:8080/@scope/pkg`, `http://localhost:$PORT/@vite/client`) or the `@` follows a `/`. It is a finding unless the exact URL string is in the stock files of any known `create-mercato-app` version (an app upgraded from 0.8 keeps its 0.8 compose URLs) or the password is only a variable reference, `$NAME` or `${NAME}`; `${NAME:-default}` holds a literal and is a finding. The hint names the workaround for a stock compose URL whose database name was changed: a variable reference with no default, such as `${POSTGRES_PASSWORD}`. `yarn-auth`: `npmAuthToken` or `npmAuthIdent` anywhere in a `.yarnrc.yml`, whatever the value. No finding, message or report field holds the matched text: findings name `rule`, `path`, `line` and `ruleId` only.
- **Opaque files.** A file is text when it decodes as UTF-8 (strictly) and has no NUL byte. A file that is not text is exported only when its extension is an image (`png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`, `icns`) or a font (`woff`, `woff2`, `ttf`, `otf`, `eot`) and its first bytes match that format's signature, so a ZIP named `logo.png` is refused. Archive (`zip`, `tar`, `tgz`, `gz`, `bz2`, `xz`, `7z`, `rar`, `jar`) and database (`sql`, `dump`, `bak`, `sqlite`, `sqlite3`, `db`) extensions are opaque even when the content is text. An opaque file is an `error`, `opaque-file`, unless its exact path is given with `--allow-file`; an allowed file is still scanned for secrets when it holds text: as UTF-8, as UTF-16 when it starts with a byte order mark or when its NUL bytes sit where mostly ASCII UTF-16 has them, or as Latin-1 when it has no NUL byte. Only binary content exported through `--allow-file` is not scanned, and an image or font whose signature matches is exported without a text scan, as the spec says. An `--allow-file` path that is not in the snapshot, or not opaque, is a `warning`, `allow-file-unused`. `report.allowFiles` lists each path with `used`.
- **Env diff and the generated `.env.example`.** The source is the root `.env.example` of the snapshot; `.env` and every other `.env*` file are never read. Each line is blank, a comment, an assignment (`KEY=VALUE`, optional `export `, optional quotes) or a commented assignment (`# KEY=VALUE` with an upper-case key). Anything else is dropped with the warning `env-line-dropped`, and so is every line of a multi-line value (an assignment whose double, single or backtick quote is not closed on its line), up to the line that closes the quote, so no text inside the value is read as a key; a commented line is always one line; a blank line takes its place, so a finding on the generated file names the same line as the source. A value is kept only when it equals a stock value of its key for the app's `create-mercato-app` version (any known version when the version is unknown), or when `--keep-env` names the key, the key does not look secret and the value passes the secret scan. A key looks secret when it has a `SECRET`, `KEY`, `TOKEN` or `PASSWORD` segment (`DOCUMENTS_COLLAB_JWT_SECRET_V2` counts). Every other value is emptied (`KEY=`, or `# KEY=`), and the key is listed in `report.env.emptied`. Comments and blank lines are kept. The generated file (`origin: "generated"`) is scanned like any text, so a secret in a comment stops the snapshot; a value that is emptied, or a line that is dropped, is still checked with the secret rules, and a match is `secret`: the value is in the app's history. Errors: `env-keep-secret` (`--keep-env` on a secret-looking key whose value is not stock), `env-keep-unknown` (`--keep-env` names a key the file lacks); a `--keep-env` value that fails the scan keeps its scan finding and is emptied. With no root `.env.example`, the warning `env-example-missing`, and the stock file of the matched version is written (none for an unknown version). Keys the stock file of the matched version lacks (the newest known version when unknown) are the declared env: each becomes `{name, description?, link?}` in the manifest, with the comment block directly above the key as one line of `description` (at most 240 characters) and its first `https://` URL as `link`; a key with no comment takes them from a `mercato-template.json` in the app, else the warning `env-undocumented`. `report.env` is `{kept, emptied, declared, dropped}`: key names and line numbers, never a value.
- **Review warnings** (never blocking): `image` for every image (an SVG, or a file with an image extension whose content matches it), with sizes in `report.images [{path, size}]`; `executable-config` for `.yarnrc.yml` `yarnPath` or `plugins`, files in `.github/workflows/` and `package.json` scripts that run on install or publish (`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, `postpack`, `prepublish`, `prepublishOnly`, `publish`, `postpublish`); `ai-content` once, with the count of exported files under `.ai/`; `seed-email` for an email address outside `example.com`, `acme.com`, their subdomains and the reserved names (`.test`, `.example`, `.invalid`, `localhost`) in a seed file (`src/modules/<module>/setup.ts`, or any path with `seed` in a directory or file name), by path and line only; `readme-missing` (no root `README.md`) or `readme-stock` (the stock `create-mercato-app` README); `exceeds-import-limits` when the snapshot has more than 5,000 files or 50 MB (the import limits planned for `create-mercato-app --template`). A stock app always has some: its images, its `preinstall` script, no README and the conditional `storage_s3` module.
- **Notices** (never blocking): `code-only`, always; `uncommitted-not-exported`; `stock-unknown` when the Open Mercato version is not in the stock table (values are then matched against every known version); `enterprise-dependency` when `yarn.lock` resolves `@open-mercato/enterprise` or a module comes from it; `derived-from-template` when `package.json` has `openMercatoTemplate` (kept as it is).
- **Uncommitted changes** are always listed in `report.uncommitted` (`modified`, `added`, `deleted`, `untracked`), found without `git status`: each tracked path is compared with the commit by hashing it in JS, the index gives added files, `git ls-files --others --exclude-standard` gives untracked ones (ignored files such as `.env` are never listed or read, and neither are paths on the deny list or marked `export-ignore`; with `--include-uncommitted` those are listed under `excluded`). By default they are not exported, with the notice `uncommitted-not-exported`. With `--include-uncommitted` the worktree version is exported (`origin: "worktree"`) and deleted files leave the snapshot; each file is opened once without following symlinks, and a file under a directory that is a symlink is `entry-symlink`, its content never read.
- **Output.** With no error: `<out>/tree/` (modes `0644` and `0755`) and then `<out>/report.json`. With an error: only `report.json`, with `snapshotId: null`; it still lists `files`. A failed write of `<out>` is exit 1, rule `io-error`, and a partly written `tree/` is removed. `report.json` (schema 1) holds `schema`, `tool {name, version, rules}`, `createdAt`, `source {head, dirty, includeUncommitted}`, `stock {version, known}` (the stock table entry of the pinned core version; `known: false` when the table lacks it), `engines` and `packageManager` (from `package.json`), `files [{path, mode, size, sha256, origin, generated?}]`, `snapshotId`, `findings [{rule, level, path, line?, ruleId?, message?}]`, `notices [{code, detail?}]`, `openMercato {version, line}` (the `@open-mercato/core` that `yarn.lock` pins from the registry, for example `0.9.0` and `0.9`; `null` when core is unresolved, a `link:` or workspace, or an npm alias to another package), `uncommitted`, `excluded [{pattern, paths}]`, `allowFiles [{path, used}]`, `env {kept, emptied, declared, dropped}`, `images [{path, size}]`, `modules {entries: [{id, from, package?, when?, line}], unparsed: [{line, reason}]}`, `enterprise {dependency, modules}` (`dependency`: `yarn.lock` resolves `@open-mercato/enterprise`; `modules`: the registered modules from it, each with its `when`; never blocking) and `totals {files, bytes}`. `tool.rules` names the bundled secret rules (see [Secret rules](#secret-rules)): `source {name, tag, path, sha256}` (gitleaks `v8.30.1`, the sha256 of its `config/gitleaks.toml`), `count` (222) and `skipped [{id, reason}]` (none today).
- **`snapshotId`.** For each file the line `<path>\t<mode>\t<sha256>\n`, sorted by the UTF-8 bytes of the path; `snapshotId` is the lower-case hex sha256 of those lines. Anyone can recompute it from `report.files`.

### `publish --from <dir> --repo <owner/name> (--public | --private)`

Pushes exactly the snapshot in `<dir>` (a `prepare` output) as a one-commit GitHub template repository. It needs Git and the GitHub CLI `gh`, signed in (`gh auth login`). It never reads the source app, and never reads or prints a token: Git asks `gh auth git-credential` for one when it pushes.

```bash
npx create-mercato-template publish --from ../my-template --repo your-name/my-template --public
npx create-mercato-template publish --from ../my-template --repo your-name/my-template --public --expect <snapshotId> --json
```

| Flag | Meaning |
|---|---|
| `--from <dir>` | Required. A `prepare` output directory. Not a directory: exit 2. |
| `--repo <owner/name>` | Required. The GitHub user or organization and the new repository name. A name GitHub would refuse: exit 2. |
| `--public`, `--private` | Exactly one is required. The visibility is never chosen for you. |
| `--expect <snapshotId>` | Publish only this snapshot (64 lower-case hex characters), without the prompt. Required with `--json` and when stdin or stdout is not a terminal (exit 2 otherwise). |
| `--resume` | Continue a publication of this snapshot: the repository must be empty or hold exactly this snapshot's one commit. |
| `--json` | One envelope on stdout, no prompt. |

The steps, in this order:

1. **`verify`** (local). `<dir>` and `<dir>/tree` must not be symlinks. `report.json` must be readable, have no `error` finding and a `snapshotId` that its `files` give, equal to `--expect`. `<dir>/tree` must hold exactly the files of the report, each a regular file (read once, without following symlinks) with the report's size, sha256 and exec bit. These bytes are the ones pushed; nothing is read from disk again. Any difference is exit 1, rule `snapshot-modified`, with `reason`: `file-changed`, `file-added`, `file-missing`, `expect-mismatch`, `report-errors` or `report-missing`. Then the Git check (above).
2. **The prompt**, only without `--expect`, on a terminal: it shows the repository, the visibility, the `snapshotId` and the file and image counts of the verified tree (never read from `report.json`). The default is no. Answering no is exit 1, rule `publish-declined`, nothing remote. There is no `--yes`: use `--expect`.
3. **Auth.** `gh` missing or `gh auth status` failing is exit 3, rule `github-auth`, with the `gh auth login` hint.
4. **Repository state**, one read (`gh api repos/<owner>/<name>`). Only HTTP 404 means missing. Any other failure stops before any change: exit 4, step `create` failed with `detail: "repo-read"`. A repository that exists without `--resume` is exit 1, `repo-name-exists`; with a visibility other than the flag, exit 1, `visibility-mismatch`.
5. **The commit**, built locally before any remote change, in a temporary repository with no hooks: the verified bytes, the report's modes, a tree checked against the snapshot, and one commit with no signature (a `commit.gpgsign` setting never prompts). Author and committer are the signed-in account's noreply address (`<id>+<login>@users.noreply.github.com`), never your Git identity, so a private email address never reaches the repository. Message: `Create template from snapshot <snapshotId>`, a blank line, `Created with create-mercato-template <version>.` No source commit, no history.
6. **`create`**: `gh repo create` with the visibility and the manifest description (when it is one line of at most 350 characters). Skipped when the repository exists.
7. **`push`**: a clone without checkout decides the state. An empty repository gets the one commit on `main`, never force-pushed. A repository with one branch, one commit and the snapshot's tree is skipped, and its commit is recorded. Anything else (another commit, another branch, a tag) is exit 1, `repo-not-from-snapshot`, unchanged, and `publication.json` does not name it. A push refused because the token lacks the `workflow` scope (a snapshot with `.github/workflows/*`) is exit 4 with `detail: "workflow-scope"`: run `gh auth refresh -s workflow`, then `--resume`.
8. **`template-flag`**: marks the repository as a template, checked in GitHub's answer.
9. **`topics`**: adds `open-mercato-template` and `open-mercato`, never replacing other topics.

`<dir>/publication.json` (schema 1: `snapshotId`, `repo {fullName, url, visibility}`, `commit {sha, tree}`, `steps`, `at`) is rewritten after each step; it is not part of the snapshot and never holds a token. With `--json` the envelope adds `snapshotId`, `repo`, `commit`, `steps` (`[{name, status, detail?}]`, `name` in `verify`, `create`, `push`, `template-flag`, `topics`, `status` in `done`, `failed`, `skipped`; the steps after a failure are not listed) and `retry`. A failed GitHub step, a `gh` that times out included, is exit 4, rule `github-step` with `step` and `detail` when known, and `retry` holds the command that continues it. Command output in a message is redacted: tokens and email addresses never appear.

```bash
npx create-mercato-template@<version> publish --from <dir> --repo <owner/name> --<visibility> --expect <snapshotId> --resume
```

`--resume` creates a repository that is still missing, pushes to an empty one, and skips the push when the repository already holds this snapshot. The tool never force-pushes, deletes or rewrites a repository.

### `describe --from <dir>`

Prints the catalog entry for the template, the file `templates/<owner>/<repo>.yml` of [Open Mercato Modules](https://github.com/open-mercato/modules), and the link that says how to add it. It reads `<dir>/report.json`, the manifest `<dir>/tree/mercato-template.json` and `<dir>/publication.json`, and nothing else: no network, no GitHub call, no other program, no write. The output goes to stdout only.

```bash
npx create-mercato-template describe --from ../my-template
npx create-mercato-template describe --from ../my-template --use-case b2b-portal \
  --when-to-use "Use when B2B customers need to request quotes and manage their own accounts." --json
```

| Flag | Meaning |
|---|---|
| `--from <dir>` | Required. A `prepare` output directory. Not a directory: exit 2. |
| `--repo <owner/name>` | The GitHub repository. Needed when `<dir>/publication.json` is missing or names no repository (a `publish` that failed before `create`); exit 2 when neither gives one. Given with a `publication.json` that names another repository: exit 2. Names are compared without case. |
| `--use-case <value>` | One of `crm`, `commerce`, `b2b-portal`, `partner-portal`, `operations`, `field-service`, `internal-tools`, `starter`. Anything else: exit 2. |
| `--summary <text>` | Plain text of 20 to 140 characters. Without it, the manifest description is used when it is plain text of that length. |
| `--when-to-use <text>` | Plain text of 40 to 240 characters that starts with `Use when `. |
| `--when-not-to-use <text>` | Plain text of at most 160 characters. Optional; printed only when given. |
| `--json` | One envelope on stdout. |

Plain text means no links (`https://`, `www.`), markdown (`[`, `]`, `*` at the start of a word, `#` at the start), HTML (`<`, `>`), backticks, control characters (a new line included) or long dashes, the rule of the catalog's descriptors. A text flag that breaks it, has the wrong length, holds an email address or matches the secret scan is exit 2, and the message never repeats the value. Every error message of every command is redacted: an email address or a token typed in a flag or a path is replaced before it is printed. A manifest text with the same problems is left out of the entry.

The entry, in this order: `github` (lower case, as the file path), `useCase`, `summary`, `whenToUse`, `whenNotToUse` when given, `pricing: free`, and `declares.env` with the keys `prepare` declared in the manifest (name, description and link; never a value). Curator fields (`slug`, `status`, `reason`, `featured` and the like), `smoke` and `ref` are never printed. A required value that is missing (`useCase`, `summary`, `whenToUse`, or a usable description of a declared key; or more than 30 declared keys, the catalog's limit) is printed as a YAML comment that says what to pass, the entry is marked incomplete and the command still exits 0. Without `--json` the output is valid YAML: a comment with the file path, the entry, then comments with what is missing and the [CONTRIBUTING link](https://github.com/open-mercato/modules/blob/main/CONTRIBUTING.md#templates). There is no `/submit` link before the catalog's Phase 1b.

```yaml
# templates/acme/b2b-portal.yml
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

With `--json` the envelope adds `path` (`templates/<owner>/<repo>.yml`), `yaml` (the file content), `entry` (the same data as an object), `complete`, `missing` (field names, for example `["useCase","whenToUse"]`) and `contributing` (the URL).

`describe` refuses a snapshot the way `publish`'s `verify` does, for the files it reads: a missing or unreadable `report.json` (`reason: "report-missing"`), a report with an error finding or no `snapshotId` (`report-errors`), and a manifest missing from the report or the tree (`file-missing`) or different from the report (`file-changed`) are exit 1, rule `snapshot-modified`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | A check failed, the snapshot does not verify, or publication is refused. No remote change. Also a missing or too old `git` and unexpected errors (`internal`). One exception: `publish` failing to write `publication.json` (`io-error`) after a GitHub step; the envelope then keeps `retry`. |
| 2 | Usage error. |
| 3 | GitHub auth missing (`gh` not installed or `gh auth status` fails). `publish` only. |
| 4 | A GitHub step failed. The JSON says which steps finished. `publish` only. |

## Try it before the npm release

Requirements:

- Node.js 24 or newer.
- Git 2.40 or newer, for `prepare` and `publish`.
- For `publish`: the GitHub CLI `gh`, signed in (`gh auth login`). A snapshot with `.github/workflows/*` also needs the `workflow` scope (`gh auth refresh -s workflow`).
- The app: an Open Mercato app on Yarn 4, at the top level of a Git repository with at least one commit. `prepare` reads the committed files, so commit your changes first (or pass `--include-uncommitted`).

The package is not on npm yet. Run the commands from the `main` branch of this repository; npm downloads it, installs its build dependencies and compiles it on the first run:

```bash
cd my-app
npx --package github:open-mercato/create-mercato-template create-mercato-template prepare --out ../my-template
# Review ../my-template/report.json and ../my-template/tree.
npx --package github:open-mercato/create-mercato-template create-mercato-template publish --from ../my-template --repo your-name/my-template --public
npx --package github:open-mercato/create-mercato-template create-mercato-template describe --from ../my-template
```

Every flag of this guide works the same way. To pin a commit, write `github:open-mercato/create-mercato-template#<sha>`. A `retry` command printed by a failed `publish` names the npm form (`npx create-mercato-template@<version>`); before the npm release, run it with `--package github:open-mercato/create-mercato-template` instead. After the npm release, use `npx create-mercato-template <command>`.

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

The implementation is strict TypeScript under `src/`, compiled to `dist/`; the small CommonJS bin only starts the compiled CLI. Tests run with `node --test` against `dist/`. Tests that read Git build fixture repositories in a temp directory with `test/helpers/fixture-app.cjs`, which writes a minimal valid Open Mercato app (`package.json` on `@open-mercato/core` with `packageManager: yarn@4.x`, a Yarn 4 `yarn.lock`, `src/modules.ts`, `.env.example`, `README.md`) and runs Git with an isolated configuration. External commands run through `run` or an injected `Executor` (`src/common.ts`, argument arrays, never a shell), so tests replace them with fake executors, a fake `git` on `PATH`, local Git repositories or a local `gh` shim; no test touches github.com or npmjs.com. The `publish` tests run against `test/release-e2e/gh-shim.mjs` (copied from `create-mercato-module`, source in `test/release-e2e/SOURCE.md`), which answers from local bare repositories and logs every mutating call, behind `test/helpers/gh-wrapper.mjs`, which logs every call and can fail one command once. They isolate the user's Git configuration (`HOME`, `GIT_CONFIG_GLOBAL`) and assert that a fake token appears in no output or file.

The module inventory tests read vendored copies of the scaffold's `src/modules.ts` and `src/official-modules.generated.ts` at open-mercato `v0.9.0` and `main` `a447cc552` (`test/fixtures/scaffold/`, byte for byte, refs and sha256 in `SOURCE.md` there), and validate the manifest against `test/fixtures/catalog/mercato-template-1.json`, a copy of the file the catalog generates (source and sha256 in `test/fixtures/catalog/SOURCE.md`). A contract test runs the catalog's `modulesFromModulesTs` fixtures (`test/fixtures/catalog/modules-from-modules-ts/`) and compares the entries and the unparsed constructs with the catalog parser's. A small validator in `test/helpers/json-schema.cjs` (tested in `test/json-schema.test.cjs`) covers the keywords those schemas use, `allOf` with `if` and `then` included, and throws on a keyword it does not know.

### Release checks (save then import)

The release checks save a real app with this tool and create a new app from the saved template, with nothing sent to github.com and nothing published to npm (spec Step 11). CI runs them on every pull request in the `release-checks` job of the Tests workflow, on two legs: `create-mercato-app@0.9.0` and `create-mercato-app@latest`. Run them by hand before a release:

```bash
password="$(openssl rand -hex 24)"
docker run -d --rm --name mercato-template-e2e-db -p 127.0.0.1:54329:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=open-mercato \
  -v "$PWD/test/release-e2e/postgres-init.sql:/docker-entrypoint-initdb.d/00-extensions.sql:ro" \
  pgvector/pgvector:pg17-trixie
npm run build
RELEASE_E2E_DATABASE_URL="postgres://postgres:$password@127.0.0.1:54329/open-mercato" \
  npm run test:release:local -- --create-app create-mercato-app@0.9.0 --results /tmp/mercato-template-release-checks
docker rm -f mercato-template-e2e-db
```

A run scaffolds an app (`--preset empty --agents none --no-init-git`), installs it, adds an `@app` module, a declared env key with a comment and an ignored `.env` with a fake key made for the run, commits, runs `prepare` and `publish` (to the gh shim in `test/release-e2e/gh-shim.mjs`), then runs `create-mercato-app --app-url https://github.com/<o>/<r>/tree/<sha>` against a GitHub API stand-in on `127.0.0.1` (`OM_CREATE_APP_GITHUB_API_BASE_URL`). It checks that the imported app registers the same modules, that its `.env.example` holds only stock values and that the fake key is nowhere in the published repository. With a database (on this machine only; it is initialized from scratch) it then installs, generates, initializes, builds and starts the imported app and signs in as the seeded admin. Requirements, options and how each stand-in keeps the run local: [`test/release-e2e/README.md`](../test/release-e2e/README.md). The fast unit tests of its offline parts are in `test/release-local.test.cjs`.

### Stock table

The tool recognizes the values a fresh `create-mercato-app` scaffold ships with, so a stock app does not fail its own checks. `src/stock/table.json` holds, for every stable `create-mercato-app` version on npm (0.4.5 to 0.9.0 today; prereleases such as `-canary-` and `-develop.` are skipped): the stock `.env.example` (identical files stored once, by sha256), each key with its stock values, active and commented, every credential URL string (`scheme://user:password@host`) in any text file of the scaffold, and the sha256 of a stock root `README.md` when there is one. `src/stock.ts` looks entries up by the app's pinned `@open-mercato/core` version, which releases in lockstep with `create-mercato-app`. An unknown version (newer than the tool, or a prerelease) is matched against every known version and reported as `known: false`; no check changes because of it. `prepare` uses it for the env diff, the credential URLs and the README check.

The table is generated and committed, never edited by hand:

```bash
npm run stock-table             # add the stable versions the table lacks, then commit src/stock/table.json
npm run stock-table -- --check  # only list them; exit 1 when one is missing
```

The script (`scripts/build-stock-table.mts`, not shipped) is incremental: it runs `npm view create-mercato-app versions --json`, downloads only the missing versions with `npm pack <spec> --pack-destination <tmp> --json` and unpacks them with the system `tar`, all with argument arrays. It writes plain ASCII JSON in a fixed order; a test fails when the committed file is not in that format, and another checks the 0.9.0 entry against a copy taken by hand. The weekly `Stock table` workflow (`.github/workflows/stock-table.yml`, also started by hand) runs the `--check` form and fails when npm has a stable version the table lacks; it never runs on pull requests. A maintainer then runs the script, commits the table and releases a patch.

### Secret rules

The secret scan (see `prepare` above) uses the default rules of [gitleaks](https://github.com/gitleaks/gitleaks), converted for offline use in JavaScript. `src/rules/gitleaks.json` holds the 222 rules of gitleaks `v8.30.1`, converted from its `config/gitleaks.toml` (pinned by tag and by sha256). Each rule keeps `id`, `regex`, `secretGroup`, `entropy`, `keywords`, its `path` filter (five rules, for example `pkcs12-file`, which has only a path) and its allowlists with `regexes`, `regexTarget` (`secret`, `match` or `line`), `stopwords` and `condition`. An allowlist keeps its `paths` only under `condition = "AND"`, where they narrow it; allowlists with only paths, and the global allowlist (which exempts `node_modules/`, lockfiles and images, among others), are dropped, so every exported file is scanned.

Patterns are Go RE2 syntax and are translated, never passed through: a leading `(?i)` becomes the `i` flag, `(?i)` inside a pattern and `(?i:...)` or `(?-i:...)` become JavaScript modifier groups (Node 24), `\z` becomes `$(?![\s\S])`, `(?P<name>` becomes `(?<name>`, a POSIX class such as `[[:alnum:]]` becomes its ASCII ranges, a `]` first in a class is escaped, `\s` and `\S` are spelled out as RE2's `[\t\n\f\r ]` (JavaScript's own `\s` also matches `\v` and Unicode spaces such as U+00A0), and each dot follows RE2's meaning: `[\s\S]` inside a `(?s` group, `[^\n]` elsewhere (a plain JavaScript dot also stops at `\r`). Any other construct, such as `\p{...}`, a lookaround, the `m` flag or a class range that ends in a set (`[a-\d]`), fails the conversion. Two differences remain, and no v8.30.1 rule depends on them because its config is plain ASCII. JavaScript without the `u` flag works on UTF-16 units, and its `i` flag does not fold K with U+212A, or s with U+017F.

The file is generated and committed, never edited by hand:

```bash
npm run secret-rules                 # fetch the pinned config, convert it, write src/rules/gitleaks.json
npm run secret-rules -- --check      # convert and compare; exit 1 when the committed file differs
npm run secret-rules -- --input <f>  # read a local copy of the config instead of fetching it
```

The script (`scripts/build-secret-rules.mts`, not shipped) fetches only the pinned URL, refuses a file whose sha256 is not the pinned one, and reads TOML with a small strict reader for the subset gitleaks uses, so no TOML parser is a dependency. It fails on any rule it cannot convert, unless `scripts/secret-rules-skipped.json` lists the id with a reason (and it fails when a listed rule converts, so no rule stays out silently after an upgrade) (`[{"id": "...", "reason": "..."}]`, empty today; the skipped ids and reasons are copied into the rules file and `report.tool.rules`), and it fails when any of these ids is missing: `private-key`, `aws-access-token`, `github-pat`, `github-fine-grained-pat`, `github-oauth`, `github-app-token`, `github-refresh-token`, `npm-access-token`, `openai-api-key`, `stripe-access-token`, `slack-bot-token`, `slack-user-token`, `slack-app-token`, `slack-webhook-url`. Its output is plain ASCII JSON in a fixed order. The tests read a vendored copy of the config (`test/fixtures/gitleaks/`, sha256 in `SOURCE.md`) and fail when the committed file is not exactly its conversion. To move to a new gitleaks tag, a maintainer updates the tag and sha256 in the script and the fixture together, runs the script and commits the result.

Work is planned as PR-sized steps in the [Phase 2 spec](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md#implementation-plan). The agent pipeline settings are in `.ai/agentic.config.json`, and the process is in `SDLC.md`.

Contributions are welcome. Keep changes focused, add tests for changed behavior, and include validation results in your pull request.
