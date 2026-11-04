# Release checks: save then import

The save then import contract test (spec Step 11) saves a real app with this tool and creates a new app from the saved template, the way an author and a user would, with nothing sent to github.com and nothing published to npm. CI runs it on every pull request (the `release-checks` job of the Tests workflow); run it by hand before a release.

## Run it locally

```bash
password="$(openssl rand -hex 24)"
docker run -d --rm --name mercato-template-e2e-db -p 127.0.0.1:54329:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=open-mercato \
  -v "$PWD/test/release-e2e/postgres-init.sql:/docker-entrypoint-initdb.d/00-extensions.sql:ro" \
  pgvector/pgvector:pg17-trixie

npm ci
npm run build
RELEASE_E2E_DATABASE_URL="postgres://postgres:$password@127.0.0.1:54329/open-mercato" \
  npm run test:release:local -- \
  --create-app create-mercato-app@0.9.0 \
  --results /tmp/mercato-template-release-checks

docker rm -f mercato-template-e2e-db
```

Needs Node 24 or newer, Git, Docker for the database, and Yarn through Corepack (`corepack enable`). The database must be on this machine (`127.0.0.1`, `localhost` or `[::1]`, with a port): the checks initialize it from scratch, so never point them at one you use. Pass the URL with `RELEASE_E2E_DATABASE_URL` (or `--database-url`, which shows the password in your shell history). Without a database the run stops after the import checks, before install; with `CI` set, a missing database is an error, so CI never passes without the full app run. Ctrl+C stops every process the run started. `--create-app` takes `create-mercato-app@<version or tag>` (default `@latest`). `--results` must be a new or empty directory; the apps, the snapshot, the bare repository and one sanitized log per stage stay there, with `local-results.json`. App servers and the API stand-in use free loopback ports; set `RELEASE_E2E_PORTS=51210-51239` (any range) to keep them in a range. `RELEASE_E2E_YARN` and `RELEASE_E2E_NPM` choose other executables.

## What a run does

1. Installs the chosen `create-mercato-app` once into the results directory, so the scaffold and the import use the same version.
2. Scaffolds a source app (`--preset empty --agents none --no-init-git`), pins Yarn 4.18.1 (the fix for the registry retry crash of the scaffold's 4.17.1, as in the create-mercato-module checks) and installs it, so its `yarn.lock` is real. Then the author changes: core's `api_keys` module, enabled with `yarn mercato module enable` when the installed core has it and the preset left it out (`yarn initialize` of core 0.9.0 reads its entities; the create-mercato-module checks do the same); an `@app` module `release_template` with an API route for signed-in users, registered in `src/modules.ts`; a declared key `RELEASE_TEMPLATE_GREETING` with a comment and a link in `.env.example`; and an ignored `.env` with a fake `OPENAI_API_KEY`, random for each run and assembled at run time. It commits with a Git configuration of its own.
3. `prepare --json`, then checks the manifest: the `@app` module and the declared key with its description and link.
4. `publish --json --expect <snapshotId>` to the gh shim, then checks the bare repository: one commit, `is_template`, both topics.
5. Checks that the fake key is in no object of the published repository (reachable or not), in no file of the `prepare` output and in no file of the shim.
6. Serves the bare repository through the GitHub API stand-in and runs `create-mercato-app imported-app --app-url https://github.com/<o>/<r>/tree/<sha> --no-init-git` with `OM_CREATE_APP_GITHUB_API_BASE_URL` pointing at it. Then checks: the tarball came from the stand-in with no credential sent; the imported app's `src/modules.ts` inventory, read by this tool's own reader, equals the source's; the imported `.env.example` holds no value that is not stock (for the pinned version, or any known version when the table does not know it), and the declared key is there, empty; the fake key is nowhere in the imported app, which has no `.env`.
7. With a database: `cp .env.example .env`, `yarn install`, `yarn generate` (a template carries no generated files: `.mercato/generated` is git-ignored), `yarn initialize`, `yarn build`, `yarn start`, with new `JWT_SECRET` and `AUTH_SECRET` values (production mode refuses the stock placeholders, so a user sets real ones after the import), then signs in as the seeded admin (password generated per run) and calls the `@app` module's API: refused anonymously, answered for the admin.

## How it stays local

| Real service | Stand-in | Why nothing can leak |
| --- | --- | --- |
| `gh` and the GitHub API it calls for `publish` | `gh-shim.mjs`, first on `PATH` | Answers from bare repositories in the results directory and refuses any other command. Pushes go to the bare repository. |
| The GitHub API `create-mercato-app --app-url` reads | `serveGitHubApi` in `local.mts`, on `127.0.0.1` only | Answers `GET /repos/<o>/<r>` and `GET /repos/<o>/<r>/tarball/<ref>` from the bare repositories (`git archive`), 404 for anything else. A guard preloaded into that process (`NODE_OPTIONS=--import`) refuses every `fetch`, `http.request`/`get` and `https.request`/`get` to another origin, and its proxy settings point at a closed loopback port, so a version that ignored `OM_CREATE_APP_GITHUB_API_BASE_URL` fails instead of reaching api.github.com. |
| npmjs.com | Not replaced: the scaffold and the installs read public packages | Nothing is published: no command of the run publishes, and no npm token reaches it. |

Every command runs without `GH_*`, `GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` or npm auth settings, and with Git's global and system configuration replaced. The CI job has `permissions: contents: read`, no secrets, and runs on `pull_request`, `push` to `main` and `workflow_dispatch` only. Logs are sanitized: the fake key, the database password, the admin password and the generated signing secrets are replaced with `[REDACTED]`.

## Legs

CI runs `create-mercato-app@0.9.0`, the release the stock table and the spec name, and `create-mercato-app@latest`, what a new user gets today. A failure only in the `@latest` leg can be upstream drift; report it, never weaken an assertion. When Phase 4 ships `create-mercato-app --template`, a third leg uses `--template owner/repo`.
