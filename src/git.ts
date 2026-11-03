import { type BytesExecutor, type Executor, type RunOptions, run, runBytes } from './common.js'
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

// ---------------------------------------------------------------------------
// Snapshot reads (spec, "Snapshot" items 1 to 5 and 7). Every call names the
// pinned sha, never HEAD, and none writes to the source app.
// ---------------------------------------------------------------------------

/**
 * Variables that would point Git at another repository, index or work tree
 * than `<app>`. They are dropped so the reads always describe `<app>` itself.
 */
const redirectingVariables = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']

/**
 * Configuration forced on every snapshot read: no file system monitor and no
 * hooks configured in the repository run, and no untracked cache is used.
 * Clean and smudge filters never run because no command here converts
 * worktree content (no `status`, `add`, `diff` or `--filters`).
 */
export const safeGitConfig = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.untrackedCache=false',
] as const

/**
 * The environment of every snapshot read. On top of `gitEnvironment`:
 * - no lazy fetch in a partial clone (`GIT_NO_LAZY_FETCH`, Git 2.44 and
 *   newer), and no transport protocol at all (`GIT_ALLOW_PROTOCOL` set to a
 *   name no transport has, for older Git), so a missing object is never
 *   downloaded, nothing is written to `.git/objects` and no program the
 *   repository configures for a remote (`uploadpack`, `sshCommand`, a
 *   credential helper) runs;
 * - no replace refs (`GIT_NO_REPLACE_OBJECTS`), so the bytes read are the
 *   pinned commit's own;
 * - no terminal prompt.
 */
