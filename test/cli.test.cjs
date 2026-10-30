const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { main, CliError, commands } = require('../dist/cli.js')
const packageJson = require('../package.json')

const bin = path.join(__dirname, '..', 'bin', 'cli.cjs')

function cli(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('--version prints the package version and nothing else', () => {
  for (const flag of ['--version', '-v']) {
    const result = cli(flag)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, `${packageJson.version}\n`)
    assert.equal(result.stderr, '')
  }
})

test('--help and no arguments print usage that names every command', () => {
  for (const args of [['--help'], ['-h'], [], ['prepare', '--help']]) {
    const result = cli(...args)
    assert.equal(result.status, 0, `exit code for ${JSON.stringify(args)}`)
    assert.equal(result.stderr, '')
    for (const command of commands) assert.match(result.stdout, new RegExp(`create-mercato-template ${command}`))
    assert.match(result.stdout, /not implemented yet/)
    assert.match(result.stdout, /Exit codes: 0 done, 1 a check failed, 2 usage error/)
  }
})

test('planned commands exit 2 with a clear "not implemented yet" message', () => {
  for (const args of [['prepare'], ['prepare', '.', '--out', 'out'], ['publish', '--from', 'out'], ['describe', '--json']]) {
    const result = cli(...args)
    assert.equal(result.status, 2, `exit code for ${JSON.stringify(args)}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(`${args[0]} is not implemented yet`))
    assert.match(result.stderr, /nothing was read or changed/)
  }
})

test('unknown commands and options are usage errors (exit 2)', () => {
  const cases = [
    [['init'], /Unknown command: init/],
    [['--json'], /Unknown option: --json/],
    [['--version', 'prepare'], /--version takes no other arguments/],
  ]
  for (const [args, message] of cases) {
    const result = cli(...args)
    assert.equal(result.status, 2, `exit code for ${JSON.stringify(args)}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
  }
})

test('main rejects with a CliError that carries the exit code', async () => {
  const output = []
  await main(['--version'], (text) => output.push(text))
  assert.deepEqual(output, [`${packageJson.version}\n`])
  await assert.rejects(main(['publish'], () => {}), (error) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.exitCode, 2)
    return true
  })
})
