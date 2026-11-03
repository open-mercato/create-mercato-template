// Spec Step 3: the internal prepare() entry point and the snapshot core. Every
// test builds a fixture repository in a temp directory from
// test/helpers/fixture-app.cjs and runs Git against it; no network. "Exit 1"
// here means prepare() returns an error finding and snapshotId null; the CLI
// assertions (stdout, stderr, --json) come with Step 8.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { prepare, checkOut } = require('../dist/prepare.js')
const { computeSnapshotId } = require('../dist/snapshot.js')
const { CliError } = require('../dist/errors.js')
const { createFixtureRepo, commitIndexEntries, fixtureFiles, git, gitEnvironment, tempDir, writeFixtureApp } = require(
  './helpers/fixture-app.cjs',
)

const repoRoot = path.join(__dirname, '..')
const fixedNow = () => new Date('2026-11-03T12:00:00.000Z')

function newOut() {
  return path.join(tempDir('cmt-out-'), 'out')
}

function run(app, options = {}) {
  const out = options.out ?? newOut()
  const result = prepare({ app, out, environment: gitEnvironment(), now: fixedNow, ...options })
  return { result, out, report: result.report }
}

function rules(report) {
  return report.findings.map((finding) => `${finding.rule} ${finding.path}`)
}

function excludedPaths(report, pattern) {
  return report.excluded.find((entry) => entry.pattern === pattern)?.paths ?? []
}

function treeFiles(out) {
  const root = path.join(out, 'tree')
  if (!fs.existsSync(root)) return null
  return fs
    .readdirSync(root, { recursive: true })
    .map((item) => item.split(path.sep).join('/'))
    .filter((item) => fs.lstatSync(path.join(root, item)).isFile())
    .sort()
}

function assertCliError(fn, exitCode, rule) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CliError, `expected a CliError, got ${error}`)
    assert.equal(error.exitCode, exitCode)
    assert.equal(error.failure.rule, rule)
    return true
  })
}

/** Records every path the process opens or reads through node:fs while `fn` runs. */
function recordReads(fn) {
  const seen = []
  const names = ['openSync', 'readFileSync', 'readlinkSync', 'createReadStream']
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]))
  for (const name of names)
    fs[name] = function (target, ...rest) {
      if (typeof target === 'string' || Buffer.isBuffer(target)) seen.push(String(target))
      return originals[name].call(this, target, ...rest)
    }
  try {
    return { value: fn(), seen }
  } finally {
    for (const name of names) fs[name] = originals[name]
  }
}

