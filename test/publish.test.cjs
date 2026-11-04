// Spec Step 9: publish, through bin/cli.cjs and the publish() entry point.
// Every GitHub call goes to the gh shim (test/release-e2e/gh-shim.mjs) behind
// a test wrapper (test/helpers/gh-wrapper.mjs) that logs every call and can
// fail one command once; repositories are local bare repositories in a temp
// directory. The user's Git configuration is isolated (HOME,
// GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM). A fake token, assembled at test
// time, is set as GH_TOKEN and GITHUB_TOKEN and must appear nowhere. No test
// touches github.com.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const packageJson = require('../package.json')
const { prepare } = require('../dist/prepare.js')
const { publish, parseRepo, commitMessage, retryCommand } = require('../dist/publish.js')
const { createFixtureRepo, tempDir } = require('./helpers/fixture-app.cjs')

const bin = path.join(__dirname, '..', 'bin', 'cli.cjs')
const wrapper = path.join(__dirname, 'helpers', 'gh-wrapper.mjs')
const fakeToken = ['ghp', 'Zq8Xw2Lm4Np6Rt0Vb3Cd5Fg7Hj9Kk1Ss2Uu'].join('_')
const noreply = '1+release-checks@users.noreply.github.com'
const envelopeKeys = ['command', 'commit', 'exitCode', 'failures', 'ok', 'repo', 'retry', 'schema', 'snapshotId', 'steps', 'tool']

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return result
}

/**
 * A GitHub stand-in: a root for the bare repositories, a bin directory whose
 * `gh` runs the wrapper, and an isolated HOME with its own Git config.
 */
function world({ gitConfig = '' } = {}) {
  const root = tempDir('cmt-gh-')
  const binDir = tempDir('cmt-bin-')
  const home = tempDir('cmt-home-')
  const gh = path.join(binDir, 'gh')
  fs.writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${wrapper}" "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.gitconfig'), gitConfig)
  const base = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_') && !/TOKEN/.test(key)) base[key] = value
  const env = {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    RELEASE_E2E_GITHUB_ROOT: root,
    GH_TOKEN: fakeToken,
    GITHUB_TOKEN: fakeToken,
  }
  return { root, binDir, home, env, bare: (repo) => path.join(root, `${repo}.git`) }
}

function readLog(w, name) {
  const file = path.join(w.root, name)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function clearLogs(w) {
  for (const name of ['calls.log', 'mutations.log']) fs.rmSync(path.join(w.root, name), { force: true })
}

/** A prepared snapshot of the fixture app plus `files`; returns `{out, snapshotId}`. */
function prepared(files = {}) {
  const app = createFixtureRepo(files)
  const out = path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out })
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures))
  return { out, snapshotId: result.snapshotId }
}

