/**
 * The secret scan (spec, Secret scan): the bundled gitleaks rules and the
 * extra rules, credential URLs and Yarn registry auth, on the text of one
 * exported file. Findings carry `rule`, `path`, `line` and, for a rule
 * match, `ruleId`; never the matched text. There is no override (Q9): a
 * `gitleaks:allow` comment is not honored.
 *
 * The matcher follows gitleaks v8.30.1 `detect/detect.go` (`detectRule`,
 * `checkFindingAllowed`, `filter`) for one file:
 * - a rule with keywords runs only on text that contains one of them,
 *   compared in lower case;
 * - a rule with a `path` runs only on files whose path matches; a rule with
 *   only a `path` is a finding on the path alone (`scanPath`);
 * - matching runs on the whole text, so a multi-line match is found; `line`
 *   is the line where the match starts;
 * - the secret is the rule's `secretGroup`, or else the first non-empty
 *   group, of the match matched again on its own; with no group, the match;
 * - a rule with an entropy drops a secret whose Shannon entropy is at most
 *   the rule's value;
 * - an allowlist tests its regexes on the secret, the match or the line
 *   (`regexTarget`) and its stopwords on the secret (case-insensitive
 *   substrings); with `condition: "AND"` every part it has (paths included)
 *   must hold, else any one is enough;
 * - a `generic` finding is dropped when a non-generic rule found a secret on
 *   the same line that contains it.
 * An extra rule's finding is dropped when a bundled finding that survived
 * that filter is on the same line, so one value gives one finding and never
 * none. Unlike gitleaks, no decoding pass runs (base64, hex and percent
 * encoded text is not decoded and scanned again).
 *
 * Scan cost (spec, Secret scan, "Scan cost"). gitleaks runs its patterns on
 * RE2, in linear time; JavaScript backtracks. So the scan finds the same
 * matches as a global `exec` loop of each rule while doing less work, and
 * stops a rule it cannot bound with a `scan-limit` error instead of
 * exporting the file unscanned:
 * - a rule is tried only in the windows before its anchors, the literal
 *   parts every match holds (`src/rules/pattern.ts`); a rule that starts
 *   with a repeated character (`[\w.-]{0,50}?` before a keyword) tries its
 *   tail once per anchor position (`splitMatches`);
 * - a rule of bounded length, or whose unbounded quantifiers are proven
 *   linear, runs as written: its cost is linear in the text;
 * - any other rule (five today) runs capped, with its saturation patterns
 *   and a work limit counted in characters (`scanWorkLimit`); where a
 *   saturation pattern matches or the work would pass the limit, the scan
 *   of that rule on that file stops with `scan-limit`, `ruleId` and `line`.
 * Nothing is timed: the same text gives the same findings on every machine.
 */
import * as path from 'node:path'
import { extraRules } from '../rules/extra.js'
import { type BundledRule, type ConvertedRegex, bundledRules } from '../rules/gitleaks.js'
import { type PatternCap, analyzePattern, scanLimitRepeats } from '../rules/pattern.js'
import { type StockTable, isStockCredentialUrl, stockTable } from '../stock.js'
import { findCredentialUrls } from './credential-url.js'
import type { Finding } from './entries.js'

type CompiledAllowlist = {
  and: boolean
  regexTarget: 'secret' | 'match' | 'line'
  regexes: RegExp[]
  stopwords: string[]
  paths: RegExp[]
}

type CompiledRule = {
  id: string
  /**
   * The pattern, capped when it is unbounded (`src/rules/pattern.ts`):
   * global for a rule scanned at every position, sticky for a rule tried
   * only at chosen positions.
   */
  regex: RegExp | null
  /** Global: the places a match must contain, each with how far before it the match can start; null to try every position. */
  anchors: { regex: RegExp; before: { min: number; max: number } }[] | null
  /**
   * For a capped pattern (`src/rules/pattern.ts`): the saturation patterns,
   * sticky (where one matches, the capped pattern may differ from the rule,
   * so the file gets `scan-limit`), and a global regex for the runs of the
   * character of each unbounded quantifier.
   */
  cap: (PatternCap & { saturationRegexes: RegExp[]; runRegexes: (RegExp | null)[] }) | null
  /** For a split pattern (`src/rules/pattern.ts`): the runs of the prefix character, the sticky tail and its anchors. */
  split: { runs: RegExp; min: number; max: number; lazy: boolean; tail: RegExp; anchors: RegExp[] } | null
  /** The rule as written, not global, for matching a match again to read its groups. */
  groups: RegExp | null
  secretGroup: number
  entropy: number | null
  keywords: string[]
  path: RegExp | null
  allowlists: CompiledAllowlist[]
  extra: boolean
}

