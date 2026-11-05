// Issue #9: the cost of the secret scan on large single-line text (spec,
// Secret scan, "Scan cost"). The scan must find exactly what a global exec
// loop of each rule finds (scanSecretsReference), stay fast on the inputs of
// the issue, and refuse a file with `scan-limit` rather than export it
// unscanned when a rule cannot be bounded. Nothing is timed inside the scan;
// the time limits below are only these tests' guard.
//
// No secret-looking value is committed (AGENTS.md): fixtures are assembled at
// test time (test/helpers/secret-fixtures.cjs).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { prepare } = require('../dist/prepare.js')
const { scanSecrets, scanSecretsReference, scanText, scanWorkLimit } = require('../dist/policy/secrets.js')
const { PatternError, analyzePattern } = require('../dist/rules/pattern.js')
const { compileProgram, runProgram, scanProgram } = require('../dist/rules/pike.js')
const { bundledRules } = require('../dist/rules/gitleaks.js')
const { extraRules } = require('../dist/rules/extra.js')
const { createFixtureRepo, gitEnvironment, tempDir } = require('./helpers/fixture-app.cjs')
const { join, randomText, secrets } = require('./helpers/secret-fixtures.cjs')

const MB = 1 << 20
const allRules = [...bundledRules.rules, ...extraRules].filter((rule) => rule.regex !== null)
const keywords = [...new Set(bundledRules.rules.flatMap((rule) => rule.keywords))]
const fill = (unit, length = MB) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
const rule = (id, source, flags = '', keywordList = []) => ({ id, regex: { source, flags }, secretGroup: 0, entropy: null, keywords: keywordList, path: null, allowlists: [] })
const only = (...rules) => ({ rules, extra: [] })
const brief = (findings) => findings.map((finding) => `${finding.rule}:${finding.ruleId ?? ''}:${finding.line ?? ''}`)

function seconds(work) {
  const started = process.hrtime.bigint()
  const result = work()
  return { result, seconds: Number(process.hrtime.bigint() - started) / 1e9 }
}

/** Deterministic pseudo-random numbers (the same texts on every run). */
function generator(seed) {
  let state = seed >>> 0
  return (limit) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return (state >>> 8) % limit
  }
}

test('every bundled and extra rule is read and compiles; five run on the linear matcher, two have no anchor', () => {
  const vm = []
  const unanchored = []
  for (const item of allRules) {
    const facts = analyzePattern(item.regex)
    if (facts.engine === 'vm') vm.push(item.id)
    if (facts.anchors === null) unanchored.push(item.id)
    for (const anchor of facts.anchors ?? []) assert.doesNotThrow(() => new RegExp(anchor.source, item.regex.flags))
    if (facts.split) assert.doesNotThrow(() => new RegExp(facts.split.tail, item.regex.flags))
    assert.doesNotThrow(() => compileProgram(item.regex), item.id)
  }
  assert.deepEqual(vm.sort(), ['curl-auth-header', 'curl-auth-user', 'kubernetes-secret-yaml', 'nuget-config-password', 'private-key'])
  assert.deepEqual(unanchored.sort(), ['facebook-access-token', 'sourcegraph-access-token'])
})

