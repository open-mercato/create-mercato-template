// Spec Step 8: the env diff and the generated .env.example, --keep-env and
// the declared env in the manifest, through the prepare() entry point and the
// parser. Fixture repositories are built in a temp directory; no network.
//
// Secret-looking values are assembled from parts at test time (AGENTS.md).
// Every test that puts a non-stock value in .env.example checks that the
// value appears nowhere in report.json or the returned result.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { prepare } = require('../dist/prepare.js')
const { CliError } = require('../dist/errors.js')
const { parseEnvLines, isSecretLookingKey, describe: describeComment, buildEnv } = require('../dist/policy/env.js')
const { matchStock } = require('../dist/stock.js')
const { validate } = require('./helpers/json-schema.cjs')
const { createFixtureRepo, gitEnvironment, tempDir } = require('./helpers/fixture-app.cjs')
const { join, randomText } = require('./helpers/secret-fixtures.cjs')
const { stockEnvExample, withPackages } = require('./helpers/stock-app.cjs')

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'catalog', 'mercato-template-1.json'), 'utf8'))
const fixedNow = () => new Date('2026-11-03T12:00:00.000Z')
const stock = stockEnvExample()

function run(app, options = {}) {
  const out = options.out ?? path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment(), now: fixedNow, ...options })
  return { result, out, report: result.report }
}

function generated(out) {
  return fs.readFileSync(path.join(out, 'tree', '.env.example'), 'utf8')
}

function manifest(out) {
  return JSON.parse(fs.readFileSync(path.join(out, 'tree', 'mercato-template.json'), 'utf8'))
}

/** The stock 0.9.0 .env.example with `KEY=<stock value>` replaced by `KEY=<value>`. */
function stockWith(key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  assert.match(stock, pattern)
  return stock.replace(pattern, `${key}=${value}`)
}

function lineOf(text, needle) {
  return text.split('\n').findIndex((line) => line.startsWith(needle)) + 1
}

function assertNoValue({ result, out }, values) {
  const texts = [fs.readFileSync(path.join(out, 'report.json'), 'utf8'), JSON.stringify(result)]
  for (const text of texts) for (const value of values) assert.equal(text.includes(value), false, 'an env value appears in the report')
}

function errors(report) {
  return report.findings.filter((finding) => finding.level === 'error')
}

test('a changed JWT_SECRET: emptied in the generated .env.example and listed in report.env.emptied', () => {
  const value = 'my-own-dev-secret'
  const run1 = run(createFixtureRepo({ '.env.example': stockWith('JWT_SECRET', value) }))
  const { result, out, report } = run1
  assert.equal(result.exitCode, 0)
  assert.deepEqual(errors(report), [])
  assert.deepEqual(report.env, { kept: [], emptied: ['JWT_SECRET'], declared: [], dropped: [] })
  assert.equal(generated(out), stockWith('JWT_SECRET', ''))
  assertNoValue(run1, [value])
})

test('--keep-env JWT_SECRET with a non-stock value: env-keep-secret, and the value is emptied', () => {
  const value = 'my-own-dev-secret'
  const env = stockWith('JWT_SECRET', value)
  const run1 = run(createFixtureRepo({ '.env.example': env }), { keepEnv: ['JWT_SECRET'] })
  const { result, report } = run1
  assert.equal(result.exitCode, 1)
  assert.equal(result.snapshotId, null)
  assert.deepEqual(
    errors(report).map(({ rule, path: where, line }) => ({ rule, path: where, line })),
    [{ rule: 'env-keep-secret', path: '.env.example', line: lineOf(env, 'JWT_SECRET=') }],
  )
  assert.deepEqual(report.env.emptied, ['JWT_SECRET'])
  assert.deepEqual(report.env.kept, [])
  assertNoValue(run1, [value])
})

test('--keep-env JWT_SECRET with its stock value: kept as stock, no finding', () => {
  const { result, out, report } = run(createFixtureRepo({ '.env.example': stock }), { keepEnv: ['JWT_SECRET'] })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.env.kept, [])
  assert.equal(generated(out), stock)
})

