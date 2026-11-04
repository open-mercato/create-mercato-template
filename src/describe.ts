/**
 * `describe` (spec, "describe"): the catalog entry for
 * `templates/<owner>/<repo>.yml`, built from `<from>/report.json`, the
 * manifest in `<from>/tree` and the repository from `<from>/publication.json`
 * or `--repo`. Read-only and offline: no network, no GitHub call, no write;
 * the result goes to stdout only.
 *
 * Every text that reaches the output is checked first: plain text (the
 * catalog's `PlainText` rule), no email address and no match of the secret
 * scan. A flag that fails is exit 2, without its value in the message; a
 * manifest text that fails is not used, and the field it would fill is
 * listed under `missing`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { stringify } from 'yaml'
import { emailPattern } from './common.js'
import { CliError, exitCodes } from './errors.js'
import { isPlainText, manifestPath } from './manifest.js'
import { scanText } from './policy/secrets.js'
import { SnapshotModified, parseRepo, readNoFollow, readReport } from './publish.js'
import { sha256Hex } from './snapshot.js'

/** The catalog's closed `useCase` list (catalog decision A3). */
export const useCases = ['crm', 'commerce', 'b2b-portal', 'partner-portal', 'operations', 'field-service', 'internal-tools', 'starter'] as const
export type UseCase = (typeof useCases)[number]

/**
 * Where a catalog entry is added in v1 (catalog decision A7). The prefilled
 * `/submit?template=owner/repo` link replaces it in catalog Phase 1b.
 */
export const contributingUrl = 'https://github.com/open-mercato/modules/blob/main/CONTRIBUTING.md#templates'

/** The text rules of the catalog's `lib/schema/descriptor.ts`. */
export const summaryLength = { min: 20, max: 140 } as const
export const whenToUseLength = { min: 40, max: 240 } as const
export const whenNotToUseMax = 160
const whenToUsePrefix = 'Use when '

export type DeclaredEnvEntry = { name: string; description?: string; link?: string }

/** The catalog entry. Author fields only: never `slug`, `status`, `reason`, `featured` or another curator field. */
export type CatalogEntry = {
  github: string
  useCase?: UseCase
  summary?: string
  whenToUse?: string
  whenNotToUse?: string
  pricing: 'free'
  declares?: { env: DeclaredEnvEntry[] }
}

/** A required field that `describe` could not fill. */
export type MissingField = 'useCase' | 'summary' | 'whenToUse' | 'declares.env'

export type DescribeOptions = {
  /** A `prepare` output directory. */
  from: string
  repo?: string
  useCase?: string
  summary?: string
  whenToUse?: string
  whenNotToUse?: string
}

export type DescribeResult = {
  /** `templates/<owner>/<repo>.yml`, lower case. */
  path: string
  /** The file content: the entry, with a comment for each missing field. */
  yaml: string
  entry: CatalogEntry
  complete: boolean
  missing: MissingField[]
  contributing: string
  /** Printed without `--json`. */
  text: string
}

function usage(message: string): CliError {
  return new CliError(`${message} Nothing was read or changed.`, exitCodes.usage)
}

/**
 * Why `value` cannot go into the output, or null: not plain text, an email
 * address, or a match of the secret scan. Never quotes the value.
 */
export function unsafeTextReason(value: string): string | null {
  if (!isPlainText(value)) return 'is not plain text (no links, markdown, HTML, backticks, control characters or long dashes)'
  if (emailPattern.test(value)) return 'holds an email address'
  if (scanText('describe', value).length > 0) return 'looks like it holds a secret'
  return null
}

/** Checks a text flag: safe text and its length; exit 2 otherwise. */
function checkText(flag: string, value: string, min: number, max: number): void {
  const reason = unsafeTextReason(value)
  if (reason !== null) throw usage(`${flag} ${reason}.`)
  if (value.length < min || value.length > max) throw usage(`${flag} must have ${min} to ${max} characters; it has ${value.length}.`)
}

/**
 * The usage checks of `describe` (exit 2), before anything under `--from` is
 * read: `--use-case` in the closed list, the text flags as the catalog's
 * `lib/schema/descriptor.ts` checks them, and `--repo` a GitHub name.
 */
