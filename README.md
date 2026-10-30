<p align="center"><img src="https://raw.githubusercontent.com/open-mercato/create-mercato-template/main/.github/readme/open-mercato.svg" alt="Open Mercato logo" width="72" /></p>

<h1 align="center">Create Mercato Template</h1>

<p align="center"><strong>Build an app. Share it as a template.</strong></p>

<p align="center">Save an Open Mercato app as a clean GitHub template repository.<br />One reviewed snapshot, one commit, no history and no secrets.</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A524-1b1b1b" alt="Node.js 24 or newer" /></a>
  <a href="https://github.com/open-mercato/create-mercato-template/actions/workflows/test.yml"><img src="https://github.com/open-mercato/create-mercato-template/actions/workflows/test.yml/badge.svg" alt="Tests" /></a>
  <a href="https://github.com/open-mercato/create-mercato-template/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-bc9aff" alt="MIT license" /></a>
</p>

> **Status: in development.** Nothing is published to npm yet. Today the CLI only answers `--help` and `--version`. `prepare`, `publish` and `describe` exit with code 2 and say they are not implemented yet. The commands below describe the planned behavior.

```bash
npx create-mercato-template prepare --out ../my-template
# Review ../my-template/report.json and ../my-template/tree.
npx create-mercato-template publish --from ../my-template --repo your-name/my-template --public
```

<p align="center"><a href="#what-it-will-do">What it will do</a> · <a href="#what-is-and-is-not-saved">What is saved</a> · <a href="#in-an-open-mercato-cloud-sandbox">Cloud sandboxes</a> · <a href="#specifications">Specs</a> · <a href="docs/guide.md">Guide</a> · <a href="https://docs.openmercato.com/">Docs</a> · <a href="https://discord.gg/f4qwPtJ3qA">Discord</a></p>

## What it will do

1. **`prepare`** reads one pinned commit of your app as Git data, offline, and without running app code. It applies a file policy and a secret scan, regenerates `.env.example`, and writes `mercato-template.json` with the app's module list. The result is `<out>/tree` plus `<out>/report.json` with a `snapshotId`.
2. **You review** `report.json`: errors, warnings, emptied env keys, images, modules and uncommitted files.
3. **`publish`** checks that `<out>` still matches the report, then pushes exactly that snapshot as a one-commit GitHub repository. It marks the repository as a template and adds the `open-mercato-template` and `open-mercato` topics. Visibility is always explicit (`--public` or `--private`). A failed step can be continued with `--resume`.
4. **`describe`** prints the catalog entry (YAML) to list the template in [Open Mercato Modules](https://github.com/open-mercato/modules).
5. **Create an app from it** with `npx create-mercato-app my-app --app-url https://github.com/your-name/my-template`, and later with `--template`.

Every command takes `--json` for scripts and agents: one JSON object on stdout, no prompts, and stable exit codes (0 done, 1 a check failed, 2 usage error, 3 GitHub auth missing, 4 a GitHub step failed).

## What is and is not saved

A template is code only. It holds the committed files of your app at one commit. It never holds your database, uploaded files, `.env` files, Git history or registry credentials. A file that looks like a secret stops `prepare`; you move the value to `.env` and commit again.

## In an Open Mercato Cloud sandbox

The sandbox will call `prepare --json` and then either push `<out>/tree` with its own GitHub integration, or run `publish --json --expect <snapshotId>` where `gh` is signed in. No platform credential is passed to the tool.

## Specifications

| Topic | Document |
|---|---|
| Templates in the catalog (parent spec, revision 6) | [open-mercato/modules: docs/specs/2026-10-29-templates.md](https://github.com/open-mercato/modules/blob/main/docs/specs/2026-10-29-templates.md) |
| This tool (Phase 2 of the parent spec) | [.ai/specs/2026-10-30-create-mercato-template.md](.ai/specs/2026-10-30-create-mercato-template.md) |
| Usage and development | [docs/guide.md](docs/guide.md) |

---

Part of [Open Mercato](https://github.com/open-mercato/open-mercato). [Website](https://openmercato.com/) · [Framework docs](https://docs.openmercato.com/) · [Cloud](https://openmercatocloud.com/) · [Discord](https://discord.gg/f4qwPtJ3qA)

MIT © Open Mercato contributors. See [LICENSE](LICENSE).
