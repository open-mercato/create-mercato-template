const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const allowed = /^(bin\/|dist\/|docs\/|README\.md$|LICENSE$|package\.json$)/

// npm 11 prints `npm pack --json` as an array; npm 12 as an object keyed by package name.
function packEntries(output) {
  const parsed = JSON.parse(output)
  return Array.isArray(parsed) ? parsed : Object.values(parsed ?? {})
}

test('npm pack ships only the files entries of package.json', () => {
  // Scripts are skipped: `npm test` has already built dist/.
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const [entry] = packEntries(result.stdout)
  const files = entry.files.map((file) => file.path)
  assert.ok(files.includes('bin/cli.cjs'))
  assert.ok(files.includes('dist/cli.js'))
  assert.ok(files.includes('LICENSE'))
  // src/ is not shipped, so a source map would point at missing files.
  assert.deepEqual(files.filter((file) => file.endsWith('.map')), [])
  assert.deepEqual(files.filter((file) => !allowed.test(file)), [])
})
