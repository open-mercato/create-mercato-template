# Usage and development guide

> **Status: in development.** Only `--help` and `--version` work today. The planned commands exit with code 2 and change nothing. The design lives in the [Phase 2 spec](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md); where this guide and the spec differ, the spec wins until a command ships.

## Command reference

### `--help`, `--version`

`--help` (or `-h`, or no arguments) prints usage and exits 0. `--version` (or `-v`) prints the tool version and exits 0. `--version` takes no other arguments.

### `prepare [<app>] --out <dir>` (planned)

Builds a reviewed snapshot of one pinned commit of the app. Flags: `--include-uncommitted`, `--allow-file <path>` (repeatable), `--keep-env <KEY>` (repeatable), `--json`. See the spec, [CLI surface](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md#cli-surface).

### `publish --from <dir> --repo <owner/name> (--public | --private)` (planned)

Pushes exactly the snapshot in `<dir>` as a one-commit GitHub template repository. Flags: `--expect <snapshotId>`, `--resume`, `--json`.

### `describe --from <dir>` (planned)

Prints the catalog entry for the published template. Flags: `--repo <owner/name>`, `--use-case <value>`, `--summary <text>`, `--when-to-use <text>`, `--when-not-to-use <text>`, `--json`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | A check failed, the snapshot does not verify, or publication is refused. No remote change. |
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

The implementation is strict TypeScript under `src/`, compiled to `dist/`; the small CommonJS bin only starts the compiled CLI. Tests run with `node --test` against `dist/`. External commands will be replaced with fake executors, local Git repositories or a local `gh` shim; no test touches github.com or npmjs.com.

Work is planned as PR-sized steps in the [Phase 2 spec](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md#implementation-plan). The agent pipeline settings are in `.ai/agentic.config.json`, and the process is in `SDLC.md`.

Contributions are welcome. Keep changes focused, add tests for changed behavior, and include validation results in your pull request.
