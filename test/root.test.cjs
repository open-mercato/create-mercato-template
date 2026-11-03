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
  frameworkNames,
  maxLockfileBytes,
  descriptorName,
  lockDescriptor,
  parseLockfile,
  resolveDependency,
  versionLine,
} = require('../dist/lockfile.js')
const { checkRoot, isPlainRange, isYarn4 } = require('../dist/policy/root.js')
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

/** The fixture yarn.lock with the core entry depending on `dependencies` (name to version), as a real core entry does. */
function coreDependingOn(dependencies) {
  const block = Object.entries(dependencies).map(([name, version]) => `    "${name}": "npm:${version}"\n`).join('')
  return fixtureFiles['yarn.lock'].replace(
    `  resolution: "@open-mercato/core@npm:${coreVersion}"\n`,
    `  resolution: "@open-mercato/core@npm:${coreVersion}"\n  dependencies:\n${block}`,
  )
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
  // Core 0.9.0 depends on shared 0.9.0, and the app pins shared 0.8.2 too.
  const app = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': coreVersion, '@open-mercato/shared': '0.8.2' } }),
    'yarn.lock':
      coreDependingOn({ '@open-mercato/shared': coreVersion }) +
      lockEntry('@open-mercato/shared', coreVersion) +
      lockEntry('@open-mercato/shared', '0.8.2'),
  })
  const outcome = run(app)
  assertErrors(outcome, ['root-om-mixed-lines yarn.lock'])
  assert.match(outcome.report.findings[0].message, /0\.8, 0\.9/)
})

test('a transitive framework package on another line is mixed too; workspace entries are not', () => {
  const workspace = `\n"@open-mercato/local@workspace:packages/local":\n  version: 0.0.0-use.local\n  resolution: "@open-mercato/local@workspace:packages/local"\n  dependencies:\n    "@open-mercato/core": "npm:${coreVersion}"\n  languageName: unknown\n  linkType: soft\n`
  const shared = `  dependencies:\n    "@open-mercato/cache": "npm:0.10.0"\n`
  const app = createFixtureRepo({
    'yarn.lock':
      coreDependingOn({ '@open-mercato/shared': coreVersion }) +
      workspace +
      lockEntry('@open-mercato/shared', coreVersion, '').replace('  checksum', `${shared}  checksum`) +
      lockEntry('@open-mercato/cache', '0.10.0'),
  })
  assertErrors(run(app), ['root-om-mixed-lines yarn.lock'])
  const onlyWorkspace = createFixtureRepo({ 'yarn.lock': fixtureFiles['yarn.lock'] + workspace })
  assert.deepEqual(run(onlyWorkspace).report.findings, [])
})

test('an @open-mercato package released on its own line is not a mixed line', () => {
  const app = createFixtureRepo({
    'package.json': packageJson({
      dependencies: { '@open-mercato/core': coreVersion, '@open-mercato/client': '^0.3.5' },
      devDependencies: { '@open-mercato/readiness-scanner': '0.1.0' },
    }),
    'yarn.lock':
      coreDependingOn({ '@open-mercato/shared': coreVersion }) +
      lockEntry('@open-mercato/shared', coreVersion) +
      lockEntry('@open-mercato/client', '0.3.5').replace('"@open-mercato/client@npm:0.3.5":', '"@open-mercato/client@npm:^0.3.5":') +
      lockEntry('@open-mercato/readiness-scanner', '0.1.0'),
  })
  const { result, report } = run(app)
  assert.deepEqual(report.findings, [])
  assert.equal(result.exitCode, 0)
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

test('a stale lockfile (package.json asks for a version yarn.lock lacks): root-om-unresolved, no openMercato', () => {
  const app = createFixtureRepo({ 'package.json': packageJson({ dependencies: { '@open-mercato/core': '0.9.1' } }) })
  const outcome = run(app)
  assertErrors(outcome, ['root-om-unresolved package.json'])
  assert.match(outcome.report.findings[0].message, /out of date/)
  assert.equal(outcome.report.openMercato, null)
})

test('a git or URL range is looked up by name, and the range never appears in a finding', () => {
  const secret = `ghp_${'Z'.repeat(36)}`
  const range = `git+https://x-access-token:${secret}@github.com/acme/ui.git`
  const known = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': coreVersion, '@open-mercato/ui': range } }),
    'yarn.lock': fixtureFiles['yarn.lock'] + lockEntry('@open-mercato/ui', coreVersion),
  })
  assert.deepEqual(run(known).report.findings, [])
  const stale = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': coreVersion, '@open-mercato/ui': `0.9.1 || ${secret}` } }),
    'yarn.lock': fixtureFiles['yarn.lock'] + lockEntry('@open-mercato/ui', coreVersion),
  })
  const outcome = run(stale)
  assertErrors(outcome, ['root-om-unresolved package.json'])
  assert.doesNotMatch(JSON.stringify(outcome.report), new RegExp(secret))
  assert.equal(fs.readFileSync(path.join(outcome.out, 'report.json'), 'utf8').includes(secret), false)
  assert.equal(isPlainRange('^0.9.0'), true)
  assert.equal(isPlainRange('npm:@acme/x@1'), true)
  assert.equal(isPlainRange('acme/ui'), false)
  assert.equal(isPlainRange('github:acme/ui'), false)
})

