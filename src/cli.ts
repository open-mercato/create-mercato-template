import * as fs from 'node:fs'
import * as path from 'node:path'
import { safeCommandOutput } from './common.js'
import { CliError, type ExitCode, type Failure, exitCodes } from './errors.js'

export { CliError, exitCodes } from './errors.js'
export type { ExitCode, Failure } from './errors.js'

export const commands = ['prepare', 'publish', 'describe'] as const
export type Command = (typeof commands)[number]

const toolName = 'create-mercato-template'
const repositoryUrl = 'https://github.com/open-mercato/create-mercato-template'

type FlagSpec = {
  /** The flag takes the next argument as its value, whatever it looks like. */
  value?: true
  /** The flag may be given more than once; its values are collected in order. */
  repeat?: true
  commands: readonly Command[]
}

/**
 * The flag matrix of the spec's "Commands and flags" table. Every flag is
 * known here from Step 1; required flags and value checks come with the step
 * that implements each command.
 */
export const flags: Readonly<Record<string, FlagSpec>> = {
  '--out': { value: true, commands: ['prepare'] },
  '--include-uncommitted': { commands: ['prepare'] },
  '--allow-file': { value: true, repeat: true, commands: ['prepare'] },
  '--keep-env': { value: true, repeat: true, commands: ['prepare'] },
  '--from': { value: true, commands: ['publish', 'describe'] },
  '--repo': { value: true, commands: ['publish', 'describe'] },
  '--public': { commands: ['publish'] },
  '--private': { commands: ['publish'] },
  '--expect': { value: true, commands: ['publish'] },
  '--resume': { commands: ['publish'] },
  '--use-case': { value: true, commands: ['describe'] },
  '--summary': { value: true, commands: ['describe'] },
  '--when-to-use': { value: true, commands: ['describe'] },
  '--when-not-to-use': { value: true, commands: ['describe'] },
  '--json': { commands: ['prepare', 'publish', 'describe'] },
}

const helpFlags = ['--help', '-h']
const versionFlags = ['--version', '-v']

export const help = `Save an Open Mercato app as a clean GitHub template repository.

Status: in development. The commands below are planned and not implemented yet.
They check their arguments, exit with code 2 and change nothing.

  npx create-mercato-template prepare [<app>] --out <dir> [--include-uncommitted]
      [--allow-file <path>]... [--keep-env <KEY>]... [--json]
  npx create-mercato-template publish --from <dir> --repo <owner/name> (--public | --private)
      [--expect <snapshotId>] [--resume] [--json]
  npx create-mercato-template describe --from <dir> [--repo <owner/name>] [--use-case <value>]
      [--summary <text>] [--when-to-use <text>] [--when-not-to-use <text>] [--json]
  npx create-mercato-template --help | --version

Commands (planned):
  prepare    build a reviewed snapshot of one pinned commit of the app, offline
  publish    push exactly that snapshot as a one-commit GitHub template repository
  describe   print the catalog entry (YAML) for the published template

Options:
  -h, --help     show this help (plain text, even with --json)
  -v, --version  print the tool version; takes no other arguments
  --json         with a command: print exactly one JSON object on stdout and
                 nothing else, usage errors included; never prompt

Exit codes: 0 done, 1 a check failed, 2 usage error, 3 GitHub auth missing,
4 a GitHub step failed.

Guide: ${repositoryUrl}/blob/main/docs/guide.md
Spec: ${repositoryUrl}/blob/main/.ai/specs/2026-10-30-create-mercato-template.md
`

/** The version of this package, read from its own package.json. */
export function toolVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string') throw new Error('The package.json of create-mercato-template has no version.')
  return manifest.version
}

function isCommand(value: string | undefined): value is Command {
  return (commands as readonly string[]).includes(value ?? '')
}

export type ParsedArgs = {
  command: Command | null
  /** `--json` was given where a flag is expected. */
  json: boolean
  /** `--help` or `-h` was given where a flag is expected. */
  help: boolean
  /** `--version` or `-v` was the only argument. */
  version: boolean
  /** The first usage problem on the command line, in order, or null. */
  error: string | null
  /** Flag values: `true` for a boolean flag, a string, or a list for a repeatable flag. */
  options: Record<string, true | string | string[]>
  positionals: string[]
}