test('--keep-env APP_URL with a custom URL: kept and listed in report.env.kept', () => {
  const env = stockWith('APP_URL', 'https://shop.example.com')
  const { result, out, report } = run(createFixtureRepo({ '.env.example': env }), { keepEnv: ['APP_URL'] })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.env, { kept: ['APP_URL'], emptied: [], declared: [], dropped: [] })
  assert.equal(generated(out), env)
  // Without --keep-env the same value is emptied.
  const plain = run(createFixtureRepo({ '.env.example': env }))
  assert.deepEqual(plain.report.env.emptied, ['APP_URL'])
  assert.equal(generated(plain.out), stockWith('APP_URL', ''))
})

test('--keep-env on a value that fails the secret scan: the scan finding, and the value is emptied', () => {
  const password = join('Hunter2-', randomText('kp1', 12))
  const env = stockWith('APP_URL', `https://admin:${password}@shop.example.com`)
  const run1 = run(createFixtureRepo({ '.env.example': env }), { keepEnv: ['APP_URL'] })
  assert.equal(run1.result.exitCode, 1)
  assert.deepEqual(
    errors(run1.report).map(({ rule, line }) => ({ rule, line })),
    [{ rule: 'credential-url', line: lineOf(env, 'APP_URL=') }],
  )
  assert.deepEqual(run1.report.env.emptied, ['APP_URL'])
  assertNoValue(run1, [password])
})

test('--keep-env naming a key the .env.example lacks: env-keep-unknown; a name that is not a key: exit 2', () => {
  const { result, report } = run(createFixtureRepo(), { keepEnv: ['NOT_THERE'] })
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    errors(report).map(({ rule, path: where }) => ({ rule, path: where })),
    [{ rule: 'env-keep-unknown', path: '.env.example' }],
  )
  assert.match(errors(report)[0].message, /--keep-env NOT_THERE/)
  for (const bad of ['APP URL', '1KEY', 'KEY=value', ''])
    assert.throws(
      () => run(createFixtureRepo(), { keepEnv: [bad] }),
      (error) => error instanceof CliError && error.exitCode === 2 && !error.message.includes('KEY=value'),
    )
})

test('a commented # OPENAI_API_KEY=sk-proj-...: secret, and the value is emptied', () => {
  const key = join('sk-', 'proj-', randomText('env-oa', 48))
  const env = `${stock}# OPENAI_API_KEY=${key}\n`
  const run1 = run(createFixtureRepo({ '.env.example': env }))
  const { result, out, report } = run1
  assert.equal(result.exitCode, 1)
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
  assert.deepEqual(
    errors(report).map(({ rule, ruleId, path: where, line }) => ({ rule, ruleId, path: where, line })),
    // generic-api-key matches the KEY=value form first, and the extra OpenAI
    // rule yields to a bundled finding on its line (Step 7): one value, one finding.
    [{ rule: 'secret', ruleId: 'generic-api-key', path: '.env.example', line: env.split('\n').length - 1 }],
  )
  assert.deepEqual(report.env.emptied, ['OPENAI_API_KEY'])
  assertNoValue(run1, [key, randomText('env-oa', 48)])
})

test('a secret in a plain comment of .env.example is found by the scan of the generated file', () => {
  const key = join('gh', 'p_', randomText('env-gh', 36))
  const env = `# Example token: ${key}\nAPP_URL=http://localhost:3000\n`
  const run1 = run(createFixtureRepo({ '.env.example': env }))
  assert.equal(run1.result.exitCode, 1)
  assert.deepEqual(
    errors(run1.report).map(({ rule, ruleId, line }) => ({ rule, ruleId, line })),
    [{ rule: 'secret', ruleId: 'github-pat', line: 1 }],
  )
  assertNoValue(run1, [key])
})

