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
const { PatternError, analyzePattern, scanLimitRepeats } = require('../dist/rules/pattern.js')
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

test('every bundled and extra rule is read by the pattern reader; five are capped, two have no anchor', () => {
  const capped = []
  const unanchored = []
  for (const item of allRules) {
    const facts = analyzePattern(item.regex)
    if (facts.cap) capped.push(item.id)
    if (facts.anchors === null) unanchored.push(item.id)
    for (const anchor of facts.anchors ?? []) assert.doesNotThrow(() => new RegExp(anchor.source, item.regex.flags))
    if (facts.cap) for (const source of [facts.cap.capped, ...facts.cap.saturations]) assert.doesNotThrow(() => new RegExp(source, item.regex.flags))
    if (facts.split) assert.doesNotThrow(() => new RegExp(facts.split.tail, item.regex.flags))
  }
  assert.deepEqual(capped.sort(), ['curl-auth-header', 'curl-auth-user', 'kubernetes-secret-yaml', 'nuget-config-password', 'private-key'])
  assert.deepEqual(unanchored.sort(), ['facebook-access-token', 'sourcegraph-access-token'])
})

test('analyzePattern: anchors, maximum length, split, linear and capped patterns', () => {
  assert.deepEqual(analyzePattern({ source: '\\bghp_[0-9a-zA-Z]{36}', flags: '' }), {
    maxLength: 40,
    anchors: [{ source: '\\bghp_', before: { min: 0, max: 0 } }],
    cap: null,
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
  // Linear: the run is fenced (`\b` before word characters, a `.` that is not in it) and followed by a character outside it.
  assert.equal(analyzePattern({ source: '\\bab[a-z]{5,}\\.', flags: '' }).cap, null)
  assert.equal(analyzePattern({ source: 'x\\.[a-z]+=', flags: '' }).cap, null)
  // Linear: an unbounded run at the end of the pattern.
  assert.equal(analyzePattern({ source: 'npm_[a-z0-9]{30,}', flags: '' }).cap, null)
  // Not linear: nothing fences the run, so it is capped, with one saturation pattern per unbounded quantifier.
  const cap = analyzePattern({ source: '\\bcurl\\b[^\\n]*?-u ([^ ]+) ', flags: '' }).cap
  assert.equal(cap.capped, `\\bcurl\\b[^\\n]{0,${scanLimitRepeats}}?-u ([^ ]{1,${scanLimitRepeats + 1}}) `)
  assert.deepEqual(cap.saturations, [
    `\\bcurl\\b(?:[^\\n]){${scanLimitRepeats}}`,
    `\\bcurl\\b[^\\n]{0,${scanLimitRepeats}}?-u (?:(?:[^ ]){${scanLimitRepeats + 1}})`,
  ])
  assert.equal(cap.reach([80, 20]), 4 + 80 + 3 + 20 + 1)
})

test('analyzePattern refuses what it cannot read or bound: a PatternError', () => {
  for (const source of ['(a)\\1', '(?=a+)b', '(?<=a+)b', '(?:a+b)+c', '\\p{L}', '[a-\\d]'])
    assert.throws(() => analyzePattern({ source, flags: '' }), PatternError, source)
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
    const fast = scanSecrets('src/x.ts', text)
    if (fast.some((finding) => finding.rule === 'scan-limit')) continue
    assert.deepEqual(brief(fast), brief(scanSecretsReference('src/x.ts', text)), JSON.stringify(text))
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

test('refusal: a run longer than the cap from a capped rule is scan-limit, an error with ruleId and line, no text', () => {
  const run = 'x'.repeat(scanLimitRepeats + 10)
  const text = `# usage\n\ncurl https://example.test ${run}\n`
  const findings = scanSecrets('README.md', text)
  assert.deepEqual(brief(findings), ['scan-limit:curl-auth-header:3', 'scan-limit:curl-auth-user:3'])
  for (const finding of findings) {
    assert.equal(finding.level, 'error')
    assert.equal(finding.path, 'README.md')
    assert.match(finding.message, /refused rather than exported unscanned/)
    assert.equal(finding.message.includes('xxxx'), false)
  }
  // Below the cap the capped rule is exact: a real curl auth header is found.
  const token = join(randomText('cu1', 30), '9Zq')
  assert.deepEqual(brief(scanSecrets('README.md', `curl https://example.test -H "Authorization: Bearer ${token}"\n`)), ['secret:curl-auth-header:1'])
  // A private key whose body runs past the cap: scan-limit for private-key, and the floor rule still finds the header.
  const key = `-----BEGIN PRIVATE KEY-----\n${fill(`${randomText('pk', 63)}\n`, scanLimitRepeats + 200)}-----END PRIVATE KEY-----\n`
  assert.deepEqual(brief(scanSecrets('src/key.ts', key)), ['secret:floor-private-key:1', 'scan-limit:private-key:1'])
})

test('refusal: a capped rule that would pass its work limit is scan-limit at the line where it stopped', () => {
  // `zz` is not fenced, so the rule is capped; lines stay under the cap, so only the work limit can stop it.
  const custom = rule('zz-rule', '\\bzz\\b[^\\n]*?yy')
  assert.notEqual(analyzePattern(custom.regex).cap, null)
  const line = `${fill('zz ', 300)}\n`
  const small = line.repeat(10)
  assert.deepEqual(brief(scanSecrets('a.txt', small, only(custom))), [])
  assert.deepEqual(brief(scanSecretsReference('a.txt', small, only(custom))), [])
  const lines = Math.ceil(scanWorkLimit(MB) / (100 * 301)) + 50
  const large = line.repeat(lines)
  const { result, seconds: took } = seconds(() => scanSecrets('a.txt', large, only(custom)))
  assert.equal(result.length, 1)
  assert.equal(result[0].rule, 'scan-limit')
  assert.equal(result[0].ruleId, 'zz-rule')
  assert.ok(result[0].line > 1 && result[0].line < lines, `line ${result[0].line}`)
  assert.ok(took < 20, `${took.toFixed(1)} s`)
  // The same with a real rule: 1 MB of `curl` on lines under the cap.
  const curl = fill(`${'curl '.repeat(200)}\n`)
  const { result: curlFindings, seconds: curlTook } = seconds(() => scanSecrets('docs/curl.md', curl))
  assert.ok(curlFindings.some((finding) => finding.rule === 'scan-limit' && finding.ruleId === 'curl-auth-header' && finding.line > 1))
  assert.ok(curlTook < 20, `${curlTook.toFixed(1)} s`)
})

test('refusal through prepare(): exit 1, snapshotId null, scan-limit in failures and report.json, nothing exported', () => {
  const app = createFixtureRepo({ 'docs/long.md': `curl https://example.test ${'x'.repeat(scanLimitRepeats + 10)}\n` })
  const out = path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment(), now: () => new Date('2026-11-04T12:00:00.000Z') })
  assert.equal(result.exitCode, 1)
  assert.equal(result.snapshotId, null)
  assert.equal(fs.existsSync(path.join(out, 'tree')), false)
  const withoutLevel = (finding) => {
    const rest = { ...finding }
    delete rest.level
    return rest
  }
  const limits = result.failures.filter((failure) => failure.rule === 'scan-limit').map(withoutLevel)
  assert.deepEqual(limits.map((failure) => [failure.path, failure.line, failure.ruleId]), [
    ['docs/long.md', 1, 'curl-auth-header'],
    ['docs/long.md', 1, 'curl-auth-user'],
  ])
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
  const reported = report.findings.filter((finding) => finding.rule === 'scan-limit')
  assert.deepEqual(reported.map((finding) => finding.level), ['error', 'error'])
  assert.deepEqual(reported.map(withoutLevel), limits)
  // The same through bin/cli.cjs --json: exit 1, the findings in failures.
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.cjs'), 'prepare', app, '--out', path.join(tempDir('cmt-out-'), 'out'), '--json'], {
    env: gitEnvironment(),
    encoding: 'utf8',
  })
  assert.equal(cli.status, 1)
  const envelope = JSON.parse(cli.stdout)
  assert.deepEqual(envelope.failures.filter((failure) => failure.rule === 'scan-limit').map(withoutLevel), limits)
})

test('scanText reports scan-limit next to the other content checks', () => {
  const findings = scanText('notes.md', `curl ${'y'.repeat(scanLimitRepeats + 1)}\npostgres://app:${join('Hunter2-', randomText('ct', 8))}@db/app\n`)
  assert.deepEqual(brief(findings), ['scan-limit:curl-auth-header:1', 'scan-limit:curl-auth-user:1', 'credential-url::2'])
})