/** One rule match, kept in memory only: `secret` never leaves this module. */
type Hit = { ruleId: string; line: number; secret: string; extra: boolean }

function compile(regex: ConvertedRegex, mode: '' | 'g' | 'y' = ''): RegExp {
  return new RegExp(regex.source, `${regex.flags}${mode}`)
}

/**
 * Compiles a rule. Its pattern must be one `analyzePattern` reads (a test
 * and the rules build check every bundled and extra rule): a `PatternError`
 * here is a bug, never a rule left unscanned or scanned without the bound.
 */
function compileRule(rule: BundledRule, extra: boolean, plain = false): CompiledRule {
  let regex: RegExp | null = null
  let anchors: CompiledRule['anchors'] = null
  let cap: CompiledRule['cap'] = null
  let split: CompiledRule['split'] = null
  if (rule.regex && plain) regex = compile(rule.regex, 'g')
  else if (rule.regex) {
    const facts = analyzePattern(rule.regex)
    const flags = rule.regex.flags
    anchors = facts.anchors?.map((anchor) => ({ regex: compile({ source: anchor.source, flags }, 'g'), before: anchor.before })) ?? null
    const source = facts.cap?.capped ?? rule.regex.source
    regex = compile({ source, flags }, anchors !== null || facts.cap !== null ? 'y' : 'g')
    if (facts.cap)
      cap = {
        ...facts.cap,
        saturationRegexes: facts.cap.saturations.map((item) => compile({ source: item, flags }, 'y')),
        runRegexes: facts.cap.quantifiers.map((item) => (item.source === null ? null : new RegExp(`(?:${item.source})+`, `${item.flags}g`))),
      }
    if (facts.split) {
      const { prefix } = facts.split
      split = {
        runs: new RegExp(`(?:${prefix.source})+`, `${prefix.flags}g`),
        min: prefix.min,
        max: prefix.max,
        lazy: prefix.lazy,
        tail: compile({ source: facts.split.tail, flags }, 'y'),
        anchors: facts.split.tailAnchors.map((source) => compile({ source, flags }, 'g')),
      }
    }
  }
  return {
    id: rule.id,
    regex,
    anchors,
    cap,
    split,
    groups: rule.regex ? compile(rule.regex) : null,
    secretGroup: rule.secretGroup,
    entropy: rule.entropy,
    keywords: rule.keywords.map((keyword) => keyword.toLowerCase()),
    path: rule.path ? compile(rule.path) : null,
    allowlists: rule.allowlists.map((allowlist) => ({
      and: allowlist.condition === 'AND',
      regexTarget: allowlist.regexTarget,
      regexes: allowlist.regexes.map((item) => compile(item)),
      stopwords: allowlist.stopwords.map((word) => word.toLowerCase()),
      paths: (allowlist.paths ?? []).map((item) => compile(item)),
    })),
    extra,
  }
}

export type SecretRules = { rules: readonly BundledRule[]; extra: readonly BundledRule[] }

let defaultCompiled: CompiledRule[] | null = null
let defaultPlain: CompiledRule[] | null = null

function compiledRules(rules?: SecretRules, plain = false): CompiledRule[] {
  if (rules) return [...rules.rules.map((rule) => compileRule(rule, false, plain)), ...rules.extra.map((rule) => compileRule(rule, true, plain))]
  if (plain) return (defaultPlain ??= compiledRules({ rules: bundledRules.rules, extra: extraRules }, true))
  defaultCompiled ??= compiledRules({ rules: bundledRules.rules, extra: extraRules })
  return defaultCompiled
}

/**
 * Shannon entropy as gitleaks computes it (`detect/utils.go`
 * `shannonEntropy`): frequencies of the characters (code points) over the
 * length in UTF-8 bytes, in bits.
 */
export function shannonEntropy(data: string): number {
  if (data === '') return 0
  const counts = new Map<string, number>()
  for (const character of data) counts.set(character, (counts.get(character) ?? 0) + 1)
  const inverse = 1 / Buffer.byteLength(data, 'utf8')
  let entropy = 0
  for (const count of counts.values()) {
    const frequency = count * inverse
    entropy -= frequency * Math.log2(frequency)
  }
  return entropy
}

