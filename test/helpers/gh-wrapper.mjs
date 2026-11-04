#!/usr/bin/env node
// Test-only front of the gh shim (test/release-e2e/gh-shim.mjs), so the shim
// keeps only the extensions spec Step 9 lists. It does two things:
// - appends every call, reads included, to <RELEASE_E2E_GITHUB_ROOT>/calls.log
//   (one JSON array per line), so a test can assert that no remote call
//   happened at all;
// - with GH_WRAPPER_FAIL_ONCE set to the start of a command line (for example
//   "repo create"), fails the first matching call with a GitHub-like error and
//   a marker file, then hands every later call to the shim. With
//   GH_WRAPPER_LEAK=1 that error also carries the GH_TOKEN value and an email
//   address, as a careless tool might print them, to test the redaction.
//   (The address is assembled here, at run time.)
// Never reaches github.com: everything else runs the shim.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = process.env.RELEASE_E2E_GITHUB_ROOT
const args = process.argv.slice(2)
if (!root || !path.isAbsolute(root)) {
  process.stderr.write('gh wrapper: RELEASE_E2E_GITHUB_ROOT must be an absolute directory\n')
  process.exit(1)
}
fs.appendFileSync(path.join(root, 'calls.log'), `${JSON.stringify(args)}\n`)

const failOnce = process.env.GH_WRAPPER_FAIL_ONCE
const marker = path.join(root, 'fail-once.done')
if (failOnce && args.join(' ').startsWith(failOnce) && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, failOnce)
  const leak = process.env.GH_WRAPPER_LEAK === '1' ? ` token=${process.env.GH_TOKEN} for ${['jane.doe', 'corp-mail.net'].join('@')}` : ''
  process.stderr.write(`gh: Something went wrong${leak} (HTTP 502)\n`)
  process.exit(1)
}

const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'release-e2e', 'gh-shim.mjs')
const result = spawnSync(process.execPath, [shim, ...args], { stdio: 'inherit' })
process.exit(result.status ?? 1)
