// Run by `npm publish` (prepublishOnly). Spec Step 12 blocks the release until
// the vendored catalog schemas are the files the catalog serves.
// test/fixtures/catalog/SOURCE.md says so in a line that starts with
// "Release blocked"; it is removed only after the served files are copied in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = join(import.meta.dirname, '..', 'test', 'fixtures', 'catalog', 'SOURCE.md')
const blocked = readFileSync(source, 'utf8')
  .split('\n')
  .find((line) => line.startsWith('Release blocked'))
if (blocked !== undefined) {
  console.error(`create-mercato-template is not published: ${blocked} See test/fixtures/catalog/SOURCE.md.`)
  process.exit(1)
}
