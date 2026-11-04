// Spec Step 7: the secret scan and the opaque file check, through the
// internal prepare() entry point and the scanner functions. "Exit 1" means
// prepare() returns an error finding and snapshotId null; stdout, stderr and
// the --json envelope are checked in Step 8, when prepare is on the CLI.
//
// No secret-looking value is committed (AGENTS.md): every fixture below is
// assembled at test time from parts and deterministic pseudo-random text, so
// neither GitHub push protection nor a secret scanner flags this file.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { prepare } = require('../dist/prepare.js')
const { scanText, scanSecrets, scanPath, scanCredentialUrls, scanYarnAuth, shannonEntropy } = require('../dist/policy/secrets.js')
const { classifyContent, decodeForScan, isText } = require('../dist/policy/opaque.js')
const { bundledRules } = require('../dist/rules/gitleaks.js')
const { extraRules } = require('../dist/rules/extra.js')
const { stockTable } = require('../dist/stock.js')
const { createFixtureRepo, fixtureFiles, gitEnvironment, tempDir } = require('./helpers/fixture-app.cjs')

const fixedNow = () => new Date('2026-11-03T12:00:00.000Z')
const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const digits = '0123456789'
const upperBase32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Deterministic text of `length` characters of `alphabet`, from the sha256 of `seed`. */
function randomText(seed, length, alphabet = alnum) {
  let text = ''
  for (let counter = 0; text.length < length; counter += 1)
    for (const byte of crypto.createHash('sha256').update(`${seed}:${counter}`).digest()) if (text.length < length) text += alphabet[byte % alphabet.length]
  return text
}

const join = (...parts) => parts.join('')

/** The fixture secrets, each assembled from parts, with the rule that must find it. */
const secrets = [
  { name: 'OpenAI project key with the marker', ruleId: 'openai-api-key', value: join('sk-', 'proj-', randomText('oa1', 74), 'T3Blbk', 'FJ', randomText('oa2', 74)) },
  { name: 'OpenAI project key without the marker', ruleId: 'openai-api-key-unmarked', value: join('sk-', 'proj-', randomText('oa3', 48)) },
  { name: 'OpenAI service account key without the marker', ruleId: 'openai-api-key-unmarked', value: join('sk-', 'svcacct-', randomText('oa4', 48)) },
  { name: 'Stripe live secret key', ruleId: 'stripe-access-token', value: join('sk', '_live_', randomText('st1', 32)) },
  { name: 'Stripe live restricted key', ruleId: 'stripe-access-token', value: join('rk', '_live_', randomText('st2', 32)) },
  { name: 'Stripe test secret key', ruleId: 'stripe-access-token', value: join('sk', '_test_', randomText('st3', 32)) },
  { name: 'Stripe webhook secret', ruleId: 'stripe-webhook-secret', value: join('wh', 'sec_', randomText('st4', 32)) },
  { name: 'Slack bot token', ruleId: 'slack-bot-token', value: join('xo', 'xb-', randomText('sl1', 12, digits), '-', randomText('sl2', 12, digits), '-', randomText('sl3', 24)) },
  {
    name: 'Slack user token',
    ruleId: 'slack-user-token',
    value: join('xo', 'xp-', randomText('sl4', 12, digits), '-', randomText('sl5', 12, digits), '-', randomText('sl6', 12, digits), '-', randomText('sl7', 32)),
  },
  { name: 'Slack webhook', ruleId: 'slack-webhook-url', value: join('https://hooks', '.slack.com/services/', randomText('sl8', 44)) },
  { name: 'GitHub PAT', ruleId: 'github-pat', value: join('gh', 'p_', randomText('gh1', 36)) },
  { name: 'npm token', ruleId: 'npm-access-token', value: join('np', 'm_', randomText('np1', 36, 'abcdefghijklmnopqrstuvwxyz0123456789')) },
  { name: 'AWS access key', ruleId: 'aws-access-token', value: join('AK', 'IA', randomText('aw1', 16, upperBase32)) },
]

