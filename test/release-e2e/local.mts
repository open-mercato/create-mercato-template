// Save then import contract test (spec Step 11). Saves a fresh
// create-mercato-app app as a template with this tool (prepare, then publish
// to the gh shim), creates a new app from it with create-mercato-app
// --app-url through a GitHub API stand-in on 127.0.0.1, then installs,
// initializes, builds and starts that app and signs in as the seeded admin.
// Nothing is sent to github.com and nothing is published to npm: "GitHub" is
// a set of bare repositories in the results directory, and no GitHub or npm
// credential reaches any command. See README.md in this directory.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as Inventory from '../../src/inventory.ts'
import type * as Stock from '../../src/stock.ts'
import type * as EnvFile from '../../src/env-file.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const toolRoot = path.resolve(here, '../..')
const requireDist = createRequire(path.join(toolRoot, 'dist', 'index.js'))

/** The repository the saved template is published to, in the shim only. */
export const repository = 'release-checks/saved-app'
/** The `@app` module added to the source app. */
export const moduleId = 'release_template'
export const moduleMarker = 'release-template-ok'
/** The declared env key, with a comment and a link, added to `.env.example`. */
export const declaredKey = 'RELEASE_TEMPLATE_GREETING'
export const declaredDescription = 'Greeting shown by the release_template module.'
export const declaredLink = 'https://docs.openmercato.com/'
/** The ignored `.env` key that must never leave the source app. */
export const fakeKeyName = 'OPENAI_API_KEY'
/** The seeded admin of a fresh app (`yarn initialize`). */
export const adminEmail = 'admin@acme.com'

const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]']

export type Options = { results: string; createApp: string; databaseUrl?: string }

/**
 * `--create-app <spec>` (default `create-mercato-app@latest`), `--results <dir>`
 * (default a new temp directory) and `--database-url <url>` (or
 * `RELEASE_E2E_DATABASE_URL`), a throwaway Postgres on this machine. Never a
 * remote database: the checks initialize it from scratch.
 */
export function parseLocalOptions(args: string[], environment: NodeJS.ProcessEnv = process.env): Options {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? ''
    const option = flag.replace(/^--/, '')
    const value = args[index + 1]
    if (!flag.startsWith('--') || !['results', 'create-app', 'database-url'].includes(option) || !value || value.startsWith('--') || values[option] !== undefined)
      throw new Error(`Invalid option: ${flag}. See test/release-e2e/README.md.`)
    values[option] = value
  }
  const createApp = values['create-app'] ?? 'create-mercato-app@latest'
  if (!/^create-mercato-app@[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(createApp))
    throw new Error('--create-app must be create-mercato-app@<version or tag>, for example create-mercato-app@0.9.0.')
  let database: URL | undefined
  const databaseValue = values['database-url'] ?? environment.RELEASE_E2E_DATABASE_URL
  if (databaseValue) {
    try { database = new URL(databaseValue) } catch {}
    if (!database || !['postgres:', 'postgresql:'].includes(database.protocol) || !loopbackHosts.includes(database.hostname) || !database.port || database.pathname.length < 2)
      throw new Error('--database-url must be a throwaway Postgres on this machine, for example postgres://postgres:<password>@127.0.0.1:54329/open-mercato. The checks initialize it from scratch.')
  }
  return { databaseUrl: database?.href, createApp, results: path.resolve(values.results ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-template-release-'))) }
}

/** A free port on 127.0.0.1, inside `RELEASE_E2E_PORTS` (`51210-51239`) when set. Copied from create-mercato-module. */
export async function freePort(range = process.env.RELEASE_E2E_PORTS): Promise<number> {
  const bounds = range ? /^(\d+)-(\d+)$/.exec(range) : null
  if (range && (!bounds || Number(bounds[1]) > Number(bounds[2]) || Number(bounds[1]) < 1024 || Number(bounds[2]) > 65535)) throw new Error('RELEASE_E2E_PORTS must be a range such as 51210-51239.')
  const candidates = bounds ? Array.from({ length: Number(bounds[2]) - Number(bounds[1]) + 1 }, (_, index) => Number(bounds[1]) + index) : [0]
  for (const candidate of candidates) {
    const port = await new Promise<number | undefined>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(undefined))
      server.listen(candidate, '127.0.0.1', () => {
        const address = server.address()
        server.close(() => resolve(address && typeof address !== 'string' ? address.port : undefined))
      })
    })
    if (port) return port
  }
  throw new Error(`No free port${range ? ` in RELEASE_E2E_PORTS ${range}` : ''}.`)
}

