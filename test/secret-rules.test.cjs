// Spec Step 6: the secret rule converter (scripts/build-secret-rules.mts) and
// the committed src/rules/gitleaks.json. The input is the vendored gitleaks
// v8.30.1 config under test/fixtures/gitleaks/ (see SOURCE.md); no test
// fetches it. The scan that uses the rules is Step 7.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { bundledRules, rulesSummary } = require('../dist/rules/gitleaks.js')

const root = path.join(__dirname, '..')
const fixtureDirectory = path.join(__dirname, 'fixtures', 'gitleaks')
const fixtureToml = fs.readFileSync(path.join(fixtureDirectory, 'gitleaks.toml'), 'utf8')
const committedRules = fs.readFileSync(path.join(root, 'src', 'rules', 'gitleaks.json'), 'utf8')
const committedSkipped = fs.readFileSync(path.join(root, 'scripts', 'secret-rules-skipped.json'), 'utf8')

const requiredIds = [
  'private-key',
  'aws-access-token',
  'github-pat',
  'github-fine-grained-pat',
  'github-oauth',
  'github-app-token',
  'github-refresh-token',
  'npm-access-token',
  'openai-api-key',
  'stripe-access-token',
  'slack-bot-token',
  'slack-user-token',
  'slack-app-token',
  'slack-webhook-url',
]