test('an unknown version: values emptied unless stock in any known version, notice stock-unknown', () => {
  const env = ['JWT_SECRET=change-me-dev-secret', 'APP_URL=https://custom.example.com', '# A key the newest stock file lacks.', 'SHOP_THEME=dark', ''].join('\n')
  const { result, out, report } = run(createFixtureRepo({ ...withPackages([], { version: '0.99.0' }), '.env.example': env }))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.stock, { version: '0.99.0', known: false })
  assert.ok(report.notices.some((notice) => notice.code === 'stock-unknown'))
  assert.equal(generated(out), ['JWT_SECRET=change-me-dev-secret', 'APP_URL=', '# A key the newest stock file lacks.', 'SHOP_THEME=', ''].join('\n'))
  assert.deepEqual(report.env.emptied, ['APP_URL', 'SHOP_THEME'])
  // Declared env of an unknown version is compared with the newest known version.
  assert.deepEqual(report.env.declared, ['SHOP_THEME'])
})

test('an unknown version with no .env.example: none is written, env-example-missing', () => {
  const { result, out, report } = run(createFixtureRepo({ ...withPackages([], { version: '0.99.0' }), '.env.example': null }))
  assert.equal(result.exitCode, 0)
  assert.equal(fs.existsSync(path.join(out, 'tree', '.env.example')), false)
  assert.deepEqual(
    report.findings.map(({ rule, level, path: where }) => ({ rule, level, path: where })),
    [{ rule: 'env-example-missing', level: 'warning', path: '.env.example' }],
  )
})

test('a known version with no .env.example: the stock file is written, env-example-missing', () => {
  const { result, out, report } = run(createFixtureRepo({ '.env.example': null }))
  assert.equal(result.exitCode, 0)
  assert.equal(generated(out), stock)
  assert.deepEqual(report.findings.map((finding) => finding.rule), ['env-example-missing'])
  assert.equal(report.files.find((file) => file.path === '.env.example').origin, 'generated')
})

test('declared keys: one with a comment and a link, one without (env-undocumented); the manifest validates', () => {
  const env = [
    ...stock.trimEnd().split('\n'),
    '',
    '# Default currency of the shop',
    '# (https://example.com/docs/currency).',
    'SHOP_CURRENCY=EUR',
    'UNDOCUMENTED_FLAG=',
    '',
  ].join('\n')
  const { result, out, report } = run(createFixtureRepo({ '.env.example': env }))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.env.declared, ['SHOP_CURRENCY', 'UNDOCUMENTED_FLAG'])
  assert.deepEqual(report.env.emptied, ['SHOP_CURRENCY'])
  const written = manifest(out)
  assert.deepEqual(written.env, [
    { name: 'SHOP_CURRENCY', description: 'Default currency of the shop.', link: 'https://example.com/docs/currency' },
    { name: 'UNDOCUMENTED_FLAG' },
  ])
  assert.deepEqual(Object.keys(written), ['schema', 'name', 'description', 'openMercato', 'env', 'modules', 'createdWith'])
  assert.deepEqual(validate(schema, written), [])
  assert.deepEqual(
    report.findings.map(({ rule, level, path: where, line }) => ({ rule, level, path: where, line })),
    [{ rule: 'env-undocumented', level: 'warning', path: '.env.example', line: lineOf(env, 'UNDOCUMENTED_FLAG=') }],
  )
})

test('a source mercato-template.json gives the description and link of a key without a comment', () => {
  const env = `${stock}UNDOCUMENTED_FLAG=\n`
  const source = { schema: 1, name: 'old', env: [{ name: 'UNDOCUMENTED_FLAG', description: 'Turns the old flow on.', link: 'https://example.com/flag' }], modules: [] }
  const { result, out, report } = run(createFixtureRepo({ '.env.example': env, 'mercato-template.json': JSON.stringify(source) }))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(manifest(out).env, [{ name: 'UNDOCUMENTED_FLAG', description: 'Turns the old flow on.', link: 'https://example.com/flag' }])
  assert.deepEqual(report.findings, [])
})

test('the stock app declares no env: the manifest has no env field', () => {
  const { out, report } = run(createFixtureRepo({ '.env.example': stock }))
  assert.equal(manifest(out).env, undefined)
  assert.deepEqual(report.env, { kept: [], emptied: [], declared: [], dropped: [] })
})

