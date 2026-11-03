import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CliError, exitCodes } from './errors.js'
import type { GitReader, TreeEntry } from './git.js'
import { deniedBy, denyList } from './policy/deny.js'
import {
  type Finding,
  caseCollisions,
  decodePath,
  displayPath,
  exportMode,
  isLfsPointer,
  treeEntryRule,
  unsafePathReason,
} from './policy/entries.js'

export type FileMode = '100644' | '100755'
export type Origin = 'tree' | 'worktree' | 'generated'

/** One entry of `report.files`. */
export type FileRecord = {
  path: string
  mode: FileMode
  size: number
  sha256: string
  origin: Origin
  generated?: true
}

export type UncommittedState = 'modified' | 'added' | 'deleted' | 'untracked'
export type Uncommitted = { path: string; state: UncommittedState }
export type Excluded = { pattern: string; paths: string[] }

/** The pattern recorded in `report.excluded` for `export-ignore` paths. */
export const exportIgnorePattern = 'export-ignore'

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * The `snapshotId` (protected surface, spec "report.json"): for each file the
 * line `<path>\t<mode>\t<sha256>\n`, lines sorted by the UTF-8 bytes of the
 * path, then the lower-case hex sha256 of the concatenated lines. Paths are
 * already safe (`unsafe-path`), so the lines are unambiguous.
 */
export function computeSnapshotId(files: readonly Pick<FileRecord, 'path' | 'mode' | 'sha256'>[]): string {
  const lines = [...files]
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((file) => `${file.path}\t${file.mode}\t${file.sha256}\n`)
  return sha256Hex(Buffer.from(lines.join(''), 'utf8'))
}

/** The Git blob id of `content`, computed in JS: `<format>("blob <size>\0" + bytes)`. */
export function blobId(content: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex')
}

export type WorktreeRead =
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'directory' }
  | { kind: 'special' }
  | { kind: 'file'; content: Buffer; executable: boolean }

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

const missingCodes = ['ENOENT', 'ENOTDIR']

/**
 * Whether every parent directory of `relative` inside the app is a real
 * directory: the same test as "realpath of the directory equals
 * realpath(<app>) joined with it" (spec, Snapshot item 5), done with `lstat`
 * per segment so a case-insensitive file system cannot make a plain string
 * comparison fail. `missing` when a parent does not exist or is a file.
 */
function parentState(appReal: string, relative: string): 'ok' | 'missing' | 'symlink' {
  const segments = relative.split('/').slice(0, -1)
  let current = appReal
  for (const segment of segments) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (missingCodes.includes(errorCode(error) ?? '')) return 'missing'
      throw error
    }
    if (stat.isSymbolicLink()) return 'symlink'
    if (!stat.isDirectory()) return 'missing'
  }
  return 'ok'
}

/**
 * Reads one worktree file the safe way (spec, Snapshot item 5): the real path
 * of its directory must equal `realpath(<app>)` joined with the path's
 * directory, so no parent directory is a symlink; the file is opened once with
 * `O_RDONLY | O_NOFOLLOW` and `fstat` on that descriptor must show a regular
 * file. A symlink, the file itself or a parent, is never followed and its
 * content never read.
 */
export function readWorktreeFile(appReal: string, relative: string): WorktreeRead {
  const parents = parentState(appReal, relative)
  if (parents !== 'ok') return { kind: parents }
  const full = path.join(appReal, relative)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(full)
  } catch (error) {
    if (missingCodes.includes(errorCode(error) ?? '')) return { kind: 'missing' }
    throw error
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink' }
  if (stat.isDirectory()) return { kind: 'directory' }
  if (!stat.isFile()) return { kind: 'special' }
  let descriptor: number
  try {
    descriptor = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    if (errorCode(error) === 'ELOOP') return { kind: 'symlink' }
    if (missingCodes.includes(errorCode(error) ?? '')) return { kind: 'missing' }
    throw error
  }
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile()) return { kind: 'special' }
    return { kind: 'file', content: fs.readFileSync(descriptor), executable: (opened.mode & 0o100) !== 0 }
  } finally {
    fs.closeSync(descriptor)
  }
}

