// Generates src/stock/table.json, the stock table (spec, Stock table), from
// each stable create-mercato-app tarball on npm. Release-time tool for
// maintainers; never shipped and never run by tests against the network.
//
//   npm run stock-table           add the stable versions the table lacks
//   npm run stock-table -- --check  only list them; exit 1 when any is missing
//
// It runs with Node's type stripping and imports only import-free modules of
// src/ by their .ts names. External commands (`npm view`, `npm pack`, `tar`)
// run through `run` from src/common.ts with argument arrays, never a shell.
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type Executor, run } from '../src/common.ts'
import { parseEnvAssignments } from '../src/env-file.ts'
import { findCredentialUrls } from '../src/policy/credential-url.ts'
import { compareStableVersions, isStableVersion } from '../src/stable-version.ts'
import type { StockTable, StockVersion } from '../src/stock.ts'

export const stockPackage = 'create-mercato-app'
export const defaultTablePath = fileURLToPath(new URL('../src/stock/table.json', import.meta.url))

export function emptyStockTable(): StockTable {
  return { schema: 1, package: stockPackage, files: {}, versions: {} }
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** The stable versions npm lists for create-mercato-app, ascending. */
export function publishedStableVersions(executor: Executor = run, cwd: string = process.cwd()): string[] {
  const result = executor('npm', ['view', stockPackage, 'versions', '--json'], cwd, { capture: true })
  const parsed: unknown = JSON.parse(result.stdout)
  const versions = typeof parsed === 'string' ? [parsed] : parsed
  if (!Array.isArray(versions) || !versions.every((version) => typeof version === 'string'))
    throw new Error(`npm view ${stockPackage} versions --json did not print a list of versions.`)
  return versions.filter(isStableVersion).sort(compareStableVersions)
}

/** The stable versions npm has and the table lacks, ascending. */
export function missingStockVersions(table: StockTable, executor: Executor = run, cwd: string = process.cwd()): string[] {
  return publishedStableVersions(executor, cwd).filter((version) => !Object.hasOwn(table.versions, version))
}

/** Downloads one version's tarball into `directory` and returns its path. */
function packVersion(version: string, directory: string, executor: Executor): string {
  const result = executor(
    'npm',
    ['pack', `${stockPackage}@${version}`, '--pack-destination', directory, '--json', '--ignore-scripts'],
    directory,
    { capture: true },
  )
  // npm 11 prints `npm pack --json` as an array; npm 12 as an object keyed by package name.
  const parsed: unknown = JSON.parse(result.stdout)
  const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed) : []
  const filename = entries.length === 1 ? (entries[0] as { filename?: unknown } | null)?.filename : undefined
  if (typeof filename !== 'string' || filename !== basename(filename) || !filename.endsWith('.tgz'))
    throw new Error(`npm pack ${stockPackage}@${version} did not report one tarball.`)
  return join(directory, filename)
}

/** Files under `directory`, recursively, as paths relative to it; symbolic links are skipped. */
function listFiles(directory: string, prefix = ''): string[] {
  const result: string[] = []
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(join(directory, relative))
    if (stat.isDirectory()) result.push(...listFiles(directory, relative))
    else if (stat.isFile()) result.push(relative)
  }
  return result
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The file as text, or null for a binary file (a NUL byte, or not UTF-8). */
function readText(path: string): string | null {
  const content = readFileSync(path)
  if (content.includes(0)) return null
  try {
    return utf8.decode(content)
  } catch {
    return null
  }
}

/**
 * Reads the stock facts of one unpacked `template/` directory: the
 * `.env.example` text and its keys with their stock values, every credential
 * URL string in a text file, and the README hash.
 */
export function readStockTemplate(templateDirectory: string): { entry: StockVersion; files: Record<string, string> } {
  const files: Record<string, string> = {}
  const credentialUrls = new Set<string>()
  let envExample: string | null = null
  const env: Record<string, string[]> = {}
  let readme: string | null = null
  for (const path of listFiles(templateDirectory)) {
    const absolute = join(templateDirectory, path)
    if (path === 'README.md') readme = sha256(readFileSync(absolute))
    const text = readText(absolute)
    if (text === null) continue
    for (const found of findCredentialUrls(text)) credentialUrls.add(found.url)
    if (path === '.env.example') {
      envExample = sha256(Buffer.from(text, 'utf8'))
      files[envExample] = text
      for (const assignment of parseEnvAssignments(text)) {
        const values = (env[assignment.key] ??= [])
        if (!values.includes(assignment.value)) values.push(assignment.value)
      }
    }
  }
  return { entry: { envExample, env, credentialUrls: [...credentialUrls].sort(), readme }, files }
}

