// Spec Step 8: prepare on the CLI, through bin/cli.cjs: its flags, the
// --json envelope, the exit codes, and no secret value or seed email address
// in stdout, stderr or the envelope. Fixture repositories are built in a temp
// directory; no network. Secret-looking values are assembled from parts at
// test time (test/helpers/secret-fixtures.cjs).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const packageJson = require('../package.json')
const { createFixtureRepo, gitEnvironment, tempDir } = require('./helpers/fixture-app.cjs')
const { allValues, join, keysFile, pem, randomText, secrets } = require('./helpers/secret-fixtures.cjs')
const { stockAppFiles, stockEnvExample } = require('./helpers/stock-app.cjs')

const bin = path.join(__dirname, '..', 'bin', 'cli.cjs')
const envelopeKeys = ['command', 'exitCode', 'failures', 'ok', 'out', 'report', 'schema', 'snapshotId', 'tool']

function newOut() {
  return path.join(tempDir('cmt-out-'), 'out')
}

function cli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env: gitEnvironment(env), encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Parses stdout as exactly one JSON object with the schema 1 envelope of prepare. */
function oneEnvelope(stdout) {
  const value = JSON.parse(stdout)
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  assert.equal(value.schema, 1)
  assert.equal(value.command, 'prepare')
  assert.deepEqual(value.tool, { name: 'create-mercato-template', version: packageJson.version })
  assert.equal(value.ok, value.exitCode === 0)
  assert.deepEqual(Object.keys(value).sort(), envelopeKeys)
  return value
}

function assertNoValue(texts, values) {
  for (const text of texts) for (const value of values) assert.equal(text.includes(value), false, 'a fixture value appears in the output')
}

test('the stock app through bin/cli.cjs --json: exit 0, one envelope with out, snapshotId and report', () => {
  const app = createFixtureRepo(stockAppFiles())
  const out = newOut()
  const result = cli(['prepare', app, '--out', out, '--json'])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const value = oneEnvelope(result.stdout)
  assert.equal(value.ok, true)
  assert.deepEqual(value.failures, [])
  assert.equal(value.out, out)
  assert.match(value.snapshotId, /^[0-9a-f]{64}$/)
  assert.deepEqual(value.report, JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')))
  assert.equal(value.report.snapshotId, value.snapshotId)
  assert.ok(value.report.findings.every((finding) => finding.level === 'warning'))
  assert.equal(fs.readFileSync(path.join(out, 'tree', '.env.example'), 'utf8'), stockEnvExample())
})

test('the stock app without --json: exit 0, a summary on stdout, nothing on stderr', () => {
  const app = createFixtureRepo(stockAppFiles())
  const out = newOut()
  const result = cli(['prepare', '--out', out], { cwd: app })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^Snapshot of [0-9a-f]{40} written to .*\/tree: \d+ files, \d+ bytes\.\nsnapshotId: [0-9a-f]{64}\n/)
  assert.match(result.stdout, /Warnings \(15\), review them before you publish:/)
  assert.match(result.stdout, /readme-missing {2}README\.md/)
  assert.match(result.stdout, /Notices:\n {2}code-only: /)
  assert.ok(result.stdout.endsWith(`Report: ${out}/report.json\n`))
})

/** An app with every Step 7 secret fixture, a credential URL, a seed email and a secret in .env.example. */
function leakingApp() {
  const seedEmail = join('jane.doe', '@', 'corp-mail', '.net')
  const envKey = join('sk', '_live_', randomText('cli-st', 32))
  const files = {
    'src/lib/keys.ts': keysFile,
    'src/lib/signing.ts': `export const pem = \`\n${pem}\n\`\n`,
    'docker-compose.yml': `services:\n  app:\n    environment:\n      DATABASE_URL: ${join('postgres://postgres:', 'Hunter2-', randomText('cli-db', 12), '@db:5432/app')}\n`,
    'src/modules/shop/setup.ts': `export const owner = '${seedEmail}'\n`,
    '.env.example': `APP_URL=http://localhost:3000\nSTRIPE_SECRET_KEY=${envKey}\n`,
  }
  const values = [...allValues, seedEmail, 'corp-mail', envKey, randomText('cli-st', 32), randomText('cli-db', 12)]
  return { app: createFixtureRepo(files), values }
}

test('the Step 7 secret fixtures through bin/cli.cjs --json: exit 1, no secret or seed email in stdout, stderr or the envelope', () => {
  const { app, values } = leakingApp()
  const out = newOut()
  const result = cli(['prepare', app, '--out', out, '--json'])
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  const value = oneEnvelope(result.stdout)
  assert.equal(value.ok, false)
  assert.equal(value.exitCode, 1)
  assert.equal(value.snapshotId, null)
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
  // failures: every error finding of the report, without its level.
  const errors = value.report.findings.filter((finding) => finding.level === 'error')
  assert.deepEqual(
    value.failures,
    errors.map(({ level, ...failure }) => (assert.equal(level, 'error'), failure)),
  )
  const keyRules = value.failures.filter((failure) => failure.path === 'src/lib/keys.ts')
  assert.deepEqual(
    keyRules.map(({ rule, ruleId, line }) => ({ rule, ruleId, line })),
    secrets.map((item, index) => ({ rule: 'secret', ruleId: item.ruleId, line: index + 2 })),
  )
  assert.ok(value.failures.some((failure) => failure.rule === 'credential-url' && failure.path === 'docker-compose.yml'))
  assert.ok(value.failures.some((failure) => failure.rule === 'secret' && failure.path === 'src/lib/signing.ts'))
  assert.ok(value.failures.some((failure) => failure.rule === 'secret' && failure.path === '.env.example' && failure.line === 2))
  assert.ok(value.report.findings.some((finding) => finding.rule === 'seed-email'))
  assertNoValue([result.stdout, result.stderr, fs.readFileSync(path.join(out, 'report.json'), 'utf8')], values)
})