/** Removes URL credentials, prefixed npm and GitHub tokens and every given value. Copied from create-mercato-module. */
export function redact(text: string, secrets: string[]): string {
  let sanitized = text.replace(/(https?:\/\/|postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, '$1[REDACTED]@').replace(/(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]')
  for (const secret of secrets) if (secret.length >= 6) sanitized = sanitized.split(secret).join('[REDACTED]')
  return sanitized
}

/**
 * The fake key written to the ignored `.env`. Assembled at run time, never a
 * literal in this repository, and random for each run, so a match in the
 * published repository can only come from this run's `.env`.
 */
export function makeFakeKey(): string {
  return ['sk', 'proj', randomBytes(24).toString('base64url').replace(/[-_]/g, 'x')].join('-')
}

type ApiRequest = { method: string; path: string; authorization: boolean }

/**
 * The GitHub API stand-in that create-mercato-app reads through
 * `OM_CREATE_APP_GITHUB_API_BASE_URL`. It listens on 127.0.0.1 only and
 * answers the two URLs `ready-apps.ts` builds at v0.9.0 (lines 175 and 179):
 * `GET /repos/<o>/<r>` and `GET /repos/<o>/<r>/tarball/<ref>`, from the bare
 * repositories under `root`. The tarball is `git archive` of the commit, with
 * one top directory as GitHub's. Everything else is 404, and every request is
 * recorded.
 */
export async function serveGitHubApi(root: string): Promise<{ url: string; requests: ApiRequest[]; close: () => Promise<void> }> {
  const requests: ApiRequest[] = []
  const port = await freePort()
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push({ method: request.method ?? '', path: pathname, authorization: request.headers.authorization !== undefined })
    const notFound = () => { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Not Found' })) }
    const match = /^\/repos\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/tarball\/([^/]+))?$/.exec(pathname)
    if (request.method !== 'GET' || !match || match[2].endsWith('.git')) return notFound()
    const [, owner, repo, encodedRef] = match
    const bare = path.join(root, owner, `${repo}.git`)
    if (!fs.existsSync(path.join(bare, 'HEAD'))) return notFound()
    if (encodedRef === undefined) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ full_name: `${owner}/${repo}`, default_branch: 'main' }))
      return
    }
    let ref = ''
    try { ref = decodeURIComponent(encodedRef) } catch {}
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) return notFound()
    const commit = spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' })
    if (commit.status !== 0) return notFound()
    const sha = commit.stdout.trim()
    const archive = spawnSync('git', ['--git-dir', bare, 'archive', '--format=tar.gz', `--prefix=${owner}-${repo}-${sha.slice(0, 7)}/`, sha], { maxBuffer: 512 * 1024 * 1024 })
    if (archive.status !== 0) { response.writeHead(500).end(); return }
    response.writeHead(200, { 'content-type': 'application/x-gzip', 'content-length': String(archive.stdout.length) }).end(archive.stdout)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('Cannot start the GitHub API stand-in')); return }
      resolve({ url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

/**
 * Source of a module preloaded (`NODE_OPTIONS=--import`) into the
 * create-mercato-app process that imports the template: every `fetch` to an
 * origin other than `RELEASE_E2E_ALLOWED_ORIGIN` fails, so a version that
 * ignored `OM_CREATE_APP_GITHUB_API_BASE_URL` would fail here instead of
 * reaching api.github.com.
 */
export const fetchGuardSource = `const allowed = process.env.RELEASE_E2E_ALLOWED_ORIGIN
const original = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  if (!allowed || url.origin !== allowed) throw new Error('release checks: refused a request to ' + url.origin + '; only the loopback GitHub API stand-in may be reached')
  return original(input, init)
}
`

/**
 * Keys of a generated `.env.example` whose value is not empty and not a stock
 * value: for the app's pinned `@open-mercato/core` version when the table
 * knows it, any known version otherwise (the tool's own rule, spec "Env diff").
 */
export function nonStockValues(envExample: string, coreVersion: string | null): string[] {
  const { parseEnvAssignments } = requireDist('./env-file.js') as typeof EnvFile
  const { matchStock, isStockValue } = requireDist('./stock.js') as typeof Stock
  const match = matchStock(coreVersion)
  return parseEnvAssignments(envExample).filter((entry) => entry.value !== '' && !isStockValue(match, entry.key, entry.value)).map((entry) => `${entry.key} (line ${entry.line})`)
}

/** The inventory of `src/modules.ts` (with the official modules file it reads), by this tool's own reader. */
export function readAppInventory(app: string): Inventory.InventoryEntry[] {
  const { readInventory } = requireDist('./inventory.js') as typeof Inventory
  const contents = new Map<string, Buffer>()
  for (const file of ['src/modules.ts', 'src/official-modules.generated.ts']) {
    const full = path.join(app, file)
    if (fs.existsSync(full)) contents.set(file, fs.readFileSync(full))
  }
  const inventory = readInventory(contents)
  assert.deepEqual(inventory.unparsed, [], `${app}: src/modules.ts must be read without unparsed constructs`)
  return inventory.entries
}

/** Files under `directory` (not following symlinks, skipping `node_modules` and `.git`) whose bytes contain `needle`. */
export function filesContaining(directory: string, needle: string): string[] {
  const found: string[] = []
  const bytes = Buffer.from(needle)
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') walk(full) }
      else if (entry.isFile() && fs.readFileSync(full).includes(bytes)) found.push(path.relative(directory, full))
    }
  }
  walk(directory)
  return found
}

