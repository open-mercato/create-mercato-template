// Spec Step 5: the module inventory of src/modules.ts and the generated
// mercato-template.json. The prepare() tests build fixture repositories in a
// temp directory from test/helpers/fixture-app.cjs; no network. The scaffold
// files are vendored under test/fixtures/scaffold/ (see SOURCE.md there) and
// the manifest schema under test/fixtures/catalog/ (a draft until the catalog
// publishes it).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { prepare } = require('../dist/prepare.js')
const { readInventory, resolveImport, maxParseBytes, isKnownFrom } = require('../dist/inventory.js')
const { buildManifest, slugify, isPlainText } = require('../dist/manifest.js')
const { coreVersion, createFixtureRepo, fixtureFiles, gitEnvironment, tempDir } = require('./helpers/fixture-app.cjs')
const { validate } = require('./helpers/json-schema.cjs')

const fixtures = path.join(__dirname, 'fixtures')
const schema = JSON.parse(fs.readFileSync(path.join(fixtures, 'catalog', 'mercato-template-1.json'), 'utf8'))
const basePackage = JSON.parse(fixtureFiles['package.json'])
const fixedNow = () => new Date('2026-11-03T12:00:00.000Z')
const scaffoldRefs = ['v0.9.0', 'a447cc552']

function run(app, options = {}) {
  const out = path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment(), now: fixedNow, ...options })
  return { result, out, report: result.report }
}

function readManifest(out) {
  return JSON.parse(fs.readFileSync(path.join(out, 'tree', 'mercato-template.json'), 'utf8'))
}

function lockEntry(name, version, descriptors = [`${name}@npm:${version}`]) {
  return `\n"${descriptors.join(', ')}":\n  version: ${version}\n  resolution: "${name}@npm:${version}"\n  checksum: 10c0/${'1'.repeat(128)}\n  languageName: node\n  linkType: hard\n`
}

/**
 * The fixture app's package.json and yarn.lock with more packages:
 * `packages` maps a name to `{range, version}` (a package.json dependency)
 * or `{version}` (a lockfile entry only).
 */
function withPackages(packages, changes = {}) {
  const dependencies = { ...basePackage.dependencies }
  let lock = fixtureFiles['yarn.lock']
  for (const [name, { range, version, descriptors }] of Object.entries(packages)) {
    if (range !== undefined) dependencies[name] = range
    lock += lockEntry(name, version, descriptors ?? [`${name}@npm:${range ?? version}`])
  }
  return {
    'package.json': `${JSON.stringify({ ...basePackage, dependencies, ...changes }, null, 2)}\n`,
    'yarn.lock': lock,
  }
}

function modulesTs(body, initial = "  { id: 'auth', from: '@open-mercato/core' },\n") {
  return `export type ModuleEntry = { id: string; from?: string }\n\nexport const enabledModules: ModuleEntry[] = [\n${initial}]\n${body}`
}

function inventoryOf(files) {
  return readInventory(new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)])))
}

function warnings(report, rule) {
  return report.findings.filter((finding) => finding.rule === rule)
}

function errors(report) {
  return report.findings.filter((finding) => finding.level === 'error')
}

function assertValidManifest(manifest) {
  assert.deepEqual(validate(schema, manifest), [])
}

// ---------------------------------------------------------------------------
// The vendored scaffold

