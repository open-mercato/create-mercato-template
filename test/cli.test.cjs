const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { main, parseArgs, CliError, commands, flags } = require('../dist/cli.js')
const { checkGit } = require('../dist/git.js')
const packageJson = require('../package.json')

const bin = path.join(__dirname, '..', 'bin', 'cli.cjs')
const envelopeKeys = ['command', 'exitCode', 'failures', 'ok', 'schema', 'tool']

function cli(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// Parses stdout as exactly one JSON object and checks the schema 1 envelope.
function oneEnvelope(stdout) {
  const value = JSON.parse(stdout)
  assert.equal(typeof value, 'object')
  assert.ok(value && !Array.isArray(value))
  assert.equal(value.schema, 1)
  assert.deepEqual(value.tool, { name: 'create-mercato-template', version: packageJson.version })
  assert.equal(value.ok, value.exitCode === 0)
  assert.ok(Array.isArray(value.failures))
  return value
}

async function capture(argv, dispatch) {
  const out = []
  const err = []
  const code = await main(argv, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, dispatch)
  return { code, stdout: out.join(''), stderr: err.join(''), writes: out.length }
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
  for (const args of [['--help'], ['-h'], [], ['prepare', '--help'], ['publish', '-h', '--json']]) {
    const result = cli(...args)
    assert.equal(result.status, 0, `exit code for ${JSON.stringify(args)}`)
    assert.equal(result.stderr, '')
    for (const command of commands) assert.match(result.stdout, new RegExp(`create-mercato-template ${command}`))
    assert.match(result.stdout, /not implemented yet/)
    assert.match(result.stdout, /Exit codes: 0 done, 1 a check failed, 2 usage error/)
  }
})

test('help documents every flag of the matrix', () => {
  const result = cli('--help')
  for (const flag of Object.keys(flags)) assert.ok(result.stdout.includes(flag), flag)
  for (const flag of ['-h', '--help', '-v', '--version']) assert.ok(result.stdout.includes(flag), flag)
})

test('help wins over every usage error where a flag is expected', () => {
  for (const args of [['prepare', '--bogus', '-h'], ['publish', '--public', '--private', '--help'], ['init', '--help'], ['describe', '--out', 'x', '-h']]) {
    const result = cli(...args)
    assert.equal(result.status, 0, JSON.stringify(args))
    assert.match(result.stdout, /Commands:/)
  }
})

