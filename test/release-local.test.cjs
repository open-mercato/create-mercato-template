// Spec Step 11: the parts of the save then import release checks
// (test/release-e2e/local.mts) that run without network: the option checks,
// the GitHub API stand-in on 127.0.0.1, the fetch guard of the import, the
// checks the release checks make on the imported app, and the security limits
// of the release-checks job. The full run (scaffold, install, build, start,
// sign in) is the release-checks job itself; see test/release-e2e/README.md.
//
// The fake key is assembled at test time (AGENTS.md).
const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')
const { pathToFileURL, URL } = require('node:url')
const YAML = require('yaml')
const { prepare } = require('../dist/prepare.js')
const { git, gitEnvironment, tempDir, writeFixtureApp } = require('./helpers/fixture-app.cjs')
const { stockAppFiles, stockEnvExample } = require('./helpers/stock-app.cjs')

let local
before(async () => {
  local = await import(pathToFileURL(path.join(__dirname, 'release-e2e', 'local.mts')).href)
})

/** A bare repository like the shim's, with one commit holding `files`. Returns `{ root, bare, sha }`. */
function shimRepository(files) {
  const root = tempDir('cmt-gh-')
  const work = tempDir('cmt-work-')
  git(work, ['init', '-q', '-b', 'main', '--template='])
  writeFixtureApp(work, files, { base: false })
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'Template'])
  const bare = path.join(root, 'acme', 'saved.git')
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  git(root, ['clone', '-q', '--bare', work, bare])
  return { root, bare, sha: git(work, ['rev-parse', 'HEAD']).toString().trim() }
}

