const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Runs the real bin/cli.cjs next to a fake dist/cli.js whose main() throws
// what FAKE_THROW describes, so the exit code mapping is tested on its own.
function runWithThrow(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-bin-'))
  try {
    fs.mkdirSync(path.join(root, 'bin'))
    fs.mkdirSync(path.join(root, 'dist'))
    fs.copyFileSync(path.join(__dirname, '..', 'bin', 'cli.cjs'), path.join(root, 'bin', 'cli.cjs'))
    fs.writeFileSync(
      path.join(root, 'dist', 'cli.js'),
      `exports.main = async () => {
  const spec = JSON.parse(process.env.FAKE_THROW)
  if (spec.kind === 'string') throw spec.value
  const error = spec.kind === 'object' ? {} : new Error('boom')
  throw Object.assign(error, spec.props)
}
`,
    )
    const result = spawnSync(process.execPath, [path.join(root, 'bin', 'cli.cjs')], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_THROW: JSON.stringify(spec) },
    })
    return result.status
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('bin keeps a CliError exit code inside the 0-4 contract', () => {
  for (const code of [1, 2, 3, 4])
    assert.equal(runWithThrow({ kind: 'error', props: { name: 'CliError', exitCode: code } }), code, `CliError ${code}`)
})

test('bin maps every other failure to exit 1', () => {
  const cases = [
    ['CliError with code 128', { kind: 'error', props: { name: 'CliError', exitCode: 128 } }],
    ['CliError with code -1', { kind: 'error', props: { name: 'CliError', exitCode: -1 } }],
    ['CliError with a string code', { kind: 'error', props: { name: 'CliError', exitCode: '3' } }],
    ['plain Error with exitCode 3', { kind: 'error', props: { exitCode: 3 } }],
    ['plain object with exitCode 4', { kind: 'object', props: { exitCode: 4 } }],
    ['thrown string', { kind: 'string', value: 'boom' }],
  ]
  for (const [label, spec] of cases) assert.equal(runWithThrow(spec), 1, label)
})
