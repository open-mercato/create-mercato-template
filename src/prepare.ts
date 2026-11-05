import * as fs from 'node:fs'
import * as path from 'node:path'
import { type Executor, run } from './common.js'
import { CliError, exitCodes } from './errors.js'
import { GitReader, checkGit, isDubiousOwnership, unsafeDirectoryError } from './git.js'
import { readInventory } from './inventory.js'
import { type ReportModule, buildManifest, manifestPath, resolveModules, serializeManifest } from './manifest.js'
import { type EnvReport, buildEnv, envExamplePath, envKeyPattern, sourceManifestEnv } from './policy/env.js'
import type { Finding } from './policy/entries.js'
import { classifyContent, decodeForScan, isText } from './policy/opaque.js'
import { type OpenMercato, type RootResult, checkRoot } from './policy/root.js'
import { type SecretRules, scanPath, scanText } from './policy/secrets.js'
import { type ImageRecord, type Notice, checkWarnings, notices as reportNotices } from './policy/warnings.js'
import {
  type Excluded,
  type FileRecord,
  type Snapshot,
  type Uncommitted,
  buildSnapshot,
  compareUtf8,
  computeSnapshotId,
  sha256Hex,
  sortFindings,
  writeOut,
} from './snapshot.js'
import { type RulesSummary, rulesSummary } from './rules/gitleaks.js'
import { matchStock } from './stock.js'
import { toolVersion } from './version.js'

export type { Finding } from './policy/entries.js'
export type { Excluded, FileRecord, Uncommitted } from './snapshot.js'
export type { OpenMercato } from './policy/root.js'
export type { Manifest, ReportModule } from './manifest.js'
export type { RulesSummary } from './rules/gitleaks.js'
export type { EnvReport } from './policy/env.js'
export type { ImageRecord, Notice } from './policy/warnings.js'

/**
 * The options of `prepare` (spec, Commands and flags). The CLI command
 * (`src/cli.ts`) maps its flags to them; tests call `prepare()` directly too.
 */
export type PrepareOptions = {
  /** The app directory; defaults to the current directory. Must be the Git top level. */
  app?: string
  /** The output directory: missing, or an empty directory, and not inside the app. */
  out: string
  /** A10: export the worktree version of changed and untracked files. */
  includeUncommitted?: boolean
  /** Exact repo-relative paths of opaque files to export (`--allow-file`). */
  allowFiles?: readonly string[]
  /** Keys whose non-stock value the generated `.env.example` keeps after the checks (`--keep-env`). */
  keepEnv?: readonly string[]
  /** Environment for Git; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Executor for the Git version check; defaults to `run`. */
  executor?: Executor
  /** Clock for `createdAt`. */
  now?: () => Date
  /** The secret rules of the content checks, for tests; the bundled and extra rules by default. */
  secretRules?: SecretRules
}

export type AllowFile = { path: string; used: boolean }

/** `report.json`, schema 1. */
export type Report = {
  schema: 1
  /** `rules`: the bundled gitleaks rules: their source tag and sha256, the rule count and the ids left out with their reasons. */
  tool: { name: string; version: string; rules: RulesSummary }
  createdAt: string
  source: { head: string | null; dirty: boolean; includeUncommitted: boolean }
  /** The stock entry matched by the pinned core version; `known: false` when the table lacks it. */
  stock: { version: string | null; known: boolean }
  /** `package.json` `engines`, string values only. */
  engines: Record<string, string> | null
  /** `package.json` `packageManager`. */
  packageManager: string | null
  files: FileRecord[]
  snapshotId: string | null
  findings: Finding[]
  notices: Notice[]
  /** The pinned `@open-mercato/core` from `yarn.lock`: version and `major.minor` line. */
  openMercato: OpenMercato | null
  uncommitted: Uncommitted[]
  excluded: Excluded[]
  /** The `allowFiles` paths, each with `used`: true when it names an opaque file of the snapshot. */
  allowFiles: AllowFile[]
  /** The env diff: kept, emptied and declared keys, and the line numbers of dropped lines. Never a value. */
  env: EnvReport
  /** Every image of the snapshot, anywhere, with its size. */
  images: ImageRecord[]
  /** The module inventory of `src/modules.ts`: the manifest entries with their line, and what could not be read. */
  modules: { entries: ReportModule[]; unparsed: Array<{ line: number; reason: string }> }
  /** Q6. `dependency`: `yarn.lock` resolves `@open-mercato/enterprise`; `modules`: the registered modules from it, with their `when`. */
  enterprise: { dependency: boolean; modules: Array<{ id: string; when?: string }> }
  totals: { files: number; bytes: number }
}