function cli(w, args, extraEnv = {}) {
  const result = sh(process.execPath, [bin, ...args], { env: { ...w.env, ...extraEnv } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function publishJson(w, snapshot, repo, extra = [], extraEnv = {}) {
  const result = cli(w, ['publish', '--from', snapshot.out, '--repo', repo, '--public', '--expect', snapshot.snapshotId, ...extra, '--json'], extraEnv)
  assert.equal(result.stderr, '')
  const value = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(value).sort(), envelopeKeys)
  assert.equal(value.schema, 1)
  assert.equal(value.command, 'publish')
  assert.deepEqual(value.tool, { name: 'create-mercato-template', version: packageJson.version })
  assert.equal(value.exitCode, result.status)
  assert.equal(value.ok, result.status === 0)
  assertNoToken(w, snapshot, [result.stdout, result.stderr])
  return { status: result.status, value }
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/** The fake token is in no output, no file of `<out>` or of the shim root, and no commit. */
function assertNoToken(w, snapshot, texts) {
  for (const text of texts) assert.equal(text.includes(fakeToken), false, 'the token appears in the output')
  for (const file of [...filesUnder(snapshot.out), ...filesUnder(w.root)])
    assert.equal(fs.readFileSync(file).includes(fakeToken), false, `the token appears in ${file}`)
  for (const directory of fs.existsSync(w.root) ? filesUnder(w.root).filter((file) => file.endsWith('/HEAD') && !file.includes('/refs/')).map(path.dirname) : []) {
    const log = sh('git', ['--git-dir', directory, 'log', '--all', '--format=%an %ae %cn %ce %B'], { env: w.env })
    assert.equal(log.stdout.includes(fakeToken), false, 'the token appears in a commit')
  }
}

function git(w, directory, args) {
  const result = sh('git', ['--git-dir', directory, ...args], { env: w.env })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** The tree of `<out>/tree` computed independently: `git add` in a fresh repository. */
function independentTree(w, out) {
  const work = tempDir('cmt-tree-')
  fs.cpSync(path.join(out, 'tree'), work, { recursive: true })
  const options = { cwd: work, env: w.env }
  sh('git', ['init', '-q', '--template='], options)
  assert.equal(sh('git', ['-c', 'core.autocrlf=false', '-c', 'core.filemode=true', 'add', '-A'], options).status, 0)
  return sh('git', ['write-tree'], options).stdout.trim()
}

function details(w, repo) {
  return JSON.parse(fs.readFileSync(`${w.bare(repo)}.json`, 'utf8'))
}

function stepList(value) {
  return value.steps.map((step) => (step.detail ? `${step.name}:${step.status}:${step.detail}` : `${step.name}:${step.status}`))
}

/** Creates a repository through the shim itself, as if someone made it before. */
function shimCreate(w, repo, visibility = '--public') {
  assert.equal(sh(process.execPath, [wrapper, 'repo', 'create', repo, visibility], { env: w.env }).status, 0)
  clearLogs(w)
}

const workflowHook = `#!/bin/sh
echo "refusing to allow an OAuth App to create or update workflow \\\`.github/workflows/ci.yml\\\` without \\\`workflow\\\` scope" >&2
exit 1
`

const rejectOnceHook = `#!/bin/sh
echo "protected branch hook declined" >&2
rm -f "$0"
exit 1
`

/** A Git template directory whose pre-receive hook the shim's `git init --bare` copies. */
function hookTemplate(script) {
  const template = tempDir('cmt-template-')
  fs.mkdirSync(path.join(template, 'hooks'))
  fs.writeFileSync(path.join(template, 'hooks', 'pre-receive'), script, { mode: 0o755 })
  return template
}

test('a full publish to the shim: one commit, the message, is_template, both topics, the tree computed locally', () => {
  const w = world()
  const snapshot = prepared()
  const { status, value } = publishJson(w, snapshot, 'acme/shop-template')
  assert.equal(status, 0, JSON.stringify(value.failures))
  assert.deepEqual(value.failures, [])
  assert.equal(value.snapshotId, snapshot.snapshotId)
  assert.deepEqual(value.repo, { fullName: 'acme/shop-template', url: 'https://github.com/acme/shop-template', visibility: 'public' })
  assert.deepEqual(stepList(value), ['verify:done', 'create:done', 'push:done', 'template-flag:done', 'topics:done'])
  assert.equal(value.retry, null)

  const bare = w.bare('acme/shop-template')
  assert.equal(git(w, bare, ['rev-list', '--count', 'main']), '1')
  assert.equal(git(w, bare, ['rev-parse', 'main']), value.commit.sha)
  assert.equal(git(w, bare, ['rev-parse', 'main^{tree}']), value.commit.tree)
  assert.equal(value.commit.tree, independentTree(w, snapshot.out))
  assert.equal(`${git(w, bare, ['log', '-1', '--format=%B', 'main'])}\n`, commitMessage(snapshot.snapshotId, packageJson.version))
  assert.equal(git(w, bare, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main']), `release-checks <${noreply}>|release-checks <${noreply}>`)
  assert.equal(git(w, bare, ['for-each-ref', '--format=%(refname)']), 'refs/heads/main')

  const repo = details(w, 'acme/shop-template')
  assert.equal(repo.is_template, true)
  assert.equal(repo.private, false)
  assert.deepEqual(repo.topics, ['open-mercato-template', 'open-mercato'])
  assert.deepEqual(
    readLog(w, 'mutations.log').map((args) => args.slice(0, 3).join(' ')),
    ['repo create acme/shop-template', 'api --method PATCH', 'repo edit acme/shop-template'],
  )
  assert.ok(readLog(w, 'mutations.log')[0].includes('--public'))

  const publication = JSON.parse(fs.readFileSync(path.join(snapshot.out, 'publication.json'), 'utf8'))
  assert.deepEqual(Object.keys(publication).sort(), ['at', 'commit', 'repo', 'schema', 'snapshotId', 'steps'])
  assert.equal(publication.schema, 1)
  assert.deepEqual(publication.commit, value.commit)
  assert.deepEqual(publication.repo, value.repo)
  assert.deepEqual(publication.steps, value.steps)
})

test('without --json: a summary on stdout, nothing on stderr', () => {
  const w = world()
  const snapshot = prepared()
  const result = cli(w, ['publish', '--from', snapshot.out, '--repo', 'acme/plain', '--private', '--expect', snapshot.snapshotId])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^Published https:\/\/github\.com\/acme\/plain \(private\) from snapshot [0-9a-f]{64}\.\nSteps:\n/)
  assert.match(result.stdout, /topics +done/)
  assert.equal(details(w, 'acme/plain').private, true)
  assertNoToken(w, snapshot, [result.stdout])
})

test('a name clash: exit 1, repo-name-exists, no mutating call', () => {
  const w = world()
  const snapshot = prepared()
  shimCreate(w, 'acme/taken')
  const { status, value } = publishJson(w, snapshot, 'acme/taken')
  assert.equal(status, 1)
  assert.equal(value.failures[0].rule, 'repo-name-exists')
  assert.deepEqual(stepList(value), ['verify:done'])
  assert.deepEqual(readLog(w, 'mutations.log'), [])
  assert.equal(git(w, w.bare('acme/taken'), ['for-each-ref']), '')
})

test('a snapshot that does not verify: exit 1, snapshot-modified with the reason, no remote call at all', () => {
  const cases = [
    ['a file edited after prepare', 'file-changed', (out) => fs.appendFileSync(path.join(out, 'tree', 'README.md'), 'edited\n')],
    ['a file added', 'file-added', (out) => fs.writeFileSync(path.join(out, 'tree', 'extra.txt'), 'extra\n')],
    ['a file removed', 'file-missing', (out) => fs.rmSync(path.join(out, 'tree', 'README.md'))],
    ['an exec bit changed', 'file-changed', (out) => fs.chmodSync(path.join(out, 'tree', 'README.md'), 0o755)],
    [
      'a report edited: a file hash',
      'file-changed',
      (out) => {
        const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
        report.files[0].sha256 = 'f'.repeat(64)
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report))
      },
    ],
    [
      'a report edited: an error finding',
      'report-errors',
      (out) => {
        const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
        report.findings.push({ rule: 'secret', level: 'error', path: 'README.md', line: 1, ruleId: 'x' })
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report))
      },
    ],
    ['a report removed', 'report-missing', (out) => fs.rmSync(path.join(out, 'report.json'))],
    [
      '<out>/tree replaced by a symlink',
      'file-changed',
      (out) => {
        const elsewhere = path.join(path.dirname(out), 'tree-copy')
        fs.renameSync(path.join(out, 'tree'), elsewhere)
        fs.symlinkSync(elsewhere, path.join(out, 'tree'))
      },
    ],
    [
      'a file replaced by a symlink to the same content',
      'file-changed',
      (out) => {
        const target = path.join(out, 'tree', 'README.md')
        const copy = path.join(path.dirname(out), 'readme-copy')
        fs.copyFileSync(target, copy)
        fs.rmSync(target)
        fs.symlinkSync(copy, target)
      },
    ],
  ]
  for (const [name, reason, edit] of cases) {
    const w = world()
    const snapshot = prepared()
    edit(snapshot.out)
    const { status, value } = publishJson(w, snapshot, 'acme/edited')
    assert.equal(status, 1, name)
    assert.equal(value.failures.length, 1, name)
    assert.equal(value.failures[0].rule, 'snapshot-modified', name)
    assert.equal(value.failures[0].reason, reason, name)
    assert.deepEqual(stepList(value), ['verify:failed'], name)
    assert.equal(value.commit, null, name)
    assert.deepEqual(readLog(w, 'calls.log'), [], `${name}: a remote call was made`)
    assert.equal(fs.existsSync(path.join(snapshot.out, 'publication.json')), false, name)
  }
})

test('a wrong --expect: exit 1, snapshot-modified, expect-mismatch, no remote call', () => {
  const w = world()
  const snapshot = prepared()
  const { status, value } = publishJson(w, { ...snapshot, snapshotId: 'a'.repeat(64) }, 'acme/wrong')
  assert.equal(status, 1)
  assert.equal(value.failures[0].rule, 'snapshot-modified')
  assert.equal(value.failures[0].reason, 'expect-mismatch')
  assert.deepEqual(readLog(w, 'calls.log'), [])
})

test('a push refused once: exit 4 with repo, commit, steps and retry; --resume then pushes and skips create; a second --resume skips push', () => {
  const w = world()
  const snapshot = prepared()
  const first = publishJson(w, snapshot, 'acme/retry', [], { GIT_TEMPLATE_DIR: hookTemplate(rejectOnceHook) })
  assert.equal(first.status, 4)
  assert.deepEqual(first.value.failures.map((failure) => [failure.rule, failure.step, failure.detail]), [['github-step', 'push', 'rejected']])
  assert.deepEqual(stepList(first.value), ['verify:done', 'create:done', 'push:failed:rejected'])
  assert.deepEqual(first.value.repo, { fullName: 'acme/retry', url: 'https://github.com/acme/retry', visibility: 'public' })
  assert.match(first.value.commit.sha, /^[0-9a-f]{40}$/)
  assert.equal(first.value.retry, retryCommand(packageJson.version, snapshot.out, 'acme/retry', 'public', snapshot.snapshotId))
  assert.equal(
    first.value.retry,
    `npx create-mercato-template@${packageJson.version} publish --from ${snapshot.out} --repo acme/retry --public --expect ${snapshot.snapshotId} --resume`,
  )
  assert.equal(git(w, w.bare('acme/retry'), ['for-each-ref']), '')
  const failedPublication = JSON.parse(fs.readFileSync(path.join(snapshot.out, 'publication.json'), 'utf8'))
  assert.deepEqual(failedPublication.steps, first.value.steps)

  const second = publishJson(w, snapshot, 'acme/retry', ['--resume'])
  assert.equal(second.status, 0, JSON.stringify(second.value.failures))
  assert.deepEqual(stepList(second.value), ['verify:done', 'create:skipped', 'push:done', 'template-flag:done', 'topics:done'])
  assert.equal(second.value.commit.tree, first.value.commit.tree)
  assert.equal(git(w, w.bare('acme/retry'), ['rev-list', '--count', 'main']), '1')

  const third = publishJson(w, snapshot, 'acme/retry', ['--resume'])
  assert.equal(third.status, 0)
  assert.deepEqual(stepList(third.value), ['verify:done', 'create:skipped', 'push:skipped', 'template-flag:done', 'topics:done'])
  assert.deepEqual(third.value.commit, second.value.commit)
  assert.deepEqual(third.value.commit, { sha: git(w, w.bare('acme/retry'), ['rev-parse', 'main']), tree: git(w, w.bare('acme/retry'), ['rev-parse', 'main^{tree}']) })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot.out, 'publication.json'), 'utf8')).commit, third.value.commit)
  assert.deepEqual(details(w, 'acme/retry').topics, ['open-mercato-template', 'open-mercato'])
})