/** A PEM private key of `lines` base64 lines, assembled from parts. */
function privateKey(seed, lines = 6) {
  const label = join('RSA ', 'PRIVATE', ' KEY')
  const body = Array.from({ length: lines }, (_, index) => crypto.createHash('sha512').update(`${seed}:${index}`).digest('base64'))
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`].join('\n')
}

const pem = privateKey('pk1')
/** Every fixture value, for the no-leak assertions. */
const allValues = [...secrets.map((item) => item.value), pem.split('\n')[1]]

function run(app, options = {}) {
  const out = options.out ?? path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment(), now: fixedNow, ...options })
  return { result, out, report: result.report }
}

function treeHas(out, relative) {
  return fs.existsSync(path.join(out, 'tree', ...relative.split('/')))
}

function assertNoValue(text, values = allValues) {
  for (const value of values) assert.equal(text.includes(value), false, 'a fixture secret appears in the output')
}

/** The source file of the hard-coded secrets: one value per line, from line 2. */
const keysFile = ['// Values the tool must refuse to export.', ...secrets.map((item, index) => `export const value${index} = '${item.value}'`), ''].join('\n')

test('each fixture secret hard-coded in a source file: exit 1, secret with its ruleId, path and line', () => {
  const { result, report, out } = run(createFixtureRepo({ 'src/lib/keys.ts': keysFile }))
  assert.equal(result.exitCode, 1)
  assert.equal(result.snapshotId, null)
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
  const found = report.findings.filter((finding) => finding.path === 'src/lib/keys.ts')
  assert.deepEqual(
    found.map((finding) => ({ rule: finding.rule, level: finding.level, ruleId: finding.ruleId, line: finding.line })),
    secrets.map((item, index) => ({ rule: 'secret', level: 'error', ruleId: item.ruleId, line: index + 2 })),
  )
  assert.deepEqual(result.failures, report.findings.filter((finding) => finding.level === 'error'))
})

test('report.json and the returned result contain none of the fixture secrets', () => {
  const app = createFixtureRepo({
    'src/lib/keys.ts': keysFile,
    'src/lib/signing.ts': `export const pem = \`\n${pem}\n\`\n`,
    'docker-compose.yml': `services:\n  app:\n    environment:\n      DATABASE_URL: ${join('postgres://postgres:', 'Hunter2-', randomText('db0', 12), '@db:5432/app')}\n`,
  })
  const { result, out } = run(app)
  assert.equal(result.exitCode, 1)
  const reportText = fs.readFileSync(path.join(out, 'report.json'), 'utf8')
  assert.equal(JSON.parse(reportText).findings.length > secrets.length, true)
  assertNoValue(reportText)
  assertNoValue(JSON.stringify(result))
  // Not even a distinctive part of a value: the random bodies.
  assertNoValue(reportText, [randomText('oa3', 48), randomText('st1', 32), randomText('gh1', 36), randomText('db0', 12)])
})

test('a multi-line private key: found, with the line where it starts', () => {
  const content = ['// Signing material.', '', 'export const pem = `', pem, '`', ''].join('\n')
  const { result, report } = run(createFixtureRepo({ 'src/lib/signing.ts': content }))
  assert.equal(result.exitCode, 1)
  const found = report.findings.filter((finding) => finding.path === 'src/lib/signing.ts')
  assert.deepEqual(
    found.map((finding) => [finding.rule, finding.ruleId, finding.line]),
    [['secret', 'private-key', 4]],
  )
})

test('the generated mercato-template.json is scanned too', () => {
  const key = join('AK', 'IA', randomText('aw2', 16, upperBase32))
  const packageJson = JSON.parse(fixtureFiles['package.json'])
  packageJson.description = `A demo app that ships the key ${key} by mistake.`
  const { result, report } = run(createFixtureRepo({ 'package.json': `${JSON.stringify(packageJson, null, 2)}\n` }))
  assert.equal(result.exitCode, 1)
  const paths = report.findings.filter((finding) => finding.rule === 'secret').map((finding) => `${finding.path} ${finding.ruleId}`)
  assert.deepEqual(paths, ['mercato-template.json aws-access-token', 'package.json aws-access-token'])
  assertNoValue(JSON.stringify(result), [key])
})

