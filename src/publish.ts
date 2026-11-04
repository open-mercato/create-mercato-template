import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { type Executor, redactMessage, run } from './common.js'
import { CliError, type ExitCode, type Failure, exitCodes } from './errors.js'
import { checkGit, gitEnvironment } from './git.js'
import { unsafePathReason } from './policy/entries.js'
import { imagesOf } from './policy/warnings.js'
import { type FileRecord, blobId, compareUtf8, computeSnapshotId, sha256Hex } from './snapshot.js'
import { toolVersion } from './version.js'

/**
 * `publish` (spec, "Publication"): pushes exactly the snapshot in `<from>` as
 * a one-commit GitHub template repository, in eight ordered steps:
 *
 * 1. `verify` (local, exit 1), then the prompt (Q11) when there is no `--expect`;
 * 2. auth (`gh auth status`, exit 3);
 * 3. repo state (one read: `gh api repos/<o>/<r>`);
 * 4. the commit, built locally before any remote change;
 * 5. `create`, 6. `push`, 7. `template-flag`, 8. `topics` (exit 4 on failure).
 *
 * Every external command runs through an `Executor` with an argument array.
 * The tool never reads a token: Git asks `gh auth git-credential` for one
 * when it pushes, and no credential is written to a temporary repository,
 * `<from>` or any output.
 */

export type Visibility = 'public' | 'private'
export type StepName = 'verify' | 'create' | 'push' | 'template-flag' | 'topics'
export type StepStatus = 'done' | 'failed' | 'skipped'
export type Step = { name: StepName; status: StepStatus; detail?: string }
export type RepoInfo = { fullName: string; url: string; visibility: Visibility }
export type CommitInfo = { sha: string; tree: string }

/** The reasons of rule `snapshot-modified` (spec, Rule table). */
export type ModifiedReason = 'file-changed' | 'file-added' | 'file-missing' | 'expect-mismatch' | 'report-errors' | 'report-missing'

/** What the prompt (Q11) shows: counts come from the verified tree, never from `report.json`. */
export type ApprovalSummary = {
  repo: string
  visibility: Visibility
  snapshotId: string
  files: number
  images: number
}

export type PublishOptions = {
  /** A `prepare` output directory. */
  from: string
  /** `<owner>/<name>`, already checked with `parseRepo`. */
  repo: string
  visibility: Visibility
  /** `--expect <snapshotId>`; replaces the prompt. */
  expect?: string
  resume?: boolean
  /** The prompt (Q11), asked after `verify` when there is no `expect`. Answering false is `publish-declined`. */
  confirm?: (summary: ApprovalSummary) => Promise<boolean>
  /** Runs `gh` and `git`; defaults to `run`. */
  executor?: Executor
  /** Environment of every command; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Clock for `publication.json` `at`. */
  now?: () => Date
}

export type PublishResult = {
  exitCode: ExitCode
  failures: Failure[]
  snapshotId: string | null
  repo: RepoInfo | null
  commit: CommitInfo | null
  steps: Step[]
  retry: string | null
  /** Printed without `--json`. */
  text: string
}

/** `publication.json`, schema 1. Never holds a token. */
export type Publication = {
  schema: 1
  snapshotId: string
  repo: RepoInfo | null
  commit: CommitInfo | null
  steps: Step[]
  at: string
}

export const templateTopics = ['open-mercato-template', 'open-mercato'] as const

export const snapshotIdPattern = /^[0-9a-f]{64}$/

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const namePattern = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Reads `<owner>/<name>` as GitHub accepts it (a user or organization login,
 * and a repository name of letters, digits, `.`, `_` and `-`), or null.
 */
export function parseRepo(value: string): { owner: string; name: string } | null {
  const parts = value.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts as [string, string]
  if (!ownerPattern.test(owner) || owner.endsWith('-')) return null
  if (!namePattern.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) return null
  return { owner, name }
}

