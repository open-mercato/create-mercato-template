import * as fs from 'node:fs'
import * as path from 'node:path'
import { toolVersion } from './cli.js'
import { type Executor, run } from './common.js'
import { CliError, exitCodes } from './errors.js'
import { GitReader, checkGit, isDubiousOwnership, unsafeDirectoryError } from './git.js'
import type { Finding } from './policy/entries.js'
import {
  type Excluded,
  type FileRecord,
  type Snapshot,
  type Uncommitted,
  buildSnapshot,
  computeSnapshotId,
  writeOut,
} from './snapshot.js'

export type { Finding } from './policy/entries.js'
export type { Excluded, FileRecord, Uncommitted } from './snapshot.js'

/**
 * The internal entry point of `prepare` (spec Step 3). The CLI command keeps
 * answering exit 2 "not implemented yet" until Step 8, so no command on
 * `main` writes an `<out>/tree` without the full scan; tests call this
 * function directly.
 */
export type PrepareOptions = {
  /** The app directory; defaults to the current directory. Must be the Git top level. */
  app?: string
  /** The output directory: missing, or an empty directory, and not inside the app. */
  out: string
  /** A10: export the worktree version of changed and untracked files. */
  includeUncommitted?: boolean
  /** Environment for Git; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Executor for the Git version check; defaults to `run`. */
  executor?: Executor
  /** Clock for `createdAt`. */
  now?: () => Date
}

export type Notice = { code: string; detail?: string }

/** `report.json`, schema 1. Later spec steps add the other catalog fields. */
export type Report = {
  schema: 1
  tool: { name: string; version: string }
  createdAt: string
  source: { head: string | null; dirty: boolean; includeUncommitted: boolean }
  files: FileRecord[]
  snapshotId: string | null
  findings: Finding[]
  notices: Notice[]
  uncommitted: Uncommitted[]
  excluded: Excluded[]
  totals: { files: number; bytes: number }
}

/** What the `--json` envelope of `prepare` will carry (spec, "--json shape"). */
export type PrepareResult = {
  /** 0, or 1 when the report has an `error` finding. */
  exitCode: 0 | 1
  /** Every `error` finding, as the envelope's `failures`. */
  failures: Finding[]
  /** Absolute path of `<out>`. */
  out: string
  snapshotId: string | null
  report: Report
}

const codeOnly: Notice = {
  code: 'code-only',
  detail:
    'The snapshot holds files only: configuration held in the database (anything set through the UI), uploaded files and runtime edits not written to tracked files are not part of it.',
}

/** Until spec Step 8: the snapshot core runs, the content checks of later steps do not yet. */
const checksIncomplete: Notice = {
  code: 'checks-incomplete',
  detail:
    'This version runs the snapshot core only. The root checks, module inventory, secret scan, opaque file check and the regenerated .env.example come in later versions; the root .env.example is excluded until then.',
}

const uncommittedNotExported: Notice = {
  code: 'uncommitted-not-exported',
  detail: 'The app has uncommitted changes. They are listed under uncommitted and not exported; commit them, or use --include-uncommitted.',
}

function usage(message: string): CliError {
  return new CliError(message, exitCodes.usage)
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

/**
 * The real path of `target`, or of its nearest existing parent joined with
 * the rest, so a `--out` that does not exist yet, or that is reached through
 * a symlink, is judged where it will really be written.
 */
export function realpathOfNearestExisting(target: string): string {
  const absolute = path.resolve(target)
  const rest: string[] = []
  let current = absolute
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse())
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      rest.push(path.basename(current))
      current = parent
    }
  }
}

