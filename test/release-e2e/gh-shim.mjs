#!/usr/bin/env node
// Stand-in for the GitHub CLI during local release checks. It answers the few
// commands the tool runs from bare repositories under RELEASE_E2E_GITHUB_ROOT
// and refuses everything else, so no request can reach github.com.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.env.RELEASE_E2E_GITHUB_ROOT
const args = process.argv.slice(2)

// create-mercato-template extension: every mutating call is appended to
// <RELEASE_E2E_GITHUB_ROOT>/mutations.log, one JSON array of its arguments per
// line, before it runs, so a test can assert that nothing remote was changed.
function logMutation() {
  fs.appendFileSync(path.join(root, 'mutations.log'), `${JSON.stringify(args)}\n`)
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function repository(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name ?? '')) fail(`gh shim: invalid repository ${name}`)
  return path.join(root, `${name}.git`)
}

function git(gitArgs, cwd) {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) fail('gh shim: RELEASE_E2E_GITHUB_ROOT must be an existing absolute directory')

if (args[0] === 'auth' && args[1] === 'status') process.exit(0)

if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write(JSON.stringify({ login: 'release-checks', id: 1 }))
  process.exit(0)
}

const contents = args[0] === 'api' ? /^repos\/([^/]+\/[^/]+)\/contents\/package\.json(?:\?ref=([0-9a-f]{40}))?$/.exec(args[1] ?? '') : null
if (contents) {
  const directory = repository(contents[1])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  const file = git(['show', `${contents[2] ?? 'main'}:package.json`], directory)
  if (file.status !== 0) fail('gh: Not Found (HTTP 404)')
  process.stdout.write(file.stdout)
  process.exit(0)
}

// gh api --method POST repos/<owner>/<repo>/git/refs -f ref=refs/tags/<tag> -f sha=<commit>
const refs = args[0] === 'api' && args[1] === '--method' && args[2] === 'POST' ? /^repos\/([^/]+\/[^/]+)\/git\/refs$/.exec(args[3] ?? '') : null
if (refs) {
  logMutation()
  const directory = repository(refs[1])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  const fields = Object.fromEntries(args.slice(4).filter((_, index) => index % 2 === 1).map((field) => field.split(/=(.*)/s).slice(0, 2)))
  if (args.length !== 8 || !/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fields.ref ?? '') || !/^[0-9a-f]{40}$/.test(fields.sha ?? '')) fail(`gh shim: unsupported ref request ${args.join(' ')}`)
  if (git(['rev-parse', '--verify', '--quiet', fields.ref], directory).status === 0) fail('gh: Reference already exists (HTTP 422)')
  const created = git(['update-ref', fields.ref, fields.sha, '0'.repeat(40)], directory)
  if (created.status !== 0) fail(`gh: Object does not exist (HTTP 422)\n${created.stderr}`)
  process.stdout.write(JSON.stringify({ ref: fields.ref, object: { sha: fields.sha } }))
  process.exit(0)
}

// create-mercato-template extension:
// gh api --method PATCH repos/<owner>/<repo> -F is_template=true
const patch = args[0] === 'api' && args[1] === '--method' && args[2] === 'PATCH' ? /^repos\/([^/]+\/[^/]+)$/.exec(args[3] ?? '') : null
if (patch) {
  logMutation()
  const directory = repository(patch[1])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  if (args.length !== 6 || args[4] !== '-F' || args[5] !== 'is_template=true') fail(`gh shim: unsupported repository update ${args.join(' ')}`)
  const details = JSON.parse(fs.readFileSync(`${directory}.json`, 'utf8'))
  const updated = { ...details, is_template: true }
  fs.writeFileSync(`${directory}.json`, JSON.stringify(updated))
  process.stdout.write(JSON.stringify({ full_name: patch[1], private: updated.private, visibility: updated.private ? 'private' : 'public', is_template: true, default_branch: 'main' }))
  process.exit(0)
}

const api = args[0] === 'api' ?/^repos\/([^/]+\/[^/]+)(?:\/commits\/(.+))?$/.exec(args[1] ?? '') : null
if (api) {
  const directory = repository(api[1])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  if (!api[2]) {
    const details = JSON.parse(fs.readFileSync(`${directory}.json`, 'utf8'))
    // create-mercato-template extension: `visibility`, as GitHub answers it.
    process.stdout.write(JSON.stringify({ private: details.private, visibility: details.private ? 'private' : 'public', default_branch: 'main' }))
    process.exit(0)
  }
  const ref = decodeURIComponent(api[2])
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) fail(`gh shim: invalid ref ${ref}`)
  const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], directory)
  if (sha.status !== 0) fail('gh: Git Repository is empty. (HTTP 409)')
  const message = git(['log', '-1', '--format=%B', sha.stdout.trim()], directory).stdout.replace(/\n+$/, '')
  const jq = args[args.indexOf('--jq') + 1]
  if (!args.includes('--jq')) process.stdout.write(JSON.stringify({ sha: sha.stdout.trim(), commit: { message } }))
  else if (jq === '.sha') process.stdout.write(`${sha.stdout.trim()}\n`)
  else if (jq === '[.sha, .commit.message] | @json') process.stdout.write(`${JSON.stringify([sha.stdout.trim(), message])}\n`)
  else fail(`gh shim: unsupported --jq ${jq}`)
  process.exit(0)
}

if (args[0] === 'repo' && args[1] === 'create') {
  logMutation()
  const directory = repository(args[2])
  if (fs.existsSync(directory)) fail('gh shim: repository already exists')
  if (!args.includes('--public') && !args.includes('--private')) fail('gh shim: repo create needs --public or --private')
  fs.mkdirSync(path.dirname(directory), { recursive: true })
  const created = git(['init', '--bare', '--initial-branch=main', directory], root)
  if (created.status !== 0) fail(created.stderr)
  fs.writeFileSync(`${directory}.json`, JSON.stringify({ private: args.includes('--private') }))
  process.exit(0)
}

// gh repo edit <owner>/<repo> --add-topic <topic> [--add-topic <topic>...]
if (args[0] === 'repo' && args[1] === 'edit') {
  logMutation()
  const directory = repository(args[2])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  const options = args.slice(3)
  if (!options.length || options.length % 2 || options.some((value, index) => index % 2 === 0 ? value !== '--add-topic' : !/^[a-z0-9][a-z0-9-]{0,49}$/.test(value))) fail(`gh shim: unsupported repo edit ${args.join(' ')}`)
  const details = JSON.parse(fs.readFileSync(`${directory}.json`, 'utf8'))
  const topics = [...new Set([...(details.topics ?? []), ...options.filter((_, index) => index % 2 === 1)])]
  fs.writeFileSync(`${directory}.json`, JSON.stringify({ ...details, topics }))
  process.exit(0)
}

if (args[0] === 'repo' && args[1] === 'clone' && args[3]) {
  const directory = repository(args[2])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  const cloned = git(['clone', directory, args[3]], process.cwd())
  if (cloned.status === 0) {
    // Keep GitHub identity for validation; route pushes to the local bare repo.
    git(['remote', 'set-url', 'origin', `https://github.com/${args[2]}.git`], args[3])
    git(['remote', 'set-url', '--push', 'origin', directory], args[3])
  }
  process.stderr.write(cloned.stderr)
  process.exit(cloned.status ?? 1)
}

fail(`gh shim: refusing unsupported command: gh ${args.join(' ')}`)
