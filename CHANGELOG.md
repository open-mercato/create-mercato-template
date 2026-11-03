# Changelog

## Unreleased

- New CLI skeleton: `--help` and `--version` work. `prepare`, `publish` and `describe` exit with code 2 and say they are not implemented yet, so scripts can rely on the exit codes from the start.
- New argument parser (spec Step 1): every flag of the three commands is known. An unknown command or flag, a flag on the wrong command, a missing value, a repeated flag (except `--allow-file` and `--keep-env`) and both `--public` and `--private` exit 2. `--help` and `-h` win over every other problem, but never count as a flag value (`describe --summary --help`). `--version` works only on its own.
- New `--json` output: with a command, stdout carries exactly one JSON object (schema 1: `schema`, `command`, `ok`, `exitCode`, `tool`, `failures`), also for usage errors and unexpected errors (rule `internal`, exit 1, no stack trace).
- New Git check for the commands that read Git: Git 2.40 or newer (`git-version`), `git` on `PATH` (`git-missing`) and Git's "dubious ownership" refusal (`git-unsafe-directory`), each exit 1 with a hint.
- New stock table (spec Step 2): `src/stock/table.json` records, for every stable `create-mercato-app` version from 0.4.5 to 0.9.0, the stock `.env.example`, each key's stock values, the credential URLs of the scaffold files and the stock README hash. Lookups by the pinned `@open-mercato/core` version; an unknown version matches any known version and reports `known: false`. The commands start using it in later steps.
- New maintainer script `npm run stock-table` (`scripts/build-stock-table.mts`, not shipped) adds the missing stable versions from npm; `--check` only lists them. A weekly `Stock table` workflow fails when npm has a stable version the table lacks; it never runs on pull requests.
