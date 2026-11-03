import { parseDocument, visit } from 'yaml'

/**
 * Yarn 2+ lockfile reader (spec, Architecture: `src/lockfile.ts`). A Yarn 4
 * `yarn.lock` is YAML: a `__metadata` map, then one map per resolved package,
 * keyed by the descriptors that resolve to it (`"a@npm:^1.0.0, a@npm:^1.2.0"`).
 * The file is parsed with the YAML failsafe schema, so every scalar stays a
 * string (`version: 1.10.0` is never a number), and into Maps, so no key can
 * reach an object prototype. YAML aliases are refused (Yarn never writes
 * them), so an alias bomb cannot expand. Nothing is executed and nothing is
 * fetched.
 */

/** The largest `yarn.lock` the reader parses. Real app lockfiles are a few MB. */
export const maxLockfileBytes = 16 * 1024 * 1024

export type LockEntry = {
  /** The descriptors of the entry key, for example `@open-mercato/core@npm:0.9.0`. */
  descriptors: string[]
  /** The package name, from `resolution`. */
  name: string
  /** `version`, as written. */
  version: string
  /** `resolution`, for example `@open-mercato/core@npm:0.9.0`. */
  resolution: string
  /** The names under `dependencies` and `peerDependencies`. */
  dependencies: string[]
}

export type Lockfile = {
  /** `__metadata.version`: 8 or later for Yarn 4 (10 for Yarn 4.17), 6 for Yarn 3. */
  metadataVersion: string | null
  entries: LockEntry[]
}

/** Thrown when a file is not a readable Yarn 2+ lockfile. The message names the reason, never file content. */
export class LockfileError extends Error {}

/** The package name of a descriptor or locator: everything before the `@` that starts its range (`@scope/name@npm:1` gives `@scope/name`). */
export function descriptorName(descriptor: string): string {
  const at = descriptor.indexOf('@', descriptor.startsWith('@') ? 1 : 0)
  return at <= 0 ? descriptor : descriptor.slice(0, at)
}

/** The range or reference after the name (`@scope/name@npm:1` gives `npm:1`). */
export function descriptorRange(descriptor: string): string {
  const name = descriptorName(descriptor)
  return descriptor.length > name.length ? descriptor.slice(name.length + 1) : ''
}

/**
 * Parses a Yarn 2+ lockfile. Throws a `LockfileError` when the text is not
 * YAML, has no `__metadata` map (a Yarn 1 lockfile, for one), or has an entry
 * without a string `version` and `resolution`.
 */
export function parseLockfile(content: Buffer | string): Lockfile {
  const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length
  if (size > maxLockfileBytes) throw new LockfileError(`it is larger than ${maxLockfileBytes / 1024 / 1024} MB`)
  const text = typeof content === 'string' ? content : content.toString('utf8')
  let root: unknown
  try {
    const document = parseDocument(text, { schema: 'failsafe', uniqueKeys: true, prettyErrors: false })
    if (document.errors.length > 0) throw new LockfileError('it is not valid YAML')
    let alias = false
    visit(document, {
      Alias() {
        alias = true
        return visit.BREAK
      },
    })
    if (alias) throw new LockfileError('it uses YAML aliases, which Yarn never writes')
    root = document.toJS({ mapAsMap: true })
  } catch (caught) {
    if (caught instanceof LockfileError) throw caught
    throw new LockfileError('it is not valid YAML')
  }
  if (!(root instanceof Map)) throw new LockfileError('it is not a YAML map')
  const metadata: unknown = root.get('__metadata')
  if (!(metadata instanceof Map)) throw new LockfileError('it has no __metadata (a Yarn 1 lockfile is not supported)')
  const metadataVersion = metadata.get('version')
  const entries: LockEntry[] = []
  for (const [key, value] of root) {
    if (key === '__metadata') continue
    if (typeof key !== 'string' || !(value instanceof Map)) throw new LockfileError('an entry is not a map')
    const version: unknown = value.get('version')
    const resolution: unknown = value.get('resolution')
    if (typeof version !== 'string' || typeof resolution !== 'string')
      throw new LockfileError('an entry has no version or resolution')
    const dependencies: string[] = []
    for (const field of ['dependencies', 'peerDependencies']) {
      const block: unknown = value.get(field)
      if (block instanceof Map) for (const name of block.keys()) if (typeof name === 'string') dependencies.push(name)
    }
    entries.push({
      descriptors: key.split(',').map((item) => item.trim()).filter((item) => item !== ''),
      name: descriptorName(resolution),
      version,
      resolution,
      dependencies,
    })
  }
  return { metadataVersion: typeof metadataVersion === 'string' ? metadataVersion : null, entries }
}

