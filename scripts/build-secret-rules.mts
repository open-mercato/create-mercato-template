// Generates src/rules/gitleaks.json, the bundled gitleaks rules (spec, Secret
// scan, "Bundled gitleaks rules"), from gitleaks config/gitleaks.toml at a
// pinned tag, checked against the pinned sha256 of the file. Release-time tool
// for maintainers; never shipped and never run by tests against the network.
//
//   npm run secret-rules              fetch the pinned file and write the rules
//   npm run secret-rules -- --check   only compare; exit 1 when the committed file differs
//   npm run secret-rules -- --input <file>   read a local copy instead of fetching
//
// It runs with Node's type stripping and imports nothing from src/ but types.
// TOML is read by the small strict reader below, for the subset gitleaks.toml
// uses, so no TOML parser is a dependency. Rules left out are listed, each
// with a reason, in the committed scripts/secret-rules-skipped.json; any other
// rule the converter cannot translate fails the build.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BundledAllowlist, BundledRule, BundledRules, ConvertedRegex, RulesSource, SkippedRule } from '../src/rules/gitleaks.ts'

export const gitleaksSource: RulesSource = {
  name: 'gitleaks',
  tag: 'v8.30.1',
  path: 'config/gitleaks.toml',
  sha256: 'e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf',
}
export const gitleaksUrl = `https://raw.githubusercontent.com/gitleaks/gitleaks/${gitleaksSource.tag}/${gitleaksSource.path}`
export const defaultRulesPath = fileURLToPath(new URL('../src/rules/gitleaks.json', import.meta.url))
export const defaultSkippedPath = fileURLToPath(new URL('./secret-rules-skipped.json', import.meta.url))

/** The build fails when any of these is missing from the converted rules (spec). */
export const requiredRuleIds = [
  'private-key',
  'aws-access-token',
  'github-pat',
  'github-fine-grained-pat',
  'github-oauth',
  'github-app-token',
  'github-refresh-token',
  'npm-access-token',
  'openai-api-key',
  'stripe-access-token',
  'slack-bot-token',
  'slack-user-token',
  'slack-app-token',
  'slack-webhook-url',
] as const

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

// ---------------------------------------------------------------------------
// TOML: a strict reader for the subset gitleaks.toml uses. Comments, bare keys,
// `[table]` and `[[array.of.tables]]` headers, basic, literal and multi-line
// strings, integers, floats, booleans and arrays. Anything else (dotted or
// quoted keys, inline tables, dates) is an error with its line, never a guess.
// ---------------------------------------------------------------------------

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export type TomlTable = { [key: string]: TomlValue }

