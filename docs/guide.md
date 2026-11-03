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

A flag that takes a value always takes the next argument, even when it starts with `-`. Write the value as a separate argument: `--out dir`, not `--out=dir`. Required flags and the checks on flag values (for example the `--use-case` list) come with each command.

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

- `command` is `prepare`, `publish` or `describe`, or `null` when the command line names none (`--json` alone, an unknown command).
- `ok` is true exactly when `exitCode` is 0, and then `failures` is empty.
- Each failure has a `rule`. Today the rules are `usage` (exit 2), `internal` (exit 1, an error the tool did not expect; its message is redacted like command output, and no stack trace is printed) and the Git rules below. Each command adds its own fields when it ships.

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

The implementation is strict TypeScript under `src/`, compiled to `dist/`; the small CommonJS bin only starts the compiled CLI. Tests run with `node --test` against `dist/`. External commands run through `run` or an injected `Executor` (`src/common.ts`, argument arrays, never a shell), so tests replace them with fake executors, a fake `git` on `PATH`, local Git repositories or a local `gh` shim; no test touches github.com or npmjs.com.

Work is planned as PR-sized steps in the [Phase 2 spec](https://github.com/open-mercato/create-mercato-template/blob/main/.ai/specs/2026-10-30-create-mercato-template.md#implementation-plan). The agent pipeline settings are in `.ai/agentic.config.json`, and the process is in `SDLC.md`.

Contributions are welcome. Keep changes focused, add tests for changed behavior, and include validation results in your pull request.
