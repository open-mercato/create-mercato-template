/**
 * Entry rules of the snapshot (spec, Rule table): entry types, `unsafe-path`,
 * `path-case-collision` and `lfs-pointer`. Each finding names the path, never
 * the content.
 */

export type Level = 'error' | 'warning'

export type Finding = {
  rule: string
  level: Level
  path: string
  line?: number
  ruleId?: string
  message?: string
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The path as text, for reports and messages. A valid UTF-8 path is returned
 * as is; any other byte sequence shows its non-ASCII and control bytes as
 * `\xNN`, so a path Git cannot export as text can still be named.
 */
export function displayPath(path: Buffer): string {
  const text = decodePath(path)
  if (text !== null) return text
  let shown = ''
  for (const byte of path) shown += byte >= 0x20 && byte < 0x7f && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`
  return shown
}

/** The path as UTF-8 text, or null when it is not valid UTF-8. */
export function decodePath(path: Buffer): string | null {
  try {
    return utf8.decode(path)
  } catch {
    return null
  }
}

/**
 * Why a path cannot be exported, or null when it is safe (spec, `snapshotId`):
 * not valid UTF-8, a tab, a newline, a backslash, a NUL, a leading `/`, or a
 * `.` or `..` segment. Safe paths make the `snapshotId` lines unambiguous.
 */
export function unsafePathReason(path: Buffer): string | null {
  const text = decodePath(path)
  if (text === null) return 'not valid UTF-8'
  if (text.length === 0) return 'empty'
  if (text.includes('\t')) return 'a tab'
  if (text.includes('\n')) return 'a newline'
  if (text.includes('\\')) return 'a backslash'
  if (text.includes('\0')) return 'a NUL byte'
  if (text.startsWith('/')) return 'a leading /'
  if (text.split('/').some((segment) => segment === '.' || segment === '..' || segment === ''))
    return 'a ., .. or empty segment'
  return null
}

export const regularModes = { file: '100644', executable: '100755' } as const

/**
 * The rule for a tree entry that is not a regular file, or null for a regular
 * file. Mode `120000` is a symlink, `160000` (type `commit`) a submodule.
 */
export function treeEntryRule(mode: string, type: string): 'entry-symlink' | 'entry-submodule' | 'entry-special' | null {
  if (mode === '120000') return 'entry-symlink'
  if (mode === '160000' || type === 'commit') return 'entry-submodule'
  if (type === 'blob' && /^100[0-7]{3}$/.test(mode)) return null
  return 'entry-special'
}

/** The export mode of a regular tree entry: `100755` when the owner exec bit is set, else `100644`. */
export function exportMode(mode: string): '100644' | '100755' {
  return (parseInt(mode.slice(3), 8) & 0o100) !== 0 ? regularModes.executable : regularModes.file
}

const lfsHeader = Buffer.from('version https://git-lfs.github.com/spec/v1', 'utf8')

/** True for a Git LFS pointer: `filter=lfs`, or content that starts with the pointer header. */
export function isLfsPointer(content: Buffer, filter: string | null): boolean {
  return filter === 'lfs' || content.subarray(0, lfsHeader.length).equals(lfsHeader)
}

/**
 * `path-case-collision` findings: every path that equals another one when
 * lower-cased (they would overwrite each other on macOS and Windows).
 */
export function caseCollisions(paths: readonly string[]): Finding[] {
  const groups = new Map<string, string[]>()
  for (const item of paths) {
    const key = item.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const findings: Finding[] = []
  for (const group of groups.values())
    if (group.length > 1) for (const item of group) findings.push({ rule: 'path-case-collision', level: 'error', path: item })
  return findings
}
