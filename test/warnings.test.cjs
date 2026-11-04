// Spec Step 8: the warnings and notices of the Rule table, report.images and
// exceeds-import-limits, through the prepare() entry point. Fixture
// repositories are built in a temp directory; no network.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { prepare } = require('../dist/prepare.js')
const { checkWarnings, isSeedFile, isExampleDomain, seedEmailLines } = require('../dist/policy/warnings.js')
const { createFixtureRepo, fixtureFiles, gitEnvironment, tempDir } = require('./helpers/fixture-app.cjs')
const { lockEntry, pngBytes, stockAppFiles, stockEnvExample, svgText } = require('./helpers/stock-app.cjs')

const fixedNow = () => new Date('2026-11-03T12:00:00.000Z')

function run(app, options = {}) {
  const out = options.out ?? path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment(), now: fixedNow, ...options })
  return { result, out, report: result.report }
}

function summary(report) {
  return report.findings.map(({ rule, level, path: where, line }) => (line === undefined ? `${level} ${rule} ${where}` : `${level} ${rule} ${where}:${line}`))
}

function codes(report) {
  return report.notices.map((notice) => notice.code)
}

const pngPaths = Array.from({ length: 8 }, (_, index) => `public/examples/example-${index + 1}.png`)
const svgPaths = ['public/favicon.svg', 'public/logo.svg', 'public/next.svg', 'public/vercel.svg']

test('a stock 0.9.0 app: no error, exactly the expected warnings, and its .env.example equals the stock file', () => {
  const { result, out, report } = run(createFixtureRepo(stockAppFiles()))
  assert.equal(result.exitCode, 0)
  assert.match(result.snapshotId, /^[0-9a-f]{64}$/)
  const storageLine = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'scaffold', 'v0.9.0', 'src', 'modules.ts'), 'utf8')
    .split('\n')
    .findIndex((line) => line.includes("id: 'storage_s3'")) + 1
  assert.deepEqual(summary(report), [
    'warning readme-missing README.md',
    'warning executable-config package.json',
    ...pngPaths.map((item) => `warning image ${item}`),
    ...svgPaths.map((item) => `warning image ${item}`),
    `warning module-package-unresolved src/modules.ts:${storageLine}`,
  ])
  assert.match(report.findings.find((finding) => finding.rule === 'executable-config').message, /preinstall/)
  assert.deepEqual(
    report.images,
    [...pngPaths, ...svgPaths].sort().map((item) => ({ path: item, size: report.files.find((file) => file.path === item).size })),
  )
  assert.equal(fs.readFileSync(path.join(out, 'tree', '.env.example'), 'utf8'), stockEnvExample())
  assert.deepEqual(report.env, { kept: [], emptied: [], declared: [], dropped: [] })
  assert.deepEqual(codes(report), ['code-only', 'enterprise-dependency'])
  assert.deepEqual(report.stock, { version: '0.9.0', known: true })
})

test('@open-mercato/enterprise in the lockfile alone: notice enterprise-dependency, no error', () => {
  const lock = fixtureFiles['yarn.lock'] + lockEntry('@open-mercato/enterprise', '0.9.0')
  const { result, report } = run(createFixtureRepo({ 'yarn.lock': lock }))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.enterprise, { dependency: true, modules: [] })
  assert.deepEqual(codes(report), ['code-only', 'enterprise-dependency'])
})

test('a seed email outside the example domains: warning seed-email with path and line, no address anywhere', () => {
  const address = ['jane.doe', '@', 'corp-mail', '.net'].join('')
  const other = ['ops', '@', 'real-company', '.io'].join('')
  const setup = [
    'export const users = [',
    "  { email: 'admin@example.com' },",
    "  { email: 'buyer@shop.acme.com' },",
    "  { email: 'qa@store.test' },",
    `  { email: '${address}' },`,
    '];',
    '',
  ].join('\n')
  const app = createFixtureRepo({
    'src/modules/shop/setup.ts': setup,
    'data-seeds/users.json': `{"email": "${other}"}\n`,
    'src/lib/contact.ts': `export const contact = '${other}'\n`,
  })
  const { result, out, report } = run(app)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(summary(report), ['warning seed-email data-seeds/users.json:1', 'warning seed-email src/modules/shop/setup.ts:5'])
  const reportText = fs.readFileSync(path.join(out, 'report.json'), 'utf8')
  for (const text of [reportText, JSON.stringify(result)])
    for (const value of [address, other, 'corp-mail', 'real-company']) assert.equal(text.includes(value), false, 'a seed email appears in the report')
})

