# Code review rules

Repository-specific rules, applied by `om-code-review` in addition to its built-in checklist. This tool reads other people's apps and pushes them to GitHub with their credentials, often as public repositories, so safety outranks convenience.

## Priorities

1. **Nothing remote happens before `verify` passes.** `publish` checks `<out>` against `report.json` and `--expect` first, then GitHub auth, then any remote step. Nothing goes out without an explicit `--public` or `--private`.
2. **No secret leaves the machine.** The scan covers every exported text file, the generated `.env.example` and `mercato-template.json` included. Findings, logs, `report.json`, `publication.json` and `--json` output never contain a matched value, an env value, a token or an email address.
3. **The source app is never written.** `prepare` reads Git data of one pinned commit and writes only `<out>`. No Git command that writes (`add`, `stash`, `commit`, an index refresh) runs on the source app.
4. **Partial publication is resumable.** Steps run in the documented order, `publication.json` is rewritten after each step, and the JSON says which steps finished. A repository is never force-pushed, deleted or rewritten.

## Repository-specific checks

- External commands go through `run` or an injected `Executor` with an argument array. No `shell: true`, no string concatenation into a command.
- Every value interpolated into a command, path or generated file is validated first: repository owner and name, topics, refs, repo-relative paths (`unsafe-path`).
- A failed check on auth, repository state or the snapshot stops the run; it never falls through to "assume it is fine".
- Network commands whose output is captured keep the default timeout.
- Exit codes follow the contract: 1 checks, 2 usage, 3 GitHub auth, 4 a GitHub step. A change that maps a failure to a different code is a breaking change.
- `rule` values in findings are part of the JSON contract; new rules are additive.
- Generated data (`src/stock/table.json`, `src/rules/gitleaks.json`) changes only through its script, with the pinned source version in the PR body.
- Behavior changes ship with a test in `test/*.test.cjs` that fails without them. Publication paths are tested with fake executors, local bare repositories or the `gh` shim, never real GitHub.
- User-facing errors say what happened, what was or was not changed, and what to do next.

## Severity

- **blocker**: a remote change before `verify` or without explicit visibility, secret exposure in any output or file, a write to the source app, a failing validation command, a breaking change to a surface in `BACKWARD_COMPATIBILITY.md` without its required path.
- **major**: correctness bug on a realistic path, missing test for changed behavior, a failure that leaves a repository or `<out>` in a state `--resume` cannot recover from.
- **minor / nit**: conventions, wording, polish.
