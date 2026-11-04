// The Step 7 secret fixtures, shared by test/secrets.test.cjs and the CLI
// tests of Step 8 (test/prepare-cli.test.cjs).
//
// No secret-looking value is committed (AGENTS.md): every fixture below is
// assembled at test time from parts and deterministic pseudo-random text, so
// neither GitHub push protection nor a secret scanner flags this file.
const crypto = require('node:crypto')

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


/** The source file of the hard-coded secrets: one value per line, from line 2. */
const keysFile = ['// Values the tool must refuse to export.', ...secrets.map((item, index) => `export const value${index} = '${item.value}'`), ''].join('\n')

module.exports = { alnum, allValues, digits, join, keysFile, pem, privateKey, randomText, secrets, upperBase32 }
