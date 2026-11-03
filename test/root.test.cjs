// Spec Step 4: root checks and the Yarn lockfile reader. The prepare() tests
// build fixture repositories in a temp directory from
// test/helpers/fixture-app.cjs and run Git against them; no network. "Its
// error" means prepare() returns that error finding and snapshotId null.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { prepare } = require('../dist/prepare.js')
const {
  LockfileError,
  compareVersions,
  descriptorName,
  lockDescriptor,
  parseLockfile,
  resolveDependency,
  versionLine,
} = require('../dist/lockfile.js')
const { checkRoot, isYarn4 } = require('../dist/policy/root.js')
const { coreVersion, createFixtureRepo, fixtureFiles, gitEnvironment, tempDir } = require('./helpers/fixture-app.cjs')

const fixedNow = () => new Date('2026-11-03T12:00:00.000Z')
const basePackage = JSON.parse(fixtureFiles['package.json'])

function run(app, options = {}) {
  const out = path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment(), now: fixedNow, ...options })
  return { result, out, report: result.report }
}

function packageJson(changes) {
  return `${JSON.stringify({ ...basePackage, ...changes }, null, 2)}\n`
}

function lockEntry(name, version, extra = '') {
  return `\n"${name}@npm:${version}":\n  version: ${version}\n  resolution: "${name}@npm:${version}"\n  checksum: 10c0/${'1'.repeat(128)}\n  languageName: node\n  linkType: hard\n${extra}`
}

function errorRules(report) {
  return report.findings.filter((finding) => finding.level === 'error').map((finding) => `${finding.rule} ${finding.path}`)
}

/** Asserts that the report holds exactly `expected` errors, no tree was written and snapshotId is null. */
function assertErrors({ result, out, report }, expected) {
  assert.deepEqual(errorRules(report), expected)
  assert.equal(result.exitCode, 1)
  assert.equal(result.snapshotId, null)
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
}

test('the Step 3 fixture app passes the root checks and fills the report fields', () => {
  const { result, report } = run(createFixtureRepo())
  assert.deepEqual(report.findings, [])
  assert.equal(result.exitCode, 0)
  assert.match(result.snapshotId, /^[0-9a-f]{64}$/)
  assert.deepEqual(report.openMercato, { version: coreVersion, line: '0.9' })
  assert.deepEqual(report.enterprise, { dependency: false })
  assert.deepEqual(report.stock, { version: coreVersion, known: true })
  assert.equal(report.packageManager, 'yarn@4.12.0')
  assert.deepEqual(report.engines, { node: '>=24' })
  const notice = report.notices.find((item) => item.code === 'checks-incomplete')
  assert.match(notice.detail, /snapshot core and the root checks only/)
})

test('a mixed-line lockfile: root-om-mixed-lines', () => {
  const app = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': coreVersion, '@open-mercato/shared': '0.8.2' } }),
    'yarn.lock': fixtureFiles['yarn.lock'] + lockEntry('@open-mercato/shared', '0.8.2'),
  })
  const outcome = run(app)
  assertErrors(outcome, ['root-om-mixed-lines yarn.lock'])
  assert.match(outcome.report.findings[0].message, /0\.8, 0\.9/)
})

test('a transitive @open-mercato package on another line is mixed too; workspace entries are not', () => {
  const workspace = `\n"@open-mercato/local@workspace:packages/local":\n  version: 0.0.0-use.local\n  resolution: "@open-mercato/local@workspace:packages/local"\n  languageName: unknown\n  linkType: soft\n`
  const app = createFixtureRepo({ 'yarn.lock': fixtureFiles['yarn.lock'] + workspace + lockEntry('@open-mercato/shared', '0.10.0') })
  assertErrors(run(app), ['root-om-mixed-lines yarn.lock'])
  const onlyWorkspace = createFixtureRepo({ 'yarn.lock': fixtureFiles['yarn.lock'] + workspace })
  assert.deepEqual(run(onlyWorkspace).report.findings, [])
})

test('a missing yarn.lock: root-yarn-lock, and no unresolved finding on top', () => {
  assertErrors(run(createFixtureRepo({ 'yarn.lock': null })), ['root-yarn-lock yarn.lock'])
})

test('a Yarn 1 lockfile or a yarn.lock that is not YAML: root-yarn-lock', () => {
  const classic = `# yarn lockfile v1\n\n\n"@open-mercato/core@${coreVersion}":\n  version "${coreVersion}"\n  resolved "https://registry.yarnpkg.com/x.tgz"\n`
  const one = run(createFixtureRepo({ 'yarn.lock': classic }))
  assertErrors(one, ['root-yarn-lock yarn.lock'])
  assert.match(one.report.findings[0].message, /Yarn 1/)
  assertErrors(run(createFixtureRepo({ 'yarn.lock': 'a: [\n' })), ['root-yarn-lock yarn.lock'])
})