test('a changed DATABASE_URL password in source: credential-url with the ${POSTGRES_PASSWORD} hint', () => {
  const url = join('postgres://postgres:', 'my-', 'changed-', 'pw', '@localhost:5432/open-mercato')
  const { result, report } = run(createFixtureRepo({ 'src/db.ts': `// Database.\nexport const databaseUrl = '${url}'\n` }))
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.rule, finding.path, finding.line]),
    [['credential-url', 'src/db.ts', 2]],
  )
  assert.match(report.findings[0].message, /\$\{POSTGRES_PASSWORD\}/)
  assertNoValue(JSON.stringify(result), [url, 'my-changed-pw'])
})

const [stockComposeUrl, stockDatabaseUrl] = stockTable.versions['0.9.0'].credentialUrls

test('the stock DATABASE_URL and the stock compose URLs: no finding; the snapshot is written', () => {
  assert.match(stockDatabaseUrl, /^postgres:\/\/postgres:postgres@localhost/)
  assert.match(stockComposeUrl, /\$\{POSTGRES_PASSWORD:-postgres\}/)
  const { result, report } = run(
    createFixtureRepo({
      'src/db.ts': `export const fallback = '${stockDatabaseUrl}'\n`,
      'docker-compose.yml': `services:\n  app:\n    environment:\n      DATABASE_URL: ${stockComposeUrl}\n`,
    }),
  )
  assert.deepEqual(report.findings, [])
  assert.equal(result.exitCode, 0)
  assert.match(result.snapshotId, /^[0-9a-f]{64}$/)
})

test('a 0.8.0 stock compose URL in an app pinned to 0.9.0: no finding', () => {
  // In the real table the 0.8.0 and 0.9.0 URLs are the same strings.
  const url = stockTable.versions['0.8.0'].credentialUrls[0]
  const { report } = run(createFixtureRepo({ 'docker-compose.yml': `x:\n  url: ${url}\n` }))
  assert.equal(report.stock.version, '0.9.0')
  assert.deepEqual(report.findings, [])
  // A table where the URL exists only in 0.8.0: still stock, whatever the app's version.
  const oldUrl = join('postgres://old', ':old-', 'pw@db/app')
  const table = {
    ...stockTable,
    versions: {
      '0.8.0': { ...stockTable.versions['0.8.0'], credentialUrls: [oldUrl] },
      '0.9.0': { ...stockTable.versions['0.9.0'], credentialUrls: [] },
    },
  }
  assert.deepEqual(scanCredentialUrls('compose.yml', `url: ${oldUrl}\n`, table), [])
  assert.equal(scanCredentialUrls('compose.yml', `url: ${oldUrl.replace(':old-', ':new-')}\n`, table).length, 1)
})

test('a stock compose URL with only the database name changed: credential-url with the ${POSTGRES_PASSWORD} hint', () => {
  const changed = stockComposeUrl.replace('${POSTGRES_DB:-open-mercato}', 'my-app')
  assert.notEqual(changed, stockComposeUrl)
  const { result, report } = run(createFixtureRepo({ 'docker-compose.yml': `services:\n  app:\n    environment:\n      DATABASE_URL: ${changed}\n` }))
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.rule, finding.path, finding.line]),
    [['credential-url', 'docker-compose.yml', 4]],
  )
  assert.match(report.findings[0].message, /\$\{POSTGRES_PASSWORD\}/)
})

test('variable-only passwords are not credentials; a variable with a default is', () => {
  assert.deepEqual(scanCredentialUrls('a.yml', 'url: postgres://${U}:${P}@db/app\n'), [])
  assert.deepEqual(scanCredentialUrls('a.yml', 'url: postgres://$U:$P@db/app\n'), [])
  const withDefault = scanCredentialUrls('a.yml', join('one: 1\nurl: postgres://${U}:${P:-', 'hunter2', '}@db/app\n'))
  assert.deepEqual(
    withDefault.map((finding) => [finding.rule, finding.level, finding.path, finding.line]),
    [['credential-url', 'error', 'a.yml', 2]],
  )
  assert.equal(JSON.stringify(withDefault).includes('hunter2'), false)
  const { report } = run(createFixtureRepo({ 'compose.yml': 'url: postgres://${U}:${P}@db/app\n' }))
  assert.deepEqual(report.findings, [])
})

