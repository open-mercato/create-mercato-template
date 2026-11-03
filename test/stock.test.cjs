const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  stockTable,
  stockVersions,
  newestStock,
  matchStock,
  isStockValue,
  stockEnvLines,
  isStockCredentialUrl,
  isStockReadme,
} = require('../dist/stock.js')
const { parseEnvAssignments } = require('../dist/env-file.js')
const { findCredentialUrls } = require('../dist/policy/credential-url.js')
const { run } = require('../dist/common.js')

const root = path.join(__dirname, '..')
const tablePath = path.join(root, 'src', 'stock', 'table.json')
// A copy of template/.env.example and the credential URL strings of the
// create-mercato-app 0.9.0 tarball, taken by hand (see test/fixtures/stock/README.md).
const fixture090 = require('./fixtures/stock/0.9.0.json')

// The generator is a type-stripped .mts module; import it, do not run it.
// Node warns once that src/*.ts has no module type (the package is CommonJS
// for dist/); `npm run stock-table` passes --disable-warning for the same
// warning, and here the default printer skips only that code.
let generator
function loadGenerator() {
  if (!generator) {
    const printers = process.listeners('warning')
    process.removeAllListeners('warning')
    process.on('warning', (warning) => {
      if (warning.code !== 'MODULE_TYPELESS_PACKAGE_JSON') for (const printer of printers) printer(warning)
    })
    generator = import(pathToFileURL(path.join(root, 'scripts', 'build-stock-table.mts')).href)
  }
  return generator
}

test('the table has every stable create-mercato-app version from 0.4.5 to 0.9.0', () => {
  const expected = ['0.4.5', '0.4.6', '0.4.7', '0.4.8', '0.4.9', '0.4.10', '0.5.0']
    .concat(['0.6.0', '0.6.1', '0.6.2', '0.6.3', '0.6.4', '0.6.5', '0.6.6', '0.6.7', '0.7.0', '0.8.0', '0.9.0'])
  assert.deepEqual(stockVersions().slice(0, expected.length), expected)
  assert.equal(stockTable.schema, 1)
  assert.equal(stockTable.package, 'create-mercato-app')
  for (const version of stockVersions()) assert.match(version, /^\d+\.\d+\.\d+$/)
})

test('the 0.9.0 entry equals the committed copy of its .env.example and credential URLs', () => {
  const entry = stockTable.versions['0.9.0']
  assert.equal(stockTable.files[entry.envExample], fixture090.envExample)
  assert.deepEqual(entry.credentialUrls, fixture090.credentialUrls)
  assert.equal(entry.readme, null, 'the 0.9.0 scaffold has no root README.md')
  assert.deepEqual(stockEnvLines(matchStock('0.9.0')), fixture090.envExample.split('\n'))
  // Every key of the file is in the entry, with its values in file order.
  const expected = {}
  for (const { key, value } of parseEnvAssignments(fixture090.envExample)) {
    expected[key] ??= []
    if (!expected[key].includes(value)) expected[key].push(value)
  }
  assert.deepEqual(entry.env, expected)
})

test('identical files are stored once and referenced by hash', () => {
  const crypto = require('node:crypto')
  const referenced = new Set(Object.values(stockTable.versions).map((entry) => entry.envExample).filter(Boolean))
  assert.deepEqual([...referenced].sort(), Object.keys(stockTable.files).sort())
  for (const [hash, content] of Object.entries(stockTable.files))
    assert.equal(crypto.createHash('sha256').update(content, 'utf8').digest('hex'), hash)
  assert.ok(referenced.size < stockVersions().length, 'some versions share a .env.example')
})

test('JWT_SECRET=change-me-dev-secret is stock for 0.9.0; a changed value is not', () => {
  const match = matchStock('0.9.0')
  assert.deepEqual({ version: match.version, known: match.known }, { version: '0.9.0', known: true })
  assert.equal(isStockValue(match, 'JWT_SECRET', 'change-me-dev-secret'), true)
  assert.equal(isStockValue(match, 'AUTH_SECRET', 'change-me-dev-auth-secret'), true)
  assert.equal(isStockValue(match, 'DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/open-mercato'), true)
  // Commented assignments count: `# OM_AUTOLOGIN_EMAIL=superadmin@acme.com`.
  assert.equal(isStockValue(match, 'OM_AUTOLOGIN_EMAIL', 'superadmin@acme.com'), true)
  assert.equal(isStockValue(match, 'JWT_SECRET', 'change-me-dev-secret-2'), false)
  assert.equal(isStockValue(match, 'NOT_A_STOCK_KEY', ''), false)
  assert.equal(isStockValue(match, 'constructor', ''), false)
})

