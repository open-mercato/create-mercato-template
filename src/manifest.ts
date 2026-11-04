/**
 * `mercato-template.json` (spec, "`mercato-template.json` mapping"). The
 * catalog owns the schema (`mercato-template-1.json`); the tests validate
 * the output against a vendored copy. The manifest is generated: a
 * `mercato-template.json` in the source app is replaced; its `env`
 * descriptions and links serve keys whose comment is missing (see
 * `src/policy/env.ts`).
 */
import { type Inventory, appFrom, defaultFrom, isKnownFrom } from './inventory.js'
import { type Lockfile } from './lockfile.js'
import type { DeclaredEnv } from './policy/env.js'
import type { Finding } from './policy/entries.js'
import { type OpenMercato, enterprisePackage, resolveModulePackage } from './policy/root.js'
import { type FileRecord, sha256Hex } from './snapshot.js'

export const manifestPath = 'mercato-template.json'
export const toolName = 'create-mercato-template'

/** A manifest name: a lower-case slug, at most 214 characters. */
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
const maxNameLength = 214
/** The longest manifest description; `publish` uses it as the repository description. */
export const maxDescriptionLength = 350

/**
 * Not plain text: links, markdown, HTML, control characters or long dashes
 * (the rule of `create-mercato-module`'s `describe.ts`).
 */
// eslint-disable-next-line no-control-regex
const notPlainText = /https?:\/\/|www\.|[[\]`<>]|(?:^|\s)\*|^\s*#|[\u0000-\u001f\u007f-\u009f\u2013\u2014]/i

export type ManifestModule = { id: string; from: string; package?: string; when?: string }

export type Manifest = {
  schema: 1
  name: string
  description?: string
  /** `<major>.<minor>.x` of the pinned core. */
  openMercato?: string
  /** Declared env: the keys of `.env.example` that the stock file lacks. Left out when there are none. */
  env?: DeclaredEnv[]
  modules: ManifestModule[]
  createdWith: { tool: string; version: string }
}

/** A report entry: the manifest entry plus its line in `src/modules.ts`. */
export type ReportModule = ManifestModule & { line: number }

export type ModulesResult = {
  /** `report.modules`. */
  report: { entries: ReportModule[]; unparsed: Inventory['unparsed'] }
  /** `report.enterprise.modules`: the registered modules from `@open-mercato/enterprise`. */
  enterprise: Array<{ id: string; when?: string }>
  /** `module-package-unresolved`. */
  findings: Finding[]
}

export function isPlainText(value: string): boolean {
  return !notPlainText.test(value)
}

/** A text made into a slug: lower case, every run of other characters one `-`, at most 214 characters. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, maxNameLength)
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'template' : slug
}

/**
 * The manifest entries with `package` (spec, Module inventory item 7): for
 * an npm `from` other than core, `<name>@<version>` as Yarn resolved it.
 * None found is `module-package-unresolved`: an error for an unconditional
 * module (the app cannot build), a warning for a conditional one. With no
 * readable `yarn.lock`, the root rule reports the cause and no package is
 * looked up.
 */
export function resolveModules(inventory: Inventory, packageJson: Record<string, unknown> | null, lockfile: Lockfile | null): ModulesResult {
  const findings: Finding[] = []
  const entries: ReportModule[] = inventory.entries.map((entry) => {
    const resolved: ManifestModule = { id: entry.id, from: entry.from }
    const npm = entry.from !== appFrom && entry.from !== defaultFrom && isKnownFrom(entry.from)
    if (npm && lockfile !== null) {
      const found = resolveModulePackage(packageJson, lockfile, entry.from)
      if (found !== null) resolved.package = `${entry.from}@${found.version}`
      else
        findings.push({
          rule: 'module-package-unresolved',
          level: entry.when === undefined ? 'error' : 'warning',
          path: 'src/modules.ts',
          line: entry.line,
          message:
            entry.when === undefined
              ? `Module ${entry.id}: ${entry.from} has no single entry in yarn.lock, so the app cannot build. Add it to package.json, run yarn install and commit yarn.lock.`
              : `Module ${entry.id}: ${entry.from} has no single entry in yarn.lock. It is registered only when its condition holds; the template is listed without its package.`,
        })
    }
    if (entry.when !== undefined) resolved.when = entry.when
    return { ...resolved, line: entry.line }
  })
  return {
    report: { entries, unparsed: inventory.unparsed },
    enterprise: entries.filter((entry) => entry.from === enterprisePackage).map((entry) => (entry.when === undefined ? { id: entry.id } : { id: entry.id, when: entry.when })),
    findings,
  }
}

export type ManifestInput = {
  packageJson: Record<string, unknown> | null
  /** The base name of the app directory, for a name when `package.json` gives none. */
  appName: string
  openMercato: OpenMercato | null
  modules: readonly ReportModule[]
  /** Declared env, from the env diff. */
  env?: readonly DeclaredEnv[]
  version: string
}

/** Builds the manifest and its `manifest-name` and `manifest-description` warnings. */
export function buildManifest(input: ManifestInput): { manifest: Manifest; findings: Finding[] } {
  const findings: Finding[] = []
  const packageName = input.packageJson?.name
  const unscoped = typeof packageName === 'string' ? packageName.replace(/^@[^/]+\//, '') : null
  let name: string
  if (unscoped !== null && unscoped.length <= maxNameLength && slugPattern.test(unscoped)) name = unscoped
  else {
    name = slugify(input.appName)
    findings.push({
      rule: 'manifest-name',
      level: 'warning',
      path: 'package.json',
      message: `package.json has no name that is a lower-case slug, so the manifest uses ${name}, made from the app directory name. Set package.json name to a slug such as my-template.`,
    })
  }
  const raw = input.packageJson?.description
  const description = typeof raw === 'string' ? raw.trim() : ''
  const usable = description !== '' && description.length <= maxDescriptionLength && isPlainText(description)
  if (!usable)
    findings.push({
      rule: 'manifest-description',
      level: 'warning',
      path: 'package.json',
      message:
        description === ''
          ? 'package.json has no description, so the manifest has none. Add one sentence of plain text.'
          : `The package.json description is left out of the manifest: write plain text (no links, markdown, HTML, control characters or long dashes) of at most ${maxDescriptionLength} characters.`,
    })
  const manifest: Manifest = {
    schema: 1,
    name,
    ...(usable ? { description } : {}),
    ...(input.openMercato === null ? {} : { openMercato: `${input.openMercato.line}.x` }),
    ...(input.env && input.env.length > 0 ? { env: input.env.map((item) => ({ ...item })) } : {}),
    modules: input.modules.map(({ id, from, package: pinned, when }) => ({
      id,
      from,
      ...(pinned === undefined ? {} : { package: pinned }),
      ...(when === undefined ? {} : { when }),
    })),
    createdWith: { tool: toolName, version: input.version },
  }
  return { manifest, findings }
}

/** The manifest file: two-space JSON with a final newline. */
export function serializeManifest(manifest: Manifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** The file record of the generated manifest. */
export function manifestRecord(content: Buffer): FileRecord {
  return { path: manifestPath, mode: '100644', size: content.length, sha256: sha256Hex(content), origin: 'generated', generated: true }
}