/** What the `--json` envelope of `prepare` carries (spec, "--json shape"). */
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
      // A path that exists but does not resolve is a dangling symlink: where
      // it would lead cannot be judged, so it is refused.
      if (fs.existsSync(current) || isSymlink(current))
        throw usage(`--out ${target} goes through a symlink to a missing directory (${current}). Choose a new directory. Nothing was written.`)
      const parent = path.dirname(current)
      if (parent === current) throw error
      rest.push(path.basename(current))
      current = parent
    }
  }
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
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
  const allowFiles = allowFilesOption(options.allowFiles)
  const keepEnv = keepEnvOption(options.keepEnv)
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

  const root: RootResult | null = base.head === null ? null : checkRoot(snapshot.contents)
  let modules: Report['modules'] = { entries: [], unparsed: [] }
  let enterpriseModules: Report['enterprise']['modules'] = []
  let allowFilesReport: AllowFile[] = allowFiles.map((item) => ({ path: item, used: false }))
  let envReport: EnvReport = { kept: [], emptied: [], declared: [], dropped: [] }
  let images: ImageRecord[] = []
  const stock = matchStock(root?.openMercato?.version ?? null)
  const notices: Notice[] = [codeOnly]
  if (root) {
    snapshot.findings.push(...root.findings)
    const inventory = readInventory(snapshot.contents)
    const resolved = resolveModules(inventory, root.packageJson, root.lockfile)
    modules = resolved.report
    enterpriseModules = resolved.enterprise
    const env = buildEnv({
      source: snapshot.contents.get(envExamplePath),
      match: stock,
      keepEnv,
      sourceManifestEnv: sourceManifestEnv(snapshot.contents.get(manifestPath)),
    })
    envReport = env.report
    const { manifest, findings } = buildManifest({
      packageJson: root.packageJson,
      appName: path.basename(appReal),
      openMercato: root.openMercato,
      modules: resolved.report.entries,
      env: env.declared,
      version: toolVersion(),
    })
    snapshot.findings.push(...inventory.findings, ...resolved.findings, ...env.findings, ...findings)
    addGenerated(snapshot, envExamplePath, env.content)
    addGenerated(snapshot, manifestPath, serializeManifest(manifest))
    const content = checkContents(snapshot, allowFiles, options.secretRules)
    snapshot.findings.push(...content.findings)
    allowFilesReport = content.allowFiles
    const warnings = checkWarnings({ files: snapshot.files, contents: snapshot.contents, excluded: snapshot.excluded })
    snapshot.findings.push(...warnings.findings)
    images = warnings.images
    sortFindings(snapshot.findings)
    notices.push(...reportNotices({ stock, enterprise: { dependency: root.enterprise.dependency, modules: enterpriseModules }, packageJson: root.packageJson }))
  }
  const errors = snapshot.findings.filter((item) => item.level === 'error')
  const snapshotId = errors.length === 0 ? computeSnapshotId(snapshot.files) : null
  if (snapshot.uncommitted.length > 0 && !includeUncommitted) notices.push(uncommittedNotExported)

  const report: Report = {
    schema: 1,
    tool: { name: 'create-mercato-template', version: toolVersion(), rules: rulesSummary() },
    createdAt: now().toISOString(),
    source: { head: base.head, dirty: snapshot.uncommitted.length > 0, includeUncommitted },
    stock: { version: stock.version, known: stock.known },
    engines: root?.engines ?? null,
    packageManager: root?.packageManager ?? null,
    files: snapshot.files,
    snapshotId,
    findings: snapshot.findings,
    notices,
    openMercato: root?.openMercato ?? null,
    uncommitted: snapshot.uncommitted,
    excluded: snapshot.excluded,
    allowFiles: allowFilesReport,
    env: envReport,
    images,
    modules,
    enterprise: { dependency: root?.enterprise.dependency ?? false, modules: enterpriseModules },
    totals: { files: snapshot.files.length, bytes: snapshot.files.reduce((sum, file) => sum + file.size, 0) },
  }
  writeOut(out, snapshot.files, snapshot.contents, report, snapshotId !== null)
  return { exitCode: errors.length === 0 ? 0 : 1, failures: errors, out, snapshotId, report }
}