/** The target of a worktree symlink, read without following it, or null when the path is not a symlink in place. */
function readWorktreeLink(appReal: string, relative: string): Buffer | null {
  if (parentState(appReal, relative) !== 'ok') return null
  try {
    const full = path.join(appReal, relative)
    if (!fs.lstatSync(full).isSymbolicLink()) return null
    return fs.readlinkSync(full, { encoding: 'buffer' })
  } catch (error) {
    if (missingCodes.includes(errorCode(error) ?? '')) return null
    throw error
  }
}

function linkExists(appReal: string, relative: string): boolean {
  try {
    fs.lstatSync(path.join(appReal, relative))
    return true
  } catch (error) {
    if (missingCodes.includes(errorCode(error) ?? '')) return false
    throw error
  }
}

export type SnapshotInput = {
  git: GitReader
  /** `realpath(<app>)`, already checked to be the Git top level. */
  appReal: string
  /** The pinned commit. */
  head: string
  includeUncommitted: boolean
}

export type Snapshot = {
  files: FileRecord[]
  /** File contents by path, for writing `<out>/tree`. */
  contents: Map<string, Buffer>
  findings: Finding[]
  excluded: Excluded[]
  uncommitted: Uncommitted[]
}

type Candidate = { mode: FileMode; origin: Origin; content?: Buffer; oid?: string; size?: number; filter: string | null }