test('the vendored scaffold files are the bytes SOURCE.md records', () => {
  const source = fs.readFileSync(path.join(fixtures, 'scaffold', 'SOURCE.md'), 'utf8')
  const rows = [...source.matchAll(/^\| `([^`]+)` \| [^|]+ \| `([0-9a-f]{40})` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)]
  assert.equal(rows.length, 4)
  for (const [, directory, , file, sha256] of rows) {
    const content = fs.readFileSync(path.join(fixtures, 'scaffold', directory, file))
    assert.equal(crypto.createHash('sha256').update(content).digest('hex'), sha256, `${directory}${file}`)
  }
  assert.match(schema.$comment, /^DRAFT\./)
})

/** A fixture app on the scaffold's src/modules.ts: every unconditional npm package resolves, enterprise too, storage-s3 does not (as in the stock app). */
function scaffoldApp(ref) {
  const directory = path.join(fixtures, 'scaffold', ref, 'src')
  const files = {
    'src/modules.ts': fs.readFileSync(path.join(directory, 'modules.ts')),
    'src/official-modules.generated.ts': fs.readFileSync(path.join(directory, 'official-modules.generated.ts')),
  }
  const names = new Set(inventoryOf(files).entries.map((entry) => entry.from))
  const packages = {}
  for (const name of names)
    if (name.startsWith('@open-mercato/') && name !== '@open-mercato/core' && name !== '@open-mercato/storage-s3')
      packages[name] = { range: coreVersion, version: coreVersion }
  return createFixtureRepo({ ...withPackages(packages), ...files })
}

for (const ref of scaffoldRefs)
  test(`the scaffold src/modules.ts at ${ref}: @app, conditional, enterprise and official entries`, () => {
    const { result, out, report } = run(scaffoldApp(ref))
    assert.deepEqual(errors(report), [])
    assert.equal(result.exitCode, 0)
    assert.deepEqual(report.modules.unparsed, [])
    const byId = Object.fromEntries(report.modules.entries.map((entry) => [entry.id, entry]))
    const lineOf = (needle) => fs.readFileSync(path.join(fixtures, 'scaffold', ref, 'src', 'modules.ts'), 'utf8').split('\n').findIndex((line) => line.includes(needle)) + 1
    const strip = ({ line, ...entry }) => (assert.equal(typeof line, 'number'), entry)

    assert.deepEqual(strip(byId.ratelimit_probe), { id: 'ratelimit_probe', from: '@app' })
    assert.equal(byId.ratelimit_probe.line, lineOf("{ id: 'ratelimit_probe'"))
    assert.deepEqual(strip(byId.example_customers_sync), { id: 'example_customers_sync', from: '@app', when: 'module:example' })
    assert.deepEqual(strip(byId.agent_examples), {
      id: 'agent_examples',
      from: '@app',
      when: 'OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_AGENTS',
    })
    assert.deepEqual(strip(byId.storage_s3), { id: 'storage_s3', from: '@open-mercato/storage-s3', when: 'OM_ENABLE_STORAGE_S3' })
    const unresolved = warnings(report, 'module-package-unresolved')
    assert.deepEqual(
      unresolved.map(({ rule, level, path: where, line }) => ({ rule, level, path: where, line })),
      [{ rule: 'module-package-unresolved', level: 'warning', path: 'src/modules.ts', line: byId.storage_s3.line }],
    )

    const enterprise = [
      { id: 'record_locks', when: 'OM_ENABLE_ENTERPRISE_MODULES' },
      { id: 'system_status_overlays', when: 'OM_ENABLE_ENTERPRISE_MODULES' },
      { id: 'sso', when: 'OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_SSO' },
      { id: 'security', when: 'OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_SECURITY' },
      { id: 'agent_orchestrator', when: 'OM_ENABLE_ENTERPRISE_MODULES && OM_ENABLE_ENTERPRISE_MODULES_AGENTS' },
    ]
    assert.deepEqual(report.enterprise, { dependency: true, modules: enterprise })
    for (const { id, when } of enterprise)
      assert.deepEqual(strip(byId[id]), { id, from: '@open-mercato/enterprise', package: `@open-mercato/enterprise@${coreVersion}`, when })

    // Commented-out registrations are not entries.
    for (const id of ['customer_groups', 'availability', 'ecommerce', 'promotions', 'cart', 'gateway_tpay', 'channel_discord', 'carrier_inpost', 'forms'])
      assert.equal(byId[id], undefined, id)
    // Unconditional entries: core without package, other npm packages pinned.
    assert.deepEqual(strip(byId.auth), { id: 'auth', from: '@open-mercato/core' })
    assert.deepEqual(strip(byId.search), { id: 'search', from: '@open-mercato/search', package: `@open-mercato/search@${coreVersion}` })
    assert.equal(report.modules.entries[0].id, 'dashboards')
    assert.equal(report.modules.entries.length, 70)
    assert.equal(new Set(report.modules.entries.map((entry) => entry.id)).size, 70)

    const manifest = readManifest(out)
    assertValidManifest(manifest)
    assert.deepEqual(
      manifest.modules,
      report.modules.entries.map(({ line, ...entry }) => (assert.ok(line > 0), entry)),
    )
  })

// ---------------------------------------------------------------------------
// The inventory rules

test('a modules list with an @app module, a pinned npm module and an env-gated one', () => {
  const app = createFixtureRepo({
    ...withPackages({ '@acme/crm-sync': { range: '^1.2.0', version: '1.2.3' } }),
    'src/modules.ts': modulesTs(
      [
        "const s3 = Boolean(process.env.OM_ENABLE_STORAGE_S3)",
        "if (s3) {",
        "  enabledModules.push({ id: 'storage_s3', from: '@open-mercato/storage-s3' })",
        "}",
        '',
      ].join('\n'),
      "  { id: 'auth' },\n  { id: 'quotes_portal', from: '@app' },\n  { id: 'crm_sync', from: '@acme/crm-sync' },\n",
    ),
  })
  const { result, out, report } = run(app)
  assert.equal(result.exitCode, 0)
  const manifest = readManifest(out)
  assert.deepEqual(manifest.modules, [
    { id: 'auth', from: '@open-mercato/core' },
    { id: 'quotes_portal', from: '@app' },
    { id: 'crm_sync', from: '@acme/crm-sync', package: '@acme/crm-sync@1.2.3' },
    { id: 'storage_s3', from: '@open-mercato/storage-s3', when: 'OM_ENABLE_STORAGE_S3' },
  ])
  assert.deepEqual(
    report.modules.entries.map((entry) => entry.line),
    [4, 5, 6, 10],
  )
  assertValidManifest(manifest)
  assert.deepEqual(report.enterprise.modules, [])
})

test('120 entries: none dropped, in registration order', () => {
  const initial = Array.from({ length: 120 }, (_, index) => `  { id: 'module_${index}', from: '@open-mercato/core' },\n`).join('')
  const app = createFixtureRepo({ 'src/modules.ts': modulesTs('', initial) })
  const { out, report } = run(app)
  assert.equal(report.modules.entries.length, 120)
  assert.deepEqual(
    report.modules.entries.map((entry) => entry.id),
    Array.from({ length: 120 }, (_, index) => `module_${index}`),
  )
  assert.equal(readManifest(out).modules.length, 120)
})

test('a helper-function construct is listed as unparsed with its line', () => {
  const body = [
    'function addExtras(list: ModuleEntry[]) {',
    "  list.push({ id: 'extra', from: '@app' })",
    '}',
    'addExtras(enabledModules)',
    'enabledModules.push(...buildMore())',
    '',
  ].join('\n')
  const app = createFixtureRepo({ 'src/modules.ts': modulesTs(body) })
  const { result, report } = run(app)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    report.modules.unparsed.map((item) => item.line),
    [9, 10],
  )
  assert.deepEqual(
    warnings(report, 'modules-unparsed').map(({ level, path: where, line }) => ({ level, path: where, line })),
    [
      { level: 'warning', path: 'src/modules.ts', line: 9 },
      { level: 'warning', path: 'src/modules.ts', line: 10 },
    ],
  )
  assert.deepEqual(
    report.modules.entries.map((entry) => entry.id),
    ['auth'],
  )
})

test('an || condition: when "custom" and a modules-unparsed warning with its line', () => {
  const body = [
    "if (process.env.OM_A === '1' || process.env.OM_B) {",
    "  enabledModules.push({ id: 'either', from: '@app' })",
    '}',
    '',
  ].join('\n')
  const { out, report } = run(createFixtureRepo({ 'src/modules.ts': modulesTs(body) }))
  const either = report.modules.entries.find((entry) => entry.id === 'either')
  assert.deepEqual(either, { id: 'either', from: '@app', when: 'custom', line: 7 })
  assert.deepEqual(
    warnings(report, 'modules-unparsed').map((finding) => finding.line),
    [6],
  )
  assert.deepEqual(report.modules.unparsed, [{ line: 6, reason: 'a condition outside the when grammar (entry kept with when: "custom")' }])
  // No source text is copied into when, the reason or the message.
  assert.ok(!JSON.stringify(report).includes("=== '1'"))
  assertValidManifest(readManifest(out))
})

test('a duplicate official entry is kept once, the first one wins', () => {
  const official = [
    "import type { ModuleEntry } from './modules'",
    'export const officialModuleEntries: ModuleEntry[] = [',
    "  { id: 'auth', from: '@acme/auth' },",
    "  { id: 'loyalty', from: '@app' },",
    "  { id: 'loyalty', from: '@acme/loyalty' },",
    ']',
    '',
  ].join('\n')
  const body = [
    "import { officialModuleEntries } from './official-modules.generated'",
    'for (const entry of officialModuleEntries) {',
    '  if (!enabledModules.some((existing) => existing.id === entry.id)) enabledModules.push(entry)',
    '}',
    '',
  ].join('\n')
  const { report } = run(createFixtureRepo({ 'src/modules.ts': modulesTs(body), 'src/official-modules.generated.ts': official }))
  assert.deepEqual(report.modules.entries, [
    { id: 'auth', from: '@open-mercato/core', line: 4 },
    { id: 'loyalty', from: '@app', line: 7 },
  ])
  assert.deepEqual(report.modules.unparsed, [])
})

test('a loop without the dedupe guard keeps every official entry', () => {
  const inventory = inventoryOf({
    'src/modules.ts': modulesTs("import { extra } from './extra'\nfor (const entry of extra) enabledModules.push(entry)\n"),
    'src/extra.ts': "export const extra = [{ id: 'auth', from: '@app' }]\n",
  })
  assert.deepEqual(
    inventory.entries.map((entry) => `${entry.id} ${entry.from}`),
    ['auth @open-mercato/core', 'auth @app'],
  )
})

test('a loop over an import the inventory cannot read is unparsed (Q5)', () => {
  for (const [specifier, files] of [
    ['@acme/official', {}],
    ['./missing', {}],
    ['./official', { 'src/official.ts': 'export const officialModuleEntries = loadModules()\n' }],
  ]) {
    const inventory = inventoryOf({
      'src/modules.ts': modulesTs(`import { officialModuleEntries } from '${specifier}'\nfor (const entry of officialModuleEntries) enabledModules.push(entry)\n`),
      ...files,
    })
    assert.equal(inventory.entries.length, 1, specifier)
    assert.deepEqual(
      inventory.unparsed.map((item) => item.line),
      [7],
      specifier,
    )
  }
})

test('when: nested ifs and && join, else negates one term, else of a compound is custom, module: terms', () => {
  const body = [
    "import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'",
    'const a = parseBooleanWithDefault(process.env.OM_A, false)',
    "if (a) { if (process.env['OM_B'] && a) enabledModules.push({ id: 'a_b', from: '@app' }) }",
    "if (!a) enabledModules.push({ id: 'not_a', from: '@app' })",
    "else enabledModules.push({ id: 'else_a', from: '@app' })",
    "if (a && process.env.OM_B) enabledModules.push({ id: 'both', from: '@app' })",
    "else enabledModules.push({ id: 'neither', from: '@app' })",
    "if (enabledModules.some((m) => m.id === 'auth')) enabledModules.push({ id: 'needs_auth', from: '@app' })",
    "if (someFlag()) enabledModules.push({ id: 'unknown_call', from: '@app' })",
    '',
  ].join('\n')
  const inventory = inventoryOf({ 'src/modules.ts': modulesTs(body) })
  assert.deepEqual(
    Object.fromEntries(inventory.entries.map((entry) => [entry.id, entry.when ?? null])),
    {
      auth: null,
      a_b: 'OM_A && OM_B',
      not_a: '!OM_A',
      else_a: 'OM_A',
      both: 'OM_A && OM_B',
      neither: 'custom',
      needs_auth: 'module:auth',
      unknown_call: 'custom',
    },
  )
  assert.deepEqual(
    inventory.unparsed.map((item) => item.line),
    [11, 14],
  )
})

test('push, unshift and a spread reassignment are followed in source order', () => {
  const body = [
    "enabledModules.push({ id: 'second', from: '@app' }, { id: 'third', from: '@app' })",
    "enabledModules.unshift({ id: 'first', from: '@app' })",
    "modules = [{ id: 'zero', from: '@app' }, ...modules, { id: 'last', from: '@app' }]",
    '',
  ].join('\n')
  const text = modulesTs(body).replace('export const enabledModules', 'export let modules').replaceAll('enabledModules.', 'modules.')
  const inventory = inventoryOf({ 'src/modules.ts': text })
  assert.deepEqual(
    inventory.entries.map((entry) => entry.id),
    ['zero', 'first', 'auth', 'second', 'third', 'last'],
  )
  assert.deepEqual(inventory.unparsed, [])
})

test('other constructs that add to the list are unparsed, nothing dropped silently; reads are not', () => {
  const body = [
    "enabledModules.push(flag ? { id: 'x', from: '@app' } : { id: 'y', from: '@app' })",
    "enabledModules.push({ id: `computed_${1}`, from: '@app' })",
    "enabledModules.push({ id: 'Bad-Id', from: '@app' })",
    "enabledModules.push({ id: 'spread', ...extra })",
    "while (more()) enabledModules.push({ id: 'loop', from: '@app' })",
    'enabledModules.splice(0, 1)',
    'const alias = enabledModules',
    'enabledModules.length = 0',
    "export const ids = enabledModules.map((entry) => entry.id).filter(Boolean)",
    'export default enabledModules',
    '',
  ].join('\n')
  const inventory = inventoryOf({ 'src/modules.ts': modulesTs(body) })
  assert.deepEqual(
    inventory.entries.map((entry) => entry.id),
    ['auth'],
  )
  assert.deepEqual(
    inventory.unparsed.map((item) => item.line),
    [6, 7, 8, 9, 10, 11, 12, 13],
  )
  // A reason names the construct, never the matched source text.
  assert.ok(inventory.unparsed.every((item) => !item.reason.includes('flag') && !item.reason.includes('Bad-Id')))
})

test('module-from-unknown: a from that is neither @app nor an npm name', () => {
  const app = createFixtureRepo({ 'src/modules.ts': modulesTs('', "  { id: 'local', from: './modules/local' },\n") })
  const { result, out, report } = run(app)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    warnings(report, 'module-from-unknown').map(({ level, line }) => ({ level, line })),
    [{ level: 'warning', line: 4 }],
  )
  assert.deepEqual(readManifest(out).modules, [{ id: 'local', from: './modules/local' }])
  assertValidManifest(readManifest(out))
  assert.equal(isKnownFrom('@app'), true)
  assert.equal(isKnownFrom('@acme/x'), true)
  assert.equal(isKnownFrom('~/modules/x'), false)
})

test('module-package-unresolved: an error for an unconditional module, a warning for a conditional one', () => {
  const body = "if (process.env.OM_X) enabledModules.push({ id: 'cond', from: '@acme/cond' })\n"
  const app = createFixtureRepo({ 'src/modules.ts': modulesTs(body, "  { id: 'auth' },\n  { id: 'plain', from: '@acme/plain' },\n") })
  const { result, out, report } = run(app)
  assert.equal(result.exitCode, 1)
  assert.equal(result.snapshotId, null)
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
  assert.deepEqual(
    warnings(report, 'module-package-unresolved').map(({ level, line }) => ({ level, line })),
    [
      { level: 'error', line: 5 },
      { level: 'warning', line: 7 },
    ],
  )
})

test('package: the package.json descriptor first, then the single lockfile entry; several entries resolve none', () => {
  const files = withPackages({
    '@acme/direct': { range: '^2.0.0', version: '2.1.0' },
    '@acme/transitive': { version: '3.0.1' },
    '@acme/twice': { version: '1.0.0' },
  })
  files['yarn.lock'] += lockEntry('@acme/twice', '1.1.0', ['@acme/twice@npm:^1.1.0'])
  const app = createFixtureRepo({
    ...files,
    'src/modules.ts': modulesTs(
      'if (process.env.OM_T) enabledModules.push({ id: \'twice\', from: \'@acme/twice\' })\n',
      "  { id: 'direct', from: '@acme/direct' },\n  { id: 'transitive', from: '@acme/transitive' },\n",
    ),
  })
  const { report } = run(app)
  const byId = Object.fromEntries(report.modules.entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.direct.package, '@acme/direct@2.1.0')
  assert.equal(byId.transitive.package, '@acme/transitive@3.0.1')
  assert.equal(byId.twice.package, undefined)
})

test('modules-ts: a missing src/modules.ts or a syntax error is an error', () => {
  for (const files of [{ 'src/modules.ts': null }, { 'src/modules.ts': 'export const enabledModules = [\n  { id: "auth" \n' }]) {
    const { result, report } = run(createFixtureRepo(files))
    assert.deepEqual(
      errors(report).map(({ rule, path: where }) => `${rule} ${where}`),
      ['modules-ts src/modules.ts'],
    )
    assert.equal(result.snapshotId, null)
  }
})

test('a src/modules.ts above 2,000,000 bytes is modules-unparsed as a whole; no exported list is one warning', () => {
  const big = inventoryOf({ 'src/modules.ts': `${modulesTs('')}// ${'x'.repeat(maxParseBytes)}\n` })
  assert.deepEqual(big.entries, [])
  assert.deepEqual(
    big.findings.map(({ rule, level, line }) => ({ rule, level, line })),
    [{ rule: 'modules-unparsed', level: 'warning', line: 1 }],
  )
  const none = inventoryOf({ 'src/modules.ts': 'const local = [1, 2]\nexport default local\n' })
  assert.deepEqual(
    none.unparsed.map((item) => item.line),
    [1],
  )
})