/**
 * Reads the whole command line before anything is decided, so help can win
 * over every usage error and `--json` is known even when the line is wrong.
 * A flag that takes a value always takes the next argument: `describe
 * --summary --help` reads `--help` as the summary.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    json: false,
    help: argv.length === 0,
    version: false,
    error: null,
    options: {},
    positionals: [],
  }
  const problem = (message: string) => {
    parsed.error ??= message
  }
  let index = 0
  if (isCommand(argv[0])) {
    parsed.command = argv[0]
    index = 1
  }
  const command = parsed.command
  for (; index < argv.length; index++) {
    const argument = argv[index]
    if (helpFlags.includes(argument)) {
      parsed.help = true
      continue
    }
    if (versionFlags.includes(argument)) {
      if (index === 0 && argv.length === 1) parsed.version = true
      else problem(`${argument} works only on its own: npx create-mercato-template --version.`)
      continue
    }
    if (argument.startsWith('-') && argument !== '-') {
      const spec = flags[argument]
      if (!spec) {
        const [name] = argument.split('=', 1)
        problem(
          flags[name]
            ? `Write ${name} and its value as two arguments: ${name} <value>.`
            : command
              ? `Unknown option for ${command}: ${argument}.`
              : `Unknown option: ${argument}.`,
        )
        continue
      }
      // A value is taken even on the wrong command, so the next argument is
      // never read as a flag or a positional.
      const missingValue = spec.value === true && index + 1 >= argv.length
      const value = spec.value && !missingValue ? argv[++index] : undefined
      if (argument === '--json') parsed.json = true
      if (!command) {
        if (argument !== '--json') problem(`${argument} needs a command first: ${spec.commands.join(' or ')}.`)
        continue
      }
      if (!spec.commands.includes(command)) {
        problem(`${argument} is not an option of ${command}. It is used by ${spec.commands.join(' and ')}.`)
        continue
      }
      if (missingValue) {
        problem(`${argument} needs a value.`)
        continue
      }
      const previous = parsed.options[argument]
      if (previous !== undefined && !spec.repeat) {
        problem(`${argument} was given more than once.`)
        continue
      }
      if (spec.repeat) parsed.options[argument] = [...((previous as string[] | undefined) ?? []), value as string]
      else parsed.options[argument] = value ?? true
      continue
    }
    if (!command) {
      problem(
        index === 0
          ? `Unknown command: ${argument}. Choose prepare, publish or describe.`
          : `Unexpected argument: ${argument}.`,
      )
      continue
    }
    if (command === 'prepare' && parsed.positionals.length === 0) parsed.positionals.push(argument)
    else
      problem(
        command === 'prepare'
          ? `prepare takes one app directory; got a second one: ${argument}.`
          : `${command} takes no positional arguments; got: ${argument}.`,
      )
  }
  if (parsed.options['--public'] && parsed.options['--private']) problem('Choose one of --public or --private, not both.')
  if (!parsed.error && !parsed.help && !parsed.version && !command)
    problem('No command given. Choose prepare, publish or describe.')
  return parsed
}

/** The `--json` envelope (schema 1). Command-specific fields are added by `extra`. */
export type Envelope = {
  schema: 1
  command: Command | null
  ok: boolean
  exitCode: ExitCode
  tool: { name: string; version: string }
  failures: Failure[]
  [field: string]: unknown
}

export function envelope(
  command: Command | null,
  exitCode: ExitCode,
  failures: Failure[],
  extra: Record<string, unknown> = {},
): Envelope {
  let version: string
  try {
    version = toolVersion()
  } catch {
    version = 'unknown'
  }
  return {
    schema: 1,
    command,
    ok: exitCode === exitCodes.ok,
    exitCode,
    tool: { name: toolName, version },
    failures,
    ...extra,
  }
}

export type Io = {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** Runs a parsed command. Its result is merged into the `--json` envelope. */
export type Dispatch = (command: Command, args: ParsedArgs) => Promise<Record<string, unknown> | void>

const notImplemented: Dispatch = async (command) => {
  throw new CliError(
    `${command} is not implemented yet. create-mercato-template is in development; nothing was read or changed. Follow progress at ${repositoryUrl}.`,
    exitCodes.usage,
  )
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

const failureCodes: readonly number[] = [exitCodes.check, exitCodes.usage, exitCodes.githubAuth, exitCodes.githubStep]

/**
 * The top-level handler. It never throws: it prints either the result or one
 * error, and returns the exit code for `bin/cli.cjs`. A CliError keeps its
 * code and rule; anything else is exit 1 with `rule: "internal"`. Under
 * `--json` it prints exactly one envelope on stdout and nothing on stderr.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  io: Io = defaultIo,
  dispatch: Dispatch = notImplemented,
): Promise<number> {
  let parsed: ParsedArgs | undefined
  try {
    parsed = parseArgs(argv)
    if (parsed.help) {
      io.stdout(help)
      return exitCodes.ok
    }
    if (parsed.version) {
      io.stdout(`${toolVersion()}\n`)
      return exitCodes.ok
    }
    if (parsed.error) throw new CliError(`${parsed.error} Run with --help for usage.`, exitCodes.usage)
    const command = parsed.command as Command
    const result = (await dispatch(command, parsed)) ?? {}
    if (parsed.json) io.stdout(`${JSON.stringify(envelope(command, exitCodes.ok, [], result), null, 2)}\n`)
    return exitCodes.ok
  } catch (error) {
    const known = error instanceof CliError && failureCodes.includes(error.exitCode)
    const exitCode: ExitCode = known ? error.exitCode : exitCodes.check
    const failure: Failure = known
      ? error.failure
      : { rule: 'internal', message: safeCommandOutput(error instanceof Error ? error.message : String(error)) }
    if (parsed?.json)
      io.stdout(`${JSON.stringify(envelope(parsed.command, exitCode, [failure]), null, 2)}\n`)
    else io.stderr(`\nError: ${failure.message ?? failure.rule}\n`)
    return exitCode
  }
}