test('--help and -h as the value of a flag do not print help', () => {
  // prepare --out --help is in test/prepare-cli.test.cjs: prepare runs now.
  for (const args of [['describe', '--summary', '--help'], ['describe', '--summary', '-h'], ['publish', '--from', '--help']]) {
    const result = cli(...args)
    assert.equal(result.status, 2, JSON.stringify(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(`${args[0]} is not implemented yet`))
    assert.deepEqual(parseArgs(args).options[args[1]], args[2])
  }
})

const plannedCommands = commands.filter((command) => command !== 'prepare')

test('planned commands exit 2 with a clear "not implemented yet" message', () => {
  const cases = [
    ['publish', '--from', 'out'],
    ['publish', '--from', 'out', '--repo', 'acme/app', '--private', '--expect', 'abc', '--resume'],
    ['describe'],
    ['describe', '--from', 'out', '--repo', 'acme/app', '--use-case', 'crm', '--summary', 's', '--when-to-use', 'w', '--when-not-to-use', 'n'],
  ]
  for (const args of cases) {
    const result = cli(...args)
    assert.equal(result.status, 2, `exit code for ${JSON.stringify(args)}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(`${args[0]} is not implemented yet`))
    assert.match(result.stderr, /nothing was read or changed/)
  }
})

test('planned commands with --json print one envelope with rule usage', () => {
  assert.deepEqual(plannedCommands, ['publish', 'describe'])
  for (const command of plannedCommands) {
    const result = cli(command, '--json')
    assert.equal(result.status, 2)
    assert.equal(result.stderr, '')
    const value = oneEnvelope(result.stdout)
    assert.deepEqual(Object.keys(value).sort(), envelopeKeys)
    assert.equal(value.command, command)
    assert.equal(value.ok, false)
    assert.equal(value.exitCode, 2)
    assert.equal(value.failures.length, 1)
    assert.equal(value.failures[0].rule, 'usage')
    assert.match(value.failures[0].message, new RegExp(`${command} is not implemented yet`))
  }
})

const usageCases = [
  ['unknown command', ['init'], /Unknown command: init/, null],
  ['unknown flag', ['prepare', '--bogus'], /Unknown option for prepare: --bogus/, 'prepare'],
  ['flag on the wrong command', ['prepare', '--repo', 'acme/app'], /--repo is not an option of prepare/, 'prepare'],
  ['flag on the wrong command, no value', ['describe', '--public'], /--public is not an option of describe/, 'describe'],
  ['missing value', ['publish', '--from'], /--from needs a value/, 'publish'],
  ['missing value at the end', ['describe', '--from', 'out', '--summary'], /--summary needs a value/, 'describe'],
  ['both --public and --private', ['publish', '--from', 'out', '--public', '--private'], /Choose one of --public or --private/, 'publish'],
  ['repeated non-repeatable flag', ['prepare', '--out', 'a', '--out', 'b'], /--out was given more than once/, 'prepare'],
  ['repeated boolean flag', ['publish', '--resume', '--resume'], /--resume was given more than once/, 'publish'],
  ['flag=value form', ['prepare', '--out=dir'], /Write --out and its value as two arguments/, 'prepare'],
  ['second app directory', ['prepare', 'a', 'b'], /prepare takes one app directory/, 'prepare'],
  ['positional on publish', ['publish', 'acme/app'], /publish takes no positional arguments/, 'publish'],
  ['--version inside a command', ['prepare', '--version'], /--version works only on its own/, 'prepare'],
  ['--version with other arguments', ['--version', 'prepare'], /--version works only on its own/, null],
  ['a command flag with no command', ['--out', 'dir'], /--out needs a command first: prepare/, null],
  ['unknown option with no command', ['--bogus'], /Unknown option: --bogus/, null],
  ['value on a boolean flag', ['publish', '--resume=yes'], /--resume takes no value/, 'publish'],
  ['end-of-options marker', ['prepare', '--', 'app'], /end-of-options marker -- is not supported/, 'prepare'],
]

test('usage errors exit 2 with a message on stderr and nothing on stdout', () => {
  for (const [label, args, message] of usageCases) {
    const result = cli(...args)
    assert.equal(result.status, 2, label)
    assert.equal(result.stdout, '', label)
    assert.match(result.stderr, message, label)
    assert.match(result.stderr, /Run with --help for usage/, label)
  }
})

// Puts --json where a flag is expected and where no flag before it takes it as a value.
function withJson(args) {
  const at = !args[0].startsWith('-') || args[0] === '--version' ? 1 : 0
  return [...args.slice(0, at), '--json', ...args.slice(at)]
}

test('usage errors with --json print one parsable envelope with rule usage', () => {
  for (const [label, args, message, command] of usageCases) {
    const result = cli(...withJson(args))
    assert.equal(result.status, 2, label)
    assert.equal(result.stderr, '', label)
    const value = oneEnvelope(result.stdout)
    assert.equal(value.command, command, label)
    assert.equal(value.exitCode, 2, label)
    assert.equal(value.ok, false, label)
    assert.equal(value.failures.length, 1, label)
    assert.equal(value.failures[0].rule, 'usage', label)
    assert.match(value.failures[0].message, message, label)
  }
})

test('--json without a command is a usage error with one envelope and command null', () => {
  const result = cli('--json')
  assert.equal(result.status, 2)
  assert.equal(result.stderr, '')
  const value = oneEnvelope(result.stdout)
  assert.equal(value.command, null)
  assert.equal(value.failures[0].rule, 'usage')
  assert.match(value.failures[0].message, /No command given/)
})

test('a command after --json is refused with a hint to put it first', () => {
  const result = cli('--json', 'publish')
  assert.equal(result.status, 2)
  assert.equal(result.stderr, '')
  const value = oneEnvelope(result.stdout)
  assert.equal(value.command, null)
  assert.match(value.failures[0].message, /Put the command first: npx create-mercato-template publish/)
})

test('the first usage problem on the command line is the one reported', () => {
  assert.match(parseArgs(['prepare', '--bogus', '--repo', 'x']).error, /--bogus/)
  assert.match(parseArgs(['publish', '--public', '--private', '--expect']).error, /--expect needs a value/)
  // A value is consumed even on the wrong command, so it is not read as a positional or a flag.
  assert.deepEqual(parseArgs(['prepare', '--from', '--json']).json, false)
})

test('a thrown non-CliError gives exactly one JSON object with rule internal and exit 1', async () => {
  const result = await capture(['describe', '--json'], async () => {
    throw new Error('boom: password=hunter2hunter2 at /tmp/x')
  })
  assert.equal(result.code, 1)
  assert.equal(result.stderr, '')
  assert.equal(result.writes, 1)
  const value = oneEnvelope(result.stdout)
  assert.equal(value.command, 'describe')
  assert.equal(value.exitCode, 1)
  assert.equal(value.failures.length, 1)
  assert.equal(value.failures[0].rule, 'internal')
  assert.match(value.failures[0].message, /boom/)
  assert.doesNotMatch(result.stdout, /hunter2/)
  assert.doesNotMatch(result.stdout, /\n\s+at /)

  const thrownString = await capture(['prepare', '--json'], async () => {
    throw 'not an error'
  })
  assert.equal(thrownString.code, 1)
  assert.equal(oneEnvelope(thrownString.stdout).failures[0].rule, 'internal')
})

test('the internal message is redacted: tokens and email addresses never reach the output', async () => {
  // Built at test time so no secret-looking value is committed.
  const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_')
  const email = ['jane.doe', 'example.org'].join('@')
  for (const json of [true, false]) {
    const result = await capture(json ? ['prepare', '--json'] : ['prepare'], async () => {
      throw new Error(`git failed for ${email} with ${token}`)
    })
    assert.equal(result.code, 1)
    const output = result.stdout + result.stderr
    assert.ok(!output.includes(token), 'token leaked')
    assert.ok(!output.includes(email), 'email leaked')
    assert.match(output, /\[REDACTED\]/)
    assert.match(output, /\[EMAIL\]/)
  }
})

test('without --json an unexpected error prints one message on stderr and exits 1', async () => {
  const result = await capture(['describe'], async () => {
    throw new Error('boom')
  })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '\nError: boom\n')
})

test('a CliError keeps its exit code and rule in the envelope', async () => {
  const gitMissing = await capture(['prepare', '--json'], async () => {
    checkGit(() => {
      throw new Error('Cannot run git', { cause: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }) })
    })
  })
  assert.equal(gitMissing.code, 1)
  const value = oneEnvelope(gitMissing.stdout)
  assert.equal(value.failures[0].rule, 'git-missing')
  assert.match(value.failures[0].message, /git is not installed or not on PATH/)

  for (const [exitCode, rule] of [[3, 'github-auth'], [4, 'github-step']]) {
    const result = await capture(['publish', '--json'], async () => {
      throw new CliError('remote problem', exitCode)
    })
    assert.equal(result.code, exitCode)
    assert.equal(oneEnvelope(result.stdout).failures[0].rule, rule)
  }

  const custom = await capture(['publish', '--json'], async () => {
    throw new CliError('step failed', 4, { rule: 'github-step', step: 'push', detail: 'workflow-scope' })
  })
  assert.deepEqual(oneEnvelope(custom.stdout).failures, [
    { rule: 'github-step', step: 'push', detail: 'workflow-scope', message: 'step failed' },
  ])
})

test('a CliError outside the 0-4 contract becomes exit 1 with rule internal', async () => {
  const result = await capture(['publish', '--json'], async () => {
    throw new CliError('odd', 7)
  })
  assert.equal(result.code, 1)
  assert.equal(oneEnvelope(result.stdout).failures[0].rule, 'internal')
})

test('a command that succeeds with --json prints ok true, no failures and its own fields', async () => {
  const result = await capture(['describe', '--json'], async (command, args) => ({ seen: command, json: args.json }))
  assert.equal(result.code, 0)
  const value = oneEnvelope(result.stdout)
  assert.equal(value.ok, true)
  assert.equal(value.exitCode, 0)
  assert.deepEqual(value.failures, [])
  assert.equal(value.seen, 'describe')
  assert.equal(value.json, true)
})

test('main returns the exit code and never throws', async () => {
  assert.equal((await capture(['--version'])).code, 0)
  assert.equal((await capture(['--version'])).stdout, `${packageJson.version}\n`)
  assert.equal((await capture(['publish'])).code, 2)
  assert.equal((await capture(['prepare'])).code, 2)
  assert.equal((await capture(['nope'])).code, 2)
})