/**
 * Builds the file set of the pinned commit (spec, Snapshot items 2 to 5):
 * the tree of `head` minus `export-ignore` and deny list paths, read as
 * blobs; the worktree changes, always listed; and, under
 * `includeUncommitted`, the worktree version of each changed file.
 * Excluded paths are never read, from the tree or the worktree.
 */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { git, appReal, head, includeUncommitted } = input
  const tree = git.listTree(head)
  const format = git.objectFormat()
  const treeKeys = new Set(tree.map((entry) => entry.path.toString('latin1')))
  const added = git.indexEntries().filter((entry) => !treeKeys.has(entry.path.toString('latin1')))
  const untracked = git.untrackedPaths()
  const paths = [...tree.map((entry) => entry.path), ...added.map((entry) => entry.path), ...untracked.map(stripTrailingSlash)]
  // `export-ignore` on a directory (`/tests export-ignore`, `docs/ export-ignore`)
  // is not inherited by the files below it, so each parent directory is asked
  // too, with a trailing slash so directory-only patterns match.
  const directories = new Map<string, Buffer>()
  for (const item of paths)
    for (let slash = item.indexOf(0x2f); slash >= 0; slash = item.indexOf(0x2f, slash + 1)) {
      const directory = item.subarray(0, slash + 1)
      directories.set(directory.toString('latin1'), directory)
    }
  const attributes = git.attributes(head, [...paths, ...directories.values()])

  const findings: Finding[] = []
  const excluded = new Map<string, Set<string>>()
  const uncommitted: Uncommitted[] = []
  const candidates = new Map<string, Candidate>()

  const attributesOf = (item: Buffer) => attributes.get(item.toString('latin1')) ?? { exportIgnore: false, filter: null }
  const exportIgnored = (item: Buffer): boolean => {
    if (attributesOf(item).exportIgnore) return true
    for (let slash = item.indexOf(0x2f); slash >= 0; slash = item.indexOf(0x2f, slash + 1))
      if (attributesOf(item.subarray(0, slash + 1)).exportIgnore) return true
    return false
  }
  /** Records an excluded path and returns true, or returns false when the path is not excluded. */
  const exclude = (item: Buffer, record: boolean): boolean => {
    const shown = displayPath(item)
    const pattern = deniedBy(shown) ?? (exportIgnored(item) ? exportIgnorePattern : null)
    if (pattern === null) return false
    if (record) excluded.set(pattern, (excluded.get(pattern) ?? new Set()).add(shown))
    return true
  }
  const finding = (rule: string, item: Buffer | string) =>
    findings.push({ rule, level: 'error', path: typeof item === 'string' ? item : displayPath(item) })
  /** Adds the worktree version of a changed path under `includeUncommitted`. */
  const takeWorktree = (relative: string, read: WorktreeRead, filter: string | null) => {
    if (read.kind === 'file')
      candidates.set(relative, {
        mode: read.executable ? '100755' : '100644',
        origin: 'worktree',
        content: read.content,
        filter,
      })
    else if (read.kind === 'symlink') finding('entry-symlink', relative)
    else if (read.kind === 'special') finding('entry-special', relative)
    // `missing` and `directory` leave the snapshot: the path is gone, or a
    // directory now holds it and its files are listed as untracked.
  }

  for (const entry of tree) {
    if (exclude(entry.path, true)) continue
    if (unsafePathReason(entry.path) !== null) {
      finding('unsafe-path', entry.path)
      continue
    }
    const relative = decodePath(entry.path) as string
    const filter = attributesOf(entry.path).filter
    const change = worktreeChange(appReal, relative, entry, format)
    if (change.state) uncommitted.push({ path: relative, state: change.state })
    if (includeUncommitted && change.state) {
      if (change.read) takeWorktree(relative, change.read, filter)
      continue
    }
    const rule = treeEntryRule(entry.mode, entry.type)
    if (rule) {
      finding(rule, relative)
      continue
    }
    candidates.set(relative, { mode: exportMode(entry.mode), origin: 'tree', oid: entry.oid, size: entry.size ?? 0, filter })
  }

  const worktreeOnly = [
    ...added.map((entry) => ({ path: entry.path, state: 'added' as const, gitlink: entry.mode === '160000' })),
    ...untracked.map((item) => ({ path: stripTrailingSlash(item), state: 'untracked' as const, gitlink: item.at(-1) === 0x2f })),
  ]
  for (const item of worktreeOnly) {
    if (exclude(item.path, includeUncommitted)) continue
    uncommitted.push({ path: displayPath(item.path), state: item.state })
    if (!includeUncommitted) continue
    if (unsafePathReason(item.path) !== null) {
      finding('unsafe-path', item.path)
      continue
    }
    const relative = decodePath(item.path) as string
    // A gitlink in the index, or a nested repository that `ls-files --others`
    // lists as `dir/`: a repository inside the app, never read.
    if (item.gitlink) {
      finding('entry-submodule', relative)
      continue
    }
    takeWorktree(relative, readWorktreeFile(appReal, relative), attributesOf(item.path).filter)
  }

  const blobs = git.readBlobs([...candidates.values()].flatMap((candidate) => (candidate.oid ? [candidate.oid] : [])))
  const files: FileRecord[] = []
  const contents = new Map<string, Buffer>()
  for (const [relative, candidate] of candidates) {
    const content = candidate.content ?? blobs.get(candidate.oid as string)
    if (!content) throw new Error(`Git returned no content for ${relative}.`)
    if (candidate.size !== undefined && candidate.size !== content.length)
      throw new Error(`Git returned ${content.length} bytes for ${relative}; the tree says ${candidate.size}.`)
    if (candidate.oid && blobId(content, format) !== candidate.oid)
      throw new Error(`Git returned other content for ${relative} than the pinned commit holds. Nothing was written.`)
    if (isLfsPointer(content, candidate.filter)) finding('lfs-pointer', relative)
    contents.set(relative, content)
    files.push({ path: relative, mode: candidate.mode, size: content.length, sha256: sha256Hex(content), origin: candidate.origin })
  }
  files.sort((left, right) => compareUtf8(left.path, right.path))
  findings.push(...caseCollisions(files.map((file) => file.path)))
  findings.sort((left, right) => compareUtf8(left.path, right.path) || left.rule.localeCompare(right.rule))
  uncommitted.sort((left, right) => compareUtf8(left.path, right.path))

  return {
    files,
    contents,
    findings,
    excluded: [...excluded]
      .map(([pattern, paths]) => ({ pattern, paths: [...paths].sort(compareUtf8) }))
      .sort((left, right) => patternOrder(left.pattern) - patternOrder(right.pattern)),
    uncommitted,
  }
}

