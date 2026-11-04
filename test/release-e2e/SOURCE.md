# Source of `gh-shim.mjs`

`gh-shim.mjs` is copied from `open-mercato/create-mercato-module`, branch `main`, commit `5b7849cca6a3cd6207bdcf836ff285344afc1dd7`, file `test/release-e2e/gh-shim.mjs` (sha256 of the unchanged copy: `07fae39421756f3574f66b6af438354ce61d8f8b4403fd7696a8465385e773ba`). It is copied, not imported (spec, "Market references").

It stands in for the GitHub CLI: it answers from bare repositories under `RELEASE_E2E_GITHUB_ROOT` and refuses every other command, so no request reaches github.com.

Extended only with what spec Step 9 lists, each change marked `create-mercato-template extension` in the file:

1. `gh api --method PATCH repos/<owner>/<repo> -F is_template=true`: sets `is_template` in the repository's details and answers it.
2. A `visibility` field (`public` or `private`) in the `gh api repos/<owner>/<repo>` answer.
3. A log of every mutating call (`repo create`, `repo edit`, `api --method POST .../git/refs`, `api --method PATCH`): one JSON array of the arguments per line in `<RELEASE_E2E_GITHUB_ROOT>/mutations.log`, written before the call runs.

Pushes do not go through the shim: `gh repo clone` routes the clone's push URL to the bare repository, as upstream does.

# Sources of the save then import release checks (spec Step 11)

`local.mts`, `postgres-init.sql`, `README.md` and the `release-checks` job in `.github/workflows/test.yml` are modeled on the local release checks of `open-mercato/create-mercato-module`, branch `main`, commit `5b7849cca6a3cd6207bdcf836ff285344afc1dd7`: `test/release-e2e/local.mts`, `test/release-e2e/run.mts`, `test/release-e2e/postgres-init.sql`, `test/release-e2e/README.md` and the `release-checks` job of `.github/workflows/test.yml`. Copied, not imported:

- `postgres-init.sql`: unchanged.
- `freePort` and `redact` (from `run.mts`): copied; `redact` also removes the credentials of a `postgres://` URL.
- The command runner with sanitized per-stage logs, `local-results.json`, the full-app run (start the app detached, wait for `/login`, sign in as the seeded admin with `POST /api/auth/login`, call the module API anonymously and signed in, stop the process group) and the Yarn 4.18.1 pin (`pinFixtureYarn`): adapted.
- The job: the two legs (`create-mercato-app@0.9.0` and `@latest`), the pinned `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` and `pgvector/pgvector` digests. Not taken: the Verdaccio registry (this tool publishes nothing to npm) and the fixed Postgres password (one is generated per run).

New here: the GitHub API stand-in (`serveGitHubApi`) that answers the two URLs `packages/create-app/src/lib/ready-apps.ts` builds at open-mercato `v0.9.0` (lines 175 and 179, through `OM_CREATE_APP_GITHUB_API_BASE_URL`), the fetch guard preloaded into the import, and the save then import assertions.