test('Yarn 3: root-package-manager', () => {
  const yarn3Lock = fixtureFiles['yarn.lock'].replace('version: 8\n  cacheKey: 10c0', 'version: 6\n  cacheKey: 8')
  const app = createFixtureRepo({ 'package.json': packageJson({ packageManager: 'yarn@3.6.4' }), 'yarn.lock': yarn3Lock })
  const outcome = run(app)
  assertErrors(outcome, ['root-package-manager package.json'])
  assert.equal(outcome.report.packageManager, 'yarn@3.6.4')
})

test('no packageManager, npm or pnpm: root-package-manager; Yarn 4 with a hash passes', () => {
  const withoutManager = { ...basePackage }
  delete withoutManager.packageManager
  assertErrors(run(createFixtureRepo({ 'package.json': `${JSON.stringify(withoutManager)}\n` })), ['root-package-manager package.json'])
  assertErrors(run(createFixtureRepo({ 'package.json': packageJson({ packageManager: 'pnpm@9.0.0' }) })), ['root-package-manager package.json'])
  assert.equal(isYarn4(`yarn@4.12.0+sha512.${'a'.repeat(16)}`), true)
  assert.equal(isYarn4('yarn@40.0.0'), false)
  assert.equal(isYarn4('yarn@4'), false)
})

test('the framework monorepo (packages/core/package.json named @open-mercato/core): root-monorepo', () => {
  const app = createFixtureRepo({ 'packages/core/package.json': '{"name": "@open-mercato/core", "version": "0.9.0"}\n' })
  assertErrors(run(app), ['root-monorepo packages/core/package.json'])
  const other = createFixtureRepo({ 'packages/core/package.json': '{"name": "@acme/core"}\n' })
  assert.deepEqual(run(other).report.findings, [])
})

test('a .template file: template-file', () => {
  const app = createFixtureRepo({ 'src/emails/welcome.html.template': '<p>Hi</p>\n', 'docs/template.md': '# not a .template file\n' })
  assertErrors(run(app), ['template-file src/emails/welcome.html.template'])
})

test('root workspaces alone: warning root-workspaces, no error, the snapshot is written', () => {
  const { result, out, report } = run(createFixtureRepo({ 'package.json': packageJson({ workspaces: ['packages/*'] }) }))
  assert.deepEqual(
    report.findings.map((finding) => `${finding.level} ${finding.rule} ${finding.path}`),
    ['warning root-workspaces package.json'],
  )
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.failures, [])
  assert.match(result.snapshotId, /^[0-9a-f]{64}$/)
  assert.equal(fs.existsSync(path.join(out, 'tree', 'package.json')), true)
})

test('no root package.json, or one that is not a JSON object: root-package-json', () => {
  assertErrors(run(createFixtureRepo({ 'package.json': null })), ['root-package-json package.json'])
  assertErrors(run(createFixtureRepo({ 'package.json': '[1, 2]\n' })), ['root-package-json package.json'])
  assertErrors(run(createFixtureRepo({ 'package.json': '{ not json\n' })), ['root-package-json package.json'])
})

test('no @open-mercato/core dependency: root-not-om-app', () => {
  const app = createFixtureRepo({ 'package.json': packageJson({ dependencies: { react: '19.0.0' } }) })
  const outcome = run(app)
  assertErrors(outcome, ['root-not-om-app package.json'])
  // The lockfile still pins core, so the report still names the version.
  assert.deepEqual(outcome.report.openMercato, { version: coreVersion, line: '0.9' })
})

test('an @open-mercato dependency or dev dependency with no lockfile entry: root-om-unresolved', () => {
  const app = createFixtureRepo({
    'package.json': packageJson({ devDependencies: { '@open-mercato/cli': coreVersion } }),
  })
  const outcome = run(app)
  assertErrors(outcome, ['root-om-unresolved package.json'])
  assert.match(outcome.report.findings[0].message, /@open-mercato\/cli/)
  const noCore = run(createFixtureRepo({ 'yarn.lock': fixtureFiles['yarn.lock'].split('\n"@open-mercato/core')[0] }))
  assertErrors(noCore, ['root-om-unresolved package.json'])
  assert.equal(noCore.report.openMercato, null)
  assert.deepEqual(noCore.report.stock, { version: null, known: false })
})

test('enterprise.dependency is true when yarn.lock resolves @open-mercato/enterprise; it never blocks', () => {
  const app = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': coreVersion, '@open-mercato/enterprise': coreVersion } }),
    'yarn.lock': fixtureFiles['yarn.lock'] + lockEntry('@open-mercato/enterprise', coreVersion),
  })
  const { result, report } = run(app)
  assert.deepEqual(report.findings, [])
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.enterprise, { dependency: true })
})

test('an unknown core version: stock known false', () => {
  const next = '0.99.0'
  const app = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': next } }),
    'yarn.lock': fixtureFiles['yarn.lock'].replaceAll(coreVersion, next),
  })
  const { report } = run(app)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.openMercato, { version: next, line: '0.99' })
  assert.deepEqual(report.stock, { version: next, known: false })
})