function stripTrailingSlash(item: Buffer): Buffer {
  return item.at(-1) === 0x2f ? item.subarray(0, -1) : item
}

/** Deny list order first, `export-ignore` last. */
function patternOrder(pattern: string): number {
  if (pattern === exportIgnorePattern) return Number.MAX_SAFE_INTEGER
  return denyListIndex.get(pattern) ?? Number.MAX_SAFE_INTEGER - 1
}

const denyListIndex = new Map(denyList.map((entry, index) => [entry, index]))

/**
 * How the worktree differs from one tree entry, without `git status` (spec,
 * Snapshot item 5): `lstat` the path; a missing path is `deleted`; a regular
 * file whose blob id (computed in JS) or exec bit differs is `modified`; any
 * other type where the tree has a file is `modified`. A submodule is not
 * compared.
 */
function worktreeChange(
  appReal: string,
  relative: string,
  entry: TreeEntry,
  format: 'sha1' | 'sha256',
): { state: UncommittedState | null; read?: WorktreeRead } {
  if (entry.mode === '160000' || entry.type === 'commit') return { state: null }
  if (entry.mode === '120000') {
    const target = readWorktreeLink(appReal, relative)
    if (target && blobId(target, format) === entry.oid) return { state: null }
    if (!target && !linkExists(appReal, relative)) return { state: 'deleted', read: { kind: 'missing' } }
    return { state: 'modified', read: readWorktreeFile(appReal, relative) }
  }
  const read = readWorktreeFile(appReal, relative)
  if (read.kind === 'missing') return { state: 'deleted', read }
  if (read.kind !== 'file') return { state: 'modified', read }
  const sameContent = blobId(read.content, format) === entry.oid
  const sameMode = read.executable === (exportMode(entry.mode) === '100755')
  return sameContent && sameMode ? { state: null } : { state: 'modified', read }
}

/**
 * Writes `<out>` (spec, Snapshot item 6): with `withTree`, every file under
 * `<out>/tree/` with mode `0644` or `0755`; then `<out>/report.json`, last.
 * `<out>` was checked to be missing or empty. Any failure is exit 1, rule
 * `io-error`, and a partly written `<out>/tree` is removed, so a failed run
 * never leaves files that look like a snapshot.
 */
export function writeOut(
  out: string,
  files: readonly FileRecord[],
  contents: ReadonlyMap<string, Buffer>,
  report: unknown,
  withTree: boolean,
): void {
  const treeDirectory = path.join(out, 'tree')
  let treeCreated = false
  try {
    fs.mkdirSync(out, { recursive: true })
    if (withTree) {
      fs.mkdirSync(treeDirectory)
      treeCreated = true
      for (const file of files) {
        const target = path.join(treeDirectory, ...file.path.split('/'))
        const mode = file.mode === '100755' ? 0o755 : 0o644
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, contents.get(file.path) as Buffer, { flag: 'wx', mode })
        fs.chmodSync(target, mode)
      }
    }
    fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
  } catch (error) {
    if (treeCreated) {
      try {
        fs.rmSync(treeDirectory, { recursive: true, force: true })
      } catch {}
    }
    const code = errorCode(error) ?? (error instanceof Error ? error.message : String(error))
    throw new CliError(
      `Cannot write the snapshot to ${out} (${code}). Check free space and permissions on --out, then retry with an empty or new directory. The app was not changed.`,
      exitCodes.check,
      { rule: 'io-error', path: '.' },
    )
  }
}
