import * as fs from 'node:fs'
import * as path from 'node:path'

/** The version of this package, read from its own package.json: the value `--version` prints. */
export function toolVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string') throw new Error('The package.json of create-mercato-template has no version.')
  return manifest.version
}