test('the stock 0.9.0 .env.example, passed to the scanner: no secret finding', () => {
  // The file is not exported before Step 8, so it is passed to the scanner directly.
  const text = stockTable.files[stockTable.versions['0.9.0'].envExample]
  assert.deepEqual(scanText('.env.example', text), [])
  // TENANT_DATA_ENCRYPTION_FALLBACK_KEY has entropy 4.13 and passes
  // generic-api-key only through its stopwords: without the ones it contains
  // (dev-, back, and ant- of "tenant-") it is a finding.
  const line = text.split('\n').find((item) => item.startsWith('TENANT_DATA_ENCRYPTION_FALLBACK_KEY='))
  const value = line.split('=')[1]
  assert.equal(shannonEntropy(value).toFixed(2), '4.13')
  const generic = bundledRules.rules.find((rule) => rule.id === 'generic-api-key')
  const contained = generic.allowlists.flatMap((allowlist) => allowlist.stopwords).filter((word) => value.toLowerCase().includes(word))
  assert.deepEqual(contained.sort(), ['ant-', 'back', 'dev-'])
  const without = {
    ...generic,
    allowlists: generic.allowlists.map((allowlist) => ({ ...allowlist, stopwords: allowlist.stopwords.filter((word) => !contained.includes(word)) })),
  }
  assert.deepEqual(
    scanSecrets('.env.example', `${line}\n`, { rules: [without], extra: [] }).map((finding) => [finding.ruleId, finding.line]),
    [['generic-api-key', 1]],
  )
})

test('every known stock .env.example passes the scan', () => {
  for (const [version, entry] of Object.entries(stockTable.versions))
    if (entry.envExample) assert.deepEqual(scanText('.env.example', stockTable.files[entry.envExample]), [], version)
})

test('.yarnrc.yml with npmAuthToken or npmAuthIdent: yarn-auth, whatever the value', () => {
  const yarnrc = 'nodeLinker: node-modules\nnpmAuthToken: "${NPM_TOKEN}"\n'
  const { result, report } = run(createFixtureRepo({ '.yarnrc.yml': yarnrc }))
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.rule, finding.path, finding.line]),
    [['yarn-auth', '.yarnrc.yml', 2]],
  )
  assert.deepEqual(
    scanYarnAuth('packages/x/.yarnrc.yml', 'npmScopes:\n  acme:\n    npmAuthIdent: user\n').map((finding) => finding.line),
    [3],
  )
  assert.deepEqual(scanYarnAuth('docs/yarnrc.md', 'npmAuthToken: x\n'), [])
})

test('a tracked backup.sql: opaque-file; exported with allowFiles ["backup.sql"]', () => {
  const app = createFixtureRepo({ 'backup.sql': 'INSERT INTO users (id) VALUES (1);\n' })
  const refused = run(app)
  assert.equal(refused.result.exitCode, 1)
  assert.deepEqual(
    refused.report.findings.map((finding) => [finding.rule, finding.level, finding.path]),
    [['opaque-file', 'error', 'backup.sql']],
  )
  assert.deepEqual(refused.report.allowFiles, [])
  const allowed = run(app, { allowFiles: ['backup.sql'] })
  assert.equal(allowed.result.exitCode, 0)
  assert.deepEqual(allowed.report.findings, [])
  assert.deepEqual(allowed.report.allowFiles, [{ path: 'backup.sql', used: true }])
  assert.equal(treeHas(allowed.out, 'backup.sql'), true)
})

test('an allowed opaque text file is still scanned for secrets', () => {
  const key = join('gh', 'p_', randomText('gh2', 36))
  const { result, report } = run(createFixtureRepo({ 'seed.sql': `INSERT INTO tokens VALUES ('${key}');\n` }), { allowFiles: ['seed.sql'] })
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.rule, finding.ruleId, finding.line]),
    [['secret', 'github-pat', 1]],
  )
})

const pngBytes = Buffer.concat([Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d), Buffer.from('IHDR'), Buffer.alloc(17)])
const zipBytes = Buffer.concat([Buffer.from('PK'), Buffer.of(0x03, 0x04), Buffer.alloc(26), Buffer.from('logo.png')])