test('analyzePattern: anchors, maximum length, split, and the engine', () => {
  assert.deepEqual(analyzePattern({ source: '\\bghp_[0-9a-zA-Z]{36}', flags: '' }), {
    maxLength: 40,
    anchors: [{ source: '\\bghp_', before: { min: 0, max: 0 } }],
    engine: 'regexp',
    split: null,
  })
  // One anchor per branch of a top-level alternation, each with its distance from the match start.
  assert.deepEqual(analyzePattern({ source: '[a-z]{2,4}_mmk|\\bATATT3[A-Z]{8}', flags: '' }).anchors, [
    { source: '_mmk', before: { min: 2, max: 4 } },
    { source: '\\bATATT3', before: { min: 0, max: 0 } },
  ])
  // An unbounded part before the anchor: no anchor to prove.
  assert.equal(analyzePattern({ source: '[a-z]+_mmk', flags: '' }).anchors, null)
  // The lazy keyword prefix of the gitleaks keyword rules is split off, and two of them join.
  const split = analyzePattern({ source: '[\\w.-]{0,50}?(?:key|token)=([a-z0-9]{8})', flags: 'i' }).split
  assert.deepEqual(split, { prefix: { source: '[\\w.-]', flags: 'i', min: 0, max: 50, lazy: true }, tail: '(?:key|token)=([a-z0-9]{8})', tailAnchors: ['(?:key|token)='] })
  const nested = analyzePattern({ source: '[\\w.-]{0,50}?(?i:[\\w.-]{0,50}?(?:cohere)=)x', flags: '' }).split
  assert.deepEqual(nested.prefix, { source: '[\\w.-]', flags: '', min: 0, max: 100, lazy: true })
  assert.equal(nested.tail, '(?i:(?:cohere)=)x')
  // Regression (review of #19): the tail anchors are read from the tail, never from the merged inner repeat.
  assert.deepEqual(analyzePattern({ source: '[a-z]{1,3}?([a-z]{1,3}?(?:ab))x', flags: '' }).split.tailAnchors, ['((?:ab))x'])
  // Linear: the run is fenced (`\b` before word characters, a `.` that is not in it) and followed by a character outside it.
  assert.equal(analyzePattern({ source: '\\bab[a-z]{5,}\\.', flags: '' }).engine, 'regexp')
  assert.equal(analyzePattern({ source: 'x\\.[a-z]+=', flags: '' }).engine, 'regexp')
  // Linear: an unbounded run at the end of the pattern.
  assert.equal(analyzePattern({ source: 'npm_[a-z0-9]{30,}', flags: '' }).engine, 'regexp')
  // Not linear: nothing fences the run.
  assert.equal(analyzePattern({ source: '\\bcurl\\b[^\\n]*?-u ([^ ]+) ', flags: '' }).engine, 'vm')
  // Bounded, but with too many ways for one try: two repeats that trade characters.
  assert.equal(analyzePattern({ source: 'zz[^\\n]{0,1500}[^\\n]{0,1500}y', flags: '' }).engine, 'vm')
  // Bounded, and a repeat followed by a character outside it adds instead of multiplying.
  assert.equal(analyzePattern({ source: 'zz[a-z]{0,1500}=[0-9]{0,1500}y', flags: '' }).engine, 'regexp')
})

test('analyzePattern and the linear matcher refuse what they cannot read or bound: a PatternError', () => {
  for (const source of ['(a)\\1', '(?=a+)b', '(?<=a+)b', '\\p{L}', '[a-\\d]'])
    assert.throws(() => analyzePattern({ source, flags: '' }), PatternError, source)
  for (const source of ['(?:a?)*b', '(?=a)b', 'a(?<!b)'])
    assert.throws(() => compileProgram({ source, flags: '' }), PatternError, source)
})

