/**
 * The env diff and the generated root `.env.example` (spec, "Env diff and
 * the generated `.env.example`"). The source is the root `.env.example` of
 * the snapshot; `.env` and every other `.env*` file are denied before any
 * read. A value reaches the generated file only when it is a stock value of
 * its key, or when `--keep-env` names the key, the key does not look secret
 * and the value passes the secret scan. Everything else is emptied.
 *
 * No finding, message or report field holds an env value: findings name the
 * rule, `.env.example`, a line and, for `--keep-env` problems, the key name.
 */
import { type StockMatch, type StockTable, isStockValue, newestStock, stockTable } from '../stock.js'
import type { Finding } from './entries.js'
import { scanSecrets, scanText } from './secrets.js'

export const envExamplePath = '.env.example'

/** A key name `--keep-env` accepts. */
export const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A declared env name the manifest schema accepts (`EnvName` of the catalog). */
const manifestEnvName = /^[A-Z][A-Z0-9_]{1,63}$/
const maxDescriptionLength = 240
const maxLinkLength = 300

export type EnvLine =
  | { kind: 'blank'; line: number; text: string }
  | { kind: 'comment'; line: number; text: string }
  | {
      kind: 'assignment'
      line: number
      text: string
      key: string
      /** The raw text after `=`, trimmed, quotes kept: the form the stock table records. */
      value: string
      commented: boolean
      /** The line up to and including `=`, written alone when the value is emptied. */
      prefix: string
    }
  | { kind: 'dropped'; line: number; text: string }

