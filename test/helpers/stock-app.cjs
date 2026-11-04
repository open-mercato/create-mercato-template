// A stock create-mercato-app 0.9.0 app for the Step 8 tests, built from the
// fixture app (test/helpers/fixture-app.cjs) and the vendored files: the
// scaffold src/modules.ts and src/official-modules.generated.ts at v0.9.0
// (test/fixtures/scaffold/), the stock .env.example from the stock table, and
// the facts the spec records about the 0.9.0 scaffold (Problem Statement):
// eight PNG files under public/examples/, four SVG files under public/, a
// preinstall script and no root README.md. Every framework package the
// modules use resolves, @open-mercato/enterprise included, and
// @open-mercato/storage-s3 does not, as in the stock app.
const fs = require('node:fs')
const path = require('node:path')
const { readInventory } = require('../../dist/inventory.js')
const { stockTable } = require('../../dist/stock.js')
const { coreVersion, fixtureFiles } = require('./fixture-app.cjs')

const scaffold = path.join(__dirname, '..', 'fixtures', 'scaffold', 'v0.9.0', 'src')

/** A PNG signature and an IHDR header: enough for the signature check. */
function pngBytes(index = 0) {
  return Buffer.concat([Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d), Buffer.from('IHDR'), Buffer.alloc(16), Buffer.of(index)])
}

function svgText(index = 0) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${index + 1}" height="1"></svg>\n`
}

function lockEntry(name, version) {
  return `\n"${name}@npm:${version}":\n  version: ${version}\n  resolution: "${name}@npm:${version}"\n  checksum: 10c0/${'1'.repeat(128)}\n  languageName: node\n  linkType: hard\n`
}

/** package.json and yarn.lock of the fixture app with more `@open-mercato` packages, all on `version`. */
function withPackages(names, { version = coreVersion, changes = {} } = {}) {
  const base = JSON.parse(fixtureFiles['package.json'])
  const dependencies = { ...base.dependencies, '@open-mercato/core': version }
  let lock = fixtureFiles['yarn.lock'].replaceAll(coreVersion, version)
  for (const name of names) {
    dependencies[name] = version
    lock += lockEntry(name, version)
  }
  return {
    'package.json': `${JSON.stringify({ ...base, dependencies, ...changes }, null, 2)}\n`,
    'yarn.lock': lock,
  }
}

/** The stock .env.example of a known version, from the stock table. */
function stockEnvExample(version = coreVersion) {
  return stockTable.files[stockTable.versions[version].envExample]
}

/** The files of the stock 0.9.0 app, by repo-relative path (`null` removes a base file). */
function stockAppFiles() {
  const modules = {
    'src/modules.ts': fs.readFileSync(path.join(scaffold, 'modules.ts')),
    'src/official-modules.generated.ts': fs.readFileSync(path.join(scaffold, 'official-modules.generated.ts')),
  }
  const inventory = readInventory(new Map(Object.entries(modules)))
  const names = new Set()
  for (const entry of inventory.entries)
    if (entry.from.startsWith('@open-mercato/') && entry.from !== '@open-mercato/core' && entry.from !== '@open-mercato/storage-s3') names.add(entry.from)
  const files = {
    ...withPackages([...names].sort(), { changes: { scripts: { preinstall: 'npx only-allow yarn', dev: 'mercato dev' } } }),
    ...modules,
    'README.md': null,
    '.env.example': stockEnvExample(),
  }
  for (let index = 0; index < 8; index++) files[`public/examples/example-${index + 1}.png`] = pngBytes(index)
  for (const [index, name] of ['logo.svg', 'favicon.svg', 'next.svg', 'vercel.svg'].entries()) files[`public/${name}`] = svgText(index)
  return files
}

module.exports = { pngBytes, svgText, lockEntry, withPackages, stockEnvExample, stockAppFiles }