// A key and value that an older version has and 0.9.0 does not.
function olderOnlyValue() {
  const newest = stockTable.versions['0.9.0'].env
  for (const version of stockVersions()) {
    for (const [key, values] of Object.entries(stockTable.versions[version].env)) {
      const value = values.find((candidate) => !(newest[key] ?? []).includes(candidate))
      if (value !== undefined) return { version, key, value }
    }
  }
  throw new Error('no value that only an older version has')
}

test('an unknown version matches a value from any known version and reports known: false', () => {
  const { version, key, value } = olderOnlyValue()
  assert.equal(isStockValue(matchStock('0.9.0'), key, value), false)
  assert.equal(isStockValue(matchStock(version), key, value), true)
  for (const unknown of ['0.9.1', '0.10.0', '0.9.1-canary-0d5782b643', '0.9.0-develop.12', null]) {
    const match = matchStock(unknown)
    assert.equal(match.version, unknown)
    assert.equal(match.known, false)
    assert.equal(match.entries.length, stockVersions().length)
    assert.equal(isStockValue(match, key, value), true, String(unknown))
    assert.equal(isStockValue(match, 'JWT_SECRET', 'change-me-dev-secret'), true)
    assert.equal(isStockValue(match, 'JWT_SECRET', 'not-a-stock-value'), false)
    // An unknown version has no stock .env.example of its own.
    assert.equal(stockEnvLines(match), null)
  }
  assert.equal(matchStock('toString').known, false)
  assert.equal(newestStock().version, stockVersions().at(-1))
})

test('stock credential URLs and README hashes match across known versions', () => {
  assert.equal(isStockCredentialUrl('postgres://postgres:postgres@localhost:5432/open-mercato'), true)
  assert.equal(
    isStockCredentialUrl('postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/${POSTGRES_DB:-open-mercato}'),
    true,
  )
  assert.equal(isStockCredentialUrl('postgres://postgres:changed@localhost:5432/open-mercato'), false)
  assert.equal(isStockReadme('0'.repeat(64)), false)
  const table = { schema: 1, package: 'create-mercato-app', files: {}, versions: { '1.0.0': { envExample: null, env: {}, credentialUrls: [], readme: 'a'.repeat(64) } } }
  assert.equal(isStockReadme('a'.repeat(64), table), true)
  assert.equal(stockEnvLines(matchStock('1.0.0', table), table), null)
})

test('the committed table is the generator output: sorted, ASCII only, never hand-edited', async () => {
  const { serializeStockTable } = await loadGenerator()
  const committed = fs.readFileSync(tablePath, 'utf8')
  assert.equal(serializeStockTable(JSON.parse(committed)), committed)
  assert.ok([...committed].every((character) => character.charCodeAt(0) < 0x80), 'the table is plain ASCII')
})

test('parseEnvAssignments reads active and commented assignments with their lines', () => {
  const text = ['# A comment', 'FOO=bar', '# BAZ=', '#QUX = no', 'export NAME="quoted value"  ', '', '# e.g. X=1', 'BAD-KEY=1', '# note=hello', 'lower_case=1'].join('\n')
  assert.deepEqual(parseEnvAssignments(text), [
    { key: 'FOO', value: 'bar', commented: false, line: 2 },
    { key: 'BAZ', value: '', commented: true, line: 3 },
    { key: 'NAME', value: '"quoted value"', commented: false, line: 5 },
    { key: 'lower_case', value: '1', commented: false, line: 10 },
  ])
})