test('repo create fails once: exit 4, then --resume creates and pushes', () => {
  const w = world()
  const snapshot = prepared()
  const first = publishJson(w, snapshot, 'acme/flaky', [], { GH_WRAPPER_FAIL_ONCE: 'repo create' })
  assert.equal(first.status, 4)
  assert.deepEqual(stepList(first.value), ['verify:done', 'create:failed'])
  assert.equal(first.value.failures[0].rule, 'github-step')
  assert.equal(first.value.failures[0].step, 'create')
  assert.equal(first.value.repo, null)
  assert.match(first.value.commit.tree, /^[0-9a-f]{40}$/)
  assert.match(first.value.retry, / --resume$/)
  assert.equal(fs.existsSync(w.bare('acme/flaky')), false)

  const second = publishJson(w, snapshot, 'acme/flaky', ['--resume'], { GH_WRAPPER_FAIL_ONCE: 'repo create' })
  assert.equal(second.status, 0, JSON.stringify(second.value.failures))
  assert.deepEqual(stepList(second.value), ['verify:done', 'create:done', 'push:done', 'template-flag:done', 'topics:done'])
  assert.equal(git(w, w.bare('acme/flaky'), ['rev-list', '--count', 'main']), '1')
  assert.equal(details(w, 'acme/flaky').is_template, true)
})