test('the Step 7 secret fixtures without --json: exit 1, findings on stdout, one error line on stderr, no value anywhere', () => {
  const { app, values } = leakingApp()
  const out = newOut()
  const result = cli(['prepare', app, '--out', out])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /^No snapshot written: \d+ errors\./)
  assert.match(result.stdout, /secret \(github-pat\) {2}src\/lib\/keys\.ts:\d+/)
  assert.match(result.stderr, /^\nError: prepare found \d+ errors; no snapshot was written\. See .*report\.json\.\n$/)
  assertNoValue([result.stdout, result.stderr], values)
})

test('the flags reach prepare(): --include-uncommitted, --allow-file and --keep-env', () => {
  const app = createFixtureRepo({ 'backup.sql': 'select 1;\n', '.env.example': 'APP_URL=https://shop.example.com\n' })
  fs.writeFileSync(path.join(app, 'src', 'extra.ts'), 'export const extra = 1\n')
  const out = newOut()
  const result = cli(['prepare', app, '--out', out, '--include-uncommitted', '--allow-file', 'backup.sql', '--allow-file', 'missing.db', '--keep-env', 'APP_URL', '--json'])
  assert.equal(result.status, 0, result.stdout)
  const { report } = oneEnvelope(result.stdout)
  assert.equal(report.source.includeUncommitted, true)
  assert.ok(report.files.some((file) => file.path === 'src/extra.ts' && file.origin === 'worktree'))
  assert.deepEqual(report.allowFiles, [
    { path: 'backup.sql', used: true },
    { path: 'missing.db', used: false },
  ])
  assert.deepEqual(report.env.kept, ['APP_URL'])
  assert.equal(fs.readFileSync(path.join(out, 'tree', '.env.example'), 'utf8'), 'APP_URL=https://shop.example.com\n')
})

/** A directory holding a `git` that only records that it ran, for PATH. */
function gitShim() {
  const directory = tempDir('cmt-shim-')
  const marker = path.join(directory, 'git-was-called')
  fs.writeFileSync(path.join(directory, 'git'), `#!/bin/sh\necho called >> '${marker}'\nexit 1\n`, { mode: 0o755 })
  return { env: { PATH: `${directory}${path.delimiter}${process.env.PATH}` }, marker }
}

test('prepare usage errors exit 2 before any Git read: no --out, a bad --keep-env, --out inside the app', { skip: process.platform === 'win32' }, () => {
  const app = createFixtureRepo()
  const shim = gitShim()
  for (const [args, pattern] of [
    [['prepare', app], /prepare needs --out <dir>/],
    [['prepare', app, '--out', newOut(), '--keep-env', 'NOT A KEY'], /--keep-env takes an env key name/],
    [['prepare', '--out', '--help'], /--out --help is inside the app/],
    [['prepare', 'missing-dir', '--out', newOut()], /The app directory .*missing-dir does not exist/],
  ]) {
    const result = cli(args, { cwd: app, env: shim.env })
    assert.equal(result.status, 2, JSON.stringify(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, pattern)
    const json = cli([...args, '--json'], { cwd: app, env: shim.env })
    assert.equal(json.status, 2)
    const value = JSON.parse(json.stdout)
    assert.deepEqual(Object.keys(value).sort(), ['command', 'exitCode', 'failures', 'ok', 'schema', 'tool'])
    assert.equal(value.failures[0].rule, 'usage')
  }
  // `--help` was read as the value of --out, not as help, and nothing was written.
  assert.equal(fs.existsSync(path.join(app, '--help')), false)
  // No Git command ran: the shim on PATH was never called.
  assert.equal(fs.existsSync(shim.marker), false)
  // The shim does work: with valid arguments prepare runs it (and fails the Git check).
  const reached = cli(['prepare', app, '--out', newOut(), '--json'], { env: shim.env })
  assert.equal(reached.status, 1)
  assert.equal(fs.existsSync(shim.marker), true)
})

test('a directory that is not a Git repository: exit 1, not-git-repo, only report.json', () => {
  const app = tempDir('cmt-plain-')
  const out = newOut()
  // The temp directory may sit inside another repository: Git stops above the app.
  const result = cli(['prepare', app, '--out', out, '--json'], { env: { GIT_CEILING_DIRECTORIES: path.dirname(app) } })
  assert.equal(result.status, 1)
  const value = oneEnvelope(result.stdout)
  assert.deepEqual(value.failures.map((failure) => [failure.rule, failure.path]), [['not-git-repo', '.']])
  assert.deepEqual(fs.readdirSync(out), ['report.json'])
})

test('publish and describe still exit 2 "not implemented yet"', () => {
  for (const command of ['publish', 'describe']) {
    const result = cli([command, '--json'])
    assert.equal(result.status, 2)
    const value = JSON.parse(result.stdout)
    assert.equal(value.failures[0].rule, 'usage')
    assert.match(value.failures[0].message, new RegExp(`${command} is not implemented yet`))
  }
})