/** The commit message (protected surface, `BACKWARD_COMPATIBILITY.md`). */
export function commitMessage(snapshotId: string, version: string): string {
  return `Create template from snapshot ${snapshotId}\n\nCreated with create-mercato-template ${version}.\n`
}

/** A shell word for the `retry` command: quoted only when it needs to be. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/** The `retry` command of a failed GitHub step (spec, "Publication"). */
export function retryCommand(version: string, from: string, repo: string, visibility: Visibility, snapshotId: string): string {
  return `npx create-mercato-template@${version} publish --from ${shellWord(from)} --repo ${repo} --${visibility} --expect ${snapshotId} --resume`
}

// ---------------------------------------------------------------------------
// Step 1: verify (local).
// ---------------------------------------------------------------------------

export type VerifiedFile = { path: string; mode: FileRecord['mode']; content: Buffer }

export type Verified = {
  snapshotId: string
  files: VerifiedFile[]
  /** The manifest description, when it is one line GitHub accepts as a repository description. */
  description: string | null
  images: number
}

/** A `verify` refusal: exit 1, rule `snapshot-modified`. */
export class SnapshotModified extends CliError {
  constructor(reason: ModifiedReason, message: string, file?: string) {
    super(`${message} Nothing remote was read or changed. Run prepare again, review the new snapshot, then publish it.`, exitCodes.check, {
      rule: 'snapshot-modified',
      reason,
      ...(file === undefined ? {} : { path: file }),
    })
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return null
    throw error
  }
}

/** Opens one file without following a symlink and reads it once; null when it is not a regular file. */
export function readNoFollow(target: string): { content: Buffer; executable: boolean } | null {
  let descriptor: number
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    if (['ELOOP', 'ENOENT', 'ENOTDIR', 'EISDIR'].includes(errorCode(error) ?? '')) return null
    throw error
  }
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) return null
    return { content: fs.readFileSync(descriptor), executable: (stat.mode & 0o100) !== 0 }
  } finally {
    fs.closeSync(descriptor)
  }
}

export type ReportFile = Pick<FileRecord, 'path' | 'mode' | 'size' | 'sha256'>