test('resolveImport: relative imports only, inside the snapshot', () => {
  const contents = new Map([['src/official-modules.generated.ts', Buffer.from('')], ['lib/x.ts', Buffer.from('')], ['src/dir/index.ts', Buffer.from('')]])
  assert.equal(resolveImport(contents, './official-modules.generated'), 'src/official-modules.generated.ts')
  assert.equal(resolveImport(contents, './official-modules.generated.js'), 'src/official-modules.generated.ts')
  assert.equal(resolveImport(contents, '../lib/x'), 'lib/x.ts')
  assert.equal(resolveImport(contents, './dir'), 'src/dir/index.ts')
  assert.equal(resolveImport(contents, '../../outside'), null)
  assert.equal(resolveImport(contents, '@acme/x'), null)
})

test('contract: the catalog modulesFromModulesTs fixtures, when they exist', (context) => {
  // Catalog Phase 1a step 4 will publish fixtures (a src/modules.ts and the
  // expected entries). Until they are vendored here, this test is skipped.
  const directory = path.join(fixtures, 'catalog', 'modules-from-modules-ts')
  if (!fs.existsSync(directory)) {
    context.skip('the catalog has not published its modulesFromModulesTs fixtures yet')
    return
  }
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.ts'))) {
    const expected = JSON.parse(fs.readFileSync(path.join(directory, name.replace(/\.ts$/, '.json')), 'utf8'))
    const inventory = inventoryOf({ 'src/modules.ts': fs.readFileSync(path.join(directory, name), 'utf8') })
    assert.deepEqual(
      inventory.entries.map(({ id, from, when }) => (when === undefined ? { id, from } : { id, from, when })),
      expected.entries,
      name,
    )
  }
})

