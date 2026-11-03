import { type Executor, type RunOptions, run } from './common.js'
import { CliError, exitCodes } from './errors.js'

/**
 * The oldest Git the tool supports. `git check-attr --source=<tree-ish>`, which
 * `prepare` needs to read `export-ignore` from the pinned commit, arrived in
 * Git 2.40.0 (`Documentation/RelNotes/2.40.0.adoc` in git/git).
 */
export const minimumGit = { major: 2, minor: 40 } as const

export type GitVersion = { major: number; minor: number }

/**
 * Environment for every Git call: no optional locks, so a read never writes
 * the source app's index (spec, Snapshot item 7).
 */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_OPTIONAL_LOCKS: '0' }
}

/**
 * Reads the leading `major.minor` of `git version X.Y...`. Vendor suffixes
 * (`2.40.0.windows.1`, `2.39.5 (Apple Git-154)`) are ignored. Returns null for
 * output the tool cannot read.
 */
export function parseGitVersion(output: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\D|$)/.exec(output.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function supported(version: GitVersion): boolean {
  return version.major > minimumGit.major || (version.major === minimumGit.major && version.minor >= minimumGit.minor)
}

const minimumText = `${minimumGit.major}.${minimumGit.minor}`

/**
 * Checks that `git` is on PATH and at least 2.40. Throws a CliError with exit
 * 1 and rule `git-missing` or `git-version`. Runs only `git --version`, which
 * reads nothing from any repository. `prepare` and `publish` call it before
 * their first Git command.
 */
export function checkGit(executor: Executor = run, cwd: string = process.cwd(), options: RunOptions = {}): GitVersion {
  let output: string
  try {
    const result = executor('git', ['--version'], cwd, {
      ...options,
      capture: true,
      allowFailure: true,
      env: gitEnvironment(options.env),
    })
    if (result.status !== 0) throw versionError('`git --version` failed')
    output = result.stdout
  } catch (error) {
    if (error instanceof CliError) throw error
    if (isMissingBinary(error))
      throw new CliError(
        `git is not installed or not on PATH. Install Git ${minimumText} or newer, then retry. Nothing was read or changed.`,
        exitCodes.check,
        { rule: 'git-missing' },
      )
    throw error
  }
  const version = parseGitVersion(output)
  if (!version) throw versionError('the output of `git --version` could not be read')
  if (!supported(version)) throw versionError(`found Git ${version.major}.${version.minor}`)
  return version
}

function versionError(reason: string): CliError {
  return new CliError(
    `create-mercato-template needs Git ${minimumText} or newer: ${reason}. Update Git, then retry. Nothing was read or changed.`,
    exitCodes.check,
    { rule: 'git-version' },
  )
}

function isMissingBinary(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
  return code === 'ENOENT'
}

/** True when Git refused a repository as "dubious ownership" (safe.directory). */
export function isDubiousOwnership(stderr: string): boolean {
  return /detected dubious ownership in repository/i.test(stderr)
}

/**
 * The `git-unsafe-directory` failure for an app Git refuses to read. The tool
 * never passes `-c safe.directory` itself; the hint tells the owner what to
 * check and run. `app` is the absolute app path the user gave, so it may appear
 * in the message.
 */
export function unsafeDirectoryError(app: string): CliError {
  return new CliError(
    `Git refuses to read ${app}: the directory is owned by another user ("dubious ownership"). Check who owns it. If you trust it, run: git config --global --add safe.directory ${app}\nThen retry. Nothing was read or changed.`,
    exitCodes.check,
    { rule: 'git-unsafe-directory', path: '.' },
  )
}