test('isSeedFile and the example domains', () => {
  for (const item of ['src/modules/shop/setup.ts', 'seed/users.ts', 'db/seeds/a.json', 'scripts/seedData.ts', 'src/Seeder.ts']) assert.equal(isSeedFile(item), true, item)
  for (const item of ['src/setup.ts', 'src/modules/shop/lib/setup.ts', 'src/modules/shop/index.ts']) assert.equal(isSeedFile(item), false, item)
  for (const domain of ['example.com', 'EXAMPLE.com', 'a.example.com', 'acme.com', 'x.acme.com', 'shop.test', 'mail.example', 'nope.invalid', 'localhost']) assert.equal(isExampleDomain(domain), true, domain)
  for (const domain of ['example.org', 'notexample.com', 'acme.co', 'test.com']) assert.equal(isExampleDomain(domain), false, domain)
  assert.deepEqual(seedEmailLines(['"@open-mercato/core": "0.9.0"', 'pkg@npm:1.0.0', 'root@localhost', 'a@b.example.org'].join('\n')), [4])
})

test('a 5,001-file app: exceeds-import-limits', () => {
  const files = {}
  for (let index = 0; index < 5001 - Object.keys(fixtureFiles).length; index++) files[`assets/f${index}.txt`] = `${index}\n`
  const { result, report } = run(createFixtureRepo(files))
  assert.equal(result.exitCode, 0)
  // The fixture files, the extra files and the generated manifest.
  assert.equal(report.totals.files, 5002)
  assert.deepEqual(summary(report), ['warning exceeds-import-limits .'])
  assert.match(report.findings[0].message, /5002 files/)
})

test('executable-config: .yarnrc.yml yarnPath and plugins, workflows and lifecycle scripts', () => {
  const packageJson = JSON.parse(fixtureFiles['package.json'])
  packageJson.scripts = { postinstall: 'node scripts/setup.js', build: 'next build', prepare: 'husky' }
  const app = createFixtureRepo({
    'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
    '.yarnrc.yml': 'nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.12.0.cjs\nplugins:\n  - path: .yarn/plugins/x.cjs\n',
    '.github/workflows/ci.yml': 'on: push\n',
    '.github/workflows/nested/x.yml': 'on: push\n',
  })
  const { result, report } = run(app)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(summary(report), [
    'warning executable-config .github/workflows/ci.yml',
    'warning executable-config .yarnrc.yml:2',
    'warning executable-config .yarnrc.yml:3',
    'warning executable-config package.json',
    'warning executable-config package.json',
  ])
  assert.deepEqual(
    report.findings.filter((finding) => finding.path === 'package.json').map((finding) => /a (\w+) script/.exec(finding.message)[1]),
    ['postinstall', 'prepare'],
  )
})

test('ai-content: one warning with the count of exported files under .ai/', () => {
  const { result, report } = run(createFixtureRepo({ '.ai/specs/a.md': '# A\n', '.ai/runs/b.md': '# B\n', '.ai/sessions.json': '{}\n' }))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(summary(report), ['warning ai-content .ai'])
  assert.match(report.findings[0].message, /^2 exported files under \.ai\//)
})

test('readme-missing, and readme-stock when the README equals a stock README', () => {
  const missing = run(createFixtureRepo({ 'README.md': null }))
  assert.deepEqual(summary(missing.report), ['warning readme-missing README.md'])
  const readme = Buffer.from('# My app\n')
  const sha256 = crypto.createHash('sha256').update(readme).digest('hex')
  const table = { schema: 1, package: 'create-mercato-app', files: {}, versions: { '0.9.0': { envExample: null, env: {}, credentialUrls: [], readme: sha256 } } }
  const files = [{ path: 'README.md', mode: '100644', size: readme.length, sha256, origin: 'tree' }]
  const stock = checkWarnings({ files, contents: new Map([['README.md', readme]]), excluded: [], table })
  assert.deepEqual(summary(stock), ['warning readme-stock README.md'])
})

test('images: SVG and images whose signature matches, anywhere; sizes in report.images', () => {
  const app = createFixtureRepo({ 'src/assets/icon.svg': svgText(), 'docs/shot.PNG': pngBytes(1), 'public/fake.png': 'not an image\n' })
  // public/fake.png is text with an image extension: not an image.
  const { report } = run(app)
  assert.deepEqual(report.images, [
    { path: 'docs/shot.PNG', size: pngBytes(1).length },
    { path: 'src/assets/icon.svg', size: Buffer.byteLength(svgText()) },
  ])
  assert.deepEqual(
    report.findings.filter((finding) => finding.rule === 'image').map((finding) => finding.path),
    ['docs/shot.PNG', 'src/assets/icon.svg'],
  )
})

test('derived-from-template: package.json openMercatoTemplate is kept, with a notice', () => {
  const packageJson = { ...JSON.parse(fixtureFiles['package.json']), openMercatoTemplate: { repo: 'acme/crm-starter' } }
  const { result, out, report } = run(createFixtureRepo({ 'package.json': `${JSON.stringify(packageJson, null, 2)}\n` }))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(codes(report), ['code-only', 'derived-from-template'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'tree', 'package.json'), 'utf8')).openMercatoTemplate, { repo: 'acme/crm-starter' })
})

test('warnings come from the pinned commit: a README deleted in the worktree is still exported', () => {
  const app = createFixtureRepo()
  fs.rmSync(path.join(app, 'README.md'))
  const { report } = run(app)
  assert.deepEqual(codes(report), ['code-only', 'uncommitted-not-exported'])
  assert.deepEqual(summary(report), [])
})
