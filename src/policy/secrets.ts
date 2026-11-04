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
 * An extra rule's finding is also dropped when a bundled rule found a secret
 * on the same line, so one value gives one finding.
 */
import * as path from 'node:path'
import { extraRules } from '../rules/extra.js'
import { type BundledRule, type ConvertedRegex, bundledRules } from '../rules/gitleaks.js'
import { isStockCredentialUrl } from '../stock.js'
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
  /** Global, for finding every match. */
  regex: RegExp | null
  /** The same pattern, not global, for matching a match again to read its groups. */
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

function compile(regex: ConvertedRegex, global = false): RegExp {
  return new RegExp(regex.source, global ? `${regex.flags}g` : regex.flags)
}

function compileRule(rule: BundledRule, extra: boolean): CompiledRule {
  return {
    id: rule.id,
    regex: rule.regex ? compile(rule.regex, true) : null,
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

function compiledRules(rules?: SecretRules): CompiledRule[] {
  if (rules) return [...rules.rules.map((rule) => compileRule(rule, false)), ...rules.extra.map((rule) => compileRule(rule, true))]
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

/** 1-based line numbers by character offset. */
class Lines {
  private starts: number[] | null = null
  constructor(private readonly text: string) {}
  lineOf(offset: number): number {
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
    return low + 1
  }
}

function allowed(rule: CompiledRule, filePath: string, secret: string, match: string, line: string): boolean {
  return rule.allowlists.some((allowlist) => {
    const target = allowlist.regexTarget === 'match' ? match : allowlist.regexTarget === 'line' ? line : secret
    const regexAllowed = target !== '' && allowlist.regexes.some((regex) => regex.test(target))
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

function ruleHits(rule: CompiledRule, filePath: string, text: string, lower: string, lines: Lines): Hit[] {
  if (rule.regex === null) return []
  if (rule.path !== null && !rule.path.test(filePath)) return []
  if (rule.keywords.length > 0 && !rule.keywords.some((keyword) => lower.includes(keyword))) return []
  const hits: Hit[] = []
  const regex = rule.regex
  regex.lastIndex = 0
  for (let found = regex.exec(text); found !== null; found = regex.exec(text)) {
    if (found[0] === '') {
      regex.lastIndex += 1
      continue
    }
    const { value: match, leading } = trimNewlines(found[0])
    if (match === '') continue
    const start = found.index + leading
    const end = start + match.length
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const newline = text.indexOf('\n', end)
    const line = text.slice(lineStart, newline === -1 ? text.length : newline)
    const secret = secretOf(rule, match)
    if (rule.entropy !== null && rule.entropy !== 0 && shannonEntropy(secret) <= rule.entropy) continue
    if (allowed(rule, filePath, secret, match, line)) continue
    hits.push({ ruleId: rule.id, line: lines.lineOf(start), secret, extra: rule.extra })
  }
  return hits
}

const isGeneric = (ruleId: string) => ruleId.toLowerCase().includes('generic')

/** gitleaks `filter`, then the extra rule dedupe, then one finding per rule and line. */
function dedupe(hits: Hit[]): Hit[] {
  const kept = hits.filter((hit) => {
    if (isGeneric(hit.ruleId)) {
      const better = hits.some(
        (other) => other.line === hit.line && other.ruleId !== hit.ruleId && !isGeneric(other.ruleId) && other.secret.includes(hit.secret),
      )
      if (better) return false
    }
    if (hit.extra) return !hits.some((other) => !other.extra && other.line === hit.line)
    return true
  })
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

/** The bundled and extra rule matches in one text file, as `secret` findings with `ruleId` and `line`. */
export function scanSecrets(filePath: string, text: string, rules?: SecretRules): Finding[] {
  const lower = text.toLowerCase()
  const lines = new Lines(text)
  const hits = compiledRules(rules).flatMap((rule) => ruleHits(rule, filePath, text, lower, lines))
  return dedupe(hits)
    .sort((left, right) => left.line - right.line || left.ruleId.localeCompare(right.ruleId))
    .map((hit) => ({ rule: 'secret', level: 'error', path: filePath, line: hit.line, ruleId: hit.ruleId, message: secretMessage }))
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
export function scanCredentialUrls(filePath: string, text: string): Finding[] {
  const lines = new Set<number>()
  for (const found of findCredentialUrls(text)) {
    if (variableOnly.test(found.password) || isStockCredentialUrl(found.url)) continue
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