test('a framework package with no lockfile edge counts when it has an entry on core line', () => {
  const app = createFixtureRepo({
    'package.json': packageJson({
      dependencies: { '@open-mercato/core': coreVersion, '@open-mercato/search': '0.8.0', '@open-mercato/queue': coreVersion },
    }),
    'yarn.lock': fixtureFiles['yarn.lock'] + lockEntry('@open-mercato/search', '0.8.0') + lockEntry('@open-mercato/queue', coreVersion) + lockEntry('@open-mercato/search', coreVersion),
  })
  assertErrors(run(app), ['root-om-mixed-lines yarn.lock'])
})

test('a dependency that package.json resolutions overrides is looked up by name', () => {
  const app = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': '^0.9.0' }, resolutions: { '@open-mercato/core': coreVersion } }),
  })
  const { report } = run(app)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.openMercato, { version: coreVersion, line: '0.9' })
})

test('a link: core or an npm alias to another package does not name the Open Mercato version', () => {
  const linked = `\n"@open-mercato/core@link:../om/packages/core::locator=fixture-app%40workspace%3A.":\n  version: 0.0.0-use.local\n  resolution: "@open-mercato/core@link:../om/packages/core::locator=fixture-app%40workspace%3A."\n  languageName: node\n  linkType: soft\n`
  const linkApp = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': 'link:../om/packages/core' } }),
    'yarn.lock': fixtureFiles['yarn.lock'].split('\n"@open-mercato/core')[0] + linked,
  })
  const link = run(linkApp).report
  assert.deepEqual(link.findings, [])
  assert.equal(link.openMercato, null)
  const aliasApp = createFixtureRepo({
    'package.json': packageJson({ dependencies: { '@open-mercato/core': 'npm:@acme/core-fork@3.1.0' } }),
    'yarn.lock':
      fixtureFiles['yarn.lock'].split('\n"@open-mercato/core')[0] +
      `\n"@open-mercato/core@npm:@acme/core-fork@3.1.0":\n  version: 3.1.0\n  resolution: "@acme/core-fork@npm:3.1.0"\n  languageName: node\n  linkType: hard\n`,
  })
  assert.equal(run(aliasApp).report.openMercato, null)
})

test('a yarn.lock with YAML aliases (an alias bomb) is root-yarn-lock, not a crash', () => {
  const rows = ['__metadata:', '  version: 8', 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]']
  for (let index = 1; index < 9; index += 1) rows.push(`a${index}: &a${index} [${Array(10).fill(`*a${index - 1}`).join(', ')}]`)
  const outcome = run(createFixtureRepo({ 'yarn.lock': `${rows.join('\n')}\n` }))
  assertErrors(outcome, ['root-yarn-lock yarn.lock'])
  assert.match(outcome.report.findings[0].message, /aliases/)
})

test('a yarn.lock over the size bound is root-yarn-lock without parsing', () => {
  const huge = Buffer.alloc(maxLockfileBytes + 1, 0x20)
  assert.throws(() => parseLockfile(huge), (error) => error instanceof LockfileError && /larger than 16 MB/.test(error.message))
})

test('a Yarn 4.17 lockfile (__metadata version 10) passes', () => {
  const app = createFixtureRepo({ 'yarn.lock': fixtureFiles['yarn.lock'].replace('version: 8\n', 'version: 10\n') })
  assert.deepEqual(run(app).report.findings, [])
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
    dependencies: [],
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

test('resolveDependency: the descriptor when a range is given, else the only entry or the highest version', () => {
  const lockfile = parseLockfile(
    `__metadata:\n  version: 8\n"x@npm:^1.0.0":\n  version: 1.2.0\n  resolution: "x@npm:1.2.0"\n"x@npm:^2.0.0":\n  version: 2.0.0-rc.1\n  resolution: "x@npm:2.0.0-rc.1"\n"x@npm:1.10.0":\n  version: 1.10.0\n  resolution: "x@npm:1.10.0"\n"y@patch:y@npm%3A1.0.0#./p.patch::locator=app%40workspace%3A.":\n  version: 1.0.0\n  resolution: "y@patch:y@npm%3A1.0.0#./p.patch::version=1.0.0&hash=abc"\n`,
  )
  assert.equal(resolveDependency(lockfile, 'x', '^1.0.0').version, '1.2.0')
  assert.equal(resolveDependency(lockfile, 'x', '^3.0.0'), null)
  assert.equal(resolveDependency(lockfile, 'x', 'github:a/b'), null)
  assert.equal(resolveDependency(lockfile, 'x', null).version, '2.0.0-rc.1')
  assert.equal(resolveDependency(lockfile, 'y', 'patch:y@npm%3A1.0.0#./p.patch').version, '1.0.0')
})

test('frameworkNames: core and every @open-mercato name linked to it, in either direction', () => {
  const lockfile = parseLockfile(
    `__metadata:\n  version: 8\n"@o/core@npm:1.0.0":\n  version: 1.0.0\n  resolution: "@o/core@npm:1.0.0"\n  dependencies:\n    "@o/shared": "npm:1.0.0"\n"@o/shared@npm:1.0.0":\n  version: 1.0.0\n  resolution: "@o/shared@npm:1.0.0"\n  dependencies:\n    "@o/cache": "npm:1.0.0"\n"@o/cache@npm:1.0.0":\n  version: 1.0.0\n  resolution: "@o/cache@npm:1.0.0"\n"@o/search@npm:1.0.0":\n  version: 1.0.0\n  resolution: "@o/search@npm:1.0.0"\n  peerDependencies:\n    "@o/core": "*"\n"@o/client@npm:0.3.0":\n  version: 0.3.0\n  resolution: "@o/client@npm:0.3.0"\n`,
  )
  assert.deepEqual([...frameworkNames(lockfile, '@o/', '@o/core')].sort(), ['@o/cache', '@o/core', '@o/search', '@o/shared'])
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

