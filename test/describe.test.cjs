// Spec Step 10: describe, through bin/cli.cjs and the describe() function.
// Snapshots are made with prepare() from fixture repositories in a temp
// directory. describe runs with an empty PATH, so it cannot start git, gh or
// any other program; no test touches the network. Values that look like
// secrets or email addresses are assembled from parts at test time.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parse } = require('yaml')
const packageJson = require('../package.json')
const { prepare } = require('../dist/prepare.js')
const { describe, contributingUrl, useCases } = require('../dist/describe.js')
const { createFixtureRepo, fixtureFiles, tempDir } = require('./helpers/fixture-app.cjs')
const { validate } = require('./helpers/json-schema.cjs')

const bin = path.join(__dirname, '..', 'bin', 'cli.cjs')
const catalog = path.join(__dirname, 'fixtures', 'catalog')
const templateSchema = JSON.parse(fs.readFileSync(path.join(catalog, 'template-1.json'), 'utf8'))
const manifestSchema = JSON.parse(fs.readFileSync(path.join(catalog, 'mercato-template-1.json'), 'utf8'))
const envelopeKeys = ['command', 'complete', 'contributing', 'entry', 'exitCode', 'failures', 'missing', 'ok', 'path', 'schema', 'tool', 'yaml']
const authorFields = ['github', 'useCase', 'summary', 'whenToUse', 'whenNotToUse', 'pricing', 'declares']
const curatorFields = ['slug', 'status', 'reason', 'alternatives', 'supersededBy', 'featured', 'smoke', 'ref']

const whenToUse = 'Use when B2B customers need to request quotes and manage their own accounts.'
const email = ['ops', 'acme-shop.io'].join('@')
const token = ['ghp', 'Zq8Xw2Lm4Np6Rt0Vb3Cd5Fg7Hj9Kk1Ss2Uu'].join('_')

/** package.json of the fixture app with another description (`undefined` removes it). */
function withDescription(description) {
  const value = JSON.parse(fixtureFiles['package.json'])
  if (description === undefined) delete value.description
  else value.description = description
  return { 'package.json': `${JSON.stringify(value, null, 2)}\n` }
}

const declaredEnv = `${fixtureFiles['.env.example']}
# Default currency of the shop
# (https://example.com/docs/currency).
SHOP_CURRENCY=EUR
`

/** A prepare output of the fixture app plus `files`; `exitCode` is checked. */
function prepared(files = {}, exitCode = 0) {
  const app = createFixtureRepo(files)
  const out = path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out })
  assert.equal(result.exitCode, exitCode, JSON.stringify(result.failures))
  return out
}

/** Runs bin/cli.cjs with an empty PATH: no git, no gh, no other program can start. */
function cli(args) {
  const result = spawnSync(process.execPath, [bin, ...args], { env: { PATH: '', HOME: tempDir('cmt-home-') }, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function oneEnvelope(stdout) {
  const value = JSON.parse(stdout)
  assert.equal(value.schema, 1)
  assert.equal(value.command, 'describe')
  assert.deepEqual(value.tool, { name: 'create-mercato-template', version: packageJson.version })
  assert.equal(value.ok, value.exitCode === 0)
  return value
}

/** Every file under `directory` with its content, to show that describe wrote nothing. */
function snapshotOf(directory) {
  const files = {}
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative)
      else files[relative] = fs.readFileSync(path.join(current, entry.name), 'base64')
    }
  }
  walk(directory, '')
  return files
}

function writePublication(out, fullName) {
  const publication = {
    schema: 1,
    snapshotId: JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).snapshotId,
    repo: { fullName, url: `https://github.com/${fullName}`, visibility: 'public' },
    commit: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) },
    steps: [],
    at: '2026-11-04T00:00:00.000Z',
  }
  fs.writeFileSync(path.join(out, 'publication.json'), `${JSON.stringify(publication, null, 2)}\n`)
}