test('findCredentialUrls finds URLs with a non-empty password, ${...} references included', () => {
  const text = [
    'DATABASE_URL=postgres://postgres:postgres@localhost:5432/open-mercato',
    '      DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/${POSTGRES_DB:-open-mercato}"',
    'REDIS_URL=redis://localhost:6379',
    'NO_PASSWORD=postgres://postgres@localhost/db',
    'EMPTY_PASSWORD=postgres://postgres:@localhost/db',
    'see https://example.com/path@handle and https://example.com/?u=a:b@c',
    'call (https://user:pass@example.com).',
    'TYPO=postgres://${DB_USER:secret@db/app',
  ].join('\n')
  assert.deepEqual(
    findCredentialUrls(text).map(({ url, password, line }) => ({ url, password, line })),
    [
      { url: 'postgres://postgres:postgres@localhost:5432/open-mercato', password: 'postgres', line: 1 },
      {
        url: 'postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/${POSTGRES_DB:-open-mercato}',
        password: '${POSTGRES_PASSWORD:-postgres}',
        line: 2,
      },
      { url: 'https://user:pass@example.com', password: 'pass', line: 7 },
      // An unclosed ${ falls back to the first colon, so the password still shows.
      { url: 'postgres://${DB_USER:secret@db/app', password: 'secret', line: 8 },
    ],
  )
})

test('findCredentialUrls scans a long line in linear time', () => {
  for (const line of ['a'.repeat(200_000) + '://', 'f0'.repeat(100_000), `${'x'.repeat(100_000)} postgres://u:p@h/db`]) {
    const started = process.hrtime.bigint()
    findCredentialUrls(line)
    assert.ok(process.hrtime.bigint() - started < 1_000_000_000n, `took too long on a ${line.length}-character line`)
  }
  assert.deepEqual(findCredentialUrls(`${'x'.repeat(100_000)} postgres://u:p@h/db`).map(({ url }) => url), ['postgres://u:p@h/db'])
})