export function snapshotGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = gitEnvironment(base)
  for (const name of redirectingVariables) delete environment[name]
  return {
    ...environment,
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: 'none',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export type TreeEntry = {
  /** Git mode as printed by `ls-tree`, for example `100644`, `100755`, `120000`, `160000`. */
  mode: string
  type: string
  oid: string
  /** Blob size in bytes; null for a submodule. */
  size: number | null
  /** The path exactly as Git stores it. */
  path: Buffer
}

export type IndexEntry = { mode: string; path: Buffer }

/** Thrown by `GitReader` when Git refuses the call; carries Git's stderr. */
export class GitCommandError extends Error {
  readonly stderr: string
  constructor(args: readonly string[], status: number | null, stderr: string) {
    super(`git ${args[0] ?? ''} failed (exit ${status ?? 'signal'}): ${stderr.trim().split('\n')[0] ?? ''}`)
    this.name = 'GitCommandError'
    this.stderr = stderr
  }
}

/**
 * Read-only Git access to one app directory. Every call runs with
 * `GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false` and `core.hooksPath=/dev/null`.
 */
export class GitReader {
  readonly app: string
  private readonly executor: BytesExecutor
  private readonly environment: NodeJS.ProcessEnv

  constructor(app: string, executor: BytesExecutor = runBytes, environment: NodeJS.ProcessEnv = process.env) {
    this.app = app
    this.executor = executor
    this.environment = snapshotGitEnvironment(environment)
  }

  /** Runs one Git command and returns its raw result; never throws on a non-zero exit. */
  raw(args: readonly string[], input?: Buffer): { status: number | null; stdout: Buffer; stderr: string } {
    return this.executor('git', [...safeGitConfig, ...args], this.app, { input, env: this.environment })
  }

  /** Runs one Git command and returns stdout; a non-zero exit throws `GitCommandError`. */
  bytes(args: readonly string[], input?: Buffer): Buffer {
    const result = this.raw(args, input)
    if (result.status !== 0) throw new GitCommandError(args, result.status, result.stderr)
    return result.stdout
  }

  text(args: readonly string[]): string {
    return this.bytes(args).toString('utf8').trim()
  }

  /** `git rev-parse --show-toplevel`, or the raw failure. */
  showToplevel(): { ok: true; path: string } | { ok: false; stderr: string } {
    const result = this.raw(['rev-parse', '--show-toplevel'])
    if (result.status !== 0) return { ok: false, stderr: result.stderr }
    return { ok: true, path: result.stdout.toString('utf8').replace(/\n$/, '') }
  }

  /** The commit `HEAD` points at, pinned once, or null when there is no commit. */
  pinHead(): string | null {
    const result = this.raw(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])
    if (result.status !== 0) return null
    const sha = result.stdout.toString('utf8').trim()
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error(`git rev-parse printed an unexpected object id.`)
    return sha
  }

  /** `sha1` or `sha256`. */
  objectFormat(): 'sha1' | 'sha256' {
    const format = this.text(['rev-parse', '--show-object-format'])
    if (format !== 'sha1' && format !== 'sha256') throw new Error(`Unsupported Git object format: ${format}.`)
    return format
  }

  /** `git ls-tree -r -z --full-tree -l <sha>`: every entry of the pinned tree. */
  listTree(sha: string): TreeEntry[] {
    const output = this.bytes(['ls-tree', '-r', '-z', '--full-tree', '-l', sha])
    const entries: TreeEntry[] = []
    for (const record of splitNul(output)) {
      const tab = record.indexOf(0x09)
      if (tab < 0) throw new Error('git ls-tree printed a record without a path.')
      const [mode, type, oid, size] = record.subarray(0, tab).toString('utf8').trim().split(/ +/)
      if (!mode || !type || !oid || size === undefined) throw new Error('git ls-tree printed an unreadable record.')
      entries.push({ mode, type, oid, size: size === '-' ? null : Number(size), path: record.subarray(tab + 1) })
    }
    return entries
  }

  /**
   * `git check-attr -z --stdin --source=<sha> export-ignore filter`: the two
   * attributes as the pinned tree's `.gitattributes` declare them. Keys are
   * the paths as latin1 strings (one char per byte), so any byte sequence
   * round-trips.
   */
  attributes(sha: string, paths: readonly Buffer[]): Map<string, { exportIgnore: boolean; filter: string | null }> {
    const result = new Map<string, { exportIgnore: boolean; filter: string | null }>()
    if (paths.length === 0) return result
    const input = Buffer.concat(paths.flatMap((item) => [item, Buffer.of(0)]))
    const fields = splitNul(this.bytes(['check-attr', '-z', '--stdin', `--source=${sha}`, 'export-ignore', 'filter'], input))
    if (fields.length % 3 !== 0) throw new Error('git check-attr printed an unreadable answer.')
    for (let index = 0; index < fields.length; index += 3) {
      const key = fields[index].toString('latin1')
      const attribute = fields[index + 1].toString('utf8')
      const info = fields[index + 2].toString('utf8')
      const entry = result.get(key) ?? { exportIgnore: false, filter: null }
      if (attribute === 'export-ignore') entry.exportIgnore = info === 'set' || info === 'true'
      if (attribute === 'filter' && info !== 'unspecified' && info !== 'unset') entry.filter = info
      result.set(key, entry)
    }
    return result
  }

  /** One `git cat-file --batch` for every blob id; returns the raw bytes by id. */
  readBlobs(oids: readonly string[]): Map<string, Buffer> {
    const unique = [...new Set(oids)]
    const blobs = new Map<string, Buffer>()
    if (unique.length === 0) return blobs
    const output = this.bytes(['cat-file', '--batch'], Buffer.from(unique.map((oid) => `${oid}\n`).join(''), 'utf8'))
    let offset = 0
    for (const oid of unique) {
      const newline = output.indexOf(0x0a, offset)
      if (newline < 0) throw new Error('git cat-file printed a truncated answer.')
      const header = output.subarray(offset, newline).toString('utf8').split(' ')
      if (header[0] === oid && header[1] === 'missing')
        throw new Error(
          `Blob ${oid} of the pinned commit is not in the local repository (a partial clone?). prepare never downloads objects: fetch them first (for example git fetch --refetch, or a full clone), then retry. Nothing was written.`,
        )
      if (header[0] !== oid || header[1] !== 'blob' || header.length !== 3)
        throw new Error(`git cat-file could not read blob ${oid}.`)
      const size = Number(header[2])
      const start = newline + 1
      if (start + size + 1 > output.length) throw new Error('git cat-file printed a truncated answer.')
      blobs.set(oid, output.subarray(start, start + size))
      offset = start + size + 1
    }
    return blobs
  }

  /** `git ls-files -z --cached --stage`: index entries (one per path). Reads the index, never refreshes it. */
  indexEntries(): IndexEntry[] {
    const entries = new Map<string, IndexEntry>()
    for (const record of splitNul(this.bytes(['ls-files', '-z', '--cached', '--stage']))) {
      const tab = record.indexOf(0x09)
      if (tab < 0) throw new Error('git ls-files printed a record without a path.')
      const [mode] = record.subarray(0, tab).toString('utf8').split(' ')
      const item = record.subarray(tab + 1)
      const key = item.toString('latin1')
      if (!entries.has(key)) entries.set(key, { mode: mode ?? '100644', path: item })
    }
    return [...entries.values()]
  }

  /** `git ls-files -z --others --exclude-standard`: untracked, not ignored paths (A10). */
  untrackedPaths(): Buffer[] {
    return splitNul(this.bytes(['ls-files', '-z', '--others', '--exclude-standard']))
  }
}

/** Splits NUL-terminated records; a trailing empty record is dropped. */
export function splitNul(output: Buffer): Buffer[] {
  const records: Buffer[] = []
  let start = 0
  for (let index = output.indexOf(0, start); index >= 0; index = output.indexOf(0, start)) {
    records.push(output.subarray(start, index))
    start = index + 1
  }
  if (start < output.length) records.push(output.subarray(start))
  return records
}