/** Downloads, unpacks and reads one version. `workDirectory` must be empty and is left for the caller to remove. */
export function readStockVersion(version: string, workDirectory: string, executor: Executor = run): ReturnType<typeof readStockTemplate> {
  const tarball = packVersion(version, workDirectory, executor)
  const unpacked = join(workDirectory, 'unpacked')
  mkdirSync(unpacked)
  executor('tar', ['-xzf', tarball, '-C', unpacked, '--no-same-owner'], workDirectory, { capture: true })
  return readStockTemplate(join(unpacked, 'package', 'template'))
}

/**
 * Adds every stable version npm has and `table` lacks. Versions already in the
 * table are not fetched again and are kept as they are. Returns a new table.
 */
export function updateStockTable(
  table: StockTable,
  options: { executor?: Executor; workRoot?: string } = {},
): { table: StockTable; added: string[] } {
  const executor = options.executor ?? run
  const workRoot = options.workRoot ?? tmpdir()
  const missing = missingStockVersions(table, executor, workRoot)
  const next: StockTable = { ...table, files: { ...table.files }, versions: { ...table.versions } }
  for (const version of missing) {
    const workDirectory = mkdtempSync(join(workRoot, 'cmt-stock-'))
    try {
      const { entry, files } = readStockVersion(version, workDirectory, executor)
      Object.assign(next.files, files)
      next.versions[version] = entry
    } finally {
      rmSync(workDirectory, { recursive: true, force: true })
    }
  }
  return { table: next, added: missing }
}

function sortedObject<T>(object: Record<string, T>, compare?: (left: string, right: string) => number): Record<string, T> {
  return Object.fromEntries(Object.keys(object).sort(compare).map((key) => [key, object[key]]))
}

/**
 * The committed form of the table: versions ascending, other keys sorted, two
 * spaces, a final newline, and every non-ASCII character escaped, so the file
 * is plain ASCII and its diffs are stable.
 */
export function serializeStockTable(table: StockTable): string {
  const ordered: StockTable = {
    schema: table.schema,
    package: table.package,
    files: sortedObject(table.files),
    versions: sortedObject(
      Object.fromEntries(
        Object.entries(table.versions).map(([version, entry]) => [
          version,
          { envExample: entry.envExample, env: sortedObject(entry.env), credentialUrls: entry.credentialUrls, readme: entry.readme },
        ]),
      ),
      compareStableVersions,
    ),
  }
  const json = JSON.stringify(ordered, null, 2).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  return `${json}\n`
}

export function readStockTableFile(path: string = defaultTablePath): StockTable {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StockTable
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyStockTable()
    throw error
  }
}

/** The command line. Returns the exit code: 0 done, 1 versions missing (`--check`), 2 usage. */
export function main(
  argv: string[],
  options: { executor?: Executor; tablePath?: string; workRoot?: string } = {},
): number {
  const executor = options.executor ?? run
  const tablePath = options.tablePath ?? defaultTablePath
  const check = argv.includes('--check')
  const unknown = argv.filter((argument) => argument !== '--check')
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown[0]}. Usage: build-stock-table.mts [--check]`)
    return 2
  }
  const table = readStockTableFile(tablePath)
  if (check) {
    const missing = missingStockVersions(table, executor, options.workRoot ?? tmpdir())
    if (missing.length === 0) {
      console.log(`The stock table has every stable ${stockPackage} version.`)
      return 0
    }
    console.error(
      `The stock table lacks ${stockPackage} ${missing.join(', ')}. Run npm run stock-table, commit src/stock/table.json and release a patch.`,
    )
    return 1
  }
  const { table: next, added } = updateStockTable(table, { executor, workRoot: options.workRoot })
  if (added.length === 0) {
    console.log('Nothing to add: the stock table has every stable version.')
    return 0
  }
  writeFileSync(tablePath, serializeStockTable(next))
  console.log(`Added ${added.join(', ')} to ${tablePath}.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