test('the template flag fails once: exit 4, then --resume skips create and push and sets it', () => {
  const w = world()
  const snapshot = prepared()
  const first = publishJson(w, snapshot, 'acme/flag', [], { GH_WRAPPER_FAIL_ONCE: 'api --method PATCH' })
  assert.equal(first.status, 4)
  assert.deepEqual(stepList(first.value), ['verify:done', 'create:done', 'push:done', 'template-flag:failed'])
  const second = publishJson(w, snapshot, 'acme/flag', ['--resume'], { GH_WRAPPER_FAIL_ONCE: 'api --method PATCH' })
  assert.equal(second.status, 0)
  assert.deepEqual(stepList(second.value), ['verify:done', 'create:skipped', 'push:skipped', 'template-flag:done', 'topics:done'])
  assert.equal(second.value.commit.sha, first.value.commit.sha)
})

test('a push rejected for the workflow scope: exit 4 with detail workflow-scope and the refresh hint', () => {
  const w = world()
  const snapshot = prepared({ '.github/workflows/ci.yml': 'on: push\njobs: {}\n' })
  const { status, value } = publishJson(w, snapshot, 'acme/workflows', [], { GIT_TEMPLATE_DIR: hookTemplate(workflowHook) })
  assert.equal(status, 4)
  assert.deepEqual(value.failures.map((failure) => [failure.rule, failure.step, failure.detail]), [['github-step', 'push', 'workflow-scope']])
  assert.match(value.failures[0].message, /gh auth refresh -s workflow/)
  assert.deepEqual(stepList(value), ['verify:done', 'create:done', 'push:failed:workflow-scope'])
  assert.match(value.retry, / --resume$/)
})

