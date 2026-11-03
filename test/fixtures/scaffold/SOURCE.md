# Scaffold fixtures

Byte-for-byte copies of two files of the `create-mercato-app` scaffold, `packages/create-app/template/src/` in `open-mercato/open-mercato`, at the two refs the spec names (Step 5). `test/inventory.test.cjs` reads them; no test fetches them.

| Directory | Ref | Commit | File | sha256 |
| --- | --- | --- | --- | --- |
| `v0.9.0/src/` | tag `v0.9.0` | `f451ce4c390087f90d5314e002e9d009d5339e08` | `modules.ts` | `b98091f35d5cff232e30237ff65db8c1bbd006ebda1ca9196704cf2ecdb9ca6e` |
| `v0.9.0/src/` | tag `v0.9.0` | `f451ce4c390087f90d5314e002e9d009d5339e08` | `official-modules.generated.ts` | `be970d128cfe516c0cf66f7c39262c4681e6cb09a857124a9925aa95cb4881cf` |
| `a447cc552/src/` | `main` at `a447cc552` | `a447cc5525c4fef153dee021cead1f3899984f3b` | `modules.ts` | `21ae8f38bb0309daebffcd4dc0e14a25a6138c0140cbf5d7f33437efc1730721` |
| `a447cc552/src/` | `main` at `a447cc552` | `a447cc5525c4fef153dee021cead1f3899984f3b` | `official-modules.generated.ts` | `be970d128cfe516c0cf66f7c39262c4681e6cb09a857124a9925aa95cb4881cf` |

Fetched on 2026-11-03 with `gh api -H "Accept: application/vnd.github.raw" repos/open-mercato/open-mercato/contents/packages/create-app/template/src/<file>?ref=<commit>`. A test checks the sha256 values above, so an edit fails it.

The files are kept exactly as upstream wrote them: they hold non-ASCII characters (long dashes in comments) and are not linted (`eslint.config.mjs` ignores `test/fixtures/scaffold/`). Do not reformat them; refresh them only by copying a new ref and updating this table.