export class TomlError extends Error {}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = Object.create(null)
  let current: TomlTable = root
  let position = 0
  let line = 1

  const fail = (message: string): never => {
    throw new TomlError(`TOML line ${line}: ${message}`)
  }
  const peek = (offset = 0) => text[position + offset]
  const startsWith = (token: string) => text.startsWith(token, position)
  const advance = (count = 1) => {
    for (let index = 0; index < count; index++) if (text[position++] === '\n') line++
  }
  const skipSpaces = () => {
    while (peek() === ' ' || peek() === '\t') advance()
  }
  const skipComment = () => {
    if (peek() === '#') while (position < text.length && peek() !== '\n') advance()
  }
  /** Spaces, comments and line breaks: inside arrays only. */
  const skipBlank = () => {
    for (;;) {
      skipSpaces()
      skipComment()
      if (peek() === '\n') advance()
      else if (startsWith('\r\n')) advance(2)
      else return
    }
  }
  const endOfLine = () => {
    skipSpaces()
    skipComment()
    if (position >= text.length) return
    if (peek() === '\n') return advance()
    if (startsWith('\r\n')) return advance(2)
    fail(`unexpected ${JSON.stringify(peek())} after a value`)
  }
  const bareKey = (): string => {
    const match = /^[A-Za-z0-9_-]+/.exec(text.slice(position, position + 256))
    if (!match) fail('expected a bare key (quoted and dotted keys are not supported)')
    advance(match![0].length)
    return match![0]
  }
  const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  const basicString = (multiline: boolean): string => {
    let value = ''
    if (multiline && peek() === '\n') advance()
    else if (multiline && startsWith('\r\n')) advance(2)
    for (;;) {
      if (position >= text.length) fail('unterminated string')
      if (multiline ? startsWith('"""') : peek() === '"') {
        advance(multiline ? 3 : 1)
        return value
      }
      const character = peek()
      if (!multiline && character === '\n') fail('line break in a string')
      if (character === '\\') {
        const next = peek(1)
        if (next in escapes) {
          value += escapes[next]
          advance(2)
        } else if (next === 'u' || next === 'U') {
          const length = next === 'u' ? 4 : 8
          const hex = text.slice(position + 2, position + 2 + length)
          if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) fail('bad unicode escape')
          value += String.fromCodePoint(Number.parseInt(hex, 16))
          advance(2 + length)
        } else fail(`unsupported escape \\${next ?? ''} in a string`)
        continue
      }
      value += character
      advance()
    }
  }
  const literalString = (multiline: boolean): string => {
    const close = multiline ? "'''" : "'"
    let start = position
    if (multiline && peek() === '\n') start = position + 1
    else if (multiline && startsWith('\r\n')) start = position + 2
    let end = text.indexOf(close, start)
    if (end < 0) fail('unterminated string')
    // Up to two quotes right before the closing ''' belong to the string.
    for (let extra = 0; multiline && extra < 2 && text[end + 3] === "'"; extra++) end++
    const value = text.slice(start, end)
    if (!multiline && value.includes('\n')) fail('line break in a string')
    advance(end + close.length - position)
    return value
  }
  const value = (): TomlValue => {
    if (startsWith("'''")) return advance(3), literalString(true)
    if (peek() === "'") return advance(), literalString(false)
    if (startsWith('"""')) return advance(3), basicString(true)
    if (peek() === '"') return advance(), basicString(false)
    if (peek() === '[') {
      advance()
      const items: TomlValue[] = []
      for (;;) {
        skipBlank()
        if (peek() === ']') return advance(), items
        items.push(value())
        skipBlank()
        if (peek() === ',') advance()
        else if (peek() !== ']') fail('expected , or ] in an array')
      }
    }
    if (startsWith('true') && !/[A-Za-z0-9_]/.test(peek(4) ?? '')) return advance(4), true
    if (startsWith('false') && !/[A-Za-z0-9_]/.test(peek(5) ?? '')) return advance(5), false
    const number = /^[+-]?(?:0|[1-9](?:_?[0-9])*)(\.[0-9](?:_?[0-9])*)?(?![0-9A-Za-z_.:-])/.exec(text.slice(position, position + 64))
    if (number) {
      advance(number[0].length)
      return Number(number[0].replaceAll('_', ''))
    }
    return fail('unsupported value (inline tables, dates and special numbers are not supported)')
  }
  const define = (table: TomlTable, key: string, item: TomlValue) => {
    if (Object.hasOwn(table, key)) fail(`duplicate key ${key}`)
    table[key] = item
  }
  const header = () => {
    const array = startsWith('[[')
    advance(array ? 2 : 1)
    skipSpaces()
    const path = [bareKey()]
    for (;;) {
      skipSpaces()
      if (peek() !== '.') break
      advance()
      skipSpaces()
      path.push(bareKey())
    }
    if (array ? !startsWith(']]') : peek() !== ']') fail('unterminated table header')
    advance(array ? 2 : 1)
    endOfLine()
    let table = root
    for (const part of path.slice(0, -1)) {
      let next = table[part]
      if (Array.isArray(next)) next = next[next.length - 1]
      if (next === undefined) next = table[part] = Object.create(null) as TomlTable
      if (!isTable(next)) fail(`${part} is not a table`)
      table = next as TomlTable
    }
    const last = path[path.length - 1]
    if (array) {
      const list = (table[last] ??= [])
      if (!Array.isArray(list) || list.some((item) => !isTable(item))) fail(`${last} is not an array of tables`)
      const fresh: TomlTable = Object.create(null)
      ;(list as TomlTable[]).push(fresh)
      current = fresh
    } else {
      if (Object.hasOwn(table, last)) fail(`table ${path.join('.')} is defined twice`)
      current = table[last] = Object.create(null) as TomlTable
    }
  }

  while (position < text.length) {
    skipBlank()
    if (position >= text.length) break
    if (peek() === '[') {
      header()
      continue
    }
    const key = bareKey()
    skipSpaces()
    if (peek() !== '=') fail(`expected = after ${key}`)
    advance()
    skipSpaces()
    define(current, key, value())
    endOfLine()
  }
  return root
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Regex: Go RE2 syntax to a JavaScript source and flags for `new RegExp`.
// The pattern is walked token by token. A construct with no translation
// below fails the conversion; nothing is passed through unchecked, because
// JavaScript reads some RE2 escapes (such as `\z`) silently as a letter.
// ---------------------------------------------------------------------------