export function checkDescribeFlags(options: DescribeOptions): void {
  if (options.repo !== undefined && parseRepo(options.repo) === null) throw usage(`--repo ${options.repo} is not a GitHub <owner>/<name>.`)
  if (options.useCase !== undefined && !(useCases as readonly string[]).includes(options.useCase))
    throw usage(`--use-case must be one of ${useCases.join(', ')}.`)
  if (options.summary !== undefined) checkText('--summary', options.summary, summaryLength.min, summaryLength.max)
  if (options.whenToUse !== undefined) {
    checkText('--when-to-use', options.whenToUse, whenToUseLength.min, whenToUseLength.max)
    if (!options.whenToUse.startsWith(whenToUsePrefix)) throw usage(`--when-to-use must start with "${whenToUsePrefix}".`)
  }
  if (options.whenNotToUse !== undefined) checkText('--when-not-to-use', options.whenNotToUse, 1, whenNotToUseMax)
}

/** `fullName` of `<from>/publication.json`, or null when the file is missing, unreadable or names no valid repository. */
export function publishedRepo(from: string): string | null {
  const read = readNoFollow(path.join(from, 'publication.json'))
  if (!read) return null
  try {
    const value = JSON.parse(read.content.toString('utf8')) as { schema?: unknown; repo?: { fullName?: unknown } | null }
    const fullName = value?.schema === 1 ? value.repo?.fullName : undefined
    return typeof fullName === 'string' && parseRepo(fullName) !== null ? fullName : null
  } catch {
    return null
  }
}

/**
 * The repository of the entry: `--repo`, else `publication.json`. Both and
 * different, or neither, is exit 2. GitHub names are compared without case.
 */
export function resolveRepo(from: string, flag: string | undefined): string {
  const published = publishedRepo(from)
  if (flag !== undefined && published !== null && flag.toLowerCase() !== published.toLowerCase())
    throw usage(`--repo ${flag} differs from ${published}, the repository in ${path.join(from, 'publication.json')}. Leave --repo out, or pass the same repository.`)
  const repo = flag ?? published
  if (repo === null)
    throw usage(`describe needs the repository: ${path.join(from, 'publication.json')} is missing or names none. Pass --repo <owner/name>.`)
  return repo
}

type ManifestFacts = { description: string | null; env: DeclaredEnvEntry[] }

/**
 * Reads `<from>/report.json` and the manifest in `<from>/tree`, without
 * following symlinks. A missing or unreadable report, a report with an
 * error finding or no `snapshotId`, and a manifest that is missing or
 * differs from the report are exit 1, rule `snapshot-modified`, as in
 * `publish`'s `verify`.
 */
export function readSnapshotFacts(from: string): ManifestFacts {
  const report = readReport(from)
  if (report.errors > 0 || report.snapshotId === null)
    throw new SnapshotModified('report-errors', `report.json lists ${report.errors} error finding(s): prepare refused this snapshot, so it has no catalog entry.`, 'report.json')
  const listed = report.files.find((file) => file.path === manifestPath)
  const tree = path.join(from, 'tree')
  const treeStat = fs.lstatSync(tree, { throwIfNoEntry: false })
  const read = treeStat?.isDirectory() ? readNoFollow(path.join(tree, manifestPath)) : null
  if (!listed || !read) throw new SnapshotModified('file-missing', `${manifestPath} is missing from report.json or from ${tree}.`, manifestPath)
  if (read.content.length !== listed.size || sha256Hex(read.content) !== listed.sha256)
    throw new SnapshotModified('file-changed', `${manifestPath} differs from report.json.`, manifestPath)
  let manifest: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(read.content.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    manifest = value as Record<string, unknown>
  } catch {
    throw new SnapshotModified('file-changed', `${manifestPath} is not a JSON object.`, manifestPath)
  }
  const env: DeclaredEnvEntry[] = []
  for (const item of Array.isArray(manifest.env) ? manifest.env : []) {
    const value = item as Record<string, unknown> | null
    if (!value || typeof value.name !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.name)) continue
    const entry: DeclaredEnvEntry = { name: value.name }
    if (typeof value.description === 'string' && value.description.length >= 1 && value.description.length <= 240 && unsafeTextReason(value.description) === null)
      entry.description = value.description
    if (
      typeof value.link === 'string' &&
      /^https:\/\/\S+$/.test(value.link) &&
      value.link.length <= 300 &&
      !emailPattern.test(value.link) &&
      scanText('describe', value.link).length === 0
    )
      entry.link = value.link
    env.push(entry)
  }
  return { description: typeof manifest.description === 'string' ? manifest.description : null, env }
}