test('commit.gpgsign=true in the user Git config: no prompt, no signature', () => {
  const marker = path.join(tempDir('cmt-gpg-'), 'called')
  const program = path.join(path.dirname(marker), 'gpg')
  fs.writeFileSync(program, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 })
  const w = world({ gitConfig: `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${program}\n` })
  const snapshot = prepared()
  const { status, value } = publishJson(w, snapshot, 'acme/signed')
  assert.equal(status, 0, JSON.stringify(value.failures))
  assert.equal(fs.existsSync(marker), false, 'gpg was called')
  assert.doesNotMatch(git(w, w.bare('acme/signed'), ['cat-file', 'commit', 'main']), /gpgsig/)
})

test('a user.email in the user Git config: author and committer are still the noreply address', () => {
  const email = ['jane.doe', 'private-mail.example'].join('@')
  const w = world({ gitConfig: `[user]\n\tname = Jane Doe\n\temail = ${email}\n` })
  const snapshot = prepared()
  const { status, value } = publishJson(w, snapshot, 'acme/identity')
  assert.equal(status, 0, JSON.stringify(value.failures))
  const log = git(w, w.bare('acme/identity'), ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main'])
  assert.equal(log, `release-checks <${noreply}>|release-checks <${noreply}>`)
  assert.equal(git(w, w.bare('acme/identity'), ['cat-file', 'commit', 'main']).includes(email), false)
})

test('an unrelated repository with --resume: exit 1, repo-not-from-snapshot, no mutating call', () => {
  const w = world()
  const snapshot = prepared()
  shimCreate(w, 'acme/unrelated')
  const other = createFixtureRepo({ 'other.txt': 'someone else\n' })
  assert.equal(sh('git', ['-C', other, 'push', '-q', w.bare('acme/unrelated'), 'HEAD:refs/heads/main'], { env: w.env }).status, 0)
  const before = git(w, w.bare('acme/unrelated'), ['rev-parse', 'main'])
  const { status, value } = publishJson(w, snapshot, 'acme/unrelated', ['--resume'])
  assert.equal(status, 1)
  assert.equal(value.failures[0].rule, 'repo-not-from-snapshot')
  assert.deepEqual(stepList(value), ['verify:done', 'create:skipped'])
  assert.deepEqual(readLog(w, 'mutations.log'), [])
  assert.equal(git(w, w.bare('acme/unrelated'), ['rev-parse', 'main']), before)
})

test('a visibility mismatch: exit 1, visibility-mismatch, no mutating call', () => {
  const w = world()
  const snapshot = prepared()
  shimCreate(w, 'acme/hidden', '--private')
  const { status, value } = publishJson(w, snapshot, 'acme/hidden', ['--resume'])
  assert.equal(status, 1)
  assert.equal(value.failures[0].rule, 'visibility-mismatch')
  assert.equal(value.repo.visibility, 'private')
  assert.deepEqual(readLog(w, 'mutations.log'), [])
})

test('gh missing, and gh auth status failing: exit 3, github-auth, nothing changed', () => {
  const w = world()
  const snapshot = prepared()
  // A PATH with git and no gh.
  const gitOnly = tempDir('cmt-gitonly-')
  const gitPath = sh('sh', ['-c', 'command -v git']).stdout.trim()
  fs.symlinkSync(gitPath, path.join(gitOnly, 'git'))
  const missing = publishJson(w, snapshot, 'acme/noauth', [], { PATH: gitOnly })
  assert.equal(missing.status, 3)
  assert.equal(missing.value.failures[0].rule, 'github-auth')
  assert.match(missing.value.failures[0].message, /gh auth login/)
  assert.deepEqual(stepList(missing.value), ['verify:done'])

  const failing = publishJson(w, snapshot, 'acme/noauth', [], { GH_WRAPPER_FAIL_ONCE: 'auth status' })
  assert.equal(failing.status, 3)
  assert.equal(failing.value.failures[0].rule, 'github-auth')
  assert.deepEqual(readLog(w, 'calls.log'), [['auth', 'status']])
  assert.deepEqual(readLog(w, 'mutations.log'), [])
})

test('a repository read that fails with anything but 404: exit 4, create failed with repo-read, nothing changed', () => {
  const w = world()
  const snapshot = prepared()
  const { status, value } = publishJson(w, snapshot, 'acme/unreadable', [], { GH_WRAPPER_FAIL_ONCE: 'api repos/acme/unreadable' })
  assert.equal(status, 4)
  assert.deepEqual(stepList(value), ['verify:done', 'create:failed:repo-read'])
  assert.match(value.retry, / --resume$/)
  assert.deepEqual(readLog(w, 'mutations.log'), [])
})

test('usage errors are exit 2 before any Git read or GitHub call', () => {
  const w = world()
  const snapshot = prepared()
  const cases = [
    [['--from', snapshot.out, '--repo', 'acme/x', '--public', '--json'], /--json needs --expect/],
    [['--repo', 'acme/x', '--public', '--expect', snapshot.snapshotId], /needs --from/],
    [['--from', snapshot.out, '--public', '--expect', snapshot.snapshotId], /needs --repo/],
    [['--from', snapshot.out, '--repo', 'acme/x', '--expect', snapshot.snapshotId], /--public or --private/],
    [['--from', snapshot.out, '--repo', 'acme', '--public', '--expect', snapshot.snapshotId], /is not a GitHub <owner>\/<name>/],
    [['--from', snapshot.out, '--repo', 'acme/../x', '--public', '--expect', snapshot.snapshotId], /is not a GitHub/],
    [['--from', snapshot.out, '--repo', 'acme/x', '--public', '--expect', 'ABC'], /64 lower-case hex/],
    [['--from', path.join(snapshot.out, 'nope'), '--repo', 'acme/x', '--public', '--expect', snapshot.snapshotId], /is not a directory/],
  ]
  for (const [args, message] of cases) {
    const result = cli(w, ['publish', ...args, ...(args.includes('--json') ? [] : ['--json'])])
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}`)
    const value = JSON.parse(result.stdout)
    assert.equal(value.failures[0].rule, 'usage')
    assert.match(value.failures[0].message, message)
  }
  const plain = cli(w, ['publish', '--from', snapshot.out, '--repo', 'acme/x', '--public'])
  assert.equal(plain.status, 2)
  assert.match(plain.stderr, /--expect <snapshotId> when it runs without a terminal/)
  assert.deepEqual(readLog(w, 'calls.log'), [])
})

test('describe still exits 2 "not implemented yet"', () => {
  const w = world()
  const result = cli(w, ['describe', '--json'])
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).failures[0].message, /describe is not implemented yet/)
})

test('the prompt (Q11): it gets counts from the verified tree; no means publish-declined and no remote call', async () => {
  const w = world()
  const snapshot = prepared({ 'public/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n' })
  // An edited count in report.json changes nothing: the counts come from the tree.
  const reportFile = path.join(snapshot.out, 'report.json')
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  report.totals.files = 9999
  report.images = []
  fs.writeFileSync(reportFile, JSON.stringify(report))
  const asked = []
  const result = await publish({
    from: snapshot.out,
    repo: 'acme/declined',
    visibility: 'public',
    environment: w.env,
    confirm: async (summary) => {
      asked.push(summary)
      return false
    },
  })
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.failures.map((failure) => failure.rule), ['publish-declined'])
  assert.deepEqual(asked, [{ repo: 'acme/declined', visibility: 'public', snapshotId: snapshot.snapshotId, files: report.files.length, images: 1 }])
  assert.deepEqual(readLog(w, 'calls.log'), [])

  const approved = await publish({ from: snapshot.out, repo: 'acme/approved', visibility: 'private', environment: w.env, confirm: async () => true })
  assert.equal(approved.exitCode, 0, JSON.stringify(approved.failures))
  assert.equal(details(w, 'acme/approved').private, true)
})

test('parseRepo accepts GitHub names only', () => {
  assert.deepEqual(parseRepo('acme/shop.template_1'), { owner: 'acme', name: 'shop.template_1' })
  for (const value of ['acme', 'acme/', '/x', 'a/b/c', '-acme/x', 'acme-/x', 'acme/..', 'acme/.', 'acme/x.git', 'acme/x y', 'acme/x;rm']) assert.equal(parseRepo(value), null, value)
})
