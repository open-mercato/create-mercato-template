/**
 * The review warnings and notices of the Rule table that are not tied to a
 * single check elsewhere: `image`, `executable-config`, `ai-content`,
 * `seed-email`, `readme-missing`, `readme-stock`, `nested-env-example`,
 * `exceeds-import-limits`, and the notices `stock-unknown`,
 * `enterprise-dependency` and `derived-from-template`. None blocks.
 *
 * Findings name paths, lines, counts and sizes, never file content: a seed
 * email address is reported by path and line only.
 */
import { type StockTable, isStockReadme, stockTable } from '../stock.js'
import type { FileRecord } from '../snapshot.js'
import type { Finding } from './entries.js'
import { classifyContent, extensionOf, isText } from './opaque.js'

/** The image extensions of the Opaque files section, plus `svg` (text, scanned like any text). */
export const imageExtensions: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'icns', 'svg']

/** `package.json` lifecycle scripts that run on install or publish. */
export const lifecycleScripts: readonly string[] = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
]

/** The import limits planned for `--template` (catalog defaults, Q10). */
export const importLimits = { bytes: 50 * 1024 * 1024, files: 5000 } as const

export type Notice = { code: string; detail?: string }

export type ImageRecord = { path: string; size: number }

export type WarningsInput = {
  files: readonly FileRecord[]
  contents: ReadonlyMap<string, Buffer>
  /** Every path left out by the deny list or `export-ignore`, with its pattern. */
  excluded: ReadonlyArray<{ pattern: string; paths: readonly string[] }>
  table?: StockTable
}

export type WarningsResult = { findings: Finding[]; images: ImageRecord[] }

/**
 * Every image file of the snapshot, anywhere, with its size: an SVG, or a
 * file with an image extension whose content matches its signature. A file
 * that only carries an image extension (a ZIP named `logo.png`) is an opaque
 * file, not an image.
 */
export function imagesOf(files: readonly FileRecord[], contents: ReadonlyMap<string, Buffer>): ImageRecord[] {
  return files
    .filter((file) => {
      const extension = extensionOf(file.path)
      if (!imageExtensions.includes(extension)) return false
      const content = contents.get(file.path)
      return extension === 'svg' || (content !== undefined && classifyContent(file.path, content) === 'media')
    })
    .map((file) => ({ path: file.path, size: file.size }))
}

/** The warnings over the exported file set (generated files included). */
export function checkWarnings(input: WarningsInput): WarningsResult {
  const table = input.table ?? stockTable
  const findings: Finding[] = []
  const images = imagesOf(input.files, input.contents)
  for (const image of images)
    findings.push({
      rule: 'image',
      level: 'warning',
      path: image.path,
      message: `An image of ${image.size} bytes. Check that you may share it and that it shows nothing private.`,
    })

  findings.push(...executableConfig(input))

  const aiFiles = input.files.filter((file) => file.path.startsWith('.ai/')).length
  if (aiFiles > 0)
    findings.push({
      rule: 'ai-content',
      level: 'warning',
      path: '.ai',
      message: `${aiFiles} exported ${aiFiles === 1 ? 'file' : 'files'} under .ai/ (agent instructions, specs, run notes). Check that they belong in the template.`,
    })

  for (const file of input.files) {
    if (!isSeedFile(file.path)) continue
    const content = input.contents.get(file.path)
    if (!content || !isText(content)) continue
    for (const line of seedEmailLines(content.toString('utf8')))
      findings.push({
        rule: 'seed-email',
        level: 'warning',
        path: file.path,
        line,
        message:
          'A seed file holds an email address outside example.com, acme.com and the reserved names. Use an address at example.com so the template seeds no real person.',
      })
  }

  const readme = input.files.find((file) => file.path === 'README.md')
  if (!readme)
    findings.push({
      rule: 'readme-missing',
      level: 'warning',
      path: 'README.md',
      message: 'The template has no root README.md. Add one that says what the template is for and how to start it.',
    })
  else if (isStockReadme(readme.sha256, table))
    findings.push({
      rule: 'readme-stock',
      level: 'warning',
      path: 'README.md',
      message: 'The root README.md is the stock create-mercato-app README. Describe the template; catalog validation refuses the stock README.',
    })

  for (const group of input.excluded)
    for (const excludedPath of group.paths)
      if (excludedPath !== '.env.example' && excludedPath.split('/').at(-1) === '.env.example')
        findings.push({
          rule: 'nested-env-example',
          level: 'warning',
          path: excludedPath,
          message: 'A .env.example below the root is excluded with the other .env* files; only the root .env.example is regenerated. Move what it documents to the root .env.example.',
        })

  const bytes = input.files.reduce((sum, file) => sum + file.size, 0)
  if (bytes > importLimits.bytes || input.files.length > importLimits.files)
    findings.push({
      rule: 'exceeds-import-limits',
      level: 'warning',
      path: '.',
      message: `The snapshot has ${input.files.length} files and ${bytes} bytes, more than the import limits planned for create-mercato-app --template (${importLimits.files} files, 50 MB). Importing it may fail.`,
    })
  return { findings, images }
}