/** The entry names of an uncompressed tar archive. */
function tarNames(tar) {
  const names = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    if (name === '') break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    if (type !== 'g' && type !== 'x') names.push(prefix ? `${prefix}/${name}` : name)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

test('options: the database must be a Postgres on this machine, the scaffold a create-mercato-app version', () => {
  const results = tempDir('cmt-results-')
  const ok = local.parseLocalOptions(['--create-app', 'create-mercato-app@0.9.0', '--results', results, '--database-url', 'postgres://postgres:pw@127.0.0.1:54329/open-mercato'], {})
  assert.equal(ok.createApp, 'create-mercato-app@0.9.0')
  assert.equal(ok.results, results)
  assert.equal(new URL(ok.databaseUrl).hostname, '127.0.0.1')
  assert.equal(local.parseLocalOptions([], {}).createApp, 'create-mercato-app@latest')
  assert.equal(local.parseLocalOptions([], {}).databaseUrl, undefined)
  assert.equal(new URL(local.parseLocalOptions([], { RELEASE_E2E_DATABASE_URL: 'postgresql://u:p@localhost:5432/db' }).databaseUrl).hostname, 'localhost')
  for (const url of ['postgres://u:p@db.example.com:5432/db', 'postgres://u:p@10.0.0.5:5432/db', 'mysql://u:p@127.0.0.1:3306/db', 'postgres://u:p@127.0.0.1/db', 'postgres://u:p@127.0.0.1:5432/', 'not a url'])
    assert.throws(() => local.parseLocalOptions(['--database-url', url], {}), /--database-url must be a throwaway Postgres on this machine/, url)
  assert.throws(() => local.parseLocalOptions([], { RELEASE_E2E_DATABASE_URL: 'postgres://u:p@db.example.com:5432/db' }), /throwaway Postgres/)
  for (const spec of ['create-mercato-module@1.0.0', 'create-mercato-app', 'create-mercato-app@0.9.0 --evil', 'evil@latest'])
    assert.throws(() => local.parseLocalOptions(['--create-app', spec], {}), /--create-app must be/, spec)
  for (const args of [['--registry', 'x'], ['--results'], ['--results', '--create-app'], ['results', 'x'], ['--results', 'a', '--results', 'b']])
    assert.throws(() => local.parseLocalOptions(args, {}), /Invalid option/, args.join(' '))
})

test('the GitHub API stand-in listens on 127.0.0.1 and answers only the repo and tarball URLs of ready-apps.ts', async () => {
  const { root, sha } = shimRepository({ 'package.json': '{"name":"saved"}\n', 'src/modules.ts': 'export const enabledModules = []\n' })
  const api = await local.serveGitHubApi(root)
  try {
    const url = new URL(api.url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.protocol, 'http:')

    const repo = await fetch(`${api.url}/repos/acme/saved`)
    assert.equal(repo.status, 200)
    assert.equal((await repo.json()).default_branch, 'main')

    for (const ref of [sha, 'main']) {
      const tarball = await fetch(`${api.url}/repos/acme/saved/tarball/${encodeURIComponent(ref)}`)
      assert.equal(tarball.status, 200, ref)
      const names = tarNames(zlib.gunzipSync(Buffer.from(await tarball.arrayBuffer())))
      // One top directory, as GitHub's tarballs; create-mercato-app strips it.
      const top = `acme-saved-${sha.slice(0, 7)}/`
      assert.ok(names.every((name) => name.startsWith(top)), names.join(','))
      assert.ok(names.includes(`${top}package.json`) && names.includes(`${top}src/modules.ts`), names.join(','))
    }

    const missing = [
      ['GET', '/repos/acme/other'],
      ['GET', '/repos/acme/other/tarball/main'],
      ['GET', '/repos/acme/saved/tarball/no-such-ref'],
      ['GET', '/repos/acme/saved/tarball/..%2F..%2Fetc'],
      ['GET', '/repos/acme/saved.git'],
      ['GET', '/repos/acme/saved/commits/main'],
      ['GET', '/acme/saved.git/HEAD'],
      ['POST', '/repos/acme/saved'],
      ['DELETE', '/repos/acme/saved'],
    ]
    for (const [method, pathname] of missing) assert.equal((await fetch(`${api.url}${pathname}`, { method })).status, 404, `${method} ${pathname}`)

    await fetch(`${api.url}/repos/acme/saved`, { headers: { authorization: 'Bearer x' } })
    assert.equal(api.requests.length, 1 + 2 + missing.length + 1)
    assert.deepEqual(api.requests[0], { method: 'GET', path: '/repos/acme/saved', authorization: false })
    assert.equal(api.requests.at(-1).authorization, true)
  } finally {
    await api.close()
  }
})

test('the fetch guard of the import refuses every origin but the stand-in, before any network', async () => {
  const dir = tempDir('cmt-guard-')
  const guard = path.join(dir, 'guard.mjs')
  fs.writeFileSync(guard, local.fetchGuardSource)
  const server = http.createServer((_request, response) => response.end('stand-in'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const allowed = `http://127.0.0.1:${server.address().port}`
  const script = `
    const results = []
    for (const target of process.argv.slice(1)) {
      try { const response = await fetch(target); results.push(await response.text()) } catch (error) { results.push('refused: ' + error.message) }
    }
    console.log(JSON.stringify(results))
  `
  const run = (environment) => {
    // Async, so this process keeps serving the stand-in while the child fetches.
    return new Promise((resolve) => {
      const child = require('node:child_process').spawn(process.execPath, ['--import', pathToFileURL(guard).href, '--input-type=module', '-e', script, `${allowed}/repos/acme/saved`, 'https://api.github.com/repos/acme/saved', 'http://127.0.0.2:9/', new URL('/x', allowed.replace('127.0.0.1', 'localhost')).href], { env: { ...process.env, ...environment } })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.on('close', (status) => resolve({ status, stdout }))
    })
  }
  try {
    const guarded = await run({ RELEASE_E2E_ALLOWED_ORIGIN: allowed })
    assert.equal(guarded.status, 0)
    const [stand, github, other, alias] = JSON.parse(guarded.stdout)
    assert.equal(stand, 'stand-in')
    assert.match(github, /^refused: release checks: refused a request to https:\/\/api\.github\.com/)
    assert.match(other, /^refused: release checks: refused/)
    assert.match(alias, /^refused: release checks: refused/)
    // Without an allowed origin nothing at all may be fetched.
    const closed = JSON.parse((await run({ RELEASE_E2E_ALLOWED_ORIGIN: '' })).stdout)
    assert.ok(closed.every((result) => result.startsWith('refused: release checks')), closed.join(','))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the author changes of the release checks give the @app module and the declared env in the manifest, and a stock-only .env.example', () => {
  const app = tempDir('cmt-app-')
  git(app, ['init', '-q', '-b', 'main', '--template='])
  writeFixtureApp(app, stockAppFiles())
  local.addAppModule(app)
  local.addDeclaredEnv(app)
  assert.throws(() => local.addAppModule(app), /Refusing to overwrite/)
  git(app, ['add', '-A'])
  git(app, ['commit', '-q', '-m', 'Source app'])

  const added = local.readAppInventory(app).find((entry) => entry.id === local.moduleId)
  assert.equal(added?.from, '@app')
  assert.equal(added.when, undefined)

  const out = path.join(tempDir('cmt-out-'), 'out')
  const result = prepare({ app, out, environment: gitEnvironment() })
  assert.deepEqual(result.report.findings.filter((finding) => finding.level === 'error'), [])
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'tree', 'mercato-template.json'), 'utf8'))
  assert.ok(manifest.modules.some((entry) => entry.id === local.moduleId && entry.from === '@app'))
  // The exact entry local.mts asserts after prepare.
  assert.deepEqual(manifest.env.find((entry) => entry.name === local.declaredKey), { name: local.declaredKey, description: local.declaredDescription, link: local.declaredLink })

  const generated = fs.readFileSync(path.join(out, 'tree', '.env.example'), 'utf8')
  assert.deepEqual(local.nonStockValues(generated, '0.9.0'), [])
  assert.match(generated, new RegExp(`^${local.declaredKey}=$`, 'm'))
})

test('nonStockValues reports a value that is not stock, by key and line, never the value', () => {
  const stock = stockEnvExample()
  assert.deepEqual(local.nonStockValues(stock, '0.9.0'), [])
  const value = ['changed', 'by', 'author'].join('-')
  const changed = stock.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${value}`)
  const line = changed.split('\n').findIndex((text) => text.startsWith('JWT_SECRET=')) + 1
  assert.deepEqual(local.nonStockValues(changed, '0.9.0'), [`JWT_SECRET (line ${line})`])
  assert.deepEqual(local.nonStockValues(`${stock}\nNEW_KEY=\n# OTHER_KEY=\n`, '0.9.0'), [])
  assert.deepEqual(local.nonStockValues('NEW_KEY=value\n', '0.9.0'), ['NEW_KEY (line 1)'])
  // An unknown version: a value stock in any known version passes.
  assert.deepEqual(local.nonStockValues('JWT_SECRET=change-me-dev-secret\n', '99.0.0'), [])
  assert.deepEqual(local.nonStockValues('JWT_SECRET=change-me-dev-secret\n', null), [])
})

test('the fake key search covers every object of the published repository and every written file', () => {
  const key = local.makeFakeKey()
  assert.match(key, /^sk-proj-[A-Za-z0-9]{32}$/)
  assert.notEqual(local.makeFakeKey(), key)
  const clean = shimRepository({ 'README.md': '# Saved\n' })
  assert.equal(local.repositoryContains(clean.bare, key), false)
  assert.deepEqual(local.filesContaining(clean.root, key), [])

  const leaked = shimRepository({ 'README.md': '# Saved\n', 'src/config.ts': `export const key = '${key}'\n` })
  assert.equal(local.repositoryContains(leaked.bare, key), true)
  // An unreachable object counts too.
  const dangling = shimRepository({ 'README.md': '# Saved\n' })
  spawnSync('git', ['--git-dir', dangling.bare, 'hash-object', '-w', '--stdin'], { input: `x ${key}\n`, env: gitEnvironment() })
  assert.equal(local.repositoryContains(dangling.bare, key), true)

  const dir = tempDir('cmt-files-')
  fs.mkdirSync(path.join(dir, 'a', 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a', 'node_modules', 'x.js'), key)
  assert.deepEqual(local.filesContaining(dir, key), [])
  fs.writeFileSync(path.join(dir, 'a', 'report.json'), `{"k":"${key}"}`)
  assert.deepEqual(local.filesContaining(dir, key), [path.join('a', 'report.json')])
})

test('redact removes URL credentials, prefixed tokens and the run secrets from logs', () => {
  const password = ['pg', 'pass', 'word', '42'].join('')
  const token = ['ghp', 'A'.repeat(36)].join('_')
  const text = `postgres://postgres:${password}@127.0.0.1:5432/db https://user:pw@example.com/x ${token} admin ${password}`
  const clean = local.redact(text, [password])
  assert.equal(clean.includes(password), false)
  assert.equal(clean.includes(token), false)
  assert.equal(clean.includes('user:pw'), false)
})

test('the release-checks job: read-only token, no secrets, no pull_request_target, two legs, throwaway Postgres', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8')
  const workflow = YAML.parse(text)
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch'])
  assert.deepEqual(workflow.on.push, { branches: ['main'] })
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(text.includes('pull_request_target'), false)
  assert.equal(/\bsecrets\./.test(text), false, 'no step may read a repository or organization secret')
  assert.equal(/GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN/.test(text), false)
  assert.equal(/npm publish|gh repo create|git push/.test(text), false)

  const job = workflow.jobs['release-checks']
  assert.ok(job, 'the release-checks job exists')
  assert.equal(job.permissions, undefined, 'the job keeps the workflow permissions')
  assert.deepEqual(job.strategy.matrix.include.map((leg) => leg.scaffold), ['create-mercato-app@0.9.0', 'create-mercato-app@latest'])
  for (const step of job.steps) if (step.uses?.startsWith('actions/checkout')) assert.equal(step.with['persist-credentials'], false)
  const steps = JSON.stringify(job.steps)
  assert.match(steps, /openssl rand/, 'the Postgres password is generated per run')
  assert.match(steps, /::add-mask::/, 'the generated password is masked in the log')
  assert.match(steps, /-p 127\.0\.0\.1:/, 'Postgres listens on loopback only')
  assert.equal(/POSTGRES_PASSWORD=postgres\b/.test(steps), false, 'no fixed Postgres password')
  assert.match(steps, /test:release:local/)
})