const activeAssignment = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=)(.*)$/
// A commented assignment needs an upper-case key (spec, Env diff item 1), so
// prose such as `# note=hello` stays a comment.
const commentedAssignment = /^(\s*#\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=)(.*)$/

/**
 * True when `value` is a value the parser can read on one line: unquoted, or
 * one quoted string (single or double, `\"` escapes in double quotes)
 * followed by nothing or by an inline comment.
 */
function readableValue(value: string): boolean {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return true
  for (let index = 1; index < value.length; index++) {
    if (quote === '"' && value[index] === '\\') {
      index++
      continue
    }
    if (value[index] === quote) return /^(?:\s+#.*)?\s*$/.test(value.slice(index + 1))
  }
  return false
}

/**
 * Parses each line of a `.env.example` (spec, Env diff item 1): blank,
 * comment, assignment (`KEY=VALUE`, optional `export `, optional quotes) or
 * commented assignment (`# KEY=VALUE` with an upper-case key). Anything else,
 * such as a multi-line quoted value, is `dropped`.
 */
export function parseEnvLines(text: string): EnvLine[] {
  const lines = text.split(/\r?\n/)
  // The final newline makes an empty last element, which is not a line.
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines.map((raw, index): EnvLine => {
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed === '') return { kind: 'blank', line, text: raw }
    const commented = trimmed.startsWith('#')
    const match = (commented ? commentedAssignment : activeAssignment).exec(raw)
    if (!match) return commented ? { kind: 'comment', line, text: raw } : { kind: 'dropped', line, text: raw }
    const value = match[3].trim()
    if (!readableValue(value)) return { kind: 'dropped', line, text: raw }
    return { kind: 'assignment', line, text: raw, key: match[2], value, commented, prefix: match[1] }
  })
}

/**
 * A secret-looking key (spec, Env diff item 2): it ends in `_SECRET`, `_KEY`,
 * `_TOKEN` or `_PASSWORD`, or has one of those words as an underscore
 * segment, so `DOCUMENTS_COLLAB_JWT_SECRET_V2` counts.
 */
export function isSecretLookingKey(key: string): boolean {
  return key
    .toUpperCase()
    .split('_')
    .some((segment) => ['SECRET', 'KEY', 'TOKEN', 'PASSWORD'].includes(segment))
}

function isEmptyValue(value: string): boolean {
  return value === '' || value === '""' || value === "''"
}

export type DeclaredEnv = { name: string; description?: string; link?: string }

/** `report.env`: key names and line numbers only. */
export type EnvReport = { kept: string[]; emptied: string[]; declared: string[]; dropped: number[] }

export type EnvInput = {
  /** The root `.env.example` of the snapshot, or undefined when the source has none. */
  source: Buffer | undefined
  match: StockMatch
  /** `--keep-env` keys, already checked to be key names. */
  keepEnv: readonly string[]
  /** `env[]` of a `mercato-template.json` in the source app: descriptions and links for keys without a comment. */
  sourceManifestEnv?: ReadonlyMap<string, Omit<DeclaredEnv, 'name'>>
  table?: StockTable
}

export type EnvResult = {
  /** The generated `.env.example`, or null when none is written (no source file and no stock file for the version). */
  content: Buffer | null
  findings: Finding[]
  report: EnvReport
  /** The manifest `env`. */
  declared: DeclaredEnv[]
}

const keepSecretMessage = (key: string) =>
  `--keep-env ${key}: the key looks secret (it has a SECRET, KEY, TOKEN or PASSWORD segment) and its value is not a stock value, so it is not kept. Remove --keep-env ${key}; the value is emptied in the generated .env.example.`
const keepUnknownMessage = (key: string) =>
  `--keep-env ${key}: the root .env.example of the snapshot has no such key, active or commented. Check the name, or add the key to .env.example and commit.`
const droppedMessage =
  'A line the parser cannot read (for example a multi-line quoted value, or text that is neither a comment nor KEY=VALUE). It is dropped from the generated .env.example: a blank line takes its place.'
const undocumentedMessage = (key: string, reason: string) =>
  `${key} is declared by the template (the stock .env.example lacks it) ${reason}. Add a one-line comment directly above it in .env.example, with an https:// link when one helps.`
const missingMessage = (written: boolean) =>
  written
    ? 'The source has no root .env.example. The stock .env.example of the matched create-mercato-app version is written instead; declare the env your template adds in a committed .env.example.'
    : 'The source has no root .env.example, and the Open Mercato version is not in the stock table, so no .env.example is written. Commit a .env.example that lists the env the app needs.'

/**
 * The env diff (spec, Env diff items 1 to 4). Every line keeps its position:
 * a dropped line becomes a blank line, so a finding on the generated file
 * points at the same line of the source. Values that are emptied, and
 * dropped lines, are still checked with the bundled and extra secret rules,
 * and a match is a `secret` finding: a credential committed to `.env.example` is in the app's history
 * even when the template leaves it out.
 */
export function buildEnv(input: EnvInput): EnvResult {
  const table = input.table ?? stockTable
  const report: EnvReport = { kept: [], emptied: [], declared: [], dropped: [] }
  const findings: Finding[] = []
  if (input.source === undefined) {
    for (const key of input.keepEnv)
      findings.push({ rule: 'env-keep-unknown', level: 'error', path: envExamplePath, message: keepUnknownMessage(key) })
    const stock = stockEnvText(input.match, table)
    findings.push({ rule: 'env-example-missing', level: 'warning', path: envExamplePath, message: missingMessage(stock !== null) })
    return { content: stock === null ? null : Buffer.from(stock, 'utf8'), findings, report, declared: [] }
  }

  const text = input.source.toString('utf8')
  const finalNewline = /\r?\n$/.test(text) || text === ''
  const lines = parseEnvLines(text)
  const keep = new Set(input.keepEnv)
  const seenKeys = new Set<string>()
  const output: string[] = []
  /** The source lines whose value is emptied, at their positions, for the secret rules. */
  const emptiedText: string[] = []
  const add = (list: string[], key: string) => {
    if (!list.includes(key)) list.push(key)
  }

  for (const line of lines) {
    emptiedText.push('')
    if (line.kind === 'dropped') {
      report.dropped.push(line.line)
      findings.push({ rule: 'env-line-dropped', level: 'warning', path: envExamplePath, line: line.line, message: droppedMessage })
      emptiedText[emptiedText.length - 1] = line.text
      output.push('')
      continue
    }
    if (line.kind !== 'assignment') {
      output.push(line.text)
      continue
    }
    seenKeys.add(line.key)
    if (isEmptyValue(line.value) || isStockValue(input.match, line.key, line.value)) {
      output.push(line.text)
      continue
    }
    if (keep.has(line.key)) {
      if (isSecretLookingKey(line.key)) {
        findings.push({ rule: 'env-keep-secret', level: 'error', path: envExamplePath, line: line.line, message: keepSecretMessage(line.key) })
      } else {
        const problems = scanText(envExamplePath, line.text).map((finding) => ({ ...finding, line: line.line }))
        if (problems.length === 0) {
          add(report.kept, line.key)
          output.push(line.text)
          continue
        }
        // The scan findings say why; the value is emptied.
        findings.push(...problems)
        add(report.emptied, line.key)
        output.push(line.prefix)
        continue
      }
    }
    add(report.emptied, line.key)
    emptiedText[emptiedText.length - 1] = line.text
    output.push(line.prefix)
  }

  // A value the env diff removes, or a line it drops, is still a committed
  // credential when a secret rule matches it.
  findings.push(...scanSecrets(envExamplePath, emptiedText.join('\n')))
  for (const key of input.keepEnv)
    if (!seenKeys.has(key)) findings.push({ rule: 'env-keep-unknown', level: 'error', path: envExamplePath, message: keepUnknownMessage(key) })

  const declared = declaredEnv(lines, input, table, findings)
  report.declared = declared.map((item) => item.name)
  const content = output.join('\n') + (finalNewline && output.length > 0 ? '\n' : '')
  return { content: Buffer.from(content, 'utf8'), findings, report, declared }
}

/** The stock `.env.example` text of a known version, or null. */
function stockEnvText(match: StockMatch, table: StockTable): string | null {
  if (!match.known) return null
  const hash = match.entries[0].envExample
  return hash === null ? null : table.files[hash]
}

/**
 * Declared env (spec, Env diff item 4): keys, active or commented, that the
 * stock `.env.example` of the matched version lacks (of the newest known
 * version when the version is unknown), in file order. `description` is the
 * comment block directly above the key's first line, joined into one line,
 * with its first `https://` URL moved to `link`.
 */
function declaredEnv(lines: readonly EnvLine[], input: EnvInput, table: StockTable, findings: Finding[]): DeclaredEnv[] {
  const stockKeys = new Set(Object.keys(input.match.known ? input.match.entries[0].env : newestStock(table).entry.env))
  const result: DeclaredEnv[] = []
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    if (line.kind !== 'assignment' || stockKeys.has(line.key) || seen.has(line.key)) return
    seen.add(line.key)
    if (!manifestEnvName.test(line.key)) {
      findings.push({
        rule: 'env-undocumented',
        level: 'warning',
        path: envExamplePath,
        line: line.line,
        message: undocumentedMessage(line.key, 'but its name is not upper case (A-Z, 0-9, _), so the manifest cannot declare it'),
      })
      return
    }
    const fromComment = describe(commentAbove(lines, index))
    // A key with no comment takes the description and link of the source
    // app's mercato-template.json, when it has them.
    const chosen = fromComment.description === undefined && fromComment.link === undefined ? (input.sourceManifestEnv?.get(line.key) ?? {}) : fromComment
    const entry: DeclaredEnv = { name: line.key }
    const { description, link } = chosen
    if (description !== undefined && description.length <= maxDescriptionLength) entry.description = description
    if (link !== undefined && link.length <= maxLinkLength) entry.link = link
    if (entry.description === undefined)
      findings.push({
        rule: 'env-undocumented',
        level: 'warning',
        path: envExamplePath,
        line: line.line,
        message: undocumentedMessage(
          line.key,
          description === undefined ? 'with no comment above it' : `with a comment longer than ${maxDescriptionLength} characters, which the manifest cannot hold`,
        ),
      })
    result.push(entry)
  })
  return result
}