export class ConversionError extends Error {}

const posixClasses: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7f',
  blank: '\\t ',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-\\/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
}

/** Escapes with the same meaning in RE2 and in a JavaScript regex without the `u` flag. */
const sharedEscapes = new Set(['d', 'D', 'w', 'W', 'f', 'n', 'r', 't', 'v'])
/** Escapes that stand for a set of characters: never the end of a class range in RE2. */
const setEscapes = new Set(['d', 'D', 'w', 'W', 's', 'S'])
/**
 * RE2's `\s` is `[\t\n\f\r ]`. JavaScript's also has `\v` and the Unicode
 * spaces (U+00A0, U+FEFF, U+2028 and more), so both are spelled out: as a
 * class outside a class, and as members inside one (`\S` as the ranges of
 * every other UTF-16 unit).
 */
const spaceEscapes: Record<'s' | 'S', { alone: string; member: string }> = {
  s: { alone: '[\\t\\n\\f\\r ]', member: '\\t\\n\\f\\r ' },
  S: { alone: '[^\\t\\n\\f\\r ]', member: '\\x00-\\x08\\x0b\\x0e-\\x1f!-\\uffff' },
}
const punctuation = /[!-/:-@[-`{-~]/

type Frame = {
  /** RE2 `s` state when the group opened, restored at its `)`. */
  dotAll: boolean
  /** Modifier groups opened by a `(?i)` inside this group: closed at `|` and at `)`, reopened after `|`. */
  scoped: string[]
}

/**
 * Converts one RE2 pattern. A leading `(?i)` becomes the `i` flag; `i`
 * elsewhere becomes a JavaScript modifier group (`(?i:...)`, `(?-i:...)`),
 * which Node 24 supports. RE2's `m` is refused: JavaScript's `^` and `$`
 * under `m` also stop at `\r`, U+2028 and U+2029. RE2's `s` is applied to each dot
 * instead of becoming a flag: a dot is `[\s\S]` where `s` is on and `[^\n]`
 * where it is off, because a JavaScript dot also stops at `\r`, `\u2028` and
 * `\u2029` and RE2's does not. `\z` is `$(?![\s\S])`, `\A` is `(?<![\s\S])`,
 * `(?P<name>` is `(?<name>`, a POSIX class is its ASCII ranges, and a `]`
 * first in a class (a literal in RE2) is escaped. `\s` and `\S` are spelled
 * out as RE2's ASCII set (see `spaceEscapes`).
 *
 * Known differences that remain: without the `u` flag JavaScript works on
 * UTF-16 units, so a dot or a negated class matches half of a character
 * outside the BMP, and `(?i)` does not fold K with U+212A or s with U+017F as
 * RE2 does. gitleaks v8.30.1 is plain ASCII, so no rule relies on either.
 */
export function convertRegex(pattern: string): ConvertedRegex {
  let index = 0
  let flags = ''
  let out = ''
  const stack: Frame[] = [{ dotAll: false, scoped: [] }]
  const fail = (message: string): never => {
    throw new ConversionError(`${message} at offset ${index}`)
  }
  const top = () => stack[stack.length - 1]

  /** Parses `(?flags` from `index` (after `(?`). Returns the on and off letters. */
  const readFlags = (): { on: string; off: string } => {
    let on = ''
    let off = ''
    let negative = false
    while (index < pattern.length && /[A-Za-z-]/.test(pattern[index])) {
      const letter = pattern[index++]
      if (letter === '-') {
        if (negative) fail('a repeated - in a flag group')
        negative = true
      } else if (!'is'.includes(letter)) fail(`the RE2 flag ${letter} has no translation`)
      else if (negative) off += letter
      else on += letter
    }
    if (on === '' && off === '') fail('an empty flag group')
    return { on, off }
  }
  const modifier = (on: string, off: string): string => {
    const add = on.replace('s', '')
    const remove = off.replace('s', '')
    return add === '' && remove === '' ? '(?:' : `(?${add}${remove ? `-${remove}` : ''}:`
  }

  // A leading flag group applies to the whole pattern.
  const leading = /^\(\?([is]+)\)/.exec(pattern)
  if (leading) {
    for (const letter of leading[1]) {
      if (letter === 's') stack[0].dotAll = true
      else if (!flags.includes(letter)) flags += letter
    }
    index = leading[0].length
  }

  while (index < pattern.length) {
    const character = pattern[index]
    if (character === '\\') {
      out += escape(false)
      continue
    }
    if (character === '[') {
      out += characterClass()
      continue
    }
    if (character === '.') {
      out += top().dotAll ? '[\\s\\S]' : '[^\\n]'
      index++
      continue
    }
    if (character === '|') {
      const frame = top()
      out += ')'.repeat(frame.scoped.length) + '|' + frame.scoped.join('')
      index++
      continue
    }
    if (character === ')') {
      if (stack.length === 1) fail('an unbalanced )')
      const frame = stack.pop()!
      out += ')'.repeat(frame.scoped.length) + ')'
      index++
      continue
    }
    if (character === '(') {
      index++
      const frame: Frame = { dotAll: top().dotAll, scoped: [] }
      if (pattern[index] !== '?') {
        out += '('
        stack.push(frame)
        continue
      }
      index++
      if (pattern[index] === ':') {
        index++
        out += '(?:'
        stack.push(frame)
        continue
      }
      if (pattern.startsWith('P<', index) || (pattern[index] === '<' && /[A-Za-z_]/.test(pattern[index + 1] ?? ''))) {
        if (pattern[index] === 'P') index++
        const name = /^<([A-Za-z_][A-Za-z0-9_]*)>/.exec(pattern.slice(index))
        if (!name) fail('a bad group name')
        index += name![0].length
        out += `(?<${name![1]}>`
        stack.push(frame)
        continue
      }
      if ('=!'.includes(pattern[index]) || pattern.startsWith('<=', index) || pattern.startsWith('<!', index))
        fail('a lookaround, which RE2 does not have')
      const { on, off } = readFlags()
      if (pattern[index] === ')') {
        // `(?i)` inside the pattern: the flags hold to the end of the
        // enclosing group, across its `|` branches, as in RE2.
        index++
        const current = top()
        if (on.includes('s')) current.dotAll = true
        if (off.includes('s')) current.dotAll = false
        const open = modifier(on, off)
        if (open !== '(?:') {
          out += open
          current.scoped.push(open)
        }
        continue
      }
      if (pattern[index] !== ':') fail('a group syntax RE2 does not have (lookaround or a conditional)')
      index++
      if (on.includes('s')) frame.dotAll = true
      if (off.includes('s')) frame.dotAll = false
      out += modifier(on, off)
      stack.push(frame)
      continue
    }
    out += character
    index++
  }
  if (stack.length !== 1) fail('an unclosed (')
  out += ')'.repeat(stack[0].scoped.length)

  try {
    new RegExp(out, flags)
  } catch (error) {
    throw new ConversionError(`the converted pattern does not compile: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { source: out, flags }

  /** One escape at `index`, inside or outside a class. */
  function escape(inClass: boolean): string {
    const next = pattern[index + 1]
    if (next === undefined) fail('a trailing backslash')
    if (sharedEscapes.has(next)) {
      index += 2
      return `\\${next}`
    }
    if (next === 's' || next === 'S') {
      index += 2
      return inClass ? spaceEscapes[next].member : spaceEscapes[next].alone
    }
    if (!inClass && (next === 'b' || next === 'B')) {
      index += 2
      return `\\${next}`
    }
    if (next === 'x') {
      const hex = /^[0-9A-Fa-f]{2}/.exec(pattern.slice(index + 2))
      if (!hex) fail('a \\x escape other than two hex digits')
      index += 4
      return `\\x${hex![0]}`
    }
    if (!inClass && next === 'z') {
      index += 2
      return '$(?![\\s\\S])'
    }
    if (!inClass && next === 'A') {
      index += 2
      return '(?<![\\s\\S])'
    }
    if (punctuation.test(next)) {
      index += 2
      return `\\${next}`
    }
    return fail(`the escape \\${next} has no translation`)
  }

  /**
   * In RE2 a `-` right after a set in a class (`[\s-x]`) is a literal. Once
   * the set is spelled out it ends in a single character, which JavaScript
   * would take as the start of a range, so the dash is escaped.
   */
  function literalDashAfterSet(): string {
    if (pattern[index] !== '-' || pattern[index + 1] === ']') return ''
    index++
    return '\\-'
  }

  /** A bracket class at `index`. */
  function characterClass(): string {
    index++
    let result = '['
    if (pattern[index] === '^') {
      result += '^'
      index++
    }
    // In RE2 a `]` first in a class is a literal; in JavaScript `[]` and `[^]` are complete classes.
    if (pattern[index] === ']') {
      result += '\\]'
      index++
    }
    for (;;) {
      if (index >= pattern.length) fail('an unclosed [')
      const character = pattern[index]
      if (character === ']') {
        index++
        return `${result}]`
      }
      if (character === '[' && pattern[index + 1] === ':') {
        const posix = /^\[:(\^?)([a-z]+):\]/.exec(pattern.slice(index))
        if (!posix) fail('a bad POSIX class')
        if (posix![1] === '^') fail('a negated POSIX class has no translation')
        const ranges = posixClasses[posix![2]]
        if (ranges === undefined) fail(`the POSIX class ${posix![2]} is unknown`)
        result += ranges
        index += posix![0].length
        result += literalDashAfterSet()
        continue
      }
      if (character === '[') {
        result += '\\['
        index++
        continue
      }
      if (character === '\\') {
        const set = setEscapes.has(pattern[index + 1] ?? '')
        result += escape(true)
        if (set) result += literalDashAfterSet()
        continue
      }
      // `a-\d` or `a-[:digit:]`: RE2 refuses a set as the end of a range;
      // JavaScript would read the dash as a literal.
      if (
        character === '-' &&
        result !== '[' &&
        result !== '[^' &&
        ((pattern[index + 1] === '\\' && setEscapes.has(pattern[index + 2])) || pattern.startsWith('[:', index + 1))
      )
        fail('a class range that ends in a set')
      result += character
      index++
    }
  }
}

// ---------------------------------------------------------------------------
// Rules: gitleaks config to the bundled form.
// ---------------------------------------------------------------------------

const ruleKeys = new Set(['id', 'description', 'regex', 'secretGroup', 'entropy', 'keywords', 'path', 'tags', 'allowlists'])
const allowlistKeys = new Set(['description', 'condition', 'regexTarget', 'regexes', 'paths', 'stopwords'])
const topKeys = new Set(['title', 'minVersion', 'allowlist', 'rules'])

function stringList(value: TomlValue | undefined, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new ConversionError(`${what} is not a list of strings`)
  return value as string[]
}

function convertAt(pattern: TomlValue | undefined, what: string): ConvertedRegex {
  if (typeof pattern !== 'string') throw new ConversionError(`${what} is not a string`)
  try {
    return convertRegex(pattern)
  } catch (error) {
    if (error instanceof ConversionError) throw new ConversionError(`${what}: ${error.message}`)
    throw error
  }
}

/**
 * One rule allowlist, or null when nothing of it applies to a snapshot. Its
 * `paths` are kept only under `condition = "AND"`, where they narrow it; an
 * allowlist with only paths (or with an `OR` that would exempt whole files)
 * is dropped, so every exported file is scanned (spec).
 */
function convertAllowlist(table: TomlValue, what: string): BundledAllowlist | null {
  if (!isTable(table)) throw new ConversionError(`${what} is not a table`)
  for (const key of Object.keys(table)) if (!allowlistKeys.has(key)) throw new ConversionError(`${what} has the unsupported key ${key}`)
  const condition = table.condition ?? 'OR'
  if (condition !== 'OR' && condition !== 'AND') throw new ConversionError(`${what} has the condition ${String(condition)}`)
  const regexTarget = table.regexTarget ?? 'secret'
  if (regexTarget !== 'secret' && regexTarget !== 'match' && regexTarget !== 'line')
    throw new ConversionError(`${what} has the regexTarget ${String(regexTarget)}`)
  const regexes = stringList(table.regexes, `${what} regexes`).map((pattern, index) => convertAt(pattern, `${what} regexes[${index}]`))
  const stopwords = stringList(table.stopwords, `${what} stopwords`)
  const paths = stringList(table.paths, `${what} paths`).map((pattern, index) => convertAt(pattern, `${what} paths[${index}]`))
  if (regexes.length === 0 && stopwords.length === 0) return null
  return condition === 'AND' && paths.length > 0
    ? { condition, regexTarget, regexes, stopwords, paths }
    : { condition, regexTarget, regexes, stopwords }
}

/** One rule. Throws a `ConversionError` naming the rule and the construct. */
export function convertRule(table: TomlValue): BundledRule {
  if (!isTable(table)) throw new ConversionError('a rule is not a table')
  const id = table.id
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ConversionError(`a rule has no valid id`)
  for (const key of Object.keys(table)) if (!ruleKeys.has(key)) throw new ConversionError(`${id}: the unsupported key ${key}`)
  const regex = table.regex === undefined ? null : convertAt(table.regex, `${id} regex`)
  const path = table.path === undefined ? null : convertAt(table.path, `${id} path`)
  if (regex === null && path === null) throw new ConversionError(`${id}: neither regex nor path`)
  const secretGroup = table.secretGroup ?? 0
  if (typeof secretGroup !== 'number' || !Number.isInteger(secretGroup) || secretGroup < 0)
    throw new ConversionError(`${id}: secretGroup is not a whole number`)
  const entropy = table.entropy ?? null
  if (entropy !== null && (typeof entropy !== 'number' || !(entropy >= 0))) throw new ConversionError(`${id}: entropy is not a number`)
  const keywords = stringList(table.keywords, `${id} keywords`)
  stringList(table.tags, `${id} tags`)
  const allowlistTables = table.allowlists ?? []
  if (!Array.isArray(allowlistTables)) throw new ConversionError(`${id}: allowlists is not a list`)
  const allowlists = allowlistTables
    .map((allowlist, index) => convertAllowlist(allowlist, `${id} allowlists[${index}]`))
    .filter((allowlist): allowlist is BundledAllowlist => allowlist !== null)
  return { id, regex, secretGroup, entropy, keywords, path, allowlists }
}

/** Reads and checks scripts/secret-rules-skipped.json: `[{id, reason}]`, ids unique, reasons non-empty. */
export function parseSkipped(text: string): SkippedRule[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('secret-rules-skipped.json is not a list.')
  const seen = new Set<string>()
  return parsed.map((entry, index) => {
    const { id, reason } = (entry ?? {}) as { id?: unknown; reason?: unknown }
    if (typeof id !== 'string' || id === '' || typeof reason !== 'string' || reason.trim() === '' || Object.keys(entry).length !== 2)
      throw new Error(`secret-rules-skipped.json entry ${index} is not {"id": "...", "reason": "..."} with a reason.`)
    if (seen.has(id)) throw new Error(`secret-rules-skipped.json lists ${id} twice.`)
    seen.add(id)
    return { id, reason }
  })
}

/**
 * Converts a gitleaks config. Fails when a rule cannot be converted and is
 * not listed in `skipped`, when `skipped` lists an id the config lacks or a
 * rule that converts, and
 * when a required id is missing from the result. Rules keep their order in
 * the config; the global allowlist is dropped.
 */
export function buildSecretRules(toml: string, skipped: SkippedRule[], source: RulesSource = gitleaksSource): BundledRules {
  const config = parseToml(toml)
  for (const key of Object.keys(config)) if (!topKeys.has(key)) throw new Error(`The config has the unsupported top-level key ${key}.`)
  const tables = config.rules
  if (!Array.isArray(tables) || tables.length === 0) throw new Error('The config has no [[rules]].')
  const skippedIds = new Map(skipped.map((entry) => [entry.id, entry.reason]))
  const rules: BundledRule[] = []
  const failures: string[] = []
  const ids = new Set<string>()
  for (const table of tables) {
    const id = isTable(table) && typeof table.id === 'string' ? table.id : null
    if (id !== null && ids.has(id)) throw new Error(`The config defines the rule ${id} twice.`)
    if (id !== null) ids.add(id)
    if (id !== null && skippedIds.has(id)) {
      // A listed rule that now converts would stay out silently after a
      // gitleaks upgrade: the maintainer removes it from the list instead.
      let converts = true
      try {
        convertRule(table)
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error
        converts = false
      }
      if (converts) throw new Error(`scripts/secret-rules-skipped.json lists ${id}, which converts; remove it from the list.`)
      continue
    }
    try {
      rules.push(convertRule(table))
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error
      failures.push(error.message)
    }
  }
  if (failures.length > 0)
    throw new Error(
      `${failures.length} rule(s) cannot be converted. Fix the converter, or list the id with a reason in scripts/secret-rules-skipped.json:\n  ${failures.join('\n  ')}`,
    )
  const stale = [...skippedIds.keys()].filter((id) => !ids.has(id))
  if (stale.length > 0) throw new Error(`scripts/secret-rules-skipped.json lists ids the config does not have: ${stale.join(', ')}.`)
  const converted = new Set(rules.map((rule) => rule.id))
  const missing = requiredRuleIds.filter((id) => !converted.has(id))
  if (missing.length > 0) throw new Error(`Required rule(s) missing from the converted rules: ${missing.join(', ')}.`)
  return {
    schema: 1,
    source,
    count: rules.length,
    skipped: [...skipped].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    rules,
  }
}

/** The committed form: two spaces, a final newline, every non-ASCII character escaped. */
export function serializeSecretRules(rules: BundledRules): string {
  const json = JSON.stringify(rules, null, 2).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  return `${json}\n`
}

/** Fetches the pinned config. Network: a maintainer's run only. */
export async function fetchGitleaksConfig(url: string = gitleaksUrl): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}.`)
  return await response.text()
}

/** The command line. Returns the exit code: 0 done, 1 failed or differs (`--check`), 2 usage. */
export async function main(
  argv: string[],
  options: {
    fetchConfig?: () => Promise<string>
    source?: RulesSource
    rulesPath?: string
    skippedPath?: string
  } = {},
): Promise<number> {
  let check = false
  let input: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--check' && !check) check = true
    else if (argument === '--input' && input === null && argv[index + 1] !== undefined) input = argv[++index]
    else {
      console.error(`Unknown or repeated argument: ${argument}. Usage: build-secret-rules.mts [--check] [--input <gitleaks.toml>]`)
      return 2
    }
  }
  const source = options.source ?? gitleaksSource
  const rulesPath = options.rulesPath ?? defaultRulesPath
  const toml = input !== null ? readFileSync(input, 'utf8') : await (options.fetchConfig ?? (() => fetchGitleaksConfig()))()
  const actual = sha256(Buffer.from(toml, 'utf8'))
  if (actual !== source.sha256) {
    console.error(`${source.path} at ${source.tag} has sha256 ${actual}, not the pinned ${source.sha256}. Nothing was written.`)
    return 1
  }
  const skipped = parseSkipped(readFileSync(options.skippedPath ?? defaultSkippedPath, 'utf8'))
  const serialized = serializeSecretRules(buildSecretRules(toml, skipped, source))
  if (check) {
    let committed: string | null = null
    try {
      committed = readFileSync(rulesPath, 'utf8')
    } catch {}
    if (committed === serialized) {
      console.log(`${rulesPath} matches ${source.name} ${source.tag}.`)
      return 0
    }
    console.error(`${rulesPath} differs from the conversion of ${source.name} ${source.tag}. Run npm run secret-rules and commit it.`)
    return 1
  }
  writeFileSync(rulesPath, serialized)
  const rules = JSON.parse(serialized) as BundledRules
  console.log(`Wrote ${rules.count} rules from ${source.name} ${source.tag} to ${rulesPath} (${rules.skipped.length} skipped).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
