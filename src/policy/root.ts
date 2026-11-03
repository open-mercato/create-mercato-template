/**
 * Root checks (spec Step 4, Rule table): the app is an Open Mercato app on
 * Yarn 4 whose `@open-mercato/*` packages resolve to one line, and no path
 * ends in `.template`. Every input comes from the snapshot's file contents:
 * the blobs of the pinned sha, or the worktree versions Step 3 admits under
 * `includeUncommitted`. Nothing else in the app is read. Messages name
 * packages and versions, never other file content.
 */
import {
  type LockEntry,
  type Lockfile,
  LockfileError,
  descriptorName,
  entriesNamed,
  frameworkNames,
  isRegistryEntry,
  parseLockfile,
  resolveDependency,
  versionLine,
} from '../lockfile.js'
import type { Finding } from './entries.js'

export const corePackage = '@open-mercato/core'
export const enterprisePackage = '@open-mercato/enterprise'
const scope = '@open-mercato/'

export type OpenMercato = { version: string; line: string }

export type RootResult = {
  findings: Finding[]
  /** The pinned `@open-mercato/core` from `yarn.lock`, or null when it is not pinned. */
  openMercato: OpenMercato | null
  /** `enterprise.dependency`: `yarn.lock` resolves `@open-mercato/enterprise` (Q6). `prepare()` adds `modules` from the module inventory. */
  enterprise: { dependency: boolean }
  /** `package.json` `packageManager`, or null. */
  packageManager: string | null
  /** `package.json` `engines` (string values only), or null. */
  engines: Record<string, string> | null
  /** The root `package.json` object, or null when it cannot be read. For the module inventory (Step 5). */
  packageJson: Record<string, unknown> | null
  /** The parsed `yarn.lock`, or null when it is missing or cannot be read. */
  lockfile: Lockfile | null
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(content: Buffer | undefined): Json | null {
  if (!content) return null
  try {
    const value: unknown = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function error(rule: string, path: string, message: string): Finding {
  return { rule, level: 'error', path, message }
}

/** `dependencies` and `devDependencies` entries named `@open-mercato/*`, with their range (null when not a string). */
function omDependencies(packageJson: Json): Array<{ name: string; range: string | null }> {
  const seen = new Map<string, string | null>()
  for (const field of ['dependencies', 'devDependencies']) {
    const block = packageJson[field]
    if (!isObject(block)) continue
    for (const [name, range] of Object.entries(block))
      if (name.startsWith(scope) && !seen.has(name)) seen.set(name, typeof range === 'string' ? range : null)
  }
  return [...seen].map(([name, range]) => ({ name, range }))
}

/**
 * The package names `package.json` `resolutions` overrides (`name`,
 * `name@range`, `parent/name`): Yarn may record those under another
 * descriptor, so they are looked up by name only.
 */
function resolutionNames(packageJson: Json | null): Set<string> {
  const names = new Set<string>()
  if (packageJson === null || !isObject(packageJson.resolutions)) return names
  for (const key of Object.keys(packageJson.resolutions)) {
    // The overridden package is the last name in the key: `b`, `a/b`, `@s/a/@s/b`, `a@1/b@2`.
    const parts = key.split('/')
    const last = parts.at(-1) ?? key
    const previous = parts.at(-2)
    names.add(descriptorName(previous?.startsWith('@') ? `${previous}/${last}` : last))
  }
  return names
}

/** True for a registry range or a Yarn protocol whose descriptor Yarn writes as is (`npm:`, `workspace:`, `link:`, `portal:`, `file:`, `patch:`). */
export function isPlainRange(range: string): boolean {
  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(range)?.[1]
  if (protocol) return ['npm', 'workspace', 'link', 'portal', 'file', 'patch'].includes(protocol)
  return !range.includes('/')
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isObject(value)) return null
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** True for a `packageManager` of Yarn 4 (`yarn@4.12.0`, with or without a `+sha...` hash). */
export function isYarn4(packageManager: unknown): boolean {
  return typeof packageManager === 'string' && /^yarn@4\.\d+\.\d+/.test(packageManager)
}

/**
 * The range to look a dependency up by in `yarn.lock`: the `package.json`
 * range, or null (look up by name) when Yarn may record it under another
 * descriptor (an override in `resolutions`, a git or URL range). The range
 * itself is never printed: a URL range can hold a credential.
 */
function rangeLookup(packageJson: Json | null): (name: string, range: string | null) => string | null {
  const overridden = resolutionNames(packageJson)
  return (name, range) => (overridden.has(name) || (range !== null && !isPlainRange(range)) ? null : range)
}

/**
 * The lockfile entry of a module's npm package (spec, Module inventory item
 * 7): first the descriptor from `package.json` (`dependencies`, then
 * `devDependencies`) looked up in `yarn.lock`; else the single lockfile
 * entry for that name. Null when neither gives one entry.
 */
export function resolveModulePackage(packageJson: Record<string, unknown> | null, lockfile: Lockfile, name: string): LockEntry | null {
  const rangeOf = rangeLookup(packageJson)
  for (const field of ['dependencies', 'devDependencies']) {
    const block = packageJson?.[field]
    if (!isObject(block) || !Object.hasOwn(block, name)) continue
    const range = block[name]
    const entry = resolveDependency(lockfile, name, rangeOf(name, typeof range === 'string' ? range : null))
    if (entry !== null) return entry
  }
  const named = entriesNamed(lockfile, name)
  return named.length === 1 ? named[0] : null
}

/**
 * Runs the root checks over the snapshot. `contents` maps every exported
 * path to its bytes.
 */
export function checkRoot(contents: ReadonlyMap<string, Buffer>): RootResult {
  const findings: Finding[] = []
  const result: RootResult = {
    findings,
    openMercato: null,
    enterprise: { dependency: false },
    packageManager: null,
    engines: null,
    packageJson: null,
    lockfile: null,
  }

  for (const path of contents.keys())
    if (path.endsWith('.template'))
      findings.push(error('template-file', path, 'The template importer refuses paths ending in .template. Rename the file or remove it from the commit.'))

  const monorepo = readJson(contents.get('packages/core/package.json'))
  if (monorepo?.name === corePackage)
    findings.push(
      error(
        'root-monorepo',
        'packages/core/package.json',
        'This is the Open Mercato framework monorepo, not an app. Save an app created with create-mercato-app instead.',
      ),
    )

  const packageJson = readJson(contents.get('package.json'))
  result.packageJson = packageJson
  if (packageJson === null) {
    findings.push(
      error(
        'root-package-json',
        'package.json',
        contents.has('package.json')
          ? 'The root package.json is not a JSON object.'
          : 'The snapshot has no root package.json: it is not in the commit, or it is not a regular file, or export-ignore left it out.',
      ),
    )
  } else {
    const dependencies = packageJson.dependencies
    if (!isObject(dependencies) || !Object.hasOwn(dependencies, corePackage))
      findings.push(error('root-not-om-app', 'package.json', `package.json does not depend on ${corePackage}: this is not an Open Mercato app.`))
    if (Object.hasOwn(packageJson, 'workspaces'))
      findings.push({
        rule: 'root-workspaces',
        level: 'warning',
        path: 'package.json',
        message: 'The root package.json has workspaces. Allowed; check that every workspace belongs in the template.',
      })
    if (!isYarn4(packageJson.packageManager))
      findings.push(
        error(
          'root-package-manager',
          'package.json',
          'packageManager must be Yarn 4 (yarn@4.x). Run corepack use yarn@4 in the app and commit package.json and yarn.lock.',
        ),
      )
    result.packageManager = typeof packageJson.packageManager === 'string' ? packageJson.packageManager : null
    result.engines = stringRecord(packageJson.engines)
  }

  const lockContent = contents.get('yarn.lock')
  let lockfile: Lockfile | null = null
  if (!lockContent) {
    findings.push(error('root-yarn-lock', 'yarn.lock', 'The snapshot has no root yarn.lock: it is not in the commit, or it is not a regular file, or export-ignore left it out. Run yarn install in the app and commit yarn.lock.'))
  } else {
    try {
      lockfile = parseLockfile(lockContent)
    } catch (caught) {
      if (!(caught instanceof LockfileError)) throw caught
      findings.push(
        error('root-yarn-lock', 'yarn.lock', `The root yarn.lock cannot be read as a Yarn 4 lockfile: ${caught.message}. Run yarn install with Yarn 4 and commit yarn.lock.`),
      )
    }
  }
  if (lockfile === null) return result
  result.lockfile = lockfile

  const rangeOf = rangeLookup(packageJson)
  if (packageJson !== null)
    for (const dependency of omDependencies(packageJson)) {
      if (resolveDependency(lockfile, dependency.name, rangeOf(dependency.name, dependency.range)) !== null) continue
      const known = entriesNamed(lockfile, dependency.name).length > 0
      findings.push(
        error(
          'root-om-unresolved',
          'package.json',
          known
            ? `${dependency.name}: the package.json range has no entry in yarn.lock: yarn.lock is out of date. Run yarn install and commit yarn.lock.`
            : `${dependency.name} has no entry in yarn.lock. Run yarn install and commit yarn.lock.`,
        ),
      )
    }

  // Only the framework's lockstep set counts: a package released on its own
  // line (such as @open-mercato/client) is not a mixed line.
  const framework = frameworkNames(lockfile, scope, corePackage)
  // A framework package with no lockfile edge to core still counts when it
  // has an entry on core's line: lockstep packages release together.
  const coreLines = new Set(entriesNamed(lockfile, corePackage).filter(isRegistryEntry).map((entry) => versionLine(entry.version)))
  for (const entry of lockfile.entries)
    if (entry.name.startsWith(scope) && isRegistryEntry(entry) && coreLines.has(versionLine(entry.version))) framework.add(entry.name)
  const lines = new Map<string, Set<string>>()
  for (const entry of lockfile.entries) {
    if (!framework.has(entry.name) || !isRegistryEntry(entry)) continue
    const line = versionLine(entry.version)
    if (line !== null) lines.set(line, (lines.get(line) ?? new Set()).add(entry.name))
  }
  if (lines.size > 1)
    findings.push(
      error(
        'root-om-mixed-lines',
        'yarn.lock',
        `Resolved @open-mercato framework packages span ${lines.size} lines (${[...lines.keys()].sort().join(', ')}). Align every @open-mercato framework dependency on one major.minor line.`,
      ),
    )

  const coreRange = packageJson !== null && isObject(packageJson.dependencies) ? packageJson.dependencies[corePackage] : undefined
  const core = resolveDependency(lockfile, corePackage, rangeOf(corePackage, typeof coreRange === 'string' ? coreRange : null))
  // Only a registry entry that really is @open-mercato/core names the version:
  // not a link: or workspace: core, and not an npm alias to another package.
  const coreLine = core ? versionLine(core.version) : null
  if (core && coreLine !== null && isRegistryEntry(core) && descriptorName(core.resolution) === corePackage)
    result.openMercato = { version: core.version, line: coreLine }
  result.enterprise.dependency = entriesNamed(lockfile, enterprisePackage).length > 0
  return result
}