// ---------------------------------------------------------------------------
// The manifest

test('the manifest of the fixture app: fields, generated file record, schema', () => {
  const { out, report } = run(createFixtureRepo())
  const manifest = readManifest(out)
  assert.deepEqual(manifest, {
    schema: 1,
    name: 'fixture-app',
    description: basePackage.description,
    openMercato: '0.9.x',
    modules: [
      { id: 'auth', from: '@open-mercato/core' },
      { id: 'directory', from: '@open-mercato/core' },
    ],
    createdWith: { tool: 'create-mercato-template', version: require('../package.json').version },
  })
  assertValidManifest(manifest)
  const record = report.files.find((file) => file.path === 'mercato-template.json')
  const bytes = fs.readFileSync(path.join(out, 'tree', 'mercato-template.json'))
  assert.deepEqual(record, {
    path: 'mercato-template.json',
    mode: '100644',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    origin: 'generated',
    generated: true,
  })
  assert.deepEqual(report.findings, [])
})

test('a mercato-template.json in the source app is replaced by the generated one', () => {
  const app = createFixtureRepo({ 'mercato-template.json': '{"schema":1,"name":"stale","modules":[]}\n' })
  const { out, report } = run(app)
  assert.equal(readManifest(out).name, 'fixture-app')
  assert.deepEqual(
    report.files.filter((file) => file.path === 'mercato-template.json').map((file) => file.origin),
    ['generated'],
  )
})