test('the linear matcher finds what exec finds, groups included, on random patterns and texts', () => {
  const next = generator(5)
  const pick = (list) => list[next(list.length)]
  const atoms = ['a', 'b', 'c', 'A', '-', '=', ' ', '[ab]', '[a-c]', '[^\\n]', '[^a]', '[aA]', '\\w', '[\\w-]', '\\b', '\\B', '^', '$', '[\\s\\S]', '\\n', '\\r']
  const quantifiers = ['', '', '?', '*', '+', '*?', '+?', '??', '{0,3}', '{0,3}?', '{1,2}', '{2,}', '{2,4}', '{1,3}?']
  let groups = 0
  const pattern = (depth) => {
    let source = ''
    for (let count = 1 + next(4); count > 0; count--) {
      if (depth < 3 && next(10) < 3) {
        let inner = pattern(depth + 1)
        if (next(3) === 0) inner += `|${pattern(depth + 1)}`
        source += `${pick(['(?:', '(', `(?<g${groups++}>`])}${inner})${pick(quantifiers)}`
      } else {
        const atom = pick(atoms)
        source += ['\\b', '\\B', '^', '$'].includes(atom) ? atom : `${atom}${pick(quantifiers)}`
      }
    }
    return source
  }
  let compared = 0
  for (let index = 0; index < 4000; index++) {
    groups = 0
    const source = pattern(0)
    const flags = next(2) ? 'i' : ''
    let program
    try {
      program = compileProgram({ source, flags })
    } catch (error) {
      if (error instanceof PatternError) continue
      throw error
    }
    const text = Array.from({ length: next(30) }, () => 'aabbcA- =\n\r_x'[next(15)]).join('')
    const expected = []
    const regex = new RegExp(source, `${flags}g`)
    for (let found = regex.exec(text); found !== null; found = regex.exec(text)) {
      if (found[0] === '') regex.lastIndex++
      else expected.push([found.index, found[0], ...found.slice(1)])
    }
    const actual = []
    const work = { steps: 0, limit: Number.POSITIVE_INFINITY }
    for (let from = 0; from <= text.length; ) {
      const result = scanProgram(program, text, from, () => true, (position) => position, work)
      if (!('match' in result)) break
      const { start, end } = result.match
      if (end === start) {
        from = start + 1
        continue
      }
      const full = runProgram(program, text, start, (position) => position === start, (position) => (position <= start ? start : Infinity), work)
      actual.push([start, text.slice(start, end), ...full.match.groups.map((group) => (group ? text.slice(group[0], group[1]) : undefined))])
      from = end
    }
    assert.deepEqual(actual, expected, JSON.stringify({ source, flags, text }))
    compared++
  }
  assert.ok(compared > 2000, `${compared} patterns`)
})

test('the scan finds exactly what a global exec loop of each rule finds, on dense random text', () => {
  const prefixes = ['ghp_', 'github_pat_', 'sk-proj-', 'sk_live_', 'xoxb-', 'xapp-1-', 'AKIA', 'AIza', 'npm_', 'whsec_', 'eyJ', 'ey', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----', 'curl ', ' -H "Authorization: Bearer ', ' -u ', 'kind: Secret', 'data:', '<add key="Password" value="', 'https://', 'glpat-', 'ops_eyJ', 'EAAM', 'T3BlbkFJ', 'KEY-----']
  const separators = [' = ', '=', ': ', ':', ' => ', '"', "'", '\n', ' ', ', ', ';', '\t', '\r\n', '.', '/', '+', '-', '_', '`', '\\n', '|', ':=']
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const next = generator(9)
  const run = (characters, length) => Array.from({ length }, () => characters[next(characters.length)]).join('')
  let compared = 0
  let found = 0
  for (let index = 0; index < 400; index++) {
    let text = ''
    for (let part = 20 + next(160); part > 0; part--) {
      const kind = next(10)
      if (kind < 2) text += keywords[next(keywords.length)]
      else if (kind < 4) text += prefixes[next(prefixes.length)]
      else if (kind < 6) text += separators[next(separators.length)]
      else if (kind < 8) text += run(alphabet, 1 + next(next(3) === 0 ? 300 : 50))
      else if (kind < 9) text += run('0123456789abcdef', 8 + next(64))
      else text += run(`${alphabet}+/=-_.`, 10 + next(120))
    }
    // Paths that let the path-filtered rules run too (kubernetes-secret-yaml, nuget-config-password).
    const file = ['src/x.ts', 'deploy/secret.yaml', 'nuget.config'][index % 3]
    const fast = scanSecrets(file, text)
    if (fast.some((finding) => finding.rule === 'scan-limit')) continue
    assert.deepEqual(brief(fast), brief(scanSecretsReference(file, text)), JSON.stringify({ file, text }))
    compared++
    found += fast.length
  }
  assert.ok(compared > 300 && found > 300, `${compared} texts, ${found} findings`)
})

test('a secret at any offset of a long line is found, across every boundary of the old chunk idea', () => {
  const filler = fill(`${randomText('filler', 61, 'qwrtzpsdfghjlvbnm')} `, 140000)
  const subjects = secrets.filter((item) => item.ruleId !== 'private-key')
  for (const offset of [0, 1, 4095, 4096, 65535, 65536, 139990])
    for (const item of subjects) {
      const text = `${filler.slice(0, offset)} ${item.value} ${filler.slice(offset)}\n`
      assert.deepEqual(brief(scanSecrets('src/blob.ts', text)), [`secret:${item.ruleId}:1`], `${item.ruleId} at ${offset}`)
    }
  // The window before a keyword: a generic match that starts the full 50 characters before it.
  const name = `${'a'.repeat(50)}token`
  const value = join(randomText('gw1', 20), '9Zq')
  for (const before of ['', ' ', fill('x9Q-', 70001)]) {
    const text = `${before} ${name} = "${value}"\n`
    assert.deepEqual(brief(scanSecrets('src/a.ts', text)), brief(scanSecretsReference('src/a.ts', text)))
    assert.deepEqual(brief(scanSecrets('src/a.ts', text)), ['secret:generic-api-key:1'])
  }
})

test('the inputs of issue #9 finish well within a CI time limit, with the same findings as before', () => {
  const next = generator(3)
  let hex = 'const blob = "'
  let keyword = 0
  while (hex.length < MB) hex += next(2000) === 0 ? keywords[keyword++ % keywords.length] : '0123456789abcdef'[next(16)]
  hex += '"\n'
  let base64 = 'export const image = "data:image/png;base64,'
  const words = ['token', 'secret', 'key', 'auth', 'password', 'api', 'access', 'client', 'private', 'credential']
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  while (base64.length < MB) base64 += next(200) === 0 ? words[next(words.length)] : b64[next(64)]
  base64 += '"\n'
  const tsc = fs.readFileSync(require.resolve('typescript/lib/_tsc.js'), 'utf8').slice(0, MB)
  const inputs = { hex, base64, tsc, 'minified tsc': tsc.replace(/\n\s*/g, ' '), 'dense key': fill('key'), 'dense cohere': fill('cohere'), 'every keyword': fill(keywords.join('')) }
  for (const [name, text] of Object.entries(inputs)) {
    const { result, seconds: took } = seconds(() => scanSecrets('src/blob.ts', text))
    assert.ok(took < 20, `${name}: ${took.toFixed(1)} s`)
    assert.equal(result.filter((finding) => finding.rule === 'scan-limit').length, 0, name)
  }
  // Findings in the hex input (vendor keywords next to hex) are the reference's, checked on a slice the old loop scans fast.
  const slice = hex.slice(0, 20000)
  assert.deepEqual(brief(scanSecrets('src/blob.ts', slice)), brief(scanSecretsReference('src/blob.ts', slice)))
})

test('regression (review of #19): files that the cap refused or that blew up are scanned, quickly and exactly', () => {
  // A carriage return matches [^\\n]: under backtracking curl-auth-header took seconds on 56 bytes.
  for (const length of [50, 100, 100000]) {
    const { result, seconds: took } = seconds(() => scanSecrets('notes.txt', `curl ${'\r'.repeat(length)}\n`))
    assert.deepEqual(result, [])
    assert.ok(took < 10, `${length}: ${took.toFixed(1)} s`)
  }
  const crOnly = Array.from({ length: 5000 }, (_, index) => (index % 3 ? `note ${index}` : `curl https://example.test/api/${index}`)).join('\r')
  assert.deepEqual(scanSecrets('notes.txt', crOnly), [])
  // Not refused any more: a minified file that mentions curl, and an API document of many curl lines.
  assert.deepEqual(scanSecrets('public/app.js', `${'var a=1;'.repeat(600)}/* Use curl to call the API */${'var b=2;'.repeat(600)}`), [])
  const api = Array.from({ length: 2500 }, (_, index) => `curl -X GET https://api.example.test/v1/items/${index} -H "Accept: application/json"`).join('\n')
  assert.deepEqual(scanSecrets('docs/API.md', `${api}\n`), [])
  // The merged prefix with an inner minimum of one: found, as the reference finds it.
  const merged = rule('merged-min1', '[a-z]{1,3}?([a-z]{1,3}?(?:ab))x')
  assert.deepEqual(brief(scanSecrets('a.txt', 'zzabx', only(merged))), ['secret:merged-min1:1'])
  assert.deepEqual(brief(scanSecretsReference('a.txt', 'zzabx', only(merged))), ['secret:merged-min1:1'])
  // The rules on the linear matcher still find their secrets, with the secret group read by the matcher.
  const token = join(randomText('cu1', 30), '9Zq')
  assert.deepEqual(brief(scanSecrets('README.md', `curl https://example.test -H "Authorization: Bearer ${token}"\n`)), ['secret:curl-auth-header:1'])
  const body = fill(`${randomText('pk', 63)}\n`, 6000)
  assert.deepEqual(brief(scanSecrets('src/key.ts', `x\n-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`)), ['secret:private-key:2'])
})

test('a known difference: V8 drops (?i:) for a class in a later alternative; the linear matcher keeps it, as RE2 does', () => {
  // Node 24: /(?i:x|[a-c])/.exec('B') is null, though (?i:) applies to the whole group.
  assert.equal(/(?i:x|[a-c])/.exec('B'), null)
  assert.notEqual(/(?i:[a-c]|x)/.exec('B'), null)
  // curl-auth-header runs on the linear matcher and has `(?:X-(?:[a-z]+-)?)` in a later alternative inside (?i:):
  // an X-Auth-Token header is its finding, where the plain scan only had generic-api-key.
  const token = join(randomText('xa1', 24), '9Zq')
  const text = `curl https://api.example.test -H "X-Auth-Token: ${token}"\n`
  assert.deepEqual(brief(scanSecrets('README.md', text)), ['secret:curl-auth-header:1'])
  assert.deepEqual(brief(scanSecretsReference('README.md', text)), ['secret:generic-api-key:1'])
})

test('refusal: a rule on the linear matcher that would pass its step limit is scan-limit at the line where it stopped', () => {
  const custom = rule('zz-rule', 'zz[\\s\\S]{0,1500}[\\s\\S]{0,1500}y')
  assert.equal(analyzePattern(custom.regex).engine, 'vm')
  assert.deepEqual(brief(scanSecrets('a.txt', 'zz a\nb y\n', only(custom))), ['secret:zz-rule:1'])
  const text = fill('zza\n', 300000)
  const { result, seconds: took } = seconds(() => scanSecrets('a.txt', text, only(custom)))
  assert.equal(result.length, 1)
  assert.equal(result[0].rule, 'scan-limit')
  assert.equal(result[0].level, 'error')
  assert.equal(result[0].ruleId, 'zz-rule')
  assert.ok(result[0].line > 1, `line ${result[0].line}`)
  assert.match(result[0].message, /refused rather than exported unscanned/)
  assert.equal(result[0].message.includes('zza'), false)
  assert.ok(took < 20, `${took.toFixed(1)} s`)
  // The limit is counted, not timed: the same text stops at the same line every time.
  assert.deepEqual(brief(scanSecrets('a.txt', text, only(custom))), brief(result))
  assert.ok(scanWorkLimit(text.length) === 2 ** 24 + 256 * text.length)
})

test('refusal through prepare(): exit 1, snapshotId null, scan-limit in failures and report.json, nothing exported', () => {
  // A rule past its step limit; prepare() takes the rules for tests, the CLI always runs the bundled ones.
  const custom = rule('zz-rule', 'zz[\\s\\S]{0,1500}[\\s\\S]{0,1500}y')
  const app = createFixtureRepo({ 'docs/long.md': fill('zza\n', 300000) })
  const out = path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment(), now: () => new Date('2026-11-04T12:00:00.000Z'), secretRules: only(custom) })
  assert.equal(result.exitCode, 1)
  assert.equal(result.snapshotId, null)
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
  const limits = result.failures.filter((failure) => failure.rule === 'scan-limit')
  assert.deepEqual(limits.map((failure) => [failure.path, failure.ruleId]), [['docs/long.md', 'zz-rule']])
  assert.ok(limits[0].line > 1)
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
  const reported = report.findings.filter((finding) => finding.rule === 'scan-limit')
  assert.deepEqual(reported.map((finding) => finding.level), ['error'])
  assert.deepEqual(
    reported.map((finding) => [finding.path, finding.line, finding.ruleId, finding.message]),
    limits.map((failure) => [failure.path, failure.line, failure.ruleId, failure.message]),
  )
  // The CLI turns every error finding into exit 1 and a failure of the envelope (test/prepare-cli.test.cjs); the
  // bundled rules stay under their step limit on any input a test can build (about 100 steps per character at most).
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.cjs'), 'prepare', app, '--out', path.join(tempDir('cmt-out-'), 'out'), '--json'], {
    env: gitEnvironment(),
    encoding: 'utf8',
  })
  assert.equal(cli.status, 0)
  assert.equal(JSON.parse(cli.stdout).failures.length, 0)
})

test('scanText reports scan-limit next to the other content checks', () => {
  const custom = rule('zz-rule', 'zz[\\s\\S]{0,1500}[\\s\\S]{0,1500}y')
  const text = `postgres://app:${join('Hunter2-', randomText('ct', 8))}@db/app\n${fill('zza\n', 300000)}`
  const findings = scanText('notes.md', text, only(custom))
  assert.deepEqual(findings.map((finding) => finding.rule), ['scan-limit', 'credential-url'])
})