const yarnExecutable = /^["']?(yarnPath|plugins)["']?\s*:/

/**
 * `executable-config`: code that runs on install, from the template author:
 * `.yarnrc.yml` `yarnPath` or `plugins`, `.github/workflows/*`, and
 * `package.json` lifecycle scripts.
 */
function executableConfig(input: WarningsInput): Finding[] {
  const findings: Finding[] = []
  for (const file of input.files) {
    const parts = file.path.split('/')
    if (parts.length === 3 && parts[0] === '.github' && parts[1] === 'workflows')
      findings.push({
        rule: 'executable-config',
        level: 'warning',
        path: file.path,
        message: 'A GitHub Actions workflow runs in every repository created from the template. Check what it runs and which secrets it reads.',
      })
    if (parts.at(-1) === '.yarnrc.yml') {
      const content = input.contents.get(file.path)
      if (!content || !isText(content)) continue
      content
        .toString('utf8')
        .split(/\r?\n/)
        .forEach((text, index) => {
          const match = yarnExecutable.exec(text)
          if (match)
            findings.push({
              rule: 'executable-config',
              level: 'warning',
              path: file.path,
              line: index + 1,
              message: `.yarnrc.yml sets ${match[1]}: Yarn runs that code on every install. Check that it is the code you mean to ship.`,
            })
        })
    }
  }
  const packageJson = input.contents.get('package.json')
  const scripts = packageJson ? readScripts(packageJson) : {}
  for (const name of lifecycleScripts)
    if (Object.hasOwn(scripts, name))
      findings.push({
        rule: 'executable-config',
        level: 'warning',
        path: 'package.json',
        message: `package.json has a ${name} script: it runs on install or publish. Check what it runs.`,
      })
  return findings
}

function readScripts(content: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const scripts = (parsed as { scripts?: unknown }).scripts
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * A seed file (spec, `seed-email`): `src/modules/<module>/setup.ts`, or any
 * path with `seed` in a directory or file name (`seed/`, `seeds/`,
 * `seed-data.json`), case-insensitive.
 */
export function isSeedFile(filePath: string): boolean {
  const parts = filePath.split('/')
  if (parts.length === 4 && parts[0] === 'src' && parts[1] === 'modules' && parts[3] === 'setup.ts') return true
  return parts.some((part) => part.toLowerCase().includes('seed'))
}

const emailPattern = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g
const allowedDomains = ['example.com', 'acme.com']
const reservedSuffixes = ['test', 'example', 'invalid', 'localhost']

/** True when `domain` is example.com, acme.com, one of their subdomains, or under a reserved name. */
export function isExampleDomain(domain: string): boolean {
  const lower = domain.toLowerCase()
  if (allowedDomains.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`))) return true
  const last = lower.split('.').at(-1) as string
  return reservedSuffixes.includes(last)
}

/** The lines of `text` that hold an email address outside the example domains. */
export function seedEmailLines(text: string): number[] {
  const lines: number[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(emailPattern)) {
      // `name@scope/package` and `user@host` without a dot are not addresses.
      const domain = match[1]
      if (!domain.includes('.') && domain.toLowerCase() !== 'localhost') continue
      if (isExampleDomain(domain)) continue
      lines.push(index + 1)
      return
    }
  })
  return lines
}

export type NoticeInput = {
  stock: { version: string | null; known: boolean }
  enterprise: { dependency: boolean; modules: readonly unknown[] }
  packageJson: Record<string, unknown> | null
}

/** The notices of the report beyond `code-only` and `uncommitted-not-exported`. Never blocking. */
export function notices(input: NoticeInput): Notice[] {
  const result: Notice[] = []
  if (!input.stock.known)
    result.push({
      code: 'stock-unknown',
      detail:
        input.stock.version === null
          ? 'The Open Mercato version is not pinned, so no stock create-mercato-app version matches. Values are checked against every known version; values that are not stock in any of them are emptied.'
          : `Open Mercato ${input.stock.version} is not in the stock table of this tool version. Values are checked against every known version; values that are not stock in any of them are emptied, and declared env is compared with the newest known version.`,
    })
  if (input.enterprise.dependency || input.enterprise.modules.length > 0)
    result.push({
      code: 'enterprise-dependency',
      detail:
        'The app depends on @open-mercato/enterprise, or registers modules from it. Allowed, and marked: see enterprise in the report for the modules and their conditions.',
    })
  if (input.packageJson && Object.hasOwn(input.packageJson, 'openMercatoTemplate'))
    result.push({
      code: 'derived-from-template',
      detail: 'package.json has openMercatoTemplate: this app was created from a template. The field is kept.',
    })
  return result
}