/** The comment lines directly above line `index`, in order, without their `#`. */
function commentAbove(lines: readonly EnvLine[], index: number): string[] {
  const block: string[] = []
  for (let at = index - 1; at >= 0; at--) {
    const line = lines[at]
    if (line.kind !== 'comment') break
    block.unshift(line.text.trim().replace(/^#+\s*/, ''))
  }
  return block
}

const linkPattern = /https:\/\/[^\s<>"'`]+/

/** One line of description and the first `https://` URL, from a comment block. */
export function describe(block: readonly string[]): { description?: string; link?: string } {
  let text = block.join(' ').replace(/\s+/g, ' ').trim()
  let link: string | undefined
  const found = linkPattern.exec(text)
  if (found) {
    link = found[0].replace(/[.,;:!?)\]]+$/, '')
    text = (text.slice(0, found.index) + text.slice(found.index + link.length))
      .replace(/\(\s*\)/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,;!?])/g, '$1')
      .replace(/[\s(:-]+$/, '')
      .trim()
  }
  return { ...(text === '' ? {} : { description: text }), ...(link === undefined ? {} : { link }) }
}

/**
 * The `env[]` of a `mercato-template.json` from the source app, by name:
 * only entries whose fields the manifest schema accepts.
 */
export function sourceManifestEnv(content: Buffer | undefined): Map<string, Omit<DeclaredEnv, 'name'>> {
  const result = new Map<string, Omit<DeclaredEnv, 'name'>>()
  if (content === undefined) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    return result
  }
  const env = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { env?: unknown }).env : undefined
  if (!Array.isArray(env)) return result
  for (const item of env) {
    if (!item || typeof item !== 'object') continue
    const { name, description, link } = item as Record<string, unknown>
    if (typeof name !== 'string' || !manifestEnvName.test(name) || result.has(name)) continue
    const entry: Omit<DeclaredEnv, 'name'> = {}
    if (typeof description === 'string' && description.trim() !== '' && description.length <= maxDescriptionLength) entry.description = description.trim()
    if (typeof link === 'string' && link.startsWith('https://') && link.length <= maxLinkLength) entry.link = link
    result.set(name, entry)
  }
  return result
}