function allowFilesOption(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === ''))
    throw usage('allowFiles must be a list of repo-relative paths. Nothing was read or written.')
  return [...new Set(value as string[])]
}

function keepEnvOption(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw usage('keepEnv must be a list of env key names. Nothing was read or written.')
  for (const item of value as string[])
    if (!envKeyPattern.test(item))
      throw usage('--keep-env takes an env key name (letters, digits and _, not starting with a digit), such as APP_URL. Nothing was read or written.')
  return [...new Set(value as string[])]
}

const opaqueMessage =
  'Not text, and not an image or font whose content matches its extension (archives and database files are opaque even as text). Remove it from the commit, or export it on purpose by giving its exact path with --allow-file.'

const allowFileUnusedMessage = (reason: string) => `--allow-file names a path that ${reason}, so it has no effect.`

/**
 * The content checks of every exported file, the generated manifest
 * included (spec, Opaque files and Secret scan): path-only secret rules on
 * every file; the secret scan, credential URLs and Yarn auth on every text
 * file, whatever its extension, and on the UTF-16 or Latin-1 decode of an
 * opaque file that holds text in another encoding; `opaque-file` for an opaque file whose exact
 * path is not in `allowFiles`; `allow-file-unused` for an `allowFiles` path
 * that is not in the snapshot or is not opaque.
 */
function checkContents(snapshot: Snapshot, allowFiles: readonly string[], rules?: SecretRules): { findings: Finding[]; allowFiles: AllowFile[] } {
  const findings: Finding[] = []
  const opaque = new Set<string>()
  for (const file of snapshot.files) {
    const content = snapshot.contents.get(file.path) as Buffer
    findings.push(...scanPath(file.path, rules))
    const text = isText(content)
    const kind = classifyContent(file.path, content, text)
    // Media (an image or font whose signature matches) is not scanned as text.
    const scanned = text ? content.toString('utf8') : kind === 'opaque' ? decodeForScan(content) : null
    if (scanned !== null) findings.push(...scanText(file.path, scanned, rules))
    if (kind !== 'opaque') continue
    opaque.add(file.path)
    if (!allowFiles.includes(file.path)) findings.push({ rule: 'opaque-file', level: 'error', path: file.path, message: opaqueMessage })
  }
  const exported = new Set(snapshot.files.map((file) => file.path))
  const report = allowFiles.map((item) => ({ path: item, used: opaque.has(item) }))
  for (const item of report)
    if (!item.used)
      findings.push({
        rule: 'allow-file-unused',
        level: 'warning',
        path: item.path,
        message: allowFileUnusedMessage(exported.has(item.path) ? 'is not an opaque file' : 'is not in the snapshot'),
      })
  return { findings, allowFiles: report }
}

/**
 * Puts a generated file (`.env.example`, `mercato-template.json`) into the
 * file set, in place of the file of that path from the source app; with
 * `content` null, the source file only leaves the set. A source path that
 * differs from it only in case would overwrite it on macOS and Windows:
 * `path-case-collision`.
 */
function addGenerated(snapshot: Snapshot, generatedPath: string, content: Buffer | null): void {
  snapshot.files = snapshot.files.filter((file) => file.path !== generatedPath)
  snapshot.contents.delete(generatedPath)
  if (content === null) return
  const lower = generatedPath.toLowerCase()
  for (const file of snapshot.files)
    if (file.path.toLowerCase() === lower)
      snapshot.findings.push({ rule: 'path-case-collision', level: 'error', path: file.path, message: `Differs from the generated ${generatedPath} only in case.` })
  snapshot.files.push({ path: generatedPath, mode: '100644', size: content.length, sha256: sha256Hex(content), origin: 'generated', generated: true })
  snapshot.files.sort((left, right) => compareUtf8(left.path, right.path))
  snapshot.contents.set(generatedPath, content)
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