/** Line lookups by character offset, from the line starts computed once. */
class Lines {
  private starts: number[] | null = null
  private readonly text: string
  constructor(text: string) {
    this.text = text
  }
  /** The 0-based index of the line that holds `offset`. */
  indexOf(offset: number): number {
    if (this.starts === null) {
      this.starts = [0]
      for (let index = this.text.indexOf('\n'); index !== -1; index = this.text.indexOf('\n', index + 1)) this.starts.push(index + 1)
    }
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.starts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low
  }
  /** The lines from the one that holds `start` to the one that holds `end`: a cache key and their text, without the final newline. */
  span(start: number, end: number): { key: string; text: () => string } {
    const first = this.indexOf(start)
    const last = this.indexOf(end)
    const starts = this.starts as number[]
    return { key: `${first}:${last}`, text: () => this.text.slice(starts[first], last + 1 < starts.length ? starts[last + 1] - 1 : this.text.length) }
  }
}

/** Code-unit order, the same on every machine (no locale). */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The line of a match, read lazily, and the result of each `regexTarget:
 * "line"` allowlist on it, cached by line span: the result depends on the
 * line text only, so many matches on one long line test it once.
 */
type LineTarget = { key: string; text: () => string; cache: Map<string, boolean> }

function allowed(rule: CompiledRule, filePath: string, secret: string, match: string, line: LineTarget): boolean {
  return rule.allowlists.some((allowlist, index) => {
    let regexAllowed: boolean
    if (allowlist.regexTarget === 'line') {
      const key = `${index}:${line.key}`
      let cached = line.cache.get(key)
      if (cached === undefined) {
        const text = line.text()
        cached = text !== '' && allowlist.regexes.some((regex) => regex.test(text))
        line.cache.set(key, cached)
      }
      regexAllowed = cached
    } else {
      const target = allowlist.regexTarget === 'match' ? match : secret
      regexAllowed = target !== '' && allowlist.regexes.some((regex) => regex.test(target))
    }
    const lower = secret.toLowerCase()
    const stopword = secret !== '' && allowlist.stopwords.some((word) => lower.includes(word))
    if (!allowlist.and) return regexAllowed || stopword
    const checks: boolean[] = []
    if (allowlist.paths.length > 0) checks.push(allowlist.paths.some((regex) => regex.test(filePath)))
    if (allowlist.regexes.length > 0) checks.push(regexAllowed)
    if (allowlist.stopwords.length > 0) checks.push(stopword)
    return checks.every(Boolean)
  })
}

function trimNewlines(text: string): { value: string; leading: number } {
  let start = 0
  let end = text.length
  while (start < end && text[start] === '\n') start += 1
  while (end > start && text[end - 1] === '\n') end -= 1
  return { value: text.slice(start, end), leading: start }
}

function secretOf(rule: CompiledRule, match: string): string {
  const groups = (rule.groups as RegExp).exec(match)
  if (!groups || groups.length < 2) return match
  if (rule.secretGroup > 0) return groups[rule.secretGroup] ?? ''
  return groups.slice(1).find((group) => group !== undefined && group.length > 0) ?? match
}

/** The positions where a global regex matches, each once, ascending; overlapping matches included. */
function positionsOf(regex: RegExp, text: string): number[] {
  const positions: number[] = []
  regex.lastIndex = 0
  for (let found = regex.exec(text); found !== null; found = regex.exec(text)) {
    positions.push(found.index)
    regex.lastIndex = found.index + 1
  }
  return positions
}

/**
 * The windows where a match of an anchored rule can start: for each place
 * `q` where an anchor matches, `[q - before.max, q - before.min]`, in
 * ascending order of their first position. A rule without anchors has one
 * window, the whole text.
 */
function windowsOf(anchors: CompiledRule['anchors'], text: string): [number, number][] {
  if (anchors === null) return [[0, text.length]]
  const windows = anchors.flatMap((anchor) =>
    positionsOf(anchor.regex, text).map((position): [number, number] => [Math.max(0, position - anchor.before.max), position - anchor.before.min]),
  )
  if (anchors.length > 1) windows.sort((left, right) => left[0] - right[0])
  return windows
}

/** The maximal runs of a regex `(?:c)+` in a text, ascending: their starts and ends. */
type RunList = { starts: number[]; ends: number[] }

/** Per text: the runs of each character class, shared by the rules that repeat the same one (`[\w.-]` for most). */
type RunCache = Map<string, RunList>

