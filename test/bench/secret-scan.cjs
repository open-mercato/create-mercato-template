// The secret scan benchmark of issue #9 (spec, Secret scan, "Scan cost").
// Not a test and not shipped: a maintainer runs it after `npm run build`.
//
//   npm run bench:secret-scan                 the scan, on every input below
//   npm run bench:secret-scan -- --reference  also the reference scan (a global
//                                             exec loop of each rule, as before
//                                             the bound): minutes, not seconds
//
// Inputs, 1 MB each and generated at run time (no secret-looking text is
// committed): the three of the issue (a base64 data URI with common words, a
// hex string with every vendor keyword, real `_tsc.js`), the same JavaScript
// on one line, and the worst cases constructed for the scan (a keyword
// repeated with no gap, every keyword run together, `curl` lines under the cap).
const fs = require('node:fs')
const { scanSecrets, scanSecretsReference } = require('../../dist/policy/secrets.js')
const { bundledRules } = require('../../dist/rules/gitleaks.js')

const MB = 1 << 20
const fill = (unit) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB)
const keywords = [...new Set(bundledRules.rules.flatMap((rule) => rule.keywords))]

function generator(seed) {
  let state = seed >>> 0
  return (limit) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return (state >>> 8) % limit
  }
}

function base64Uri() {
  const next = generator(1)
  const words = ['token', 'secret', 'key', 'auth', 'password', 'api', 'access', 'client', 'private', 'credential']
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let text = 'export const image = "data:image/png;base64,'
  while (text.length < MB) text += next(200) === 0 ? words[next(words.length)] : alphabet[next(64)]
  return `${text}"\n`
}

function hexWithKeywords() {
  const next = generator(3)
  let text = 'const blob = "'
  let keyword = 0
  while (text.length < MB) text += next(2000) === 0 ? keywords[keyword++ % keywords.length] : '0123456789abcdef'[next(16)]
  return `${text}"\n`
}

const tsc = fs.readFileSync(require.resolve('typescript/lib/_tsc.js'), 'utf8').slice(0, MB)
const inputs = {
  'base64 data URI with common words': base64Uri(),
  'hex string with every vendor keyword': hexWithKeywords(),
  'real _tsc.js': tsc,
  '_tsc.js on one line': tsc.replace(/\n\s*/g, ' '),
  'worst: "key" with no gap': fill('key'),
  'worst: "cohere" with no gap': fill('cohere'),
  'worst: every keyword run together': fill(keywords.join('')),
  'worst: "curl " lines of 1,000 characters': fill(`${'curl '.repeat(200)}\n`),
}

const reference = process.argv.includes('--reference')
const time = (scan, text) => {
  const started = process.hrtime.bigint()
  const findings = scan('src/blob.ts', text)
  return { seconds: Number(process.hrtime.bigint() - started) / 1e9, limits: findings.filter((finding) => finding.rule === 'scan-limit').length }
}
scanSecrets('warm.ts', 'const a = 1\n')
console.log(`| Input (1 MB) | Scan${reference ? ' | Reference' : ''} | scan-limit findings |`)
console.log(`|---|---|${reference ? '---|' : ''}---|`)
for (const [name, text] of Object.entries(inputs)) {
  const scan = time(scanSecrets, text)
  const before = reference ? ` | ${time(scanSecretsReference, text).seconds.toFixed(2)} s` : ''
  console.log(`| ${name} | ${scan.seconds.toFixed(2)} s${before} | ${scan.limits} |`)
}