/**
 * The lockfile descriptor Yarn writes for a `package.json` dependency: a
 * range with no protocol gets `npm:` (`"0.9.0"` gives `name@npm:0.9.0`); a
 * range with one (`workspace:`, `patch:`, `npm:` aliases, URLs) stays as is.
 */
export function lockDescriptor(name: string, range: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(range) ? `${name}@${range}` : `${name}@npm:${range}`
}

/** Every entry whose resolution names `name`. */
export function entriesNamed(lockfile: Lockfile, name: string): LockEntry[] {
  return lockfile.entries.filter((entry) => entry.name === name)
}

/** A descriptor without the `::locator=...` suffix Yarn adds to `patch:`, `file:` and `link:` descriptors. */
export function withoutLocator(descriptor: string): string {
  const at = descriptor.indexOf('::')
  return at >= 0 ? descriptor.slice(0, at) : descriptor
}

/**
 * The entry a `package.json` dependency resolves to. With a range: the entry
 * listing its descriptor, or null when none does (the lockfile does not
 * match `package.json`). With `range` null (no usable range, or a range that
 * `resolutions` overrides): the only entry for the name, else the one with
 * the highest version, or null when the lockfile has no entry for the name.
 */
export function resolveDependency(lockfile: Lockfile, name: string, range: string | null): LockEntry | null {
  if (range !== null) {
    const descriptor = withoutLocator(lockDescriptor(name, range))
    return lockfile.entries.find((entry) => entry.descriptors.some((item) => withoutLocator(item) === descriptor)) ?? null
  }
  const named = entriesNamed(lockfile, name)
  if (named.length === 0) return null
  return [...named].sort((left, right) => compareVersions(right.version, left.version))[0]
}

/**
 * The framework's lockstep set: `@open-mercato/core` and every
 * `@open-mercato/*` name linked to it, in either direction, through the
 * `dependencies` and `peerDependencies` of `@open-mercato/*` entries.
 * `@open-mercato/cache` (a dependency of `shared`) is in it; a package
 * released on its own line that no framework package links, such as
 * `@open-mercato/client`, is not.
 */
export function frameworkNames(lockfile: Lockfile, scope: string, core: string): Set<string> {
  const edges = new Map<string, Set<string>>()
  const link = (left: string, right: string) => edges.set(left, (edges.get(left) ?? new Set()).add(right))
  for (const entry of lockfile.entries) {
    if (!entry.name.startsWith(scope)) continue
    for (const dependency of entry.dependencies)
      if (dependency.startsWith(scope)) {
        link(entry.name, dependency)
        link(dependency, entry.name)
      }
  }
  const found = new Set([core])
  const queue = [core]
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const neighbour of edges.get(next) ?? [])
      if (!found.has(neighbour)) {
        found.add(neighbour)
        queue.push(neighbour)
      }
  return found
}

/** True when the entry was resolved from the registry (`npm:`, or a `patch:` of an npm package), not a workspace or a link. */
export function isRegistryEntry(entry: LockEntry): boolean {
  const reference = descriptorRange(entry.resolution)
  return reference.startsWith('npm:') || reference.startsWith('patch:')
}

/** The `major.minor` line of a version (`0.9.0-canary.1` gives `0.9`), or null when the version has no such prefix. */
export function versionLine(version: string): string | null {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(version)
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

/** Compares versions: numeric `major.minor.patch` first; a release is newer than its prereleases; then the text. */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?/.exec(version)
    return match ? { numbers: [match[1], match[2], match[3]].map(Number), pre: match[4] ?? null } : null
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return a ? 1 : b ? -1 : left.localeCompare(right)
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre.localeCompare(b.pre, 'en', { numeric: true })
}