/** The manifest description as `summary`, when it is safe plain text of 20 to 140 characters. */
export function summaryFromDescription(description: string | null): string | undefined {
  if (description === null || description.length < summaryLength.min || description.length > summaryLength.max) return undefined
  return unsafeTextReason(description) === null ? description : undefined
}

const placeholders: Record<Exclude<MissingField, 'declares.env'>, string> = {
  useCase: `# useCase: required, one of ${useCases.join(', ')}. Pass --use-case <value>.`,
  summary: `# summary: required, plain text of ${summaryLength.min} to ${summaryLength.max} characters. Pass --summary <text>.`,
  whenToUse: `# whenToUse: required, plain text of ${whenToUseLength.min} to ${whenToUseLength.max} characters that starts with "${whenToUsePrefix}". Pass --when-to-use <text>.`,
}

function yamlField(key: string, value: unknown): string {
  return stringify({ [key]: value }, { lineWidth: 0 })
}

/** The file content: fields in catalog table order, a comment line for each missing required value. */
export function entryYaml(entry: CatalogEntry, missing: readonly MissingField[]): string {
  let yaml = yamlField('github', entry.github)
  for (const key of ['useCase', 'summary', 'whenToUse'] as const)
    yaml += entry[key] !== undefined ? yamlField(key, entry[key]) : `${placeholders[key]}\n`
  if (entry.whenNotToUse !== undefined) yaml += yamlField('whenNotToUse', entry.whenNotToUse)
  yaml += yamlField('pricing', entry.pricing)
  if (entry.declares) {
    if (missing.includes('declares.env')) {
      const names = entry.declares.env.filter((item) => item.description === undefined).map((item) => item.name)
      yaml += `# declares.env: ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no description. Add a comment line above each key in .env.example, commit and run prepare again.\n`
    }
    yaml += yamlField('declares', entry.declares)
  }
  return yaml
}

/** Runs `describe`: the usage checks (exit 2), then the reads of `<from>` (exit 1), then the entry. */
export function describe(options: DescribeOptions): DescribeResult {
  checkDescribeFlags(options)
  const stat = fs.statSync(options.from, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) throw usage(`--from ${options.from} is not a directory. Run prepare first.`)
  const repo = resolveRepo(options.from, options.repo).toLowerCase()
  const facts = readSnapshotFacts(options.from)

  const entry: CatalogEntry = { github: repo, pricing: 'free' }
  if (options.useCase !== undefined) entry.useCase = options.useCase as UseCase
  const summary = options.summary ?? summaryFromDescription(facts.description)
  if (summary !== undefined) entry.summary = summary
  if (options.whenToUse !== undefined) entry.whenToUse = options.whenToUse
  if (options.whenNotToUse !== undefined) entry.whenNotToUse = options.whenNotToUse
  if (facts.env.length > 0) entry.declares = { env: facts.env }

  const missing: MissingField[] = []
  if (entry.useCase === undefined) missing.push('useCase')
  if (entry.summary === undefined) missing.push('summary')
  if (entry.whenToUse === undefined) missing.push('whenToUse')
  if (facts.env.some((item) => item.description === undefined)) missing.push('declares.env')

  const [owner, name] = repo.split('/') as [string, string]
  const file = `templates/${owner}/${name}.yml`
  const yaml = entryYaml(entry, missing)
  let text = `# ${file}\n${yaml}\n`
  if (missing.length > 0) text += `# Incomplete: fill ${missing.join(', ')} before you submit the entry, or pass the flags and run describe again.\n`
  text += `# Add this file to the catalog with a pull request to open-mercato/modules:\n# ${contributingUrl}\n`
  return { path: file, yaml, entry, complete: missing.length === 0, missing, contributing: contributingUrl, text }
}
