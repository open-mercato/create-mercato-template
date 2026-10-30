import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Exit codes are a contract (see BACKWARD_COMPATIBILITY.md and the
 * "Exit codes" section of the Phase 2 spec).
 */
export const exitCodes = {
  ok: 0,
  check: 1,
  usage: 2,
  githubAuth: 3,
  githubStep: 4,
} as const

export const commands = ['prepare', 'publish', 'describe'] as const

/** An error that carries the exit code `bin/cli.cjs` must use. */
export class CliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

const repositoryUrl = 'https://github.com/open-mercato/create-mercato-template'

export const help = `Save an Open Mercato app as a clean GitHub template repository.

Status: in development. The commands below are planned and not implemented yet.
They exit with code 2 and change nothing.

  npx create-mercato-template prepare [<app>] --out <dir>
  npx create-mercato-template publish --from <dir> --repo <owner/name> (--public | --private)
  npx create-mercato-template describe --from <dir>
  npx create-mercato-template --help | --version

Commands (planned):
  prepare    build a reviewed snapshot of one pinned commit of the app, offline
  publish    push exactly that snapshot as a one-commit GitHub template repository
  describe   print the catalog entry (YAML) for the published template

Options:
  -h, --help     show this help
  -v, --version  print the tool version

Exit codes: 0 done, 1 a check failed, 2 usage error, 3 GitHub auth missing,
4 a GitHub step failed.

Spec: ${repositoryUrl}/blob/main/.ai/specs/2026-10-30-create-mercato-template.md
`

/** The version of this package, read from its own package.json. */
export function toolVersion(): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { version?: unknown }
  if (typeof manifest.version !== 'string')
    throw new Error('The package.json of create-mercato-template has no version.')
  return manifest.version
}

function isCommand(value: string): value is (typeof commands)[number] {
  return (commands as readonly string[]).includes(value)
}

export async function main(
  argv: string[] = process.argv.slice(2),
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    write(help)
    return
  }
  const [first, ...rest] = argv
  if (first === '--version' || first === '-v') {
    if (rest.length)
      throw new CliError(
        `--version takes no other arguments. Got: ${rest.join(' ')}`,
        exitCodes.usage,
      )
    write(`${toolVersion()}\n`)
    return
  }
  if (isCommand(first))
    throw new CliError(
      `${first} is not implemented yet. create-mercato-template is in development; nothing was read or changed. Follow progress at ${repositoryUrl}.`,
      exitCodes.usage,
    )
  throw new CliError(
    first.startsWith('-')
      ? `Unknown option: ${first}. Run with --help for usage.`
      : `Unknown command: ${first}. Choose prepare, publish or describe. Run with --help for usage.`,
    exitCodes.usage,
  )
}