// The converter is a type-stripped .mts module; import it, do not run it
// (same warning filter as test/stock.test.cjs).
let converter
function loadConverter() {
  if (!converter) {
    const printers = process.listeners('warning')
    process.removeAllListeners('warning')
    process.on('warning', (warning) => {
      if (warning.code !== 'MODULE_TYPELESS_PACKAGE_JSON') for (const printer of printers) printer(warning)
    })
    converter = import(pathToFileURL(path.join(root, 'scripts', 'build-secret-rules.mts')).href)
  }
  return converter
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function compile(converted) {
  return new RegExp(converted.source, converted.flags)
}

/** The fixture config with the [[rules]] block of `id` (and its allowlists) removed. */
function withoutRule(toml, id) {
  const blocks = toml.split(/(?=^\[\[rules\]\]$)/m)
  const kept = blocks.filter((block) => !block.startsWith(`[[rules]]\nid = "${id}"\n`))
  assert.equal(kept.length, blocks.length - 1, `the fixture has the rule ${id}`)
  return kept.join('')
}

/** A config of the required ids with simple patterns, plus `extra` TOML. */
function smallConfig(extra = '') {
  const rules = requiredIds.map((id) => `[[rules]]\nid = "${id}"\nregex = '''${id}-[a-z]{8}'''\nkeywords = ["${id}"]\n`)
  return `title = "small"\n\n${rules.join('\n')}\n${extra}`
}

function mutedConsole(callback) {
  const saved = { log: console.log, error: console.error }
  const lines = []
  console.log = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  return Promise.resolve()
    .then(callback)
    .finally(() => Object.assign(console, saved))
    .then((value) => ({ value, lines }))
}

test('the vendored fixture is gitleaks v8.30.1 config/gitleaks.toml with the pinned sha256', async () => {
  const { gitleaksSource, gitleaksUrl } = await loadConverter()
  assert.equal(sha256(fixtureToml), gitleaksSource.sha256)
  assert.equal(gitleaksSource.tag, 'v8.30.1')
  assert.equal(gitleaksUrl, 'https://raw.githubusercontent.com/gitleaks/gitleaks/v8.30.1/config/gitleaks.toml')
  assert.ok(fs.readFileSync(path.join(fixtureDirectory, 'SOURCE.md'), 'utf8').includes(gitleaksSource.sha256))
})

test('the committed gitleaks.json is exactly the conversion of the fixture, and the conversion is deterministic', async () => {
  const { buildSecretRules, parseSkipped, serializeSecretRules } = await loadConverter()
  const skipped = parseSkipped(committedSkipped)
  const first = serializeSecretRules(buildSecretRules(fixtureToml, skipped))
  const second = serializeSecretRules(buildSecretRules(fixtureToml, skipped))
  assert.equal(first, second)
  assert.equal(first, committedRules, 'run npm run secret-rules and commit src/rules/gitleaks.json')
  assert.ok(!/[^\t\n -~]/.test(committedRules), 'the committed file is plain printable ASCII')
})

test('the converted file has the required ids, every rule, and patterns that compile', () => {
  const ids = bundledRules.rules.map((rule) => rule.id)
  for (const id of requiredIds) assert.ok(ids.includes(id), id)
  assert.equal(bundledRules.count, 222)
  assert.equal(ids.length, 222)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(bundledRules.skipped, JSON.parse(committedSkipped))
  for (const rule of bundledRules.rules) {
    for (const converted of [rule.regex, rule.path, ...rule.allowlists.flatMap((list) => [...list.regexes, ...(list.paths ?? [])])])
      if (converted) assert.doesNotThrow(() => compile(converted), rule.id)
  }
  assert.deepEqual(rulesSummary(), { source: bundledRules.source, count: 222, skipped: [] })
})

test('the rule build fails when a required id is removed from the input TOML', async () => {
  const { buildSecretRules } = await loadConverter()
  assert.throws(() => buildSecretRules(withoutRule(fixtureToml, 'private-key'), []), /Required rule\(s\) missing[^\n]*private-key/)
  assert.throws(() => buildSecretRules(withoutRule(fixtureToml, 'slack-webhook-url'), []), /slack-webhook-url/)
  // Skipping a required rule does not get around the check.
  assert.throws(() => buildSecretRules(fixtureToml, [{ id: 'github-pat', reason: 'test' }]), /missing[^\n]*github-pat/)
  assert.ok(buildSecretRules(smallConfig(), []).rules.length === requiredIds.length)
})

test('the rule build fails on a construct it cannot convert, unless the rule is listed in secret-rules-skipped.json', async () => {
  const { buildSecretRules } = await loadConverter()
  const unconvertible = smallConfig(`[[rules]]\nid = "unicode-letters"\nregex = '''key-\\pL{8}'''\n`)
  assert.throws(() => buildSecretRules(unconvertible, []), /cannot be converted[\s\S]*unicode-letters regex: the escape \\p has no translation/)
  const built = buildSecretRules(unconvertible, [{ id: 'unicode-letters', reason: 'Unicode class without the u flag.' }])
  assert.ok(!built.rules.some((rule) => rule.id === 'unicode-letters'))
  assert.deepEqual(built.skipped, [{ id: 'unicode-letters', reason: 'Unicode class without the u flag.' }])
  assert.equal(built.count, requiredIds.length)
  // An unsupported key in a rule or an allowlist is a construct it cannot convert too.
  assert.throws(() => buildSecretRules(smallConfig(`[[rules]]\nid = "composite"\nregex = '''x'''\n[[rules.required]]\nid = "private-key"\n`), []), /composite: the unsupported key required/)
  assert.throws(
    () => buildSecretRules(smallConfig(`[[rules]]\nid = "commits"\nregex = '''x'''\n[[rules.allowlists]]\ncommits = ["abc"]\n`), []),
    /commits allowlists\[0\] has the unsupported key commits/,
  )
  // A listed id the config does not have is stale.
  assert.throws(() => buildSecretRules(smallConfig(), [{ id: 'gone', reason: 'old' }]), /does not have: gone/)
})

test('secret-rules-skipped.json: a list of {id, reason}, each with a reason, no id twice', async () => {
  const { parseSkipped } = await loadConverter()
  assert.deepEqual(parseSkipped(committedSkipped), [])
  assert.deepEqual(parseSkipped('[{"id": "a", "reason": "why"}]'), [{ id: 'a', reason: 'why' }])
  assert.throws(() => parseSkipped('{"a": "why"}'), /not a list/)
  assert.throws(() => parseSkipped('[{"id": "a"}]'), /with a reason/)
  assert.throws(() => parseSkipped('[{"id": "a", "reason": " "}]'), /with a reason/)
  assert.throws(() => parseSkipped('[{"id": "a", "reason": "x"}, {"id": "a", "reason": "y"}]'), /twice/)
})

test('translation \\z: the end of the text only', async () => {
  const { convertRegex } = await loadConverter()
  const converted = convertRegex('token-[a-z]{4}(?:[^a-z]|\\z)')
  assert.equal(converted.source, 'token-[a-z]{4}(?:[^a-z]|$(?![\\s\\S]))')
  const regex = compile(converted)
  assert.ok(regex.test('x = token-abcd'))
  assert.ok(regex.test('token-abcd;'))
  assert.ok(!regex.test('token-abcde'))
  // With the m modifier, $ alone would also match before a line break.
  const multiline = compile(convertRegex('(?m)token-[a-z]{4}\\z'))
  assert.equal(multiline.flags, 'm')
  assert.ok(!multiline.test('token-abcd\nmore'))
  assert.ok(multiline.test('more\ntoken-abcd'))
  // In JavaScript \z alone is the letter z: the converter never passes it through.
  assert.ok(!converted.source.includes('\\z'))
})

test('translation (?s:.): any character, line breaks included; a dot elsewhere stops only at \\n, as in RE2', async () => {
  const { convertRegex } = await loadConverter()
  const converted = convertRegex('kind:(?s:.){0,20}?data:.+')
  assert.equal(converted.source, 'kind:(?:[\\s\\S]){0,20}?data:[^\\n]+')
  const regex = compile(converted)
  assert.ok(regex.test('kind: Secret\nmetadata: x\ndata: value'))
  assert.ok(!regex.test('kind: Secret\n'.padEnd(40, 'x') + '\ndata: value'))
  assert.ok(!regex.test('kind: x data:\nvalue'))
  // RE2's dot matches \r; a plain JavaScript dot does not.
  assert.ok(regex.test('kind: data:value\r\n'))
  assert.equal(regex.exec('kind: data:a\rb\nc')[0], 'kind: data:a\rb')
  // A leading (?s) applies to every dot, and (?-s:...) turns it off again.
  const dotAll = compile(convertRegex('(?s)a.b(?-s:.)c'))
  assert.ok(dotAll.test('a\nbxc'))
  assert.ok(!dotAll.test('a\nb\nc'))
})

test('translation (?P<name>: a JavaScript named group', async () => {
  const { convertRegex } = await loadConverter()
  const converted = convertRegex('\\bZXlK(?:(?P<alg>aGJHY2lPaU)|(?P<typ>dGVYUWlPaU))')
  assert.equal(converted.source, '\\bZXlK(?:(?<alg>aGJHY2lPaU)|(?<typ>dGVYUWlPaU))')
  const regex = compile(converted)
  assert.equal(regex.exec('x ZXlKaGJHY2lPaU').groups.alg, 'aGJHY2lPaU')
  assert.equal(regex.exec('ZXlKdGVYUWlPaU').groups.typ, 'dGVYUWlPaU')
  assert.ok(!regex.test('ZXlKbm90aGluZw'))
  assert.ok(!regex.test('P<alg>aGJHY2lPaU'))
})

test('translation of a POSIX class: its ASCII ranges', async () => {
  const { convertRegex } = await loadConverter()
  const converted = convertRegex('\\b(pat[[:alnum:]]{14}\\.[a-f0-9]{4})\\b')
  assert.equal(converted.source, '\\b(pat[0-9A-Za-z]{14}\\.[a-f0-9]{4})\\b')
  const regex = compile(converted)
  assert.ok(regex.test('pat0123456789ABcd.beef'))
  assert.ok(!regex.test('pat0123456789AB-d.beef'))
  assert.ok(!regex.test('pat:alnum:alnum:a.beef'))
  const others = compile(convertRegex('^[[:xdigit:][:space:]_]+$'))
  assert.ok(others.test('0aF \t_'))
  assert.ok(!others.test('0aG'))
})

test('other translations: leading (?i), (?i) inside a group across |, (?-i:, and ] first in a class', async () => {
  const { convertRegex } = await loadConverter()
  assert.deepEqual(convertRegex('(?i)key'), { source: 'key', flags: 'i' })
  // RE2 keeps a (?i) to the end of the enclosing group, across its | branches.
  const scoped = convertRegex('(?:"(?i)a"|\'b\')x')
  assert.equal(scoped.source, '(?:"(?i:a")|(?i:\'b\'))x')
  const regex = compile(scoped)
  assert.ok(regex.test('"A"x'))
  assert.ok(regex.test("'B'x"))
  assert.ok(!regex.test('"A"X'))
  const inner = compile(convertRegex('(?i)[a-z]{2}(?-i:ATLAS)'))
  assert.ok(inner.test('xyATLAS'))
  assert.ok(!inner.test('xyatlas'))
  // In RE2 [^]] is "not ]"; in JavaScript [^] would be any character.
  const bracket = convertRegex('[^:]+:\\[[^]]+]')
  assert.equal(bracket.source, '[^:]+:\\[[^\\]]+]')
  assert.ok(compile(bracket).test('user:[secret]'))
  assert.ok(!compile(bracket).test('user:[]]'))
  assert.equal(compile(convertRegex('\\Aabc')).test('xabc'), false)
})

test('constructs with no translation fail the conversion instead of passing through', async () => {
  const { convertRegex, ConversionError } = await loadConverter()
  for (const pattern of ['\\pL', '\\p{Greek}', '\\Qa.b\\E', 'a(?=b)', '(?<!a)b', '(?U)a+', '(a)\\1', '[[:^alpha:]]', '[[:nope:]]', '\\x{41}', '\\C', 'a)', '(a', '[a', '\\'])
    assert.throws(() => convertRegex(pattern), ConversionError, pattern)
})

test('rule path filters and allowlist regexTarget, condition and AND paths survive the conversion', async () => {
  const { buildSecretRules, parseSkipped } = await loadConverter()
  const rules = buildSecretRules(fixtureToml, parseSkipped(committedSkipped)).rules
  const byId = Object.fromEntries(rules.map((rule) => [rule.id, rule]))
  // Five rules have a path filter; pkcs12-file has nothing else.
  assert.deepEqual(
    rules.filter((rule) => rule.path).map((rule) => rule.id),
    ['freemius-secret-key', 'hashicorp-tf-password', 'kubernetes-secret-yaml', 'nuget-config-password', 'pkcs12-file'],
  )
  assert.equal(byId['pkcs12-file'].regex, null)
  assert.ok(compile(byId['pkcs12-file'].path).test('certs/Client.PFX'))
  assert.ok(!compile(byId['pkcs12-file'].path).test('certs/client.pfx.txt'))
  assert.ok(compile(byId['nuget-config-password'].path).test('src/NuGet.Config'))
  // generic-api-key: a default (secret) allowlist, one on the match with stopwords, one on the line, and one AND with paths.
  const generic = byId['generic-api-key'].allowlists
  assert.deepEqual(
    generic.map((list) => [list.condition, list.regexTarget, list.regexes.length, list.stopwords.length > 0, list.paths?.length ?? 0]),
    [
      ['OR', 'secret', 1, false, 0],
      ['OR', 'match', 1, true, 0],
      ['OR', 'line', 2, false, 0],
      ['AND', 'line', 3, false, 4],
    ],
  )
  const andPaths = generic[3].paths.map(compile)
  assert.ok(andPaths.some((regex) => regex.test('meta/recipes/app.bbappend')))
  assert.ok(!andPaths.some((regex) => regex.test('src/app.ts')))
  assert.ok(generic[1].stopwords.includes('dev-') || generic[1].stopwords.includes('back'))
  assert.equal(byId['sonar-api-token'].secretGroup, 2)
  assert.equal(byId['github-pat'].entropy, 3)
  assert.deepEqual(byId['github-pat'].keywords, ['ghp_'])
  // Path-only allowlists (an OR with only paths) are dropped, so every exported file is scanned.
  assert.deepEqual(byId['github-pat'].allowlists, [])
  assert.deepEqual(byId['github-app-token'].allowlists, [])
  // The global [allowlist] is dropped too: nothing in the output exempts node_modules or lockfiles.
  assert.ok(!committedRules.includes('node_modules'))
})

test('the TOML reader: the subset gitleaks uses, and an error with its line for anything else', async () => {
  const { parseToml, TomlError } = await loadConverter()
  const parsed = parseToml(
    [
      '# comment',
      'title = "a \\"quoted\\" \\u0041" # trailing',
      '[allowlist]',
      "paths = ['''a''', '''b''',",
      "  # inside",
      "  'c',",
      ']',
      '[[rules]]',
      'id = "x"',
      "regex = '''it''s ''\\z'''''",
      'entropy = 3.5',
      'secretGroup = 2',
      'ok = true',
      '[[rules.allowlists]]',
      'regexes = []',
      '[[rules]]',
      'id = "y"',
      'regex = """',
      'multi"""',
      '',
    ].join('\n'),
  )
  assert.equal(parsed.title, 'a "quoted" A')
  assert.deepEqual(parsed.allowlist.paths, ['a', 'b', 'c'])
  assert.equal(parsed.rules[0].regex, "it''s ''\\z''")
  assert.equal(parsed.rules[0].entropy, 3.5)
  assert.equal(parsed.rules[0].secretGroup, 2)
  assert.equal(parsed.rules[0].ok, true)
  assert.deepEqual(parsed.rules[0].allowlists, [{ regexes: [] }].map((entry) => Object.assign(Object.create(null), entry)))
  assert.equal(parsed.rules[1].regex, 'multi')
  for (const [text, message] of [
    ['a.b = 1', /line 1: expected = after a/],
    ['"a" = 1', /line 1: expected a bare key/],
    ['a = { b = 1 }', /unsupported value/],
    ['a = 1979-05-27', /unsupported value/],
    ['a = 1\na = 2', /line 2: duplicate key a/],
    ['a = "x\\q"', /unsupported escape/],
    ["a = 'x", /unterminated string/],
    ['[t]\n[t]', /defined twice/],
    ['a = 1 b = 2', /unexpected "b"/],
  ])
    assert.throws(() => parseToml(text), (error) => error instanceof TomlError && message.test(error.message), text)
})

test('the command line: pinned sha256, --check, --input, usage', async () => {
  const { main, serializeSecretRules, buildSecretRules } = await loadConverter()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-secret-rules-'))
  try {
    const rulesPath = path.join(directory, 'gitleaks.json')
    const skippedPath = path.join(directory, 'skipped.json')
    fs.writeFileSync(skippedPath, '[]\n')
    let fetched = 0
    const fetchConfig = async () => {
      fetched++
      return fixtureToml
    }
    const options = { fetchConfig, rulesPath, skippedPath }

    // --check with no committed file, then the write, then --check again.
    let outcome = await mutedConsole(() => main(['--check'], options))
    assert.equal(outcome.value, 1)
    outcome = await mutedConsole(() => main([], options))
    assert.equal(outcome.value, 0)
    assert.match(outcome.lines.join('\n'), /Wrote 222 rules from gitleaks v8.30.1/)
    assert.equal(fs.readFileSync(rulesPath, 'utf8'), committedRules)
    outcome = await mutedConsole(() => main(['--check'], options))
    assert.equal(outcome.value, 0)
    assert.equal(fetched, 3)

    // A committed file that differs fails --check.
    fs.writeFileSync(rulesPath, serializeSecretRules(buildSecretRules(fixtureToml, [{ id: 'adobe-client-id', reason: 'test' }])))
    outcome = await mutedConsole(() => main(['--check'], options))
    assert.equal(outcome.value, 1)
    assert.match(outcome.lines.join('\n'), /differs/)

    // A config that is not the pinned file is refused, and nothing is written.
    const before = fs.readFileSync(rulesPath, 'utf8')
    outcome = await mutedConsole(() => main([], { ...options, fetchConfig: async () => `${fixtureToml}\n` }))
    assert.equal(outcome.value, 1)
    assert.match(outcome.lines.join('\n'), /not the pinned e163e53b/)
    assert.equal(fs.readFileSync(rulesPath, 'utf8'), before)

    // --input reads a local copy and never fetches.
    outcome = await mutedConsole(() => main(['--input', path.join(fixtureDirectory, 'gitleaks.toml')], { ...options, fetchConfig: async () => assert.fail('fetched') }))
    assert.equal(outcome.value, 0)
    assert.equal(fs.readFileSync(rulesPath, 'utf8'), committedRules)

    for (const argv of [['--nope'], ['--check', '--check'], ['--input']]) {
      outcome = await mutedConsole(() => main(argv, options))
      assert.equal(outcome.value, 2, argv.join(' '))
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