test('a ZIP named logo.png: opaque-file; a real PNG is exported', () => {
  const { result, report, out } = run(createFixtureRepo({ 'public/logo.png': zipBytes, 'public/real.png': pngBytes }))
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.rule, finding.path]),
    [['opaque-file', 'public/logo.png'], ['image', 'public/real.png']],
  )
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
  const clean = run(createFixtureRepo({ 'public/real.png': pngBytes }))
  assert.equal(clean.result.exitCode, 0)
  assert.deepEqual(clean.report.images, [{ path: 'public/real.png', size: pngBytes.length }])
  assert.equal(treeHas(clean.out, 'public/real.png'), true)
})

test('allowFiles naming a path that is missing or not opaque: warning allow-file-unused, not exported on its own', () => {
  const { result, report } = run(createFixtureRepo(), { allowFiles: ['missing.bin', 'package.json', 'missing.bin'] })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.allowFiles, [
    { path: 'missing.bin', used: false },
    { path: 'package.json', used: false },
  ])
  assert.deepEqual(
    report.findings.map((finding) => [finding.rule, finding.level, finding.path]),
    [
      ['allow-file-unused', 'warning', 'missing.bin'],
      ['allow-file-unused', 'warning', 'package.json'],
    ],
  )
  assert.throws(() => run(createFixtureRepo(), { allowFiles: 'backup.sql' }), (error) => error.exitCode === 2)
  assert.throws(() => run(createFixtureRepo(), { allowFiles: [''] }), (error) => error.exitCode === 2)
})

test('a path-only rule (pkcs12-file) is a finding on the path, with no line', () => {
  const p12 = Buffer.concat([Buffer.of(0x30, 0x82, 0x0a, 0x00, 0x02, 0x01, 0x03), Buffer.alloc(16)])
  const { result, report } = run(createFixtureRepo({ 'certs/client.p12': p12 }), { allowFiles: ['certs/client.p12'] })
  assert.equal(result.exitCode, 1)
  assert.deepEqual(report.findings, [
    { rule: 'secret', level: 'error', path: 'certs/client.p12', ruleId: 'pkcs12-file', message: report.findings[0].message },
  ])
  assert.deepEqual(scanPath('certs/client.pem.txt'), [])
})

