const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { checkGit, parseGitVersion, isDubiousOwnership, unsafeDirectoryError, minimumGit } = require('../dist/git.js')
const { run } = require('../dist/common.js')
const { CliError } = require('../dist/errors.js')

function fakeExecutor(stdout, status = 0) {
  const calls = []
  const executor = (command, args, cwd, options) => {
    calls.push({ command, args, cwd, options })
    return { status, stdout, stderr: '', pid: 0, output: [], signal: null }
  }
  return { executor, calls }
}

function assertCliError(fn, rule, exitCode = 1) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CliError, `expected a CliError, got ${error}`)
    assert.equal(error.exitCode, exitCode)
    assert.equal(error.failure.rule, rule)
    assert.equal(typeof error.failure.message, 'string')
    return true
  })
}

// A directory with one executable `git` script that prints the given version.
function fakeGitOnPath(versionLine) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-git-'))
  fs.writeFileSync(path.join(directory, 'git'), `#!/bin/sh\necho '${versionLine}'\n`, { mode: 0o755 })
  return directory
}

test('the minimum Git is 2.40', () => {
  assert.deepEqual({ ...minimumGit }, { major: 2, minor: 40 })
})

test('parseGitVersion reads the leading major.minor, vendor suffixes included', () => {
  assert.deepEqual(parseGitVersion('git version 2.40.0\n'), { major: 2, minor: 40 })
  assert.deepEqual(parseGitVersion('git version 2.40.0.windows.1'), { major: 2, minor: 40 })
  assert.deepEqual(parseGitVersion('git version 2.39.5 (Apple Git-154)'), { major: 2, minor: 39 })
  assert.deepEqual(parseGitVersion('git version 3.0'), { major: 3, minor: 0 })
  for (const unreadable of ['', 'version 2.40.0', 'git version two', 'git version 2', 'git version 2.x'])
    assert.equal(parseGitVersion(unreadable), null, unreadable)
})

test('checkGit refuses Git 2.39 and accepts 2.40 or newer (fake executor)', () => {
  assertCliError(() => checkGit(fakeExecutor('git version 2.39.0\n').executor), 'git-version')
  assertCliError(() => checkGit(fakeExecutor('git version 2.39.5 (Apple Git-154)\n').executor), 'git-version')
  assertCliError(() => checkGit(fakeExecutor('git version 1.99.0\n').executor), 'git-version')
  assert.deepEqual(checkGit(fakeExecutor('git version 2.40.0\n').executor), { major: 2, minor: 40 })
  assert.deepEqual(checkGit(fakeExecutor('git version 2.40.0.windows.1\n').executor), { major: 2, minor: 40 })
  assert.deepEqual(checkGit(fakeExecutor('git version 3.1.0\n').executor), { major: 3, minor: 1 })
})

test('checkGit treats unreadable output or a failing git --version as git-version', () => {
  assertCliError(() => checkGit(fakeExecutor('hello\n').executor), 'git-version')
  assertCliError(() => checkGit(fakeExecutor('git version 2.40.0\n', 1).executor), 'git-version')
})

test('checkGit runs only `git --version`, with an argument array and GIT_OPTIONAL_LOCKS=0', () => {
  const { executor, calls } = fakeExecutor('git version 2.45.1\n')
  checkGit(executor, '/somewhere')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'git')
  assert.deepEqual(calls[0].args, ['--version'])
  assert.equal(calls[0].cwd, '/somewhere')
  assert.equal(calls[0].options.capture, true)
  assert.equal(calls[0].options.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(calls[0].options.shell, undefined)
})

test('checkGit refuses a fake git 2.39.0 on PATH and accepts a fake 2.40.0', () => {
  const old = fakeGitOnPath('git version 2.39.0')
  const current = fakeGitOnPath('git version 2.40.0')
  try {
    assertCliError(() => checkGit(run, old, { env: { ...process.env, PATH: old } }), 'git-version')
    assert.deepEqual(checkGit(run, current, { env: { ...process.env, PATH: current } }), { major: 2, minor: 40 })
  } finally {
    fs.rmSync(old, { recursive: true, force: true })
    fs.rmSync(current, { recursive: true, force: true })
  }
})

test('checkGit reports git-missing when git is not on PATH', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-nogit-'))
  try {
    assertCliError(() => checkGit(run, empty, { env: { ...process.env, PATH: empty } }), 'git-missing')
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test('checkGit passes other executor errors through unchanged', () => {
  const failure = new Error('something else')
  assert.throws(
    () =>
      checkGit(() => {
        throw failure
      }),
    (error) => error === failure,
  )
})

test('dubious ownership is detected and reported as git-unsafe-directory with a hint', () => {
  const stderr =
    "fatal: detected dubious ownership in repository at '/srv/app'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /srv/app\n"
  assert.equal(isDubiousOwnership(stderr), true)
  assert.equal(isDubiousOwnership('fatal: not a git repository (or any of the parent directories): .git'), false)
  const error = unsafeDirectoryError('/srv/app')
  assert.ok(error instanceof CliError)
  assert.equal(error.exitCode, 1)
  assert.equal(error.failure.rule, 'git-unsafe-directory')
  assert.equal(error.failure.path, '.')
  assert.match(error.message, /git config --global --add safe\.directory \/srv\/app/)
  assert.match(error.message, /Nothing was read or changed/)
})

test('the Git on this machine passes the check and supports check-attr --source', () => {
  assert.ok(checkGit())
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-attr-'))
  try {
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout
    }
    git('init', '-q', '--template=')
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'skip.txt export-ignore\n')
    fs.writeFileSync(path.join(repo, 'skip.txt'), 'x\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--no-gpg-sign', '-m', 'fixture')
    const sha = git('rev-parse', 'HEAD').trim()
    // Remove the attribute from the working tree: --source must still read it from the commit.
    fs.writeFileSync(path.join(repo, '.gitattributes'), '')
    assert.equal(git('check-attr', `--source=${sha}`, 'export-ignore', '--', 'skip.txt'), 'skip.txt: export-ignore: set\n')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