/** True when any object of the Git repository at `gitDir` (every blob, tree and commit, reachable or not) contains `needle`. */
export function repositoryContains(gitDir: string, needle: string): boolean {
  const objects = spawnSync('git', ['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch', '--unordered'], { maxBuffer: 1024 * 1024 * 1024 })
  if (objects.status !== 0) throw new Error(`Cannot read the objects of ${gitDir}`)
  return objects.stdout.includes(Buffer.from(needle))
}

/**
 * Yarn 4.18.1 fixes the registry retry crash of the scaffold's 4.17.1
 * (yarnpkg/berry#7249), as in the create-mercato-module checks. The source app
 * is pinned before its install, so the template and the imported app keep it.
 */
export function pinYarn(app: string): void {
  const file = path.join(app, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.packageManager = 'yarn@4.18.1'
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** True when `src/modules.ts` registers the module `id`. Copied from create-mercato-module. */
export function hasEnabledModule(source: string, id: string): boolean {
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error('Invalid module id.')
  return new RegExp(`\\bid\\s*:\\s*['"]${id}['"]`).test(source)
}

/** True when the app's installed `@open-mercato/core` has the api_keys module. */
function coreHasApiKeys(app: string): boolean {
  try {
    createRequire(path.join(app, 'package.json')).resolve('@open-mercato/core/modules/api_keys')
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    return false
  }
}

/** Adds the `@app` module and registers it in `src/modules.ts`, as an author would. */
export function addAppModule(app: string): void {
  const route = path.join(app, 'src/modules', moduleId, 'api/status/route.ts')
  if (fs.existsSync(path.dirname(path.dirname(route)))) throw new Error(`Refusing to overwrite ${moduleId} in ${app}`)
  fs.mkdirSync(path.dirname(route), { recursive: true })
  fs.writeFileSync(route, [
    'export const metadata = {',
    '  GET: { requireAuth: true },',
    '}',
    '',
    'export async function GET() {',
    `  return Response.json({ marker: '${moduleMarker}' })`,
    '}',
    '',
  ].join('\n'))
  const modulesFile = path.join(app, 'src/modules.ts')
  const source = fs.readFileSync(modulesFile, 'utf8')
  const updated = source.replace(/(export const enabledModules: ModuleEntry\[\] = \[\n)/, `$1  { id: '${moduleId}', from: '@app' },\n`)
  assert.notEqual(updated, source, 'src/modules.ts must have the scaffold\'s enabledModules array')
  fs.writeFileSync(modulesFile, updated)
}

/** Appends the declared key, with its comment and link, to `.env.example`. */
export function addDeclaredEnv(app: string): void {
  const file = path.join(app, '.env.example')
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(!text.includes(`${declaredKey}=`), `${declaredKey} must not be in the stock .env.example`)
  fs.writeFileSync(file, `${text.replace(/\n*$/, '\n')}\n# ${declaredDescription}\n# ${declaredLink}\n${declaredKey}=hello-from-the-source-app\n`)
}

type Envelope = { ok: boolean; exitCode: number; failures: { rule: string; message: string }[]; [key: string]: unknown }

export async function main(args: string[]): Promise<void> {
  const options = parseLocalOptions(args)
  fs.mkdirSync(options.results, { recursive: true })
  if (fs.readdirSync(options.results).length > 0) throw new Error(`--results must be a new or empty directory: ${options.results}`)
  const toolBin = path.join(toolRoot, 'bin', 'cli.cjs')
  assert.ok(fs.existsSync(path.join(toolRoot, 'dist', 'cli.js')), 'Build the tool first: npm run build')
  const yarn = process.env.RELEASE_E2E_YARN ?? 'yarn'
  const npm = process.env.RELEASE_E2E_NPM ?? 'npm'

  const fakeKey = makeFakeKey()
  const adminPassword = randomBytes(18).toString('base64url')
  // Production mode refuses the stock placeholder signing secrets, so the
  // imported app gets new ones, as a user sets them in .env after the import.
  const jwtSecret = randomBytes(32).toString('hex')
  const authSecret = randomBytes(32).toString('hex')
  const secrets = [fakeKey, adminPassword, jwtSecret, authSecret, ...(options.databaseUrl ? [decodeURIComponent(new URL(options.databaseUrl).password)] : [])]

  const githubRoot = path.join(options.results, 'github')
  const binaries = path.join(options.results, 'bin')
  fs.mkdirSync(githubRoot, { recursive: true })
  fs.mkdirSync(binaries, { recursive: true })
  fs.writeFileSync(path.join(binaries, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(here, 'gh-shim.mjs'))} "$@"\n`, { mode: 0o755 })
  const guard = path.join(options.results, 'fetch-guard.mjs')
  fs.writeFileSync(guard, fetchGuardSource)
  // Git runs with a configuration of its own: no user insteadOf, signing or hook settings apply.
  const gitConfig = path.join(options.results, 'gitconfig')
  fs.writeFileSync(gitConfig, '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n')

  // Every command sees the gh shim first and no GitHub or npm credential.
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    PATH: `${binaries}${path.delimiter}${process.env.PATH ?? ''}`,
    RELEASE_E2E_GITHUB_ROOT: githubRoot,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    YARN_ENABLE_PROGRESS_BARS: '0',
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
  }
  for (const name of Object.keys(environment))
    if (/^(?:GH_|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|NODE_AUTH_TOKEN$|NPM_TOKEN$|npm_config_.*auth|NPM_CONFIG_.*AUTH|RELEASE_E2E_DATABASE_URL$|OM_CREATE_APP_GITHUB_API_BASE_URL$)/i.test(name)) delete environment[name]

  const stages: { stage: string; status: string; durationMs: number }[] = []
  const writeResults = (extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(path.join(options.results, 'local-results.json'), JSON.stringify({ createdAt: new Date().toISOString(), createApp: options.createApp, repository, stages, ...extra }, null, 2) + '\n')

  async function command(stage: string, executable: string, commandArgs: string[], cwd: string, extra: NodeJS.ProcessEnv = {}, allowed: number[] = [0]): Promise<{ code: number; output: string; stdout: string }> {
    const started = Date.now()
    process.stdout.write(`\n🧪 local: ${stage}\n`)
    const logfile = path.join(options.results, `local-${stage.replace(/[^a-z0-9-]/gi, '-')}.log`)
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, commandArgs, { cwd, env: { ...environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let stdout = ''
      const timeout = setTimeout(() => { child.kill('SIGTERM') }, 20 * 60 * 1000)
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timeout)
        const sanitized = redact(output, secrets)
        fs.writeFileSync(logfile, sanitized)
        const ok = code !== null && allowed.includes(code)
        stages.push({ stage, status: ok ? 'passed' : 'failed', durationMs: Date.now() - started })
        if (!ok) reject(new Error(`local/${stage} exited ${code}. Diagnostics: ${logfile}\n${sanitized.slice(-4000)}`))
        else resolve({ code: code ?? 0, output, stdout })
      })
    })
  }
  const check = (stage: string, action: () => void) => {
    const started = Date.now()
    process.stdout.write(`\n🔍 local: ${stage}\n`)
    try { action(); stages.push({ stage, status: 'passed', durationMs: Date.now() - started }) }
    catch (error) { stages.push({ stage, status: 'failed', durationMs: Date.now() - started }); throw error }
  }
  const tool = async (stage: string, toolArgs: string[], cwd: string): Promise<Envelope> => {
    const result = await command(stage, process.execPath, [toolBin, ...toolArgs], cwd, {}, [0, 1, 2, 3, 4])
    const envelope = JSON.parse(result.stdout) as Envelope
    assert.equal(result.code, 0, `${toolArgs[0]} must succeed: ${redact(JSON.stringify(envelope.failures), secrets)}`)
    assert.equal(envelope.ok, true)
    return envelope
  }

  let api: Awaited<ReturnType<typeof serveGitHubApi>> | undefined
  try {
    // One create-mercato-app install serves the scaffold and the import, so both use the same version.
    const createAppDir = path.join(options.results, 'create-app')
    fs.mkdirSync(createAppDir)
    await command('install-create-mercato-app', npm, ['install', '--prefix', createAppDir, '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', options.createApp], options.results)
    const createAppManifest = JSON.parse(fs.readFileSync(path.join(createAppDir, 'node_modules/create-mercato-app/package.json'), 'utf8')) as { version: string; bin: string | Record<string, string> }
    const createAppBin = path.join(createAppDir, 'node_modules/create-mercato-app', typeof createAppManifest.bin === 'string' ? createAppManifest.bin : createAppManifest.bin['create-mercato-app'])
    process.stdout.write(`create-mercato-app ${createAppManifest.version}\n`)

    // 1. A fresh app, as the create-mercato-module release checks scaffold it.
    const sourceApp = path.join(options.results, 'source-app')
    await command('scaffold-source-app', process.execPath, [createAppBin, 'source-app', '--preset', 'empty', '--agents', 'none', '--no-init-git'], options.results)
    pinYarn(sourceApp)
    // The scaffold's yarn.lock is a stub: an author installs before saving, and prepare refuses an unresolved lockfile.
    await command('install-source-app', yarn, ['install'], sourceApp)
    // `yarn initialize` of core 0.9.0 reads the api_keys entities, which the
    // empty preset does not enable; enable it when the core has it, as the
    // create-mercato-module checks do. An author change like the others.
    if (coreHasApiKeys(sourceApp) && !hasEnabledModule(fs.readFileSync(path.join(sourceApp, 'src/modules.ts'), 'utf8'), 'api_keys'))
      await command('enable-api-keys', yarn, ['mercato', 'module', 'enable', '@open-mercato/core', '--module', 'api_keys'], sourceApp)
    addAppModule(sourceApp)
    addDeclaredEnv(sourceApp)
    fs.writeFileSync(path.join(sourceApp, '.env'), `# Local secrets, never committed.\n${fakeKeyName}=${fakeKey}\n`)
    await command('git-init-source-app', 'git', ['init', '-q'], sourceApp)
    await command('git-add-source-app', 'git', ['add', '-A'], sourceApp)
    await command('git-commit-source-app', 'git', ['-c', 'user.name=Release Checks', '-c', 'user.email=release-checks@example.invalid', 'commit', '-q', '-m', 'Source app'], sourceApp)
    check('env-file-ignored', () => {
      assert.equal(spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: sourceApp, env: environment }).status, 0, '.env must be ignored by the scaffold')
      assert.equal(spawnSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: sourceApp, env: environment }).status, 1, '.env must not be committed')
    })

    // 2. Save: prepare, then publish to the shim.
    const out = path.join(options.results, 'snapshot')
    const prepared = await tool('prepare', ['prepare', sourceApp, '--out', out, '--json'], options.results)
    const snapshotId = prepared.snapshotId
    assert.ok(typeof snapshotId === 'string' && /^[0-9a-f]{64}$/.test(snapshotId), 'prepare must return a snapshotId')
    check('manifest', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'tree/mercato-template.json'), 'utf8')) as { modules: { id: string; from: string }[]; env?: { name: string; description?: string; link?: string }[] }
      assert.ok(manifest.modules.some((entry) => entry.id === moduleId && entry.from === '@app'), `The manifest must list the ${moduleId} module from @app`)
      assert.deepEqual(manifest.env?.find((entry) => entry.name === declaredKey), { name: declaredKey, description: declaredDescription, link: declaredLink })
    })
    const published = await tool('publish', ['publish', '--from', out, '--repo', repository, '--public', '--expect', snapshotId, '--json'], options.results)
    const bare = path.join(githubRoot, `${repository}.git`)
    const commit = published.commit as { sha?: string } | string | null
    const commitSha = typeof commit === 'string' ? commit : commit?.sha
    assert.ok(commitSha && /^[0-9a-f]{40}$/.test(commitSha), 'publish must return the commit')
    check('published-repository', () => {
      const git = (gitArgs: string[]) => spawnSync('git', ['--git-dir', bare, ...gitArgs], { encoding: 'utf8', env: environment }).stdout.trim()
      assert.equal(git(['rev-parse', 'main']), commitSha, 'main must be the published commit')
      assert.equal(git(['rev-list', '--count', 'main']), '1', 'The template repository must have one commit')
      const details = JSON.parse(fs.readFileSync(`${bare}.json`, 'utf8')) as { is_template?: boolean; private?: boolean; topics?: string[] }
      assert.equal(details.is_template, true, 'The repository must be a template')
      assert.equal(details.private, false)
      for (const topic of ['open-mercato-template', 'open-mercato']) assert.ok(details.topics?.includes(topic), `The repository must have the topic ${topic}`)
    })

    // 3. The fake key from the ignored .env appears nowhere in the published repository, or in what the tool wrote.
    check('fake-key-not-published', () => {
      assert.equal(repositoryContains(bare, fakeKey), false, 'The fake key must not be in any object of the published repository')
      assert.deepEqual(filesContaining(out, fakeKey), [], 'The fake key must not be in the prepare output')
      assert.deepEqual(filesContaining(githubRoot, fakeKey), [], 'The fake key must not be in the shim root')
    })

    // 4. Import: create-mercato-app --app-url, reading the shim's repository through the loopback API only.
    api = await serveGitHubApi(githubRoot)
    await command('import-app', process.execPath, [createAppBin, 'imported-app', '--app-url', `https://github.com/${repository}/tree/${commitSha}`, '--no-init-git'], options.results, {
      OM_CREATE_APP_GITHUB_API_BASE_URL: api.url,
      RELEASE_E2E_ALLOWED_ORIGIN: api.url,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(guard).href}`.trim(),
    })
    const importedApp = path.join(options.results, 'imported-app')
    check('import-read-loopback-api', () => {
      const requests = api!.requests
      assert.ok(requests.some((request) => request.method === 'GET' && request.path === `/repos/${repository}/tarball/${commitSha}`), 'create-mercato-app must download the tarball from the loopback API')
      assert.ok(requests.every((request) => !request.authorization), 'No credential may be sent to the API stand-in')
    })
    check('inventory-equal', () => {
      const source = readAppInventory(sourceApp)
      assert.ok(source.some((entry) => entry.id === moduleId), `The source inventory must list ${moduleId}`)
      assert.deepEqual(readAppInventory(importedApp), source, 'The imported app must register the same modules as the source app')
    })
    check('env-example-stock-only', () => {
      const text = fs.readFileSync(path.join(importedApp, '.env.example'), 'utf8')
      const manifest = JSON.parse(fs.readFileSync(path.join(importedApp, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
      const core = manifest.dependencies?.['@open-mercato/core'] ?? null
      assert.deepEqual(nonStockValues(text, core && /^\d+\.\d+\.\d+$/.test(core) ? core : null), [], 'The imported .env.example may hold only stock values')
      assert.match(text, new RegExp(`^${declaredKey}=$`, 'm'), `${declaredKey} must be declared with an empty value`)
    })
    check('fake-key-not-imported', () => {
      assert.deepEqual(filesContaining(importedApp, fakeKey), [], 'The fake key must not be in the imported app')
      assert.equal(fs.existsSync(path.join(importedApp, '.env')), false, 'The imported app must have no .env')
    })
    await api.close()
    api = undefined

    // 5. The imported app runs: install, initialize, build, start, sign in.
    if (!options.databaseUrl) {
      process.stdout.write('\nℹ️ Full app run skipped: pass --database-url (a throwaway Postgres on this machine) to install, initialize, build, start and sign in.\n')
    } else {
      fs.copyFileSync(path.join(importedApp, '.env.example'), path.join(importedApp, '.env'))
      const port = await freePort()
      const baseUrl = `http://127.0.0.1:${port}`
      const appEnvironment: NodeJS.ProcessEnv = {
        DATABASE_URL: options.databaseUrl, PORT: String(port), APP_URL: baseUrl, NEXT_PUBLIC_APP_URL: baseUrl, INTERNAL_APP_ORIGIN: baseUrl,
        JWT_SECRET: jwtSecret, AUTH_SECRET: authSecret, NEXTAUTH_SECRET: authSecret,
        OM_INIT_ADMIN_PASSWORD: adminPassword, OM_INIT_EMPLOYEE_PASSWORD: adminPassword, AUTO_SPAWN_WORKERS: 'false', AUTO_SPAWN_SCHEDULER: 'false',
      }
      await command('imported-install', yarn, ['install'], importedApp, appEnvironment)
      // A template carries no generated files (.mercato/generated is git-ignored), so generate before initialize.
      await command('imported-generate', yarn, ['generate'], importedApp, appEnvironment)
      await command('imported-initialize', yarn, ['initialize'], importedApp, appEnvironment)
      await command('imported-build', yarn, ['build'], importedApp, appEnvironment)
      await signIn(importedApp, baseUrl, appEnvironment)
    }
    process.stdout.write(`\n✅ Save then import passed with ${options.createApp} (${createAppManifest.version}), without contacting github.com. Results: ${options.results}\n`)
    writeResults({ createAppVersion: createAppManifest.version, snapshotId, commit: commitSha, fullApp: Boolean(options.databaseUrl) })
  } catch (error) {
    writeResults()
    throw error
  } finally {
    await api?.close()
  }

  // Starts the built app and signs in as the seeded admin; the @app module answers the signed-in user only.
  async function signIn(app: string, baseUrl: string, appEnvironment: NodeJS.ProcessEnv): Promise<void> {
    const started = Date.now()
    process.stdout.write('\n🌐 local: start the imported app and sign in\n')
    let output = ''
    const child = spawn(yarn, ['start'], { cwd: app, env: { ...environment, ...appEnvironment }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let exited = false
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('close', () => { exited = true })
    try {
      let ready = false
      while (!ready && Date.now() - started < 5 * 60 * 1000) {
        if (exited) throw new Error(`The imported app stopped before it answered requests:\n${redact(output, secrets).slice(-4000)}`)
        try { ready = (await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(30000) })).status === 200 } catch {}
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      assert.ok(ready, 'The imported app must serve its login page within five minutes')
      const route = `${baseUrl}/api/${moduleId}/status`
      assert.equal((await fetch(route, { signal: AbortSignal.timeout(60000) })).status, 401, 'The @app module API must refuse anonymous requests')
      const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: adminEmail, password: adminPassword }).toString(), signal: AbortSignal.timeout(60000) })
      assert.equal(login.status, 200, 'The seeded admin must be able to sign in')
      const session = (await login.json()) as { token?: string }
      assert.ok(session.token, 'Sign-in must return a token')
      const answer = await fetch(route, { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(60000) })
      assert.equal(answer.status, 200, 'The @app module API must answer the signed-in admin')
      assert.deepEqual(await answer.json(), { marker: moduleMarker })
      stages.push({ stage: 'imported-start-sign-in', status: 'passed', durationMs: Date.now() - started })
    } catch (error) {
      stages.push({ stage: 'imported-start-sign-in', status: 'failed', durationMs: Date.now() - started })
      throw error
    } finally {
      if (child.pid && child.exitCode === null) {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 10000)
        await closed
        clearTimeout(force)
      }
      fs.writeFileSync(path.join(options.results, 'local-imported-server.log'), redact(output, secrets))
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