test('with --use-case and --when-to-use the YAML validates against template-1.json, and the manifest against mercato-template-1.json', () => {
  const out = prepared({ '.env.example': declaredEnv })
  const before = snapshotOf(out)
  const result = cli(['describe', '--from', out, '--repo', 'acme/b2b-portal', '--use-case', 'b2b-portal', '--when-to-use', whenToUse, '--json'])
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.stderr, '')
  const value = oneEnvelope(result.stdout)
  assert.deepEqual(Object.keys(value).sort(), envelopeKeys)
  assert.deepEqual(value.failures, [])
  assert.equal(value.complete, true)
  assert.deepEqual(value.missing, [])
  assert.equal(value.path, 'templates/acme/b2b-portal.yml')
  assert.equal(value.contributing, contributingUrl)
  assert.deepEqual(value.entry, {
    github: 'acme/b2b-portal',
    useCase: 'b2b-portal',
    summary: 'A minimal Open Mercato app used by the create-mercato-template tests.',
    whenToUse,
    pricing: 'free',
    declares: { env: [{ name: 'SHOP_CURRENCY', description: 'Default currency of the shop.', link: 'https://example.com/docs/currency' }] },
  })
  const yaml = parse(value.yaml)
  assert.deepEqual(yaml, value.entry)
  assert.deepEqual(validate(templateSchema, yaml), [])
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'tree', 'mercato-template.json'), 'utf8'))
  assert.deepEqual(validate(manifestSchema, manifest), [])
  assert.deepEqual(snapshotOf(out), before, 'describe changed <from>')
})

test('without --json: the YAML file with its path, then the CONTRIBUTING link, all of it valid YAML', () => {
  const out = prepared()
  const result = cli(['describe', '--from', out, '--repo', 'acme/b2b-portal', '--use-case', 'crm', '--when-to-use', whenToUse, '--when-not-to-use', 'Not for public storefronts.'])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^# templates\/acme\/b2b-portal\.yml\ngithub: acme\/b2b-portal\n/)
  assert.ok(result.stdout.includes(`# ${contributingUrl}\n`))
  const yaml = parse(result.stdout)
  assert.equal(yaml.whenNotToUse, 'Not for public storefronts.')
  assert.deepEqual(validate(templateSchema, yaml), [])
})

