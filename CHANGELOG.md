# Changelog

## Unreleased

### Fixed

- The secret scan no longer slows down on large single-line text (#9). A 1 MB hex string with every vendor keyword took 134 s; it now takes 0.26 s, and every 1 MB input measured, the worst cases constructed for the scan included, takes under 1.5 s. The scan finds the same matches as before: each rule is tried only near the literal parts every match holds, and a rule whose cost cannot be proven linear runs capped with a counted work limit, never a clock. The bound and the benchmark (`npm run bench:secret-scan`) are in the guide, under Scan cost.
- New error `scan-limit`: a secret rule that cannot run within its fixed limits on a file (a run of more than 4,096 repeated characters where it could match, or more work than its limit) stops `prepare` with exit 1, `ruleId` and the line. The file is refused, never exported unscanned. Five rules can raise it: `curl-auth-header`, `curl-auth-user`, `kubernetes-secret-yaml`, `nuget-config-password` and `private-key`.

## 0.1.0

First release. It needs Node.js 24 or newer and Git 2.40 or newer; `publish` also needs the GitHub CLI `gh`, signed in. The app must be a Git repository with at least one commit.

### Commands

- `prepare [<app>] --out <dir>` builds a reviewed snapshot of one pinned commit of an Open Mercato app, offline and without running app code: `<out>/tree` and `<out>/report.json` with a `snapshotId`. Flags: `--include-uncommitted`, `--allow-file <path>` and `--keep-env <KEY>` (both repeatable), `--json`. Exit 0 with the tree and the report, or 1 with only `report.json` when a check fails. Without `--json` it prints a summary of the errors, warnings and notices.
- `publish --from <dir> --repo <owner/name> (--public | --private)` pushes exactly that snapshot as a one-commit GitHub template repository. It checks `<dir>` against its `report.json` first (`snapshot-modified`, nothing remote), asks for approval on a terminal unless `--expect <snapshotId>` is given, checks `gh auth status` (exit 3) and reads the repository once. It builds the commit locally (author and committer: the account's noreply address, never signed), then creates the repository, pushes to `main` (never forced), marks it as a template and adds the `open-mercato-template` and `open-mercato` topics. `<dir>/publication.json` is rewritten after each step. A failed GitHub step is exit 4 with a `retry` command; `--resume` continues on a missing, empty or matching repository and refuses any other. No token is read or printed.
- `describe --from <dir>` prints the catalog entry `templates/<owner>/<repo>.yml` for Open Mercato Modules and the CONTRIBUTING link, with `--repo`, `--use-case`, `--summary`, `--when-to-use` and `--when-not-to-use`. A missing required value is printed as a YAML comment, and the entry is marked incomplete (`complete: false`, `missing`) with exit 0. It reads only `<dir>`: no network, no GitHub call, no write.
- Every command takes `--json`: exactly one JSON object on stdout (schema 1: `schema`, `command`, `ok`, `exitCode`, `tool`, `failures` and the command's fields), also for usage errors, and no prompts. Exit codes: 0 done, 1 a check failed, 2 usage error, 3 GitHub auth missing, 4 a GitHub step failed. `--help` and `--version` work. Error messages are redacted, so an email address or a token typed in a flag or a path is never printed.

### What `prepare` checks

- Snapshot: `HEAD` is pinned once and every file is read from that commit, never from the working tree unless `--include-uncommitted`. No Git hook, file system monitor or filter of the app runs, and the app is never written. `export-ignore` files and the catalog deny list (`.env*` files, `node_modules/`, `/data/`, agent state and more) are left out before they are read. Symlinks, submodules, unsafe paths, paths that differ only in case and Git LFS pointers are refused. `--out` must not be inside the app, judged by real paths. Uncommitted changes are always listed.
- Root checks: an Open Mercato app on Yarn 4, a `yarn.lock` that resolves every `@open-mercato/*` dependency and is up to date with `package.json`, framework packages on one `major.minor` line, not the framework monorepo, no file ending in `.template`.
- Module inventory: the modules the app registers, read from `src/modules.ts` with the TypeScript parser, with their `when` conditions and the `package` version that `yarn.lock` resolves. A construct the reader cannot follow is a `modules-unparsed` warning with its line, never dropped. The result goes into a generated `mercato-template.json` (`name`, `description`, `openMercato`, `env`, `modules`, `createdWith`).
- Secret scan of every exported text file with the 222 default rules of gitleaks v8.30.1, bundled and converted for JavaScript, and extra rules; connection URLs with a literal password (`credential-url`) and `.yarnrc.yml` auth (`yarn-auth`). A match is an error with no override. Opaque files are refused unless `--allow-file` names them. No finding or report field holds a matched value.
- `.env.example` is regenerated: a value is kept only when it is a stock value of the app's `create-mercato-app` version, or when `--keep-env` names a key that does not look secret; every other value is emptied. Keys the stock file lacks are declared in the manifest with their description and link. `.env` is never read.
- Review warnings (images, executable config, `.ai/` content, seed email addresses, README, import limits) and notices, never blocking.

### Catalog and release checks

- The tests validate the manifest and the `describe` YAML against the catalog's `mercato-template-1.json` and `template-1.json`, copied from what the catalog generates, and run the catalog's `modulesFromModulesTs` fixtures against the module inventory. The JSON Schema helper of the tests knows `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`, local `$ref` and the other common keywords.
- Release checks, `npm run test:release:local` and the `release-checks` CI job: save a fresh `create-mercato-app` app with `prepare` and `publish` (to a local `gh` shim), create a new app from it with `create-mercato-app --app-url`, then install, build, start and sign in. Nothing reaches github.com and nothing is published to npm.
- Maintainer scripts `npm run stock-table` and `npm run secret-rules` (not shipped) refresh the stock table of `create-mercato-app` versions and the bundled gitleaks rules. A weekly workflow reports a stable `create-mercato-app` version the stock table lacks.