test('classifyContent: text, image and font signatures, archive and database extensions', () => {
  const nul = Buffer.alloc(8)
  assert.equal(isText(Buffer.from('plain text\n')), true)
  assert.equal(isText(Buffer.from('a\0b')), false)
  assert.equal(isText(Buffer.of(0xc3, 0x28)), false)
  assert.equal(classifyContent('a/icon.svg', Buffer.from('<svg/>')), 'text')
  assert.equal(classifyContent('a/x.png', pngBytes), 'media')
  assert.equal(classifyContent('a/X.PNG', pngBytes), 'media')
  assert.equal(classifyContent('a/x.jpg', pngBytes), 'opaque')
  assert.equal(classifyContent('a/x.jpeg', Buffer.concat([Buffer.of(0xff, 0xd8, 0xff, 0xe0), nul])), 'media')
  assert.equal(classifyContent('a/x.gif', Buffer.concat([Buffer.from('GIF89a'), nul])), 'media')
  assert.equal(classifyContent('a/x.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.of(0, 0, 0, 0), Buffer.from('WEBPVP8 '), nul])), 'media')
  assert.equal(classifyContent('a/x.avif', Buffer.concat([Buffer.of(0, 0, 0, 0x1c), Buffer.from('ftypavif'), Buffer.of(0, 0, 0, 0), Buffer.from('avifmif1miaf'), nul])), 'media')
  assert.equal(classifyContent('a/x.avif', Buffer.concat([Buffer.of(0, 0, 0, 0x18), Buffer.from('ftypmif1'), Buffer.of(0, 0, 0, 0), Buffer.from('avifmiaf'), nul])), 'media')
  assert.equal(classifyContent('a/x.avif', Buffer.concat([Buffer.of(0, 0, 0, 0x14), Buffer.from('ftypisom'), Buffer.of(0, 0, 0, 0), Buffer.from('mp41'), nul])), 'opaque')
  assert.equal(classifyContent('a/x.bmp', Buffer.concat([Buffer.from('BM'), nul])), 'media')
  assert.equal(classifyContent('a/favicon.ico', Buffer.concat([Buffer.of(0, 0, 1, 0), nul])), 'media')
  assert.equal(classifyContent('a/x.icns', Buffer.concat([Buffer.from('icns'), nul])), 'media')
  assert.equal(classifyContent('a/x.woff', Buffer.concat([Buffer.from('wOFF'), nul])), 'media')
  assert.equal(classifyContent('a/x.woff2', Buffer.concat([Buffer.from('wOF2'), nul])), 'media')
  assert.equal(classifyContent('a/x.ttf', Buffer.concat([Buffer.of(0, 1, 0, 0), nul])), 'media')
  assert.equal(classifyContent('a/x.otf', Buffer.concat([Buffer.from('OTTO'), nul])), 'media')
  const eot = Buffer.alloc(40)
  eot[34] = 0x4c
  eot[35] = 0x50
  assert.equal(classifyContent('a/x.eot', eot), 'media')
  assert.equal(classifyContent('a/x.woff', zipBytes), 'opaque')
  assert.equal(classifyContent('a/x.bin', nul), 'opaque')
  assert.equal(classifyContent('Makefile', nul), 'opaque')
  for (const extension of ['zip', 'tar', 'tgz', 'gz', 'bz2', 'xz', '7z', 'rar', 'jar', 'sql', 'dump', 'bak', 'sqlite', 'sqlite3', 'db'])
    assert.equal(classifyContent(`x/file.${extension}`, Buffer.from('text\n')), 'opaque', extension)
  assert.equal(classifyContent('src/migrations/Migration20260101.ts', Buffer.from('export class M {}\n')), 'text')
})

test('shannonEntropy follows gitleaks: code point counts over the UTF-8 byte length', () => {
  assert.equal(shannonEntropy(''), 0)
  assert.equal(shannonEntropy('aaaa'), 0)
  assert.equal(shannonEntropy('ab'), 1)
  assert.equal(shannonEntropy('abcd'), 2)
  // One code point of two bytes: frequency 1/2, so 0.5 bits, as Go's len() gives.
  assert.equal(shannonEntropy('\u00e9'), 0.5)
})

/** A synthetic rule in the bundled shape, for the matcher semantics. */
function rule(overrides) {
  return { id: 'test-rule', regex: { source: 'tok_([a-z0-9]{8})', flags: '' }, secretGroup: 0, entropy: null, keywords: [], path: null, allowlists: [], ...overrides }
}
const only = (...rules) => ({ rules, extra: [] })
const ids = (findings) => findings.map((finding) => `${finding.ruleId}:${finding.line}`)

test('matcher: keywords prefilter, case-insensitive, and the rule path filter', () => {
  const text = 'a = "tok_abcd1234"\n'
  assert.deepEqual(ids(scanSecrets('a.ts', text, only(rule({ keywords: ['TOK_'] })))), ['test-rule:1'])
  assert.deepEqual(ids(scanSecrets('a.ts', text, only(rule({ keywords: ['nope'] })))), [])
  const pathRule = rule({ path: { source: '\\.ts$', flags: '' } })
  assert.deepEqual(ids(scanSecrets('a.ts', text, only(pathRule))), ['test-rule:1'])
  assert.deepEqual(ids(scanSecrets('a.md', text, only(pathRule))), [])
})

test('matcher: secretGroup, the first non-empty group, and entropy at most the threshold is dropped', () => {
  const text = 'tok_aaaaaaaa tok_abcdefgh\n'
  // Entropy of the group: 0 for aaaaaaaa, 3 for abcdefgh. Threshold 3 drops both (<=), 2.9 keeps one.
  assert.deepEqual(ids(scanSecrets('a', text, only(rule({ entropy: 3 })))), [])
  assert.deepEqual(ids(scanSecrets('a', text, only(rule({ entropy: 2.9 })))), ['test-rule:1'])
  const twoGroups = rule({ regex: { source: '(x)?tok_([a-z]{8})', flags: '' }, entropy: 2.9 })
  assert.deepEqual(ids(scanSecrets('a', 'tok_abcdefgh\n', only(twoGroups))), ['test-rule:1'])
  assert.deepEqual(ids(scanSecrets('a', 'tok_abcdefgh\n', only({ ...twoGroups, secretGroup: 1 }))), [])
})

test('matcher: allowlists by regexTarget, stopwords, OR and AND with paths', () => {
  const text = 'const x = "tok_abcd1234" // fixture\n'
  const allow = (allowlist) => only(rule({ allowlists: [{ condition: 'OR', regexTarget: 'secret', regexes: [], stopwords: [], ...allowlist }] }))
  assert.deepEqual(ids(scanSecrets('a', text, allow({ regexes: [{ source: '^abcd', flags: '' }] }))), [])
  assert.deepEqual(ids(scanSecrets('a', text, allow({ regexes: [{ source: '^tok_', flags: '' }] }))), ['test-rule:1'])
  assert.deepEqual(ids(scanSecrets('a', text, allow({ regexTarget: 'match', regexes: [{ source: '^tok_', flags: '' }] }))), [])
  assert.deepEqual(ids(scanSecrets('a', text, allow({ regexTarget: 'line', regexes: [{ source: '// fixture$', flags: '' }] }))), [])
  assert.deepEqual(ids(scanSecrets('a', text, allow({ stopwords: ['ABCD'] }))), [])
  assert.deepEqual(ids(scanSecrets('a', text, allow({ stopwords: ['tok_'] }))), ['test-rule:1'], 'stopwords test the secret group')
  const and = allow({ condition: 'AND', stopwords: ['abcd'], paths: [{ source: '^test/', flags: '' }] })
  assert.deepEqual(ids(scanSecrets('test/a.ts', text, and)), [])
  assert.deepEqual(ids(scanSecrets('src/a.ts', text, and)), ['test-rule:1'])
})

test('matcher: a generic finding inside a better one is dropped; an extra rule yields to a bundled one on its line', () => {
  const text = join('api', '_key = "tok_', 'abcd1234"\n')
  const specific = rule({ id: 'specific', regex: { source: 'tok_[a-z0-9]{8}', flags: '' } })
  const generic = rule({ id: 'generic-thing', regex: { source: 'key = "([a-z_0-9]+)"', flags: '' } })
  assert.deepEqual(ids(scanSecrets('a', text, only(specific, generic))), ['specific:1'])
  assert.deepEqual(ids(scanSecrets('a', text, only(generic))), ['generic-thing:1'])
  assert.deepEqual(ids(scanSecrets('a', text, { rules: [specific], extra: [rule({ id: 'extra' })] })), ['specific:1'])
  assert.deepEqual(ids(scanSecrets('a', text, { rules: [], extra: [rule({ id: 'extra' })] })), ['extra:1'])
})

test('the extra rules: OpenAI without the marker, Stripe webhook secrets and the create-mercato-module floor', () => {
  const extra = { rules: [], extra: extraRules }
  const cases = [
    ['openai-api-key-unmarked', join('sk-', 'admin-', randomText('oa5', 30))],
    ['stripe-webhook-secret', join('wh', 'sec_', randomText('st5', 24))],
    ['floor-private-key', join('-----BEGIN ', 'PRIVATE', ' KEY-----')],
    ['floor-github-token', join('github', '_pat_', randomText('gh3', 40))],
    ['floor-npm-token', join('np', 'm_', randomText('np2', 30))],
    ['floor-aws-access-key', join('AS', 'IA', randomText('aw3', 16, upperBase32))],
    ['floor-stripe-live-key', join('rk', '_live_', randomText('st6', 20))],
    ['floor-slack-token', join('xo', 'xa-', randomText('sl9', 12))],
    ['floor-google-api-key', join('AI', 'za', randomText('go1', 35))],
  ]
  for (const [ruleId, value] of cases) assert.deepEqual(ids(scanSecrets('a', `x = '${value}'\n`, extra)), [`${ruleId}:1`], ruleId)
  // The AWS documentation key of the stock .env.example ends in EXAMPLE: allowed, as in gitleaks.
  assert.deepEqual(ids(scanSecrets('a', `x = '${join('AK', 'IA', 'IOSFODNN7', 'EXAMPLE')}'\n`, extra)), [])
  // A public example key that the gitleaks gcp-api-key allowlist names: allowed by the floor too.
  assert.deepEqual(ids(scanSecrets('a', `x = '${join('AI', 'zaSy', 'abcdefghijklmnopqrstuvwxyz', '1234567')}'\n`, extra)), [])
  assert.deepEqual(ids(scanSecrets('a', `x = '${join('sk-', 'proj-', 'short')}'\n`, extra)), [])
})

test('regression: a value that an extra rule and generic-api-key both match on one line gets a finding', () => {
  const cases = [
    `export const stripeWebhookSecret = "${join('wh', 'sec_', randomText('st7', 32))}"`,
    `api_token = "${join('gh', 's_', randomText('gh4', 30))}"`,
    `const npmToken = "${join('np', 'm_', randomText('np3', 30))}"`,
    `slack_token = "${join('xo', 'xs-', randomText('sl10', 20))}"`,
  ]
  for (const line of cases) assert.equal(scanText('src/a.ts', `${line}\n`).length, 1, line.split('=')[0])
  const { result } = run(createFixtureRepo({ 'src/stripe.ts': `${cases[0]}\n` }))
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    result.failures.map((finding) => [finding.rule, finding.path, finding.line]),
    [['secret', 'src/stripe.ts', 1]],
  )
})

test('an allowed opaque file that holds Latin-1 or UTF-16 text is still scanned', () => {
  const key = join('gh', 'p_', randomText('gh5', 36))
  const latin1 = Buffer.from(`// Caf\u00e9\nexport const t = '${key}'\n`, 'latin1')
  const utf16 = Buffer.concat([Buffer.of(0xff, 0xfe), Buffer.from(`$t = '${key}'\r\n`, 'utf16le')])
  assert.equal(isText(latin1), false)
  assert.equal(isText(utf16), false)
  const { result, report } = run(createFixtureRepo({ 'src/legacy.ts': latin1, 'scripts/setup.ps1': utf16 }), {
    allowFiles: ['src/legacy.ts', 'scripts/setup.ps1'],
  })
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.rule, finding.path, finding.ruleId, finding.line]),
    [
      ['secret', 'scripts/setup.ps1', 'github-pat', 1],
      ['secret', 'src/legacy.ts', 'github-pat', 2],
    ],
  )
  assert.deepEqual(report.allowFiles, [
    { path: 'src/legacy.ts', used: true },
    { path: 'scripts/setup.ps1', used: true },
  ])
  assertNoValue(JSON.stringify(result), [key])
})