test('a line the parser cannot read: env-line-dropped, a blank line in its place; a secret on it is still found', () => {
  const env = ['APP_URL=http://localhost:3000', 'MULTI_LINE="first', 'second"', 'not an assignment', ''].join('\n')
  const { result, out, report } = run(createFixtureRepo({ '.env.example': env }))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(report.env.dropped, [2, 3, 4])
  assert.deepEqual(
    report.findings.filter((finding) => finding.rule === 'env-line-dropped').map((finding) => finding.line),
    [2, 3, 4],
  )
  assert.equal(generated(out), ['APP_URL=http://localhost:3000', '', '', '', ''].join('\n'))

  const key = join('np', 'm_', randomText('env-np', 36, 'abcdefghijklmnopqrstuvwxyz0123456789'))
  const leaking = run(createFixtureRepo({ '.env.example': `TOKEN_LIST="${key}\nmore"\n` }))
  assert.equal(leaking.result.exitCode, 1)
  assert.deepEqual(
    errors(leaking.report).map(({ rule, ruleId, line }) => ({ rule, ruleId, line })),
    [{ rule: 'secret', ruleId: 'npm-access-token', line: 1 }],
  )
  assertNoValue(leaking, [key])
})

test('a nested .env.example: excluded and warned, nested-env-example', () => {
  const { result, report, out } = run(createFixtureRepo({ 'apps/web/.env.example': 'APP_URL=http://localhost:3000\n' }))
  assert.equal(result.exitCode, 0)
  assert.ok(report.excluded.some((group) => group.pattern === '**/.env*' && group.paths.includes('apps/web/.env.example')))
  assert.deepEqual(
    report.findings.map(({ rule, level, path: where }) => ({ rule, level, path: where })),
    [{ rule: 'nested-env-example', level: 'warning', path: 'apps/web/.env.example' }],
  )
  assert.equal(fs.existsSync(path.join(out, 'tree', 'apps/web/.env.example')), false)
})

test('parseEnvLines: blank, comment, assignment, commented assignment, export and quotes; anything else dropped', () => {
  const lines = parseEnvLines(['', '# note=hello', '# KEY=commented', 'export A="quoted value" # inline', "B='x'", 'c=lower', 'D="open', '  E = spaced', ''].join('\n'))
  assert.deepEqual(
    lines.map((line) => (line.kind === 'assignment' ? [line.kind, line.key, line.value, line.commented, line.prefix] : [line.kind])),
    [
      ['blank'],
      ['comment'],
      ['assignment', 'KEY', 'commented', true, '# KEY='],
      ['assignment', 'A', '"quoted value" # inline', false, 'export A='],
      ['assignment', 'B', "'x'", false, 'B='],
      ['assignment', 'c', 'lower', false, 'c='],
      ['dropped'],
      ['dropped'],
    ],
  )
})

test('isSecretLookingKey: a SECRET, KEY, TOKEN or PASSWORD segment', () => {
  for (const key of ['JWT_SECRET', 'API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'DOCUMENTS_COLLAB_JWT_SECRET_V2', 'secret', 'KEY']) assert.equal(isSecretLookingKey(key), true, key)
  for (const key of ['APP_URL', 'KEYCLOAK_URL', 'SECRETARY_EMAIL', 'TOKENS_PER_MINUTE', 'PASSWORDLESS']) assert.equal(isSecretLookingKey(key), false, key)
})

test('describe: one line, the first https:// URL moved to link', () => {
  assert.deepEqual(describeComment(['Default currency.', 'See https://example.com/a and https://example.com/b.']), {
    description: 'Default currency. See and https://example.com/b.',
    link: 'https://example.com/a',
  })
  assert.deepEqual(describeComment(['https://example.com/only']), { link: 'https://example.com/only' })
  assert.deepEqual(describeComment([]), {})
})

test('buildEnv keeps line positions and never puts a value in a finding', () => {
  const value = 'value-that-must-not-leak'
  const result = buildEnv({ source: Buffer.from(`A_FLAG=${value}\n"broken\n`), match: matchStock('0.9.0'), keepEnv: ['MISSING'] })
  assert.equal(result.content.toString(), 'A_FLAG=\n\n')
  assert.equal(JSON.stringify(result.findings).includes(value), false)
  assert.deepEqual(result.findings.map((finding) => finding.rule).sort(), ['env-keep-unknown', 'env-line-dropped', 'env-undocumented'])
})
