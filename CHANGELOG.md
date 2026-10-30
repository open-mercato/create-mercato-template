# Changelog

## Unreleased

- New CLI skeleton: `--help` and `--version` work. `prepare`, `publish` and `describe` exit with code 2 and say they are not implemented yet, so scripts can rely on the exit codes from the start. `--json` is not accepted yet; it comes with the argument parser (spec Step 1).