/** Reads `<from>/report.json` and checks its shape; any problem is `report-missing`. */
export function readReport(from: string): { snapshotId: string | null; files: ReportFile[]; errors: number } {
  const missing = (detail: string) => new SnapshotModified('report-missing', `${path.join(from, 'report.json')} ${detail}.`, 'report.json')
  const read = readNoFollow(path.join(from, 'report.json'))
  if (!read) throw missing('is missing or is not a regular file')
  let report: unknown
  try {
    report = JSON.parse(read.content.toString('utf8'))
  } catch {
    throw missing('is not valid JSON')
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw missing('is not a prepare report')
  const value = report as Record<string, unknown>
  if (value.schema !== 1 || !Array.isArray(value.files) || !Array.isArray(value.findings)) throw missing('is not a schema 1 prepare report')
  if (value.snapshotId !== null && (typeof value.snapshotId !== 'string' || !snapshotIdPattern.test(value.snapshotId)))
    throw missing('has an unreadable snapshotId')
  const errors = value.findings.filter((finding) => !finding || typeof finding !== 'object' || (finding as { level?: unknown }).level !== 'warning').length
  const seen = new Set<string>()
  const files: ReportFile[] = []
  for (const entry of value.files as unknown[]) {
    const file = entry as Record<string, unknown> | null
    if (
      !file ||
      typeof file.path !== 'string' ||
      (file.mode !== '100644' && file.mode !== '100755') ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      unsafePathReason(Buffer.from(file.path, 'utf8')) !== null ||
      seen.has(file.path)
    )
      throw missing('lists a file entry that is not valid')
    seen.add(file.path)
    files.push({ path: file.path, mode: file.mode, size: file.size, sha256: file.sha256 })
  }
  return { snapshotId: value.snapshotId as string | null, files, errors }
}

/** Every entry under `directory`, by `/`-joined relative path, found with `lstat` (symlinks never followed). */
function walkTree(directory: string, prefix: string, found: Map<string, 'file' | 'other'>): void {
  for (const entry of fs.readdirSync(directory)) {
    const relative = prefix === '' ? entry : `${prefix}/${entry}`
    const stat = fs.lstatSync(path.join(directory, entry))
    if (stat.isDirectory()) walkTree(path.join(directory, entry), relative, found)
    else found.set(relative, stat.isFile() ? 'file' : 'other')
  }
}

function manifestDescription(files: readonly VerifiedFile[]): string | null {
  const manifest = files.find((file) => file.path === 'mercato-template.json')
  if (!manifest) return null
  try {
    const description = (JSON.parse(manifest.content.toString('utf8')) as { description?: unknown }).description
    // GitHub takes one line of at most 350 characters.
    // eslint-disable-next-line no-control-regex
    if (typeof description === 'string' && description.length > 0 && description.length <= 350 && !/[\u0000-\u001f\u007f-\u009f]/.test(description))
      return description
  } catch {}
  return null
}

/**
 * Step 1 (spec, "Publication"): `<from>` and `<from>/tree` are no symlinks;
 * `report.json` is readable, has no `error` finding and a `snapshotId` its
 * files give; that id equals `expect`; the tree holds exactly the report's
 * files, each a regular file read once with `O_NOFOLLOW`, with the report's
 * size, sha256 and exec bit. The bytes read here are the bytes pushed.
 */
export function verify(from: string, expect?: string): Verified {
  const fromStat = lstatOrNull(from)
  if (!fromStat || fromStat.isSymbolicLink() || !fromStat.isDirectory())
    throw new SnapshotModified(
      fromStat?.isSymbolicLink() ? 'file-changed' : 'report-missing',
      `${from} is not a prepare output directory (missing, a symlink or a file).`,
      '.',
    )
  const report = readReport(from)
  if (report.errors > 0)
    throw new SnapshotModified('report-errors', `report.json lists ${report.errors} error finding(s): prepare refused this snapshot.`, 'report.json')
  if (report.snapshotId === null) throw new SnapshotModified('report-errors', 'report.json has no snapshotId: prepare refused this snapshot.', 'report.json')
  if (computeSnapshotId(report.files) !== report.snapshotId)
    throw new SnapshotModified('file-changed', 'report.json was edited: its files no longer give its snapshotId.', 'report.json')
  if (expect !== undefined && expect !== report.snapshotId)
    throw new SnapshotModified('expect-mismatch', `--expect ${expect} is not the snapshotId of ${from} (${report.snapshotId}).`)
  const treeDirectory = path.join(from, 'tree')
  const treeStat = lstatOrNull(treeDirectory)
  if (!treeStat) throw new SnapshotModified('file-missing', `${treeDirectory} is missing.`, 'tree')
  if (treeStat.isSymbolicLink() || !treeStat.isDirectory())
    throw new SnapshotModified('file-changed', `${treeDirectory} is not a directory (a symlink or a file).`, 'tree')
  const found = new Map<string, 'file' | 'other'>()
  walkTree(treeDirectory, '', found)
  const expected = new Set(report.files.map((file) => file.path))
  const added = [...found.keys()].filter((file) => !expected.has(file)).sort(compareUtf8)
  if (added.length > 0) throw new SnapshotModified('file-added', `${added[0]} is in ${treeDirectory} but not in report.json.`, added[0])
  const files: VerifiedFile[] = []
  for (const file of [...report.files].sort((left, right) => compareUtf8(left.path, right.path))) {
    const kind = found.get(file.path)
    if (kind === undefined) throw new SnapshotModified('file-missing', `${file.path} is listed in report.json but missing from ${treeDirectory}.`, file.path)
    const changed = () => new SnapshotModified('file-changed', `${file.path} differs from report.json.`, file.path)
    if (kind !== 'file') throw changed()
    const read = readNoFollow(path.join(treeDirectory, ...file.path.split('/')))
    if (!read) throw changed()
    if (read.content.length !== file.size || sha256Hex(read.content) !== file.sha256 || read.executable !== (file.mode === '100755')) throw changed()
    files.push({ path: file.path, mode: file.mode, content: read.content })
  }
  const contents = new Map(files.map((file) => [file.path, file.content]))
  return {
    snapshotId: report.snapshotId,
    files,
    description: manifestDescription(files),
    images: imagesOf(
      files.map((file) => ({ path: file.path, mode: file.mode, size: file.content.length, sha256: '', origin: 'tree' })),
      contents,
    ).length,
  }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

type Result = { status: number | null; stdout: string; stderr: string }

/** Configuration on every Git command `publish` runs: no hooks, no file system monitor. */
const gitSafety = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] as const

/** Variables that would point Git at another repository than the one named. */
const redirectingVariables = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']

class Commands {
  private readonly executor: Executor
  private readonly environment: NodeJS.ProcessEnv

  constructor(executor: Executor, environment: NodeJS.ProcessEnv) {
    this.executor = executor
    this.environment = environment
  }

  private exec(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, input?: Buffer): Result {
    const result = this.executor(command, args, cwd, {
      capture: true,
      allowFailure: true,
      env: environment,
      ...(input === undefined ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  gh(args: string[], cwd: string, environment: NodeJS.ProcessEnv = this.environment): Result {
    return this.exec('gh', args, cwd, environment)
  }

  gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const environment = gitEnvironment(this.environment)
    for (const name of redirectingVariables) delete environment[name]
    return { ...environment, GIT_TERMINAL_PROMPT: '0', ...extra }
  }

  git(args: string[], cwd: string, options: { input?: Buffer; extra?: NodeJS.ProcessEnv; config?: string[] } = {}): Result {
    return this.exec('git', [...gitSafety, ...(options.config ?? []), ...args], cwd, this.gitEnvironment(options.extra), options.input)
  }

  /** A Git command that must succeed; its failure is unexpected (exit 1, `internal`). */
  gitOk(args: string[], cwd: string, options: { input?: Buffer; extra?: NodeJS.ProcessEnv } = {}): string {
    const result = this.git(args, cwd, options)
    if (result.status !== 0)
      throw new Error(`git ${args[0]} failed (exit ${result.status ?? 'signal'}): ${redactMessage(result.stderr, this.environment).split('\n')[0] ?? ''}`)
    return result.stdout
  }
}

function isMissingBinary(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return errorCode(cause) === 'ENOENT'
}

/** A failed GitHub step: exit 4, rule `github-step`. */
class StepFailed extends CliError {
  constructor(step: Exclude<StepName, 'verify'>, message: string, detail?: string) {
    super(message, exitCodes.githubStep, { rule: 'github-step', step, ...(detail === undefined ? {} : { detail }) })
  }
}

function refusal(rule: string, message: string): CliError {
  return new CliError(message, exitCodes.check, { rule })
}

function commandDetail(result: Result, environment: NodeJS.ProcessEnv): string {
  const text = redactMessage([result.stderr, result.stdout].filter((value) => value.trim()).join('\n'), environment)
  return text === '' ? '' : `\n\n${text}`
}

// ---------------------------------------------------------------------------
// The eight steps.
// ---------------------------------------------------------------------------

type RemoteState = { exists: false } | { exists: true; visibility: Visibility | 'internal' }

/** Step 3: one read. Only HTTP 404 means missing; any other failure stops before a remote change. */
function readRepoState(commands: Commands, repo: string, cwd: string): RemoteState {
  const result = commands.gh(['api', `repos/${repo}`], cwd)
  if (result.status !== 0) {
    if (/\(HTTP 404\)/.test(result.stderr)) return { exists: false }
    throw new StepFailed('create', `Cannot read ${repo} on GitHub. Nothing was changed. Check the network and gh auth status, then retry.`, 'repo-read')
  }
  let details: { private?: unknown; visibility?: unknown }
  try {
    details = JSON.parse(result.stdout) as typeof details
  } catch {
    throw new StepFailed('create', `GitHub answered ${repo} with unreadable details. Nothing was changed; retry.`, 'repo-read')
  }
  const visibility =
    details.visibility === 'public' || details.visibility === 'private' || details.visibility === 'internal'
      ? details.visibility
      : typeof details.private === 'boolean'
        ? details.private
          ? 'private'
          : 'public'
        : null
  if (visibility === null) throw new StepFailed('create', `GitHub answered ${repo} without its visibility. Nothing was changed; retry.`, 'repo-read')
  return { exists: true, visibility }
}

/** The noreply identity of the signed-in `gh` account: never the local Git identity. */
function commitIdentity(commands: Commands, cwd: string): { name: string; email: string } {
  const result = commands.gh(['api', 'user'], cwd)
  let user: { login?: unknown; id?: unknown } = {}
  if (result.status === 0) {
    try {
      user = JSON.parse(result.stdout) as typeof user
    } catch {}
  }
  if (typeof user.login !== 'string' || !ownerPattern.test(user.login) || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0)
    throw new StepFailed('create', 'Cannot read the signed-in GitHub account (gh api user). Nothing was changed; retry.', 'user-read')
  return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` }
}

/** Parses `git ls-tree -r -z` output into `path -> "<mode> <oid>"`. */
function lsTree(output: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const record of output.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), `${mode} ${type} ${oid}`)
  }
  return entries
}

/**
 * Step 4: the commit, built in a new temporary repository before any remote
 * change. The verified bytes are written with `hash-object -w --no-filters`,
 * the index gets the report modes, the written tree is compared with the
 * snapshot, and `commit-tree --no-gpg-sign` makes the one commit.
 */
function buildCommit(
  commands: Commands,
  buildRepo: string,
  verified: Verified,
  identity: { name: string; email: string },
  version: string,
): CommitInfo {
  commands.gitOk(['init', '--quiet', '--template=', '--object-format=sha1', buildRepo], path.dirname(buildRepo))
  const records: Buffer[] = []
  const expected = new Map<string, string>()
  for (const file of verified.files) {
    const oid = commands.gitOk(['hash-object', '-w', '--no-filters', '--stdin'], buildRepo, { input: file.content }).trim()
    if (oid !== blobId(file.content, 'sha1')) throw new SnapshotModified('file-changed', `Git stored other bytes for ${file.path} than verify read.`, file.path)
    records.push(Buffer.from(`${file.mode} ${oid}\t${file.path}\0`, 'utf8'))
    expected.set(file.path, `${file.mode} blob ${oid}`)
  }
  commands.gitOk(['update-index', '-z', '--index-info'], buildRepo, { input: Buffer.concat(records) })
  const tree = commands.gitOk(['write-tree'], buildRepo).trim()
  const written = lsTree(commands.gitOk(['ls-tree', '-r', '-z', tree], buildRepo))
  if (written.size !== expected.size || [...expected].some(([file, entry]) => written.get(file) !== entry))
    throw new SnapshotModified('file-changed', 'The tree Git wrote differs from the verified snapshot.')
  const sha = commands
    .gitOk(['commit-tree', '--no-gpg-sign', tree, '-F', '-'], buildRepo, {
      input: Buffer.from(commitMessage(verified.snapshotId, version), 'utf8'),
      extra: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      },
    })
    .trim()
  commands.gitOk(['update-ref', 'refs/heads/main', sha], buildRepo)
  return { sha, tree }
}

/**
 * Step 6: clone without checkout, decide the state, push the one commit to an
 * empty repository. Returns the commit GitHub holds, or null when it pushed
 * the local one. Never `--force`, never a `+` refspec.
 */
function push(commands: Commands, repo: string, workspace: string, buildRepo: string, local: CommitInfo): { commit: CommitInfo; pushed: boolean } {
  const clone = path.join(workspace, 'clone')
  const cloned = commands.gh(['repo', 'clone', repo, clone, '--', '--no-checkout'], workspace, commands.gitEnvironment())
  if (cloned.status !== 0 || !fs.existsSync(path.join(clone, '.git')))
    throw new StepFailed('push', `Cannot clone ${repo}. Its commit was built locally; retry with --resume.`, 'clone')
  // Every ref the clone got (branches and tags), except the symbolic origin/HEAD.
  const remoteRefs = commands.gitOk(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin', 'refs/tags'], clone)
    .split('\n')
    .filter((ref) => ref !== '' && ref !== 'refs/remotes/origin/HEAD')
  if (remoteRefs.length > 0) {
    const head = commands.git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD^{commit}'], clone)
    const count = head.status === 0 ? commands.git(['rev-list', '--count', 'refs/remotes/origin/HEAD'], clone).stdout.trim() : ''
    const tree = head.status === 0 ? commands.git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD^{tree}'], clone).stdout.trim() : ''
    // This snapshot's repository has one branch, one commit, the snapshot's tree.
    if (head.status !== 0 || remoteRefs.length !== 1 || count !== '1' || tree !== local.tree)
      throw refusal(
        'repo-not-from-snapshot',
        `${repo} is neither empty nor this snapshot's one commit, so publish leaves it alone. Nothing was changed. Choose a new repository name.`,
      )
    return { commit: { sha: head.stdout.trim(), tree }, pushed: false }
  }
  commands.gitOk(['fetch', '--quiet', '--no-tags', buildRepo, local.sha], clone)
  const pushed = commands.git(['push', '--quiet', '--no-verify', 'origin', `${local.sha}:refs/heads/main`], clone, {
    config: ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'],
  })
  if (pushed.status !== 0) {
    if (/without [`'"]?workflow[`'"]? scope/i.test(pushed.stderr))
      throw new StepFailed(
        'push',
        `GitHub refused the push: the snapshot has .github/workflows files and the gh token lacks the workflow scope. Run gh auth refresh -s workflow, then retry with --resume.`,
        'workflow-scope',
      )
    throw new StepFailed('push', `The push to ${repo} failed. The repository exists and the commit is built; retry with --resume.`, 'rejected')
  }
  return { commit: local, pushed: true }
}

function writePublication(from: string, publication: Publication): void {
  const target = path.join(from, 'publication.json')
  const temporary = path.join(from, `.publication.json.${process.pid}.${Date.now()}`)
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(publication, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
    // A rename replaces a symlink at the target itself, never the file it points at.
    fs.renameSync(temporary, target)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {}
    throw new CliError(
      `Cannot write ${target} (${errorCode(error) ?? 'error'}). Check free space and permissions on --from, then retry with --resume.`,
      exitCodes.check,
      { rule: 'io-error', path: 'publication.json' },
    )
  }
}

function resultText(result: Omit<PublishResult, 'text'>): string {
  const lines: string[] = []
  if (result.exitCode === exitCodes.ok && result.repo)
    lines.push(`Published ${result.repo.url} (${result.repo.visibility}) from snapshot ${result.snapshotId}.`)
  if (result.steps.length > 0) {
    lines.push('Steps:')
    for (const step of result.steps) lines.push(`  ${step.name.padEnd(13)} ${step.status}${step.detail ? ` (${step.detail})` : ''}`)
  }
  if (result.commit) lines.push(`Commit: ${result.commit.sha} (tree ${result.commit.tree})`)
  if (result.retry) lines.push(`Retry: ${result.retry}`)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * Runs the eight steps. Never throws for a known failure: a refusal, an auth
 * problem or a failed step comes back as a result with its exit code, the
 * steps that ran, `repo`, `commit` and `retry` when known.
 */
export async function publish(options: PublishOptions): Promise<PublishResult> {
  const from = path.resolve(options.from)
  const executor = options.executor ?? run
  const environment = options.environment ?? process.env
  const now = options.now ?? (() => new Date())
  const commands = new Commands(executor, environment)
  const version = toolVersion()
  const fullName = options.repo
  const repoInfo: RepoInfo = { fullName, url: `https://github.com/${fullName}`, visibility: options.visibility }

  const steps: Step[] = []
  let snapshotId: string | null = null
  let repo: RepoInfo | null = null
  let commit: CommitInfo | null = null
  let workspace: string | null = null

  const record = () => {
    if (snapshotId !== null) writePublication(from, { schema: 1, snapshotId, repo, commit, steps: steps.map((step) => ({ ...step })), at: now().toISOString() })
  }
  const finish = (exitCode: ExitCode, failures: Failure[]): PublishResult => {
    // A retry for a failed GitHub step, and for any other failure once the
    // repository may have been changed (a publication.json write that failed).
    const remoteChanged = steps.some((step) => step.status === 'done' && step.name !== 'verify')
    const retry =
      exitCode !== exitCodes.ok && snapshotId !== null && (exitCode === exitCodes.githubStep || remoteChanged)
        ? retryCommand(version, from, fullName, options.visibility, snapshotId)
        : null
    const result = { exitCode, failures, snapshotId, repo, commit, steps, retry }
    return { ...result, text: resultText(result) }
  }
  /** Marks `name` done, or skipped, and rewrites `publication.json`. */
  const done = (name: StepName, status: StepStatus = 'done', write = true) => {
    steps.push({ name, status })
    if (write) record()
  }
  /** Runs a GitHub read or change; a command that cannot run or times out fails `step` (exit 4). */
  const remote = <T>(step: Exclude<StepName, 'verify'>, detail: string | undefined, action: () => T): T => {
    try {
      return action()
    } catch (error) {
      if (error instanceof CliError) throw error
      const message = redactMessage(error instanceof Error ? error.message : String(error), environment)
      throw new StepFailed(step, `The ${step} step failed: ${message} Retry with --resume.`, detail)
    }
  }

  let current: StepName = 'verify'
  try {
    let verified: Verified
    try {
      verified = verify(from, options.expect)
    } catch (error) {
      if (error instanceof CliError) steps.push({ name: 'verify', status: 'failed' })
      throw error
    }
    snapshotId = verified.snapshotId
    checkGit(executor, from, { env: environment })
    if (options.expect === undefined) {
      if (!options.confirm) throw new CliError('publish needs --expect <snapshotId> or an answer to the prompt.', exitCodes.usage)
      const approved = await options.confirm({
        repo: fullName,
        visibility: options.visibility,
        snapshotId: verified.snapshotId,
        files: verified.files.length,
        images: verified.images,
      })
      if (!approved) {
        steps.push({ name: 'verify', status: 'done' })
        throw refusal('publish-declined', 'Publication declined. Nothing remote was read or changed.')
      }
    }
    done('verify')

    // Step 2: auth.
    let auth: Result
    try {
      auth = commands.gh(['auth', 'status'], from)
    } catch (error) {
      if (isMissingBinary(error))
        throw new CliError('gh (the GitHub CLI) is not installed or not on PATH. Install it from https://cli.github.com, run gh auth login, then retry. Nothing remote was changed.', exitCodes.githubAuth)
      throw error
    }
    if (auth.status !== 0) throw new CliError('gh is not signed in to GitHub. Run gh auth login, then retry. Nothing remote was changed.', exitCodes.githubAuth)

    // Step 3: repo state (reads only).
    const state = remote('create', 'repo-read', () => readRepoState(commands, fullName, from))
    if (state.exists) {
      if (state.visibility !== 'internal') repo = { ...repoInfo, visibility: state.visibility }
      if (!options.resume)
        throw refusal('repo-name-exists', `${fullName} already exists on GitHub. Nothing was changed. Choose a new name, or add --resume to continue a publication of this snapshot.`)
      if (state.visibility !== options.visibility)
        throw refusal(
          'visibility-mismatch',
          state.visibility === 'internal'
            ? `${fullName} is an internal repository on GitHub; publish makes public or private templates only. Nothing was changed. Choose a new name.`
            : `${fullName} is ${state.visibility} on GitHub, not ${options.visibility}. Nothing was changed. Run again with --${state.visibility} or choose a new name.`,
        )
    }

    // Step 4: the commit, built locally before any remote change.
    const identity = remote('create', 'user-read', () => commitIdentity(commands, from))
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'create-mercato-template-')))
    workspace = work
    const buildRepo = path.join(work, 'build')
    const local = buildCommit(commands, buildRepo, verified, identity, version)
    commit = local

    // Step 5: create. On a resume, publication.json is written only once the
    // push step has checked that the repository is this snapshot's.
    current = 'create'
    if (state.exists) done('create', 'skipped', false)
    else {
      const created = remote('create', undefined, () => commands.gh(
        ['repo', 'create', fullName, `--${options.visibility}`, ...(verified.description ? ['--description', verified.description] : [])],
        work,
      ))
      if (created.status !== 0)
        throw new StepFailed('create', `gh repo create ${fullName} failed. Nothing was pushed; retry with --resume.${commandDetail(created, environment)}`)
      repo = repoInfo
      done('create')
    }

    // Step 6: push.
    current = 'push'
    const pushed = remote('push', undefined, () => push(commands, fullName, work, buildRepo, local))
    commit = pushed.commit
    done('push', pushed.pushed ? 'done' : 'skipped')

    // Step 7: template-flag.
    current = 'template-flag'
    const flagged = remote('template-flag', undefined, () => commands.gh(['api', '--method', 'PATCH', `repos/${fullName}`, '-F', 'is_template=true'], work))
    let isTemplate = false
    if (flagged.status === 0) {
      try {
        isTemplate = (JSON.parse(flagged.stdout) as { is_template?: unknown }).is_template === true
      } catch {}
    }
    if (!isTemplate) throw new StepFailed('template-flag', `GitHub did not mark ${fullName} as a template. Retry with --resume.${commandDetail(flagged, environment)}`)
    done('template-flag')

    // Step 8: topics.
    current = 'topics'
    const topics = remote('topics', undefined, () => commands.gh(['repo', 'edit', fullName, ...templateTopics.flatMap((topic) => ['--add-topic', topic])], work))
    if (topics.status !== 0) throw new StepFailed('topics', `Adding the topics to ${fullName} failed. Retry with --resume.${commandDetail(topics, environment)}`)
    done('topics')
    return finish(exitCodes.ok, [])
  } catch (thrown) {
    let error = thrown
    // Once a repository may have been changed, an unexpected failure is the
    // failure of the step that ran, so the run can be resumed (exit 4).
    if (!(error instanceof CliError) && steps.some((step) => step.name === 'create')) {
      const message = redactMessage(error instanceof Error ? error.message : String(error), environment)
      error = new StepFailed(current as Exclude<StepName, 'verify'>, `The ${current} step failed: ${message} Retry with --resume.`)
    }
    if (!(error instanceof CliError)) throw error
    if (error instanceof StepFailed) {
      const failure = error.failure
      steps.push({ name: failure.step as StepName, status: 'failed', ...(typeof failure.detail === 'string' ? { detail: failure.detail } : {}) })
      try {
        record()
      } catch {}
    } else if (error.exitCode === exitCodes.githubStep) steps.push({ name: current, status: 'failed' })
    return finish(error.exitCode, [error.failure])
  } finally {
    if (workspace !== null) fs.rmSync(workspace, { recursive: true, force: true })
  }
}