/** sha256 of every file under `root` (`.git` included), by relative path. */
function hashTree(root) {
  const hashes = {}
  for (const item of fs.readdirSync(root, { recursive: true })) {
    const full = path.join(root, item)
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) hashes[item] = `link:${fs.readlinkSync(full)}`
    else if (stat.isFile()) hashes[item] = `${stat.mode.toString(8)}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
    else if (stat.isDirectory()) hashes[item] = 'dir'
  }
  return hashes
}

// ---------------------------------------------------------------------------
// Export, deny list, export-ignore
// ---------------------------------------------------------------------------

test('module data folders are kept while /data/x and .env.local are excluded and listed', () => {
  const app = createFixtureRepo({
    'src/modules/x/data/entities.ts': 'export const entities = []\n',
    'data/x': 'local data\n',
    '.env.local': 'LOCAL_ONLY=1\n',
  })
  const { result, out, report } = run(app)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.failures, [])
  assert.match(result.snapshotId, /^[0-9a-f]{64}$/)
  assert.equal(report.snapshotId, result.snapshotId)
  assert.ok(treeFiles(out).includes('src/modules/x/data/entities.ts'))
  assert.deepEqual(excludedPaths(report, '/data/'), ['data/x'])
  assert.ok(excludedPaths(report, '**/.env*').includes('.env.local'))
  assert.ok(!treeFiles(out).includes('data/x'))
  assert.ok(!treeFiles(out).includes('.env.local'))
})

test('the root .env.example is listed under excluded and absent from <out>/tree (until Step 8)', () => {
  const app = createFixtureRepo()
  const { out, report } = run(app)
  assert.ok(excludedPaths(report, '**/.env*').includes('.env.example'))
  assert.ok(!treeFiles(out).includes('.env.example'))
  assert.ok(!report.files.some((file) => file.path === '.env.example'))
})

test('the report: files, notices code-only and checks-incomplete, written last next to tree/', () => {
  const app = createFixtureRepo({ 'bin/run.sh': '#!/bin/sh\necho hi\n' })
  fs.chmodSync(path.join(app, 'bin/run.sh'), 0o755)
  git(app, ['add', 'bin/run.sh'])
  git(app, ['commit', '-q', '-m', 'exec bit'])
  const { result, out, report } = run(app)
  assert.equal(result.out, out)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')), report)
  assert.deepEqual(fs.readdirSync(out).sort(), ['report.json', 'tree'])
  assert.deepEqual(report.notices.map((notice) => notice.code), ['code-only', 'checks-incomplete'])
  assert.equal(report.schema, 1)
  assert.deepEqual(report.tool.name, 'create-mercato-template')
  assert.equal(report.createdAt, '2026-11-03T12:00:00.000Z')
  assert.deepEqual(report.source, { head: git(app, ['rev-parse', 'HEAD']).toString().trim(), dirty: false, includeUncommitted: false })
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.uncommitted, [])
  const script = report.files.find((file) => file.path === 'bin/run.sh')
  assert.deepEqual(script, {
    path: 'bin/run.sh',
    mode: '100755',
    size: 18,
    sha256: crypto.createHash('sha256').update('#!/bin/sh\necho hi\n').digest('hex'),
    origin: 'tree',
  })
  assert.equal(fs.statSync(path.join(out, 'tree/bin/run.sh')).mode & 0o777, 0o755)
  assert.equal(fs.statSync(path.join(out, 'tree/package.json')).mode & 0o777, 0o644)
  assert.deepEqual(report.files.map((file) => file.path), treeFiles(out))
  for (const file of report.files)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'tree', file.path))).digest('hex'), file.sha256)
  assert.deepEqual(report.totals, { files: report.files.length, bytes: report.files.reduce((sum, file) => sum + file.size, 0) })
})

test('an export-ignore file is excluded and listed, never exported', () => {
  const app = createFixtureRepo({
    '.gitattributes': 'docs/internal.md export-ignore\n',
    'docs/internal.md': 'internal notes\n',
    'docs/public.md': 'public notes\n',
  })
  const { out, report } = run(app)
  assert.deepEqual(excludedPaths(report, 'export-ignore'), ['docs/internal.md'])
  assert.ok(!treeFiles(out).includes('docs/internal.md'))
  assert.ok(treeFiles(out).includes('docs/public.md'))
  assert.equal(report.excluded.at(-1).pattern, 'export-ignore')
})

test('a directory marked export-ignore excludes every file below it', () => {
  const app = createFixtureRepo({
    '.gitattributes': '/internal export-ignore\ntests/ export-ignore\n',
    'internal/notes.md': 'internal\n',
    'internal/deep/more.md': 'internal\n',
    'tests/a.test.ts': 'test\n',
    'src/tests.ts': 'kept\n',
  })
  const { out, report } = run(app)
  assert.deepEqual(excludedPaths(report, 'export-ignore'), ['internal/deep/more.md', 'internal/notes.md', 'tests/a.test.ts'])
  assert.ok(treeFiles(out).includes('src/tests.ts'))
  assert.ok(!treeFiles(out).some((item) => item.startsWith('internal/') || item.startsWith('tests/')))
})

test('a partial clone with missing blobs: nothing is fetched, no repo program runs, .git is unchanged', () => {
  const source = createFixtureRepo({ 'src/a.ts': 'export const a = 1\n' })
  git(source, ['config', 'uploadpack.allowFilter', 'true'])
  git(source, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
  const parent = tempDir('cmt-partial-')
  git(parent, ['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${source}`, 'app'])
  const app = path.join(parent, 'app')
  const marker = path.join(parent, 'marker')
  const script = path.join(parent, 'upload-pack.sh')
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexec git-upload-pack "$@"\n`, { mode: 0o755 })
  git(app, ['config', 'remote.origin.uploadpack', script])
  const before = hashTree(path.join(app, '.git'))
  const out = newOut()
  assert.throws(() => prepare({ app, out, environment: gitEnvironment() }), /not in the local repository|not allowed/)
  assert.equal(fs.existsSync(marker), false, 'a program configured for the remote ran')
  assert.deepEqual(hashTree(path.join(app, '.git')), before)
  assert.equal(fs.existsSync(out), false)
})

test('replace refs do not change the exported bytes', () => {
  const app = createFixtureRepo({ 'src/a.ts': 'export const a = 1\n' })
  const original = git(app, ['rev-parse', 'HEAD:src/a.ts']).toString().trim()
  const other = git(app, ['hash-object', '-w', '--stdin'], Buffer.from('export const a = 666\n')).toString().trim()
  git(app, ['replace', original, other])
  const { out } = run(app)
  assert.equal(fs.readFileSync(path.join(out, 'tree/src/a.ts'), 'utf8'), 'export const a = 1\n')
})

// ---------------------------------------------------------------------------
// Worktree changes
// ---------------------------------------------------------------------------

function dirtyApp() {
  const app = createFixtureRepo({ 'src/a.ts': 'export const a = 1\n', 'src/gone.ts': 'export const gone = 1\n' })
  fs.writeFileSync(path.join(app, 'src/a.ts'), 'export const a = 2\n')
  fs.rmSync(path.join(app, 'src/gone.ts'))
  fs.writeFileSync(path.join(app, 'src/staged.ts'), 'export const staged = 1\n')
  git(app, ['add', 'src/staged.ts'])
  fs.writeFileSync(path.join(app, 'src/untracked.ts'), 'export const untracked = 1\n')
  fs.writeFileSync(path.join(app, '.env'), 'IGNORED_LOCAL=1\n')
  return app
}

const dirtyList = [
  { path: 'src/a.ts', state: 'modified' },
  { path: 'src/gone.ts', state: 'deleted' },
  { path: 'src/staged.ts', state: 'added' },
  { path: 'src/untracked.ts', state: 'untracked' },
]

test('a dirty worktree: changes are listed and not exported by default', () => {
  const app = dirtyApp()
  const { value, seen } = recordReads(() => run(app))
  const { result, out, report } = value
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.uncommitted, dirtyList)
  assert.equal(report.source.dirty, true)
  assert.equal(report.source.includeUncommitted, false)
  assert.deepEqual(report.notices.map((notice) => notice.code), ['code-only', 'checks-incomplete', 'uncommitted-not-exported'])
  assert.equal(fs.readFileSync(path.join(out, 'tree/src/a.ts'), 'utf8'), 'export const a = 1\n')
  assert.ok(treeFiles(out).includes('src/gone.ts'))
  assert.ok(!treeFiles(out).includes('src/staged.ts'))
  assert.ok(!treeFiles(out).includes('src/untracked.ts'))
  // Every exported file comes from the pinned tree, except the generated manifest.
  assert.ok(report.files.every((file) => file.origin === 'tree' || (file.origin === 'generated' && file.path === 'mercato-template.json')))
  assert.ok(!seen.some((item) => item.endsWith(`${path.sep}.env`)), 'the ignored .env was read')
})

test('--include-uncommitted: modified, added, deleted and untracked are exported from the worktree; ignored .env never read', () => {
  const app = dirtyApp()
  const { value, seen } = recordReads(() => run(app, { includeUncommitted: true }))
  const { result, out, report } = value
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.uncommitted, dirtyList)
  assert.equal(report.source.includeUncommitted, true)
  assert.deepEqual(report.notices.map((notice) => notice.code), ['code-only', 'checks-incomplete'])
  const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]))
  assert.equal(byPath['src/a.ts'].origin, 'worktree')
  assert.equal(byPath['src/staged.ts'].origin, 'worktree')
  assert.equal(byPath['src/untracked.ts'].origin, 'worktree')
  assert.equal(byPath['package.json'].origin, 'tree')
  assert.equal(byPath['src/gone.ts'], undefined)
  assert.equal(fs.readFileSync(path.join(out, 'tree/src/a.ts'), 'utf8'), 'export const a = 2\n')
  assert.ok(!treeFiles(out).includes('src/gone.ts'))
  assert.ok(!treeFiles(out).includes('.env'))
  assert.ok(!seen.some((item) => item.endsWith(`${path.sep}.env`)), 'the ignored .env was read')
})

test('an exec bit change alone is modified, and exported with the worktree mode under --include-uncommitted', () => {
  const app = createFixtureRepo({ 'tool.sh': 'echo hi\n' })
  fs.chmodSync(path.join(app, 'tool.sh'), 0o755)
  assert.deepEqual(run(app).report.uncommitted, [{ path: 'tool.sh', state: 'modified' }])
  const included = run(app, { includeUncommitted: true }).report.files.find((file) => file.path === 'tool.sh')
  assert.equal(included.mode, '100755')
  assert.equal(included.origin, 'worktree')
})

test('the source repo index, refs and worktree are unchanged after prepare', () => {
  const app = dirtyApp()
  const before = hashTree(app)
  run(app)
  run(app, { includeUncommitted: true })
  assert.deepEqual(hashTree(app), before)
})

test('core.fsmonitor and a clean filter set to marker scripts never run', () => {
  const app = createFixtureRepo({ 'src/a.ts': 'export const a = 1\n' })
  const marker = path.join(tempDir('cmt-marker-'), 'marker')
  const script = path.join(tempDir('cmt-script-'), 'touch-marker.sh')
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 })
  // Set after the commit: the fixture's own `git add` must not run them.
  git(app, ['config', 'core.fsmonitor', script])
  git(app, ['config', 'filter.marker.clean', script])
  git(app, ['config', 'filter.marker.smudge', script])
  git(app, ['config', 'filter.marker.required', 'true'])
  fs.mkdirSync(path.join(app, '.git/info'), { recursive: true })
  fs.writeFileSync(path.join(app, '.git/info/attributes'), '* filter=marker\n')
  fs.writeFileSync(path.join(app, 'src/a.ts'), 'export const a = 2\n')
  const hooks = path.join(app, '.git/hooks')
  fs.mkdirSync(hooks, { recursive: true })
  for (const hook of ['post-index-change', 'reference-transaction', 'post-checkout'])
    fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  // Without the isolated environment too, as a user would run it.
  run(app, { environment: process.env })
  run(app, { includeUncommitted: true })
  assert.equal(fs.existsSync(marker), false, 'a monitor, filter or hook of the source repo ran')
})

// ---------------------------------------------------------------------------
// Entry types and paths
// ---------------------------------------------------------------------------

function assertError(app, expected, options = {}) {
  const { result, out, report } = run(app, options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.snapshotId, null)
  assert.equal(report.snapshotId, null)
  for (const item of expected) assert.ok(rules(report).includes(item), `${item} not in ${rules(report).join(', ')}`)
  assert.deepEqual(result.failures, report.findings.filter((finding) => finding.level === 'error'))
  // Q7: only report.json, no tree; the report still lists the files.
  assert.deepEqual(fs.readdirSync(out), ['report.json'])
  assert.ok(report.files.length > 0)
  return report
}

test('a committed symlink is entry-symlink, its target never read', () => {
  const app = createFixtureRepo()
  commitIndexEntries(app, [{ path: 'link', mode: '120000', content: '/etc/passwd' }])
  assertError(app, ['entry-symlink link'])
})

// Spec Step 3 names "an untracked file under a directory symlink that points
// outside the app". Git never lists files below a symlink: `ls-files --others`
// lists the symlink itself, so that is the entry prepare sees and refuses. A
// tracked file below a parent that became a symlink is the next test.
test('an untracked symlink to a directory outside the app is entry-symlink, its content never read', () => {
  const outside = tempDir('cmt-outside-')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n')
  const app = createFixtureRepo()
  fs.symlinkSync(outside, path.join(app, 'linked'))
  const { value, seen } = recordReads(() => assertError(app, ['entry-symlink linked'], { includeUncommitted: true }))
  assert.deepEqual(value.uncommitted, [{ path: 'linked', state: 'untracked' }])
  assert.ok(!seen.some((item) => item.startsWith(outside)), `read outside the app: ${seen.filter((item) => item.startsWith(outside))}`)
})

test('a tracked file whose parent directory became a symlink out of the app is never read through it', () => {
  const outside = tempDir('cmt-outside-')
  fs.writeFileSync(path.join(outside, 'a.ts'), 'outside\n')
  const app = createFixtureRepo({ 'lib/a.ts': 'export const a = 1\n' })
  fs.rmSync(path.join(app, 'lib'), { recursive: true })
  fs.symlinkSync(outside, path.join(app, 'lib'))
  const plain = recordReads(() => run(app))
  assert.deepEqual(plain.value.report.uncommitted.find((item) => item.path === 'lib/a.ts'), { path: 'lib/a.ts', state: 'modified' })
  assert.equal(plain.value.result.exitCode, 0)
  const included = recordReads(() => assertError(app, ['entry-symlink lib/a.ts'], { includeUncommitted: true }))
  for (const { seen } of [plain, included]) assert.ok(!seen.some((item) => item.startsWith(outside)))
})

test('a submodule is entry-submodule', () => {
  const app = createFixtureRepo()
  const head = git(app, ['rev-parse', 'HEAD']).toString().trim()
  commitIndexEntries(app, [{ path: 'vendor/lib', mode: '160000', oid: head }])
  assertError(app, ['entry-submodule vendor/lib'])
})

test('a worktree FIFO under --include-uncommitted is entry-special', { skip: process.platform === 'win32' }, () => {
  const app = createFixtureRepo()
  const made = spawnSync('mkfifo', [path.join(app, 'pipe')])
  if (made.status !== 0) return
  // ls-files --others lists a FIFO only on some Git versions; when it does, it must be entry-special.
  const { report } = run(app, { includeUncommitted: true })
  if (report.uncommitted.some((item) => item.path === 'pipe')) assert.ok(rules(report).includes('entry-special pipe'))
})

test('a path with a tab is unsafe-path', () => {
  const app = createFixtureRepo()
  commitIndexEntries(app, [{ path: 'docs/a\tb.md', content: 'tab\n' }])
  assertError(app, ['unsafe-path docs/a\tb.md'])
})

test('a path that is not valid UTF-8 is unsafe-path, named with \\x escapes', () => {
  const app = createFixtureRepo()
  commitIndexEntries(app, [{ path: Buffer.from([0x64, 0x6f, 0x63, 0x2f, 0xff, 0x2e, 0x6d, 0x64]), content: 'latin\n' }])
  const report = assertError(app, ['unsafe-path doc/\\xff.md'])
  assert.ok(!report.files.some((file) => file.path.startsWith('doc/')))
})

test('two paths equal when lower-cased are path-case-collision', () => {
  const app = createFixtureRepo()
  commitIndexEntries(app, [
    { path: 'README.md', content: 'one\n' },
    { path: 'Readme.md', content: 'two\n' },
  ])
  assertError(app, ['path-case-collision README.md', 'path-case-collision Readme.md'])
})

test('an LFS pointer is lfs-pointer, by content and by filter=lfs', () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 12\n'
  const app = createFixtureRepo({
    '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    'assets/model.bin': 'not a pointer, but filter=lfs\n',
    'assets/pointer.dat': pointer,
  })
  assertError(app, ['lfs-pointer assets/model.bin', 'lfs-pointer assets/pointer.dat'])
})

// ---------------------------------------------------------------------------
// snapshotId
// ---------------------------------------------------------------------------

test('computeSnapshotId: sorted <path>\\t<mode>\\t<sha256>\\n lines, sha256 (golden)', () => {
  const files = [
    { path: 'b.txt', mode: '100644', sha256: 'b'.repeat(64) },
    { path: 'a/z.txt', mode: '100755', sha256: 'a'.repeat(64) },
    { path: 'a.txt', mode: '100644', sha256: 'c'.repeat(64) },
    { path: 'é.txt', mode: '100644', sha256: 'd'.repeat(64) },
  ]
  const lines = `a.txt\t100644\t${'c'.repeat(64)}\na/z.txt\t100755\t${'a'.repeat(64)}\nb.txt\t100644\t${'b'.repeat(64)}\né.txt\t100644\t${'d'.repeat(64)}\n`
  assert.equal(computeSnapshotId(files), crypto.createHash('sha256').update(lines, 'utf8').digest('hex'))
  assert.equal(computeSnapshotId(files), 'a2fe0cb0c1f058d9da5936f1a7181b4aaccf6057167870e6deccbffb659c9305')
  assert.equal(computeSnapshotId([]), crypto.createHash('sha256').update('').digest('hex'))
})

test('snapshotId equals a golden value for the fixture app', () => {
  // Changes when the fixture app or the generated files change: Step 5 added
  // mercato-template.json (whose createdWith.version is the package version,
  // so a version bump changes it too), Step 8 adds the regenerated .env.example.
  const { result } = run(createFixtureRepo())
  assert.equal(result.snapshotId, 'f2177b5023bff572ad956b63a68a79f4460d14f5fa688ada893941b7a7ac1d12')
  assert.equal(result.snapshotId, computeSnapshotId(result.report.files))
})

// ---------------------------------------------------------------------------
// The app and <out>
// ---------------------------------------------------------------------------

test('not-git-repo, no-commit and app-not-repo-root: an error finding at ".", only report.json', () => {
  for (const [rule, makeApp] of [
    ['not-git-repo', () => writeFixtureApp(tempDir('cmt-plain-'))],
    ['no-commit', () => createFixtureRepo({}, { commit: false })],
    ['app-not-repo-root', () => path.join(createFixtureRepo(), 'src')],
  ]) {
    const app = makeApp()
    // The temp directory may itself sit inside a Git repository; Git must not search above it.
    const environment = gitEnvironment({ GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()) })
    const { result, out, report } = run(app, { environment })
    assert.equal(result.exitCode, 1, rule)
    assert.equal(result.snapshotId, null)
    assert.deepEqual(rules(report), [`${rule} .`])
    assert.match(report.findings[0].message, /git|repository/i)
    assert.deepEqual(report.files, [])
    assert.deepEqual(fs.readdirSync(out), ['report.json'])
  }
})

test('--out inside the app, or not empty, is a CliError with exit 2 and nothing is written', () => {
  const app = createFixtureRepo()
  const before = hashTree(app)
  assertCliError(() => prepare({ app, out: path.join(app, 'out') }), 2, 'usage')
  assertCliError(() => prepare({ app, out: app }), 2, 'usage')
  const full = tempDir('cmt-full-')
  fs.writeFileSync(path.join(full, 'keep.txt'), 'x\n')
  assertCliError(() => prepare({ app, out: full }), 2, 'usage')
  const file = path.join(tempDir('cmt-file-'), 'a-file')
  fs.writeFileSync(file, 'x\n')
  assertCliError(() => prepare({ app, out: file }), 2, 'usage')
  assertCliError(() => prepare({ app, out: '' }), 2, 'usage')
  assertCliError(() => prepare({ app: path.join(app, 'missing'), out: newOut() }), 2, 'usage')
  assert.deepEqual(fs.readdirSync(full), ['keep.txt'])
  assert.deepEqual(hashTree(app), before)
})

test('--out reached through a symlink into the app is inside the app (realpath, not Git)', () => {
  const app = createFixtureRepo()
  fs.mkdirSync(path.join(app, 'build'))
  const links = tempDir('cmt-links-')
  // A symlink outside the app that points into it; --out does not exist yet.
  fs.symlinkSync(path.join(app, 'src'), path.join(links, 'into-app'))
  assertCliError(() => prepare({ app, out: path.join(links, 'into-app', 'out') }), 2, 'usage')
  assertCliError(() => prepare({ app, out: path.join(links, 'into-app', 'a', 'b') }), 2, 'usage')
  // --out itself is a symlink to an empty, untracked directory of the app.
  fs.symlinkSync(path.join(app, 'build'), path.join(links, 'build-link'))
  assertCliError(() => prepare({ app, out: path.join(links, 'build-link') }), 2, 'usage')
  // An app reached through a symlink and an --out inside its real directory.
  fs.symlinkSync(app, path.join(links, 'app-link'))
  assertCliError(() => prepare({ app: path.join(links, 'app-link'), out: path.join(app, 'out') }), 2, 'usage')
  assert.equal(fs.existsSync(path.join(app, 'src', 'out')), false)
  assert.deepEqual(fs.readdirSync(path.join(app, 'build')), [])
  // A dangling symlink to a missing directory of the app.
  fs.symlinkSync(path.join(app, 'snap'), path.join(links, 'dangling'))
  assertCliError(() => prepare({ app, out: path.join(links, 'dangling') }), 2, 'usage')
  assertCliError(() => prepare({ app, out: path.join(links, 'dangling', 'sub') }), 2, 'usage')
  assert.equal(fs.existsSync(path.join(app, 'snap')), false)
  // A sibling whose name starts like the app is not inside it.
  assert.equal(checkOut(`${app}-out`, app), `${app}-out`)
})

test('an empty existing --out directory outside the app is used', () => {
  const out = tempDir('cmt-empty-')
  const { result } = run(createFixtureRepo(), { out })
  assert.equal(result.exitCode, 0)
  assert.equal(result.out, out)
  assert.deepEqual(fs.readdirSync(out).sort(), ['report.json', 'tree'])
})

test('a failed write of <out> is io-error, exit 1, with no partial tree', { skip: process.getuid?.() === 0 }, () => {
  const parent = tempDir('cmt-readonly-')
  fs.chmodSync(parent, 0o555)
  try {
    assertCliError(() => prepare({ app: createFixtureRepo(), out: path.join(parent, 'out'), environment: gitEnvironment() }), 1, 'io-error')
    assert.deepEqual(fs.readdirSync(parent), [])
  } finally {
    fs.chmodSync(parent, 0o755)
  }
})

test('node bin/cli.cjs prepare . --out <dir> still exits 2 "not implemented yet" and writes nothing', () => {
  const app = createFixtureRepo()
  const out = newOut()
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin/cli.cjs'), 'prepare', '.', '--out', out], {
    cwd: app,
    encoding: 'utf8',
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /prepare is not implemented yet/)
  assert.equal(result.stdout, '')
  assert.equal(fs.existsSync(out), false)
  assert.equal(fs.existsSync(path.dirname(out)) && fs.readdirSync(path.dirname(out)).length, 0)
})

test('the fixture app holds the files the later root checks need', () => {
  assert.deepEqual(Object.keys(fixtureFiles).sort(), ['.env.example', '.gitignore', 'package.json', 'src/modules.ts', 'yarn.lock'])
  const manifest = JSON.parse(fixtureFiles['package.json'])
  assert.match(manifest.packageManager, /^yarn@4\./)
  assert.ok(manifest.dependencies['@open-mercato/core'])
  assert.match(fixtureFiles['yarn.lock'], /"@open-mercato\/core@npm:/)
})