test('a source path equal to mercato-template.json when lower-cased is path-case-collision', () => {
  const { result, report } = run(createFixtureRepo({ 'Mercato-Template.json': '{}\n' }))
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    errors(report).map(({ rule, path: where }) => `${rule} ${where}`),
    ['path-case-collision Mercato-Template.json'],
  )
})

test('manifest-name: a scoped slug loses its scope; any other name falls back to the directory name with a warning', () => {
  const scoped = run(createFixtureRepo(withPackages({}, { name: '@acme/b2b-portal' })))
  assert.equal(readManifest(scoped.out).name, 'b2b-portal')
  assert.deepEqual(warnings(scoped.report, 'manifest-name'), [])

  const other = run(createFixtureRepo(withPackages({}, { name: 'My_App' })))
  const name = readManifest(other.out).name
  assert.match(name, /^cmt-app-[a-z0-9]+$/)
  assert.deepEqual(
    warnings(other.report, 'manifest-name').map(({ level, path: where }) => `${level} ${where}`),
    ['warning package.json'],
  )
  assert.equal(slugify('My App (v2)!'), 'my-app-v2')
  assert.equal(slugify('___'), 'template')
})

test('manifest-description: not plain text or missing, the description is left out with a warning', () => {
  for (const description of ['See https://example.com for more.', '**Bold** claims', 'A long — dash', undefined, 'x'.repeat(351)]) {
    const { out, report } = run(createFixtureRepo(withPackages({}, { description })))
    const manifest = readManifest(out)
    assert.equal(manifest.description, undefined, String(description))
    assert.equal(warnings(report, 'manifest-description').length, 1, String(description))
    assertValidManifest(manifest)
  }
  assert.equal(isPlainText('B2B self-service portal with quotes and customer accounts.'), true)
})

test('buildManifest: openMercato is left out when the core version is unknown', () => {
  const { manifest } = buildManifest({ packageJson: { name: 'x' }, appName: 'x', openMercato: null, modules: [], version: '0.1.0' })
  assert.deepEqual(manifest, { schema: 1, name: 'x', modules: [], createdWith: { tool: 'create-mercato-template', version: '0.1.0' } })
  assertValidManifest(manifest)
})

test('the JSON Schema helper rejects what the draft schema forbids', () => {
  const valid = { schema: 1, name: 'x', modules: [{ id: 'a', from: '@app', when: 'OM_A && !module:b' }], createdWith: { tool: 'create-mercato-template', version: '0.1.0' } }
  assert.deepEqual(validate(schema, valid), [])
  assert.notDeepEqual(validate(schema, { ...valid, name: 'Not A Slug' }), [])
  assert.notDeepEqual(validate(schema, { ...valid, extra: true }), [])
  assert.notDeepEqual(validate(schema, { ...valid, modules: [{ id: 'a', from: '@app', when: 'OM_A || OM_B' }] }), [])
  assert.notDeepEqual(validate(schema, { ...valid, modules: [{ id: 'Bad', from: '@app' }] }), [])
})