test('without the two flags and with a manifest description of 20 to 140 characters: exit 0, complete false, missing useCase and whenToUse', () => {
  const out = prepared()
  const result = cli(['describe', '--from', out, '--repo', 'acme/b2b-portal', '--json'])
  assert.equal(result.status, 0)
  const value = oneEnvelope(result.stdout)
  assert.equal(value.ok, true)
  assert.equal(value.complete, false)
  assert.deepEqual(value.missing, ['useCase', 'whenToUse'])
  assert.equal(value.entry.summary, 'A minimal Open Mercato app used by the create-mercato-template tests.')
  assert.ok(value.yaml.includes(`# useCase: required, one of ${useCases.join(', ')}. Pass --use-case <value>.\n`))
  assert.match(value.yaml, /^# whenToUse: required/m)
  assert.deepEqual(parse(value.yaml), value.entry)

  const plain = cli(['describe', '--from', out, '--repo', 'acme/b2b-portal'])
  assert.equal(plain.status, 0)
  assert.match(plain.stdout, /# Incomplete: fill useCase, whenToUse before you submit/)
})

test('a manifest description shorter than 20 characters puts summary in missing; --summary fills it', () => {
  const out = prepared(withDescription('Short one.'))
  const value = describe({ from: out, repo: 'acme/app', useCase: 'starter', whenToUse })
  assert.deepEqual(value.missing, ['summary'])
  assert.equal(value.complete, false)
  assert.equal(value.entry.summary, undefined)
  assert.match(value.yaml, /^# summary: required, plain text of 20 to 140 characters\. Pass --summary <text>\.$/m)

  const filled = describe({ from: out, repo: 'acme/app', useCase: 'starter', whenToUse, summary: 'A starter for B2B quoting portals.' })
  assert.equal(filled.complete, true)
  assert.equal(filled.entry.summary, 'A starter for B2B quoting portals.')

  const none = describe({ from: prepared(withDescription(undefined)), repo: 'acme/app', useCase: 'starter', whenToUse })
  assert.deepEqual(none.missing, ['summary'])
  const long = describe({ from: prepared(withDescription(`A ${'very '.repeat(30)}long description.`)), repo: 'acme/app', useCase: 'starter', whenToUse })
  assert.deepEqual(long.missing, ['summary'])
})

test('plain-text rules on summary: a manifest description with a link or an email address is not used; such a --summary is exit 2', () => {
  for (const description of ['Quote portal, see www.example.com for details.', `Quote portal, ask ${email} for access.`]) {
    const out = prepared(withDescription(description))
    const value = describe({ from: out, repo: 'acme/app', useCase: 'crm', whenToUse })
    assert.deepEqual(value.missing, ['summary'])
    assert.ok(!value.text.includes(description) && !value.yaml.includes(email))
  }
  const out = prepared()
  for (const summary of [
    'A portal, see https://example.com/portal now.',
    'A **bold** B2B portal for quotes.',
    'A `code` B2B portal for quotes.',
    `A B2B portal ${String.fromCharCode(0x2014)} quotes and accounts.`,
    'A B2B portal\nwith two lines of text.',
    `A B2B portal, contact ${email}.`,
    `A B2B portal with key ${token}.`,
    'Too short.',
    `A B2B portal ${'and more '.repeat(20)}.`,
  ]) {
    const result = cli(['describe', '--from', out, '--repo', 'acme/app', '--summary', summary, '--json'])
    assert.equal(result.status, 2, summary)
    const value = oneEnvelope(result.stdout)
    assert.equal(value.failures[0].rule, 'usage')
    assert.match(value.failures[0].message, /^--summary /)
    assert.ok(!result.stdout.includes(email) && !result.stdout.includes(token), 'a flag value reached the output')
  }
})

test('a --when-to-use value without the "Use when " prefix, or too short, is exit 2; so are a bad --use-case and --when-not-to-use', () => {
  const out = prepared()
  const cases = [
    [['--when-to-use', 'B2B customers need to request quotes and manage their own accounts.'], /--when-to-use must start with "Use when "/],
    [['--when-to-use', 'use when B2B customers need to request quotes and accounts.'], /--when-to-use must start with "Use when "/],
    [['--when-to-use', 'Use when you need quotes.'], /--when-to-use must have 40 to 240 characters/],
    [['--when-to-use', `Use when ${'x'.repeat(240)}`], /--when-to-use must have 40 to 240 characters/],
    [['--use-case', 'b2b'], /--use-case must be one of crm, commerce, b2b-portal/],
    [['--when-not-to-use', 'x'.repeat(161)], /--when-not-to-use must have 1 to 160 characters/],
    [['--when-not-to-use', 'Not for [stores](x).'], /--when-not-to-use is not plain text/],
    [['--repo', 'acme/b2b/portal'], /--repo is not a GitHub <owner>\/<name>/],
  ]
  for (const [flags, message] of cases) {
    const args = flags[0] === '--repo' ? flags : ['--repo', 'acme/app', ...flags]
    const result = cli(['describe', '--from', out, ...args])
    assert.equal(result.status, 2, flags.join(' '))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
  }
  const missingFrom = cli(['describe', '--from', path.join(out, 'nope'), '--repo', 'acme/app'])
  assert.equal(missingFrom.status, 2)
  assert.match(missingFrom.stderr, /is not a directory\. Run prepare first/)
})

test('the path and github are lower-cased, from --repo and from publication.json', () => {
  const out = prepared()
  const value = describe({ from: out, repo: 'Acme-Labs/B2B.Portal' })
  assert.equal(value.path, 'templates/acme-labs/b2b.portal.yml')
  assert.equal(value.entry.github, 'acme-labs/b2b.portal')
  assert.match(value.yaml, /^github: acme-labs\/b2b\.portal$/m)

  writePublication(out, 'Acme-Labs/B2B.Portal')
  const published = describe({ from: out })
  assert.equal(published.path, 'templates/acme-labs/b2b.portal.yml')
  assert.equal(published.entry.github, 'acme-labs/b2b.portal')
  // The same repository in another case is not a conflict.
  assert.equal(describe({ from: out, repo: 'acme-labs/b2b.portal' }).entry.github, 'acme-labs/b2b.portal')
})

test('the repository: publication.json and --repo that differ, or neither, is exit 2', () => {
  const out = prepared()
  const neither = cli(['describe', '--from', out, '--json'])
  assert.equal(neither.status, 2)
  assert.match(oneEnvelope(neither.stdout).failures[0].message, /publication\.json is missing or names none\. Pass --repo <owner\/name>/)

  writePublication(out, 'acme/portal')
  assert.equal(cli(['describe', '--from', out]).status, 0)
  const differs = cli(['describe', '--from', out, '--repo', 'acme/other', '--json'])
  assert.equal(differs.status, 2)
  assert.match(oneEnvelope(differs.stdout).failures[0].message, /--repo acme\/other differs from acme\/portal/)

  // A publication.json whose create step failed names no repository yet.
  const failed = JSON.parse(fs.readFileSync(path.join(out, 'publication.json'), 'utf8'))
  fs.writeFileSync(path.join(out, 'publication.json'), JSON.stringify({ ...failed, repo: null }))
  assert.equal(cli(['describe', '--from', out]).status, 2)
  assert.equal(cli(['describe', '--from', out, '--repo', 'acme/other']).status, 0)
})

test('no /submit link and no curator field, in the YAML, the entry and the text', () => {
  const out = prepared({ '.env.example': declaredEnv })
  for (const args of [[], ['--use-case', 'crm', '--when-to-use', whenToUse]]) {
    const value = describe({ from: out, repo: 'acme/app', ...(args.length ? { useCase: 'crm', whenToUse } : {}) })
    assert.ok(!value.text.includes('/submit') && !value.yaml.includes('/submit'))
    assert.equal(value.contributing, 'https://github.com/open-mercato/modules/blob/main/CONTRIBUTING.md#templates')
    for (const key of Object.keys(value.entry)) assert.ok(authorFields.includes(key), `unexpected field ${key}`)
    const yaml = parse(value.yaml)
    for (const field of curatorFields) {
      assert.equal(Object.hasOwn(yaml, field), false, `curator field ${field}`)
      assert.doesNotMatch(value.yaml, new RegExp(`^${field}:`, 'm'))
    }
  }
})

test('a declared key without a description is listed under missing; an env description with an email address is dropped', () => {
  const env = `${fixtureFiles['.env.example']}
# Default currency of the shop.
SHOP_CURRENCY=EUR
# Ask ${email} for a key.
PARTNER_KEY_ID=
UNDOCUMENTED_FLAG=
`
  const out = prepared({ '.env.example': env })
  const value = describe({ from: out, repo: 'acme/app', useCase: 'crm', whenToUse })
  assert.equal(value.complete, false)
  assert.deepEqual(value.missing, ['declares.env'])
  assert.deepEqual(value.entry.declares.env, [{ name: 'SHOP_CURRENCY', description: 'Default currency of the shop.' }, { name: 'PARTNER_KEY_ID' }, { name: 'UNDOCUMENTED_FLAG' }])
  assert.match(value.yaml, /^# declares\.env: PARTNER_KEY_ID, UNDOCUMENTED_FLAG have no usable description/m)
  assert.ok(!value.text.includes(email))
})

test('a report with errors, a missing report and a manifest edited after prepare: exit 1, snapshot-modified', () => {
  const refused = prepared({ 'app.json.template': '{}\n' }, 1)
  const errors = cli(['describe', '--from', refused, '--repo', 'acme/app', '--json'])
  assert.equal(errors.status, 1)
  assert.deepEqual(oneEnvelope(errors.stdout).failures.map(({ rule, reason, path: where }) => ({ rule, reason, path: where })), [
    { rule: 'snapshot-modified', reason: 'report-errors', path: 'report.json' },
  ])
  const plain = cli(['describe', '--from', refused, '--repo', 'acme/app'])
  assert.equal(plain.status, 1)
  assert.equal(plain.stdout, '')
  assert.match(plain.stderr, /prepare refused this snapshot/)

  const empty = tempDir('cmt-empty-')
  const missing = cli(['describe', '--from', empty, '--repo', 'acme/app', '--json'])
  assert.equal(missing.status, 1)
  assert.equal(oneEnvelope(missing.stdout).failures[0].reason, 'report-missing')

  const out = prepared()
  const manifestFile = path.join(out, 'tree', 'mercato-template.json')
  fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace('"description": "', '"description": "Edited. '))
  const edited = cli(['describe', '--from', out, '--repo', 'acme/app', '--json'])
  assert.equal(edited.status, 1)
  assert.deepEqual(oneEnvelope(edited.stdout).failures.map(({ reason, path: where }) => [reason, where]), [['file-changed', 'mercato-template.json']])

  fs.rmSync(manifestFile)
  const removed = cli(['describe', '--from', out, '--repo', 'acme/app', '--json'])
  assert.equal(removed.status, 1)
  assert.equal(oneEnvelope(removed.stdout).failures[0].reason, 'file-missing')
})

test('usage errors win over a missing report (exit 2 before exit 1)', () => {
  const empty = tempDir('cmt-empty-')
  assert.equal(cli(['describe', '--from', empty, '--repo', 'acme/app', '--use-case', 'nope']).status, 2)
  assert.equal(cli(['describe', '--from', empty]).status, 2)
})

test('no email address or token typed in --repo or in the --from path reaches stdout, stderr or the envelope', () => {
  const out = prepared()
  const inside = path.join(tempDir('cmt-'), `copy-${email}`)
  fs.cpSync(out, inside, { recursive: true })
  const empty = path.join(tempDir('cmt-'), `empty-${email}-${token}`)
  fs.mkdirSync(empty)
  const cases = [
    { args: ['--from', out, '--repo', email], status: 2 },
    { args: ['--from', out, '--repo', token], status: 2 },
    { args: ['--from', path.join(out, `nope-${email}`), '--repo', 'acme/app'], status: 2 },
    { args: ['--from', empty, '--repo', 'acme/app'], status: 1 },
  ]
  for (const { args, status } of cases)
    for (const json of [false, true]) {
      const result = cli(['describe', ...args, ...(json ? ['--json'] : [])])
      assert.equal(result.status, status, args.join(' '))
      const output = result.stdout + result.stderr
      assert.ok(!output.includes(email), `an email address reached the output: ${args.join(' ')}`)
      assert.ok(!output.includes(token), `a token reached the output: ${args.join(' ')}`)
    }
  const fine = cli(['describe', '--from', inside, '--repo', 'acme/app'])
  assert.equal(fine.status, 0)
  assert.ok(!fine.stdout.includes(email) && !fine.stderr.includes(email))
})

test('more than 30 declared keys: declares.env is listed under missing, with a comment', () => {
  const keys = Array.from({ length: 31 }, (_, index) => `# Setting number ${index + 1}.\nSHOP_SETTING_${index + 1}=\n`).join('')
  const out = prepared({ '.env.example': `${fixtureFiles['.env.example']}${keys}` })
  const value = describe({ from: out, repo: 'acme/app', useCase: 'crm', whenToUse })
  assert.equal(value.entry.declares.env.length, 31)
  assert.deepEqual(value.missing, ['declares.env'])
  assert.equal(value.complete, false)
  assert.match(value.yaml, /^# declares\.env: 31 keys; the catalog takes at most 30\./m)
  assert.doesNotMatch(value.yaml, /no usable description/)
})

test('a refusal of <from> says what describe did not do, not what publish did not do', () => {
  const result = cli(['describe', '--from', tempDir('cmt-empty-'), '--repo', 'acme/app'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no entry was printed/)
  assert.doesNotMatch(result.stderr, /publish it|Nothing remote/)
})

test('a publish refusal returned as an outcome is redacted too: no email address from the --from path', () => {
  const from = path.join(tempDir('cmt-'), `x-${email}`)
  fs.mkdirSync(from)
  for (const json of [false, true]) {
    const result = cli(['publish', '--from', from, '--repo', 'acme/app', '--public', '--expect', 'a'.repeat(64), ...(json ? ['--json'] : [])])
    assert.equal(result.status, 1)
    assert.ok(!(result.stdout + result.stderr).includes(email), 'an email address reached the output')
    assert.match(result.stdout + result.stderr, /\[EMAIL\]/)
  }
})

test('the vendored entry schema is the catalog file, not a draft', () => {
  assert.equal(templateSchema.$id, 'https://modules.openmercato.com/schema/template-1.json')
  assert.equal(templateSchema.$comment, undefined)
})