test('decodeForScan: UTF-16 with a byte order mark, Latin-1 without NUL bytes, nothing for binary', () => {
  assert.equal(decodeForScan(Buffer.concat([Buffer.of(0xff, 0xfe), Buffer.from('hi', 'utf16le')])), 'hi')
  assert.equal(decodeForScan(Buffer.concat([Buffer.of(0xfe, 0xff), Buffer.from('hi', 'utf16le').swap16()])), 'hi')
  assert.equal(decodeForScan(Buffer.of(0x43, 0x61, 0x66, 0xe9)), 'Caf\u00e9')
  assert.equal(decodeForScan(zipBytes), null)
  // UTF-16 without a byte order mark, as Windows tools write it.
  assert.equal(decodeForScan(Buffer.from('$t = 1\r\n', 'utf16le')), '$t = 1\r\n')
  assert.equal(decodeForScan(Buffer.from('$t = 1\r\n', 'utf16le').swap16()), '$t = 1\r\n')
  assert.equal(decodeForScan(pngBytes), null)
})

test('many matches on one long line stay fast: the line allowlists run once per line', () => {
  const line = Array.from({ length: 8000 }, (_, index) => `apiKey:"k${index}Zq81x${index}"`).join(',')
  const started = process.hrtime.bigint()
  scanText('dist/app.js', `${line}\n`)
  const seconds = Number(process.hrtime.bigint() - started) / 1e9
  assert.ok(seconds < 5, `took ${seconds.toFixed(1)} s`)
})
