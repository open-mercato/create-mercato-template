import { parseDocument } from 'yaml'

/**
 * Yarn 2+ lockfile reader (spec, Architecture: `src/lockfile.ts`). A Yarn 4
 * `yarn.lock` is YAML: a `__metadata` map, then one map per resolved package,
 * keyed by the descriptors that resolve to it (`"a@npm:^1.0.0, a@npm:^1.2.0"`).
 * The file is parsed with the YAML failsafe schema, so every scalar stays a
 * string (`version: 1.10.0` is never a number), and into Maps, so no key can
 * reach an object prototype. Nothing is executed and nothing is fetched.
 */

export type LockEntry = {
  /** The descriptors of the entry key, for example `@open-mercato/core@npm:0.9.0`. */
  descriptors: string[]
  /** The package name, from `resolution`. */
  name: string
  /** `version`, as written. */
  version: string
  /** `resolution`, for example `@open-mercato/core@npm:0.9.0`. */
  resolution: string
}

export type Lockfile = {
  /** `__metadata.version`: 8 for Yarn 4, 6 for Yarn 3. */
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
  const text = typeof content === 'string' ? content : content.toString('utf8')
  const document = parseDocument(text, { schema: 'failsafe', uniqueKeys: true, prettyErrors: false })
  if (document.errors.length > 0) throw new LockfileError('it is not valid YAML')
  const root: unknown = document.toJS({ mapAsMap: true })
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
    entries.push({
      descriptors: key.split(',').map((item) => item.trim()).filter((item) => item !== ''),
      name: descriptorName(resolution),
      version,
      resolution,
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

/**
 * The entry a dependency resolves to: the entry listing its descriptor, else
 * the only entry for the name, else the entry with the highest version, or
 * null when the lockfile has no entry for the name.
 */
export function resolveDependency(lockfile: Lockfile, name: string, range: string | null): LockEntry | null {
  if (range !== null) {
    const descriptor = lockDescriptor(name, range)
    const exact = lockfile.entries.find((entry) => entry.descriptors.includes(descriptor))
    if (exact) return exact
  }
  const named = entriesNamed(lockfile, name)
  if (named.length === 0) return null
  return [...named].sort((left, right) => compareVersions(right.version, left.version))[0]
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
