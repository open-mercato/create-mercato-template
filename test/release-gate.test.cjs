// Spec Step 12: the release waits until the vendored catalog schemas are the
// files the catalog serves. test/fixtures/catalog/SOURCE.md carries the
// "Release blocked" line until then, AGENTS.md and CHANGELOG.md repeat it, and
// `npm publish` runs scripts/release-gate.mts, which refuses while it is there.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const marker = 'Release blocked (spec Step 12) until the catalog serves these files'
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

function runGate(dir) {
  return spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(dir, 'scripts', 'release-gate.mts')], { encoding: 'utf8' })
}

/** A copy of the gate script next to a SOURCE.md with the given text. */
function gateCopy(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-gate-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(path.join(root, 'scripts', 'release-gate.mts'), path.join(dir, 'scripts', 'release-gate.mts'))
  fs.mkdirSync(path.join(dir, 'test', 'fixtures', 'catalog'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'catalog', 'SOURCE.md'), source)
  return dir
}

test('npm publish runs the release gate', () => {
  const { scripts } = JSON.parse(read('package.json'))
  assert.match(scripts.prepublishOnly, /scripts\/release-gate\.mts$/)
})

test('the release gate refuses while SOURCE.md has the Release blocked line, and passes without it', () => {
  const blocked = gateCopy(`# Catalog fixtures\n\n${marker}.\n`)
  const open = gateCopy('# Catalog fixtures\n\nCopied from the served files.\n')
  try {
    const refused = runGate(blocked)
    assert.equal(refused.status, 1)
    assert.ok(refused.stderr.includes(`${marker}.`), refused.stderr)
    const passed = runGate(open)
    assert.equal(passed.status, 0, passed.stderr)
  } finally {
    fs.rmSync(blocked, { recursive: true, force: true })
    fs.rmSync(open, { recursive: true, force: true })
  }
})

test('SOURCE.md, AGENTS.md and CHANGELOG.md agree on the release gate', () => {
  const blocked = read('test/fixtures/catalog/SOURCE.md')
    .split('\n')
    .some((line) => line.startsWith(marker))
  for (const file of ['AGENTS.md', 'CHANGELOG.md']) assert.equal(read(file).includes(marker), blocked, file)
  // The vendored schemas are not the published files yet (spec Step 12).
  assert.equal(blocked, true)
  assert.equal(runGate(root).status, 1)
})
