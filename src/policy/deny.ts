/**
 * The deny list of the catalog spec (File policy, check 3), held as data.
 * Denied paths are excluded before any read, counted and listed in
 * `report.excluded`; they are not findings.
 *
 * Matching (spec, "Deny list"):
 * - an entry is anchored at the repo root unless it starts with `**` and a slash;
 * - a trailing `/` matches a directory and everything below it;
 * - `*` matches within one path segment;
 * - as in `.gitignore`, an entry that matches a directory excludes everything
 *   below it, so `/.mercato/*` excludes `.mercato/a/b`.
 *
 * Only the root `.env.example` is excepted from the `.env*` entry (spec Step
 * 8): `prepare` never exports it as it is, but regenerates it through the env
 * diff (`src/policy/env.ts`). A `.env.example` below the root is excluded
 * like any other `.env*` file, with the warning `nested-env-example`.
 */
export const denyList: readonly string[] = [
  '**/.env*',
  '/.mercato/*',
  '**/node_modules/',
  '/.yarn/cache/',
  '/.yarn/install-state.gz',
  '/public/uploads/',
  '/storage/',
  '/data/',
  '**/*.pem',
  '**/.npmrc',
  '**/.mcp.json',
  '**/.claude/',
  '**/.codex/',
  '/.cursor/mcp.json',
  '/.playwright-mcp',
  '/.agents/skills/',
  '/skills-lock.json',
  '/.ai/framework-context/',
  '/.ai/harness/results/',
  '/.ai/sessions*.json',
  '/.ai/session-exports/',
  '/.ai/qa/test-env*',
  '/.ai/qa/artifacts_*/',
  '/.ai/qa/ephemeral*',
  '/.ai/scripts/test-env-*',
  '/.ai/.gate-state.json',
]

type Matcher = { anywhere: boolean; directoryOnly: boolean; segments: RegExp[] }

function segmentPattern(segment: string): RegExp {
  const source = segment
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${source}$`)
}

function compile(entry: string): Matcher {
  const anywhere = entry.startsWith('**/')
  const body = anywhere ? entry.slice(3) : entry.replace(/^\//, '')
  const directoryOnly = body.endsWith('/')
  const segments = body.replace(/\/$/, '').split('/').map(segmentPattern)
  return { anywhere, directoryOnly, segments }
}

const compiled = denyList.map((entry) => ({ entry, matcher: compile(entry) }))

function matchesAt(matcher: Matcher, parts: readonly string[], start: number): boolean {
  const end = start + matcher.segments.length
  // The match must leave at least one more segment when the entry names a
  // directory only (a trailing `/`): then the matched part is a directory.
  if (matcher.directoryOnly ? end >= parts.length : end > parts.length) return false
  return matcher.segments.every((pattern, offset) => pattern.test(parts[start + offset]))
}

/** True when `entry` excludes the repo-relative `path` (forward slashes). */
export function denyEntryMatches(entry: string, path: string): boolean {
  return matches(compile(entry), path.split('/'))
}

function matches(matcher: Matcher, parts: readonly string[]): boolean {
  if (!matcher.anywhere) return matchesAt(matcher, parts, 0)
  for (let start = 0; start < parts.length; start++) if (matchesAt(matcher, parts, start)) return true
  return false
}

/** The one path excepted from the `.env*` entry: it is regenerated, never exported as it is. */
export const rootEnvExample = '.env.example'

/** The first deny list entry that excludes `path`, or null. */
export function deniedBy(path: string): string | null {
  const parts = path.split('/')
  for (const { entry, matcher } of compiled) {
    if (entry === '**/.env*' && path === rootEnvExample) continue
    if (matches(matcher, parts)) return entry
  }
  return null
}