/** True when `inner` is `outer` or below it. Both are real paths. */
export function isInside(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * The `<out>` rules (spec, "Commands and flags"), decided before any Git read
 * of the app: `<out>` must not exist or be an empty directory, and must not be
 * inside `<app>`. "Inside" compares `realpath` of `<out>` (or of its nearest
 * existing parent) with `realpath(<app>)`, not Git, so a symlinked or not yet
 * existing `<out>` is judged correctly. Each problem is exit 2.
 */
export function checkOut(out: string, appReal: string): string {
  const absolute = path.resolve(out)
  let link: fs.Stats | null = null
  try {
    link = fs.lstatSync(absolute)
  } catch {}
  if (link?.isSymbolicLink() && !fs.existsSync(absolute))
    throw usage(`--out ${out} is a symlink to a missing directory. Choose a new directory. Nothing was written.`)
  if (isInside(appReal, realpathOfNearestExisting(absolute)))
    throw usage(`--out ${out} is inside the app (${appReal}). Choose a directory outside the app. Nothing was written.`)
  let stat: fs.Stats
  try {
    stat = fs.statSync(absolute)
  } catch (error) {
    if (['ENOENT'].includes(errorCode(error) ?? '')) return absolute
    if (errorCode(error) === 'ENOTDIR') throw usage(`--out ${out} is below a file. Choose a new directory. Nothing was written.`)
    throw error
  }
  if (!stat.isDirectory()) throw usage(`--out ${out} exists and is not a directory. Choose a new directory. Nothing was written.`)
  if (fs.readdirSync(absolute).length > 0)
    throw usage(`--out ${out} exists and is not empty. Choose a new or empty directory. Nothing was written.`)
  return absolute
}

function resolveApp(app: string): string {
  let stat: fs.Stats
  try {
    stat = fs.statSync(app)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? ''))
      throw usage(`The app directory ${app} does not exist. Nothing was read or written.`)
    throw error
  }
  if (!stat.isDirectory()) throw usage(`The app path ${app} is not a directory. Nothing was read or written.`)
  return fs.realpathSync(app)
}

const repoHints: Record<string, string> = {
  'not-git-repo':
    'The app is not a Git repository. prepare reads one pinned commit, so the app needs Git: run git init, git add -A and git commit in the app, then retry.',
  'no-commit': 'The app repository has no commit yet. Run git add -A and git commit in the app, then retry.',
  'app-not-repo-root':
    'The app is not the top level of its Git repository. A template is a whole repository: run prepare on the repository root.',
}

/**
 * Builds the snapshot of one pinned commit and writes `<out>` (spec,
 * "Snapshot"). Usage problems throw a `CliError` with exit 2 before any Git
 * read; a missing or old Git, Git's "dubious ownership" refusal and a failed
 * write of `<out>` throw a `CliError` with exit 1. Every other problem is an
 * `error` finding in the returned report, with `snapshotId: null` and only
 * `<out>/report.json` written (Q7). The source app is never written.
 */
export function prepare(options: PrepareOptions): PrepareResult {
  if (typeof options.out !== 'string' || options.out === '')
    throw usage('prepare needs --out <dir>: a new or empty directory outside the app. Nothing was read or written.')
  const appInput = path.resolve(options.app ?? '.')
  const appReal = resolveApp(appInput)
  const out = checkOut(options.out, appReal)
  const environment = options.environment ?? process.env
  const includeUncommitted = options.includeUncommitted === true
  const now = options.now ?? (() => new Date())

  checkGit(options.executor ?? run, appReal, { env: environment })
  const git = new GitReader(appReal, undefined, environment)

  const base = { head: null as string | null, findings: [] as Finding[] }
  const toplevel = git.showToplevel()
  if (!toplevel.ok) {
    if (isDubiousOwnership(toplevel.stderr)) throw unsafeDirectoryError(appInput)
    base.findings.push(repoFinding('not-git-repo'))
  } else if (realpathOrSelf(toplevel.path) !== appReal) {
    base.findings.push(repoFinding('app-not-repo-root'))
  } else {
    base.head = git.pinHead()
    if (base.head === null) base.findings.push(repoFinding('no-commit'))
  }

  const snapshot: Snapshot =
    base.head === null
      ? { files: [], contents: new Map(), findings: base.findings, excluded: [], uncommitted: [] }
      : buildSnapshot({ git, appReal, head: base.head, includeUncommitted })

  const errors = snapshot.findings.filter((item) => item.level === 'error')
  const snapshotId = errors.length === 0 ? computeSnapshotId(snapshot.files) : null
  const notices: Notice[] = [codeOnly, checksIncomplete]
  if (snapshot.uncommitted.length > 0 && !includeUncommitted) notices.push(uncommittedNotExported)

  const report: Report = {
    schema: 1,
    tool: { name: 'create-mercato-template', version: toolVersion() },
    createdAt: now().toISOString(),
    source: { head: base.head, dirty: snapshot.uncommitted.length > 0, includeUncommitted },
    files: snapshot.files,
    snapshotId,
    findings: snapshot.findings,
    notices,
    uncommitted: snapshot.uncommitted,
    excluded: snapshot.excluded,
    totals: { files: snapshot.files.length, bytes: snapshot.files.reduce((sum, file) => sum + file.size, 0) },
  }
  writeOut(out, snapshot.files, snapshot.contents, report, snapshotId !== null)
  return { exitCode: errors.length === 0 ? 0 : 1, failures: errors, out, snapshotId, report }
}

function repoFinding(rule: keyof typeof repoHints): Finding {
  return { rule, level: 'error', path: '.', message: repoHints[rule] }
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}