function runList(regex: RegExp, text: string, cache: RunCache): RunList {
  const key = `${regex.flags}/${regex.source}`
  let runs = cache.get(key)
  if (runs === undefined) {
    runs = { starts: [], ends: [] }
    regex.lastIndex = 0
    for (let found = regex.exec(text); found !== null; found = regex.exec(text)) {
      runs.starts.push(found.index)
      runs.ends.push(found.index + found[0].length)
    }
    cache.set(key, runs)
  }
  return runs
}

/** The first index of an ascending list whose value is at least `value`. */
function lowerBound(list: number[], value: number): number {
  let low = 0
  let high = list.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (list[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

/** A match: where it starts and its text. */
type Found = { index: number; text: string }

/** A match, or the position where the scan of the rule stopped at the limit. */
type Step = { found: Found } | { limit: number }

/**
 * The work a capped rule may do on one text, in characters its tries may
 * read (spec, Secret scan, "Scan cost"): a fixed part and a part per
 * character of the text. Counted, never timed, so the findings are the same
 * on every machine.
 */
export const scanWorkLimit = (length: number) => 2 ** 24 + 64 * length

/**
 * Every non-empty match of a rule, as a global `exec` loop of the rule as
 * written finds them: the leftmost match at or after the end of the one
 * before, an empty match skipped one position ahead. A plain rule (no
 * anchors, no cap) runs exactly that loop; a split rule runs
 * `splitMatches`. Otherwise the rule is tried with its sticky regex only at
 * the positions of its windows: every match starts in one
 * (`src/rules/pattern.ts`).
 *
 * A capped rule counts its work: each try may read `reach` characters, the
 * reach of the capped pattern with the longest runs of the text, and each
 * saturation pattern it runs as much again. A saturation pattern runs only
 * where a run of its character as long as its repetitions is within the
 * longest match. The scan of the rule stops with `limit` where a saturation
 * pattern matches (the capped pattern might not find what the rule would)
 * or where the work would pass `scanWorkLimit`.
 */
function* matchesOf(rule: CompiledRule, text: string, cache: RunCache): Generator<Step> {
  const regex = rule.regex as RegExp
  if (!regex.sticky) {
    regex.lastIndex = 0
    for (let found = regex.exec(text); found !== null; found = regex.exec(text)) {
      if (found[0] === '') regex.lastIndex += 1
      else yield { found: { index: found.index, text: found[0] } }
    }
    return
  }
  if (rule.split) {
    yield* splitMatches(rule.split, text, cache)
    return
  }
  const cap = rule.cap
  const runs = (cap?.quantifiers ?? []).map((quantifier, index) => {
    const pattern = cap!.runRegexes[index]
    if (pattern === null) return { longest: Number.POSITIVE_INFINITY, long: { starts: [0], ends: [text.length] } }
    const list = runList(pattern, text, cache)
    const long: RunList = { starts: [], ends: [] }
    let longest = 0
    list.starts.forEach((first, item) => {
      const length = list.ends[item] - first
      longest = Math.max(longest, length)
      if (length >= quantifier.repeats) {
        long.starts.push(first)
        long.ends.push(list.ends[item])
      }
    })
    return { longest, long }
  })
  const reach = cap ? Math.min(cap.maxLength, cap.reach(runs.map((item) => item.longest))) : 0
  const limit = scanWorkLimit(text.length)
  let work = 0
  let next = 0
  for (const [first, last] of windowsOf(rule.anchors, text)) {
    for (let start = Math.max(first, next); start <= last; start = next) {
      if (cap) {
        const read = Math.min(reach, text.length - start) + 1
        work += read
        if (work > limit) {
          yield { limit: start }
          return
        }
        for (let index = 0; index < runs.length; index++) {
          // A long run overlapping [start, start + maxLength): the first one ending after `start`.
          const long = runs[index].long
          const near = lowerBound(long.ends, start + 1)
          if (near >= long.starts.length || long.starts[near] >= start + cap.maxLength) continue
          work += read
          const saturation = cap.saturationRegexes[index]
          saturation.lastIndex = start
          if (work > limit || saturation.test(text)) {
            yield { limit: start }
            return
          }
        }
      }
      regex.lastIndex = start
      const found = regex.exec(text)
      if (found === null || found[0] === '') {
        next = start + 1
        continue
      }
      next = found.index + found[0].length
      yield { found: { index: found.index, text: found[0] } }
    }
  }
}

/**
 * The matches of a split rule (`src/rules/pattern.ts`, `PatternSplit`),
 * the same as trying the whole pattern at each start `s` of a window: the
 * prefix reaches the anchor positions `q` with `min <= q - s <= max` up to
 * the end of the run of its character at `s`; the tail is tried at those
 * `q`, the nearest first when the prefix is lazy and the farthest first
 * when it is greedy, and at each `q` once per text.
 */
function* splitMatches(split: NonNullable<CompiledRule['split']>, text: string, cache: RunCache): Generator<Step> {
  const positions = [...new Set(split.anchors.flatMap((anchor) => positionsOf(anchor, text)))].sort((left, right) => left - right)
  if (positions.length === 0) return
  const runs = runList(split.runs, text, cache)
  const tails = new Map<number, number>()
  const tailEnd = (position: number): number => {
    let end = tails.get(position)
    if (end === undefined) {
      split.tail.lastIndex = position
      const found = split.tail.exec(text)
      end = found === null || found[0] === '' ? -1 : position + found[0].length
      tails.set(position, end)
    }
    return end
  }
  let next = 0
  for (const position of positions) {
    for (let start = Math.max(position - split.max, next, 0); start <= position - split.min; start = next) {
      const run = lowerBound(runs.starts, start + 1) - 1
      const runEnd = run >= 0 && runs.ends[run] > start ? runs.ends[run] : start
      const first = lowerBound(positions, start + split.min)
      const last = lowerBound(positions, Math.min(start + split.max, runEnd) + 1) - 1
      let end = -1
      if (split.lazy) for (let index = first; index <= last && end < 0; index++) end = tailEnd(positions[index])
      else for (let index = last; index >= first && end < 0; index--) end = tailEnd(positions[index])
      if (end < 0) {
        next = start + 1
        continue
      }
      next = end
      yield { found: { index: start, text: text.slice(start, end) } }
    }
  }
}

/** The hits of one rule in one text, and the line where its scan stopped at the limit, if it did. */
type RuleScan = { hits: Hit[]; limit: number | null }

function ruleHits(rule: CompiledRule, filePath: string, text: string, lower: string, lines: Lines, cache: RunCache): RuleScan {
  const hits: Hit[] = []
  if (rule.regex === null) return { hits, limit: null }
  if (rule.path !== null && !rule.path.test(filePath)) return { hits, limit: null }
  if (rule.keywords.length > 0 && !rule.keywords.some((keyword) => lower.includes(keyword))) return { hits, limit: null }
  const lineCache = new Map<string, boolean>()
  for (const step of matchesOf(rule, text, cache)) {
    if ('limit' in step) return { hits, limit: lines.indexOf(step.limit) + 1 }
    const found = step.found
    const { value: match, leading } = trimNewlines(found.text)
    if (match === '') continue
    const start = found.index + leading
    const line = { ...lines.span(start, start + match.length), cache: lineCache }
    const secret = secretOf(rule, match)
    if (rule.entropy !== null && rule.entropy !== 0 && shannonEntropy(secret) <= rule.entropy) continue
    if (allowed(rule, filePath, secret, match, line)) continue
    hits.push({ ruleId: rule.id, line: lines.indexOf(start) + 1, secret, extra: rule.extra })
  }
  return { hits, limit: null }
}

const isGeneric = (ruleId: string) => ruleId.toLowerCase().includes('generic')

/**
 * gitleaks `filter` on the bundled hits; then an extra hit is kept unless a
 * bundled hit that survived the filter is on its line; then one finding per
 * rule and line. The order matters: each step looks only at what the step
 * before kept, so two drops can never cancel each other out.
 */
function dedupe(hits: Hit[]): Hit[] {
  const bundled = hits.filter((hit) => !hit.extra)
  const keptBundled = bundled.filter(
    (hit) =>
      !isGeneric(hit.ruleId) ||
      !bundled.some(
        (other) => other.line === hit.line && other.ruleId !== hit.ruleId && !isGeneric(other.ruleId) && other.secret.includes(hit.secret),
      ),
  )
  const bundledLines = new Set(keptBundled.map((hit) => hit.line))
  const kept = [...keptBundled, ...hits.filter((hit) => hit.extra && !bundledLines.has(hit.line))]
  const seen = new Set<string>()
  return kept.filter((hit) => {
    const key = `${hit.ruleId}\n${hit.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const secretMessage =
  'A secret rule matched here. Remove the value from the committed file, read it from the environment instead, and commit; rotate it if it was ever shared. A secret finding has no override.'

const credentialUrlMessage =
  'A connection URL with a literal password (scheme://user:password@host). Replace the password with a variable reference with no default, such as ${POSTGRES_PASSWORD}, and commit. Only the exact URL strings of a stock create-mercato-app scaffold are accepted as they are.'

const yarnAuthMessage =
  '.yarnrc.yml sets npmAuthToken or npmAuthIdent. A template does not carry registry auth, whatever the value: remove the setting and commit.'

const scanLimitMessage = `The secret scan stops a rule at a fixed limit, so that its time stays bounded: from this line, the rule would read a run of more than ${scanLimitRepeats} characters it repeats, or more text than its work limit for this file. The file is refused rather than exported unscanned. Break up the long text or remove the file from the commit.`

/**
 * The bundled and extra rule matches in one text file, as `secret` findings
 * with `ruleId` and `line`, and a `scan-limit` finding with `ruleId` and
 * `line` for each rule whose scan stopped at the limit.
 */
export function scanSecrets(filePath: string, text: string, rules?: SecretRules): Finding[] {
  return scanWith(compiledRules(rules), filePath, text)
}

/**
 * The reference for tests: `scanSecrets` with every rule run as a global
 * `exec` loop at every position (no anchors, no split, no cap), as before
 * the cost bound. Its time is not bounded; never call it on exported files.
 */
export function scanSecretsReference(filePath: string, text: string, rules?: SecretRules): Finding[] {
  return scanWith(compiledRules(rules, true), filePath, text)
}

function scanWith(compiled: CompiledRule[], filePath: string, text: string): Finding[] {
  const lower = text.toLowerCase()
  const lines = new Lines(text)
  const hits: Hit[] = []
  const limits: Finding[] = []
  const cache: RunCache = new Map()
  for (const rule of compiled) {
    const scan = ruleHits(rule, filePath, text, lower, lines, cache)
    hits.push(...scan.hits)
    if (scan.limit !== null) limits.push({ rule: 'scan-limit', level: 'error', path: filePath, line: scan.limit, ruleId: rule.id, message: scanLimitMessage })
  }
  const secrets: Finding[] = dedupe(hits).map((hit) => ({ rule: 'secret', level: 'error', path: filePath, line: hit.line, ruleId: hit.ruleId, message: secretMessage }))
  return [...secrets, ...limits].sort(
    (left, right) => (left.line as number) - (right.line as number) || compareCodeUnits(left.ruleId as string, right.ruleId as string) || compareCodeUnits(left.rule, right.rule),
  )
}

/** Path-only rules (`pkcs12-file`): a finding on the path alone, for any exported file, text or not. */
export function scanPath(filePath: string, rules?: SecretRules): Finding[] {
  return compiledRules(rules)
    .filter((rule) => rule.regex === null && rule.path !== null && rule.path.test(filePath))
    .map((rule) => ({ rule: 'secret', level: 'error', path: filePath, ruleId: rule.id, message: secretMessage }))
}

const variableOnly = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/

/**
 * `credential-url`: `scheme://user:password@host` with a non-empty password,
 * one finding per line. Not a finding when the exact URL string is in the
 * stock files of any known version (catalog check 5), or when the password is
 * only `$NAME` or `${NAME}` (Q8); `${NAME:-default}` holds a literal and is a
 * finding.
 */
export function scanCredentialUrls(filePath: string, text: string, table: StockTable = stockTable): Finding[] {
  const lines = new Set<number>()
  for (const found of findCredentialUrls(text)) {
    if (variableOnly.test(found.password) || isStockCredentialUrl(found.url, table)) continue
    lines.add(found.line)
  }
  return [...lines]
    .sort((left, right) => left - right)
    .map((line) => ({ rule: 'credential-url', level: 'error', path: filePath, line, message: credentialUrlMessage }))
}

/** `yarn-auth`: `npmAuthToken` or `npmAuthIdent` anywhere in a `.yarnrc.yml`, whatever the value. */
export function scanYarnAuth(filePath: string, text: string): Finding[] {
  if (path.posix.basename(filePath) !== '.yarnrc.yml') return []
  const findings: Finding[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (/npmAuth(?:Token|Ident)/.test(line))
      findings.push({ rule: 'yarn-auth', level: 'error', path: filePath, line: index + 1, message: yarnAuthMessage })
  })
  return findings
}

/** Every content check of the secret scan on one text file. */
export function scanText(filePath: string, text: string, rules?: SecretRules): Finding[] {
  return [...scanSecrets(filePath, text, rules), ...scanCredentialUrls(filePath, text), ...scanYarnAuth(filePath, text)]
}