// A create-mercato-app tarball built from a few local files, as npm would ship it.
function fixtureTarball(directory, version) {
  const source = path.join(directory, `source-${version}`)
  const template = path.join(source, 'package', 'template')
  fs.mkdirSync(path.join(template, 'docker'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package', 'package.json'), JSON.stringify({ name: 'create-mercato-app', version }))
  fs.writeFileSync(
    path.join(template, '.env.example'),
    '# Stock\nDATABASE_URL=postgres://app:stock-pw@localhost:5432/app\nJWT_SECRET=change-me\n# JWT_SECRET=other-stock\n# REDIS_URL=redis://localhost:6379\n',
  )
  fs.writeFileSync(
    path.join(template, 'docker', 'compose.yml'),
    'services:\n  app:\n    environment:\n      DATABASE_URL: postgres://${DB_USER:-app}:${DB_PASSWORD:-app}@db:5432/app\n',
  )
  fs.writeFileSync(path.join(template, 'README.md'), '# Stock README\n')
  fs.writeFileSync(path.join(template, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  const tarball = path.join(directory, `create-mercato-app-${version}.tgz`)
  run('tar', ['-czf', tarball, '-C', source, 'package'], directory, { capture: true })
  return tarball
}

test('the generator, run on a local fixture tarball through a fake executor, adds only the missing version', async () => {
  const { updateStockTable, serializeStockTable } = await loadGenerator()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-stock-test-'))
  const tarball = fixtureTarball(work, '0.9.1')
  const calls = []
  let packs = 0
  const executor = (command, args, cwd, options) => {
    calls.push([command, ...args])
    if (command === 'npm' && args[0] === 'view') {
      const published = [...stockVersions(), '0.9.1', '0.9.2-canary-0d5782b643', '0.9.2-develop.3']
      return { status: 0, stdout: JSON.stringify(published), stderr: '', pid: 0, output: [], signal: null }
    }
    if (command === 'npm' && args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1]
      fs.copyFileSync(tarball, path.join(destination, path.basename(tarball)))
      // npm 12 prints an object keyed by package name, npm 11 an array; take turns.
      const entry = { filename: path.basename(tarball) }
      packs += 1
      const stdout = JSON.stringify(packs % 2 ? { 'create-mercato-app': entry } : [entry])
      return { status: 0, stdout, stderr: '', pid: 0, output: [], signal: null }
    }
    if (command === 'tar') return run(command, args, cwd, options)
    throw new Error(`unexpected command ${command} ${args.join(' ')}`)
  }
  const before = JSON.parse(fs.readFileSync(tablePath, 'utf8'))
  try {
    const { table, added } = updateStockTable(before, { executor, workRoot: work })

    assert.deepEqual(added, ['0.9.1'])
    assert.deepEqual(
      calls.filter(([command]) => command === 'npm'),
      [
        ['npm', 'view', 'create-mercato-app', 'versions', '--json'],
        ['npm', 'pack', 'create-mercato-app@0.9.1', '--pack-destination', calls[1][4], '--json', '--ignore-scripts'],
      ],
    )
    // The versions already in the table are kept as they are.
    for (const version of stockVersions()) assert.deepEqual(table.versions[version], before.versions[version])
    for (const [hash, content] of Object.entries(before.files)) assert.equal(table.files[hash], content)
    assert.deepEqual(Object.keys(table.versions), [...stockVersions(), '0.9.1'])

    const entry = table.versions['0.9.1']
    assert.deepEqual(entry.env, {
      DATABASE_URL: ['postgres://app:stock-pw@localhost:5432/app'],
      JWT_SECRET: ['change-me', 'other-stock'],
      REDIS_URL: ['redis://localhost:6379'],
    })
    assert.deepEqual(entry.credentialUrls, [
      'postgres://${DB_USER:-app}:${DB_PASSWORD:-app}@db:5432/app',
      'postgres://app:stock-pw@localhost:5432/app',
    ])
    assert.match(table.files[entry.envExample], /^# Stock\n/)
    assert.equal(entry.readme, require('node:crypto').createHash('sha256').update('# Stock README\n').digest('hex'))
    assert.equal(isStockReadme(entry.readme, table), true)
    assert.equal(matchStock('0.9.1', table).known, true)

    // The serialized table orders 0.9.1 after 0.9.0, and work directories are removed.
    assert.ok(serializeStockTable(table).indexOf('"0.9.1"') > serializeStockTable(table).indexOf('"0.9.0"'))
    assert.deepEqual(fs.readdirSync(work).filter((name) => name.startsWith('cmt-stock-')), [])

    // A second run with nothing missing fetches nothing.
    calls.length = 0
    const again = updateStockTable(table, { executor, workRoot: work })
    assert.deepEqual(again.added, [])
    assert.deepEqual(calls, [['npm', 'view', 'create-mercato-app', 'versions', '--json']])

    // The npm 11 array shape is read the same way.
    delete table.versions['0.9.1']
    const array = updateStockTable(table, { executor, workRoot: work })
    assert.equal(packs, 2)
    assert.deepEqual(array.added, ['0.9.1'])
    assert.deepEqual(array.table.versions['0.9.1'], entry)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('the generator refuses npm output it cannot read', async () => {
  const { missingStockVersions, emptyStockTable } = await loadGenerator()
  const executor = (stdout) => () => ({ status: 0, stdout, stderr: '', pid: 0, output: [], signal: null })
  assert.throws(() => missingStockVersions(emptyStockTable(), executor('{"a":1}')), /did not print a list of versions/)
  assert.deepEqual(missingStockVersions(emptyStockTable(), executor('"0.9.0"')), ['0.9.0'])
})

test('the generator --check exits 1 when npm has a stable version the table lacks, and writes nothing', async () => {
  const { main } = await loadGenerator()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-stock-check-'))
  const copy = path.join(work, 'table.json')
  fs.copyFileSync(tablePath, copy)
  const npmView = (published) => (command, args) => {
    assert.deepEqual([command, ...args], ['npm', 'view', 'create-mercato-app', 'versions', '--json'])
    return { status: 0, stdout: JSON.stringify(published), stderr: '', pid: 0, output: [], signal: null }
  }
  const quiet = { log: console.log, error: console.error }
  console.log = console.error = () => {}
  try {
    assert.equal(main(['--check'], { executor: npmView([...stockVersions(), '1.0.0-canary-1']), tablePath: copy, workRoot: work }), 0)
    assert.equal(main(['--check'], { executor: npmView([...stockVersions(), '0.9.1']), tablePath: copy, workRoot: work }), 1)
    assert.equal(main(['--bogus'], { executor: npmView([]), tablePath: copy, workRoot: work }), 2)
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(tablePath, 'utf8'))
  } finally {
    Object.assign(console, quiet)
    fs.rmSync(work, { recursive: true, force: true })
  }
})