test('the root checks read the pinned commit, not the worktree, unless --include-uncommitted', () => {
  const app = createFixtureRepo()
  fs.writeFileSync(path.join(app, 'package.json'), packageJson({ packageManager: 'yarn@3.6.4' }))
  fs.rmSync(path.join(app, 'yarn.lock'))
  assert.deepEqual(run(app).report.findings, [])
  assert.deepEqual(errorRules(run(app, { includeUncommitted: true }).report), [
    'root-package-manager package.json',
    'root-yarn-lock yarn.lock',
  ])
})

test('an export-ignored yarn.lock is not in the snapshot: root-yarn-lock', () => {
  const app = createFixtureRepo({ '.gitattributes': 'yarn.lock export-ignore\n' })
  assertErrors(run(app), ['root-yarn-lock yarn.lock'])
})

test('a repo error skips the root checks', () => {
  const app = createFixtureRepo({}, { commit: false })
  const { report } = run(app)
  assert.deepEqual(errorRules(report), ['no-commit .'])
  assert.equal(report.openMercato, null)
  assert.deepEqual(report.enterprise, { dependency: false })
})

test('checkRoot reads only the contents it is given', () => {
  const contents = new Map(Object.entries(fixtureFiles).map(([name, content]) => [name, Buffer.from(content)]))
  assert.deepEqual(checkRoot(contents).findings, [])
  contents.delete('package.json')
  assert.deepEqual(checkRoot(contents).findings.map((finding) => finding.rule), ['root-package-json'])
})

test('parseLockfile: failsafe strings, joined descriptors, patch resolutions, metadata version', () => {
  const text = `__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"left-pad@npm:^1.10.0, left-pad@npm:1.10.0":\n  version: 1.10.0\n  resolution: "left-pad@npm:1.10.0"\n\n"@scope/pkg@patch:@scope/pkg@npm%3A2.0.0#~/.yarn/patches/x.patch::locator=app%40workspace%3A.":\n  version: 2.0.0\n  resolution: "@scope/pkg@patch:@scope/pkg@npm%3A2.0.0#~/.yarn/patches/x.patch::version=2.0.0&hash=abc"\n`
  const lockfile = parseLockfile(text)
  assert.equal(lockfile.metadataVersion, '8')
  assert.deepEqual(lockfile.entries[0], {
    descriptors: ['left-pad@npm:^1.10.0', 'left-pad@npm:1.10.0'],
    name: 'left-pad',
    version: '1.10.0',
    resolution: 'left-pad@npm:1.10.0',
  })
  assert.equal(lockfile.entries[1].name, '@scope/pkg')
  assert.equal(resolveDependency(lockfile, 'left-pad', '^1.10.0').version, '1.10.0')
  assert.equal(resolveDependency(lockfile, 'missing', '1.0.0'), null)
})

test('parseLockfile refuses Yarn 1, YAML errors, duplicate keys and entries without a resolution', () => {
  assert.throws(() => parseLockfile('"a@^1":\n  version "1.0.0"\n'), LockfileError)
  assert.throws(() => parseLockfile('a: [\n'), LockfileError)
  assert.throws(() => parseLockfile('__metadata:\n  version: 8\n"a@npm:1":\n  version: 1\n'), LockfileError)
  assert.throws(
    () => parseLockfile('__metadata:\n  version: 8\n"a@npm:1":\n  version: 1\n  resolution: a@npm:1\n"a@npm:1":\n  version: 1\n  resolution: a@npm:1\n'),
    LockfileError,
  )
  assert.throws(() => parseLockfile('- a\n'), LockfileError)
})

test('resolveDependency: descriptor first, then the only entry, then the highest version', () => {
  const lockfile = parseLockfile(
    `__metadata:\n  version: 8\n"x@npm:^1.0.0":\n  version: 1.2.0\n  resolution: "x@npm:1.2.0"\n"x@npm:^2.0.0":\n  version: 2.0.0-rc.1\n  resolution: "x@npm:2.0.0-rc.1"\n"x@npm:1.10.0":\n  version: 1.10.0\n  resolution: "x@npm:1.10.0"\n`,
  )
  assert.equal(resolveDependency(lockfile, 'x', '^1.0.0').version, '1.2.0')
  assert.equal(resolveDependency(lockfile, 'x', 'github:a/b').version, '2.0.0-rc.1')
  assert.equal(resolveDependency(lockfile, 'x', null).version, '2.0.0-rc.1')
})

test('descriptor helpers, version lines and comparison', () => {
  assert.equal(descriptorName('@open-mercato/core@npm:0.9.0'), '@open-mercato/core')
  assert.equal(descriptorName('left-pad@npm:1.0.0'), 'left-pad')
  assert.equal(lockDescriptor('a', '^1.0.0'), 'a@npm:^1.0.0')
  assert.equal(lockDescriptor('a', 'workspace:*'), 'a@workspace:*')
  assert.equal(lockDescriptor('a', 'npm:b@1'), 'a@npm:b@1')
  assert.equal(versionLine('0.9.0'), '0.9')
  assert.equal(versionLine('0.10.1-canary.3'), '0.10')
  assert.equal(versionLine('latest'), null)
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0)
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

