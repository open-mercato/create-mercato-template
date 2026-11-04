# Source of `gh-shim.mjs`

`gh-shim.mjs` is copied from `open-mercato/create-mercato-module`, branch `main`, commit `5b7849cca6a3cd6207bdcf836ff285344afc1dd7`, file `test/release-e2e/gh-shim.mjs` (sha256 of the unchanged copy: `07fae39421756f3574f66b6af438354ce61d8f8b4403fd7696a8465385e773ba`). It is copied, not imported (spec, "Market references").

It stands in for the GitHub CLI: it answers from bare repositories under `RELEASE_E2E_GITHUB_ROOT` and refuses every other command, so no request reaches github.com.

Extended only with what spec Step 9 lists, each change marked `create-mercato-template extension` in the file:

1. `gh api --method PATCH repos/<owner>/<repo> -F is_template=true`: sets `is_template` in the repository's details and answers it.
2. A `visibility` field (`public` or `private`) in the `gh api repos/<owner>/<repo>` answer.
3. A log of every mutating call (`repo create`, `repo edit`, `api --method POST .../git/refs`, `api --method PATCH`): one JSON array of the arguments per line in `<RELEASE_E2E_GITHUB_ROOT>/mutations.log`, written before the call runs.

Pushes do not go through the shim: `gh repo clone` routes the clone's push URL to the bare repository, as upstream does.
