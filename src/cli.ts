import { safeCommandOutput } from './common.js'
import { CliError, type ExitCode, type Failure, exitCodes } from './errors.js'
import type { Finding } from './policy/entries.js'
import * as fs from 'node:fs'
import * as readline from 'node:readline/promises'
import { type PrepareResult, prepare } from './prepare.js'
import { type ApprovalSummary, type PublishResult, parseRepo, publish, snapshotIdPattern } from './publish.js'
import { toolVersion } from './version.js'

export { CliError, exitCodes } from './errors.js'
export type { ExitCode, Failure } from './errors.js'
export { toolVersion } from './version.js'

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

Status: in development. prepare and publish work. describe is planned and
not implemented yet: it checks its arguments, exits 2 and changes nothing.

  npx create-mercato-template prepare [<app>] --out <dir> [--include-uncommitted]
      [--allow-file <path>]... [--keep-env <KEY>]... [--json]
  npx create-mercato-template publish --from <dir> --repo <owner/name> (--public | --private)
      [--expect <snapshotId>] [--resume] [--json]
  npx create-mercato-template describe --from <dir> [--repo <owner/name>] [--use-case <value>]
      [--summary <text>] [--when-to-use <text>] [--when-not-to-use <text>] [--json]
  npx create-mercato-template --help | --version

Commands:
  prepare    build a reviewed snapshot of one pinned commit of the app, offline:
             <dir>/tree (the files to publish) and <dir>/report.json
  publish    check <dir> against its report, then push exactly that snapshot
             as a one-commit GitHub template repository (needs gh, signed in)
  describe   (planned) print the catalog entry (YAML) for the published template

prepare options:
  <app>                  the app directory, the top level of its Git repository
                         (default: the current directory)
  --out <dir>            required: a new or empty directory outside the app
  --include-uncommitted  export the working tree version of changed and
                         untracked files (they are always listed)
  --allow-file <path>    export this opaque file (exact repo-relative path);
                         repeatable
  --keep-env <KEY>       keep the non-stock value of KEY in the generated
                         .env.example, when the key does not look secret and
                         the value passes the secret scan; repeatable

publish options:
  --from <dir>           required: a prepare output directory
  --repo <owner/name>    required: the GitHub repository to create
  --public, --private    required, exactly one: the repository visibility
  --expect <snapshotId>  publish only this snapshot, without the prompt;
                         required with --json or without a terminal
  --resume               continue a publication of this snapshot, on an empty
                         repository or one made from this snapshot

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
          argument === '--'
            ? 'The end-of-options marker -- is not supported. Write an app directory that starts with - as ./<name>.'
            : flags[name]?.value
            ? `Write ${name} and its value as two arguments: ${name} <value>.`
            : flags[name]
            ? `${name} takes no value.`
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
          : isCommand(argument)
            ? `Put the command first: npx create-mercato-template ${argument} [options].`
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

const outcomeTag: unique symbol = Symbol('create-mercato-template outcome')

/**
 * What a command reports: its exit code, the envelope's `failures`, the
 * command's own envelope fields, and the text printed without `--json`.
 */
export type Outcome = {
  readonly [outcomeTag]: true
  exitCode: ExitCode
  failures: Failure[]
  fields: Record<string, unknown>
  /** Printed on stdout without `--json`. */
  text: string
  /** Printed on stderr without `--json` when the exit code is not 0. */
  error?: string
}

export function outcome(value: Omit<Outcome, typeof outcomeTag>): Outcome {
  return { [outcomeTag]: true, ...value }
}

function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'object' && value !== null && outcomeTag in value
}

/**
 * Runs a parsed command. A plain object is merged into the `--json`
 * envelope of a successful run; an `Outcome` sets the exit code and failures
 * too.
 */
export type Dispatch = (command: Command, args: ParsedArgs) => Promise<Outcome | Record<string, unknown> | void>

const notImplemented: Dispatch = async (command) => {
  throw new CliError(
    `${command} is not implemented yet. create-mercato-template is in development; nothing was read or changed. Follow progress at ${repositoryUrl}.`,
    exitCodes.usage,
  )
}

/** The envelope's `failures` entry for a finding: its fields without `level`. */
function failureOf(finding: Finding): Failure {
  const failure: Failure = { ...finding }
  delete failure.level
  return failure
}

function findingLine(finding: Finding): string {
  const where = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`
  const rule = finding.ruleId === undefined ? finding.rule : `${finding.rule} (${finding.ruleId})`
  return `  ${rule}  ${where}${finding.message ? `\n      ${finding.message}` : ''}\n`
}

/** The text `prepare` prints without `--json`: counts, findings and notices, never a value. */
export function prepareText(result: PrepareResult): string {
  const { report } = result
  const errors = report.findings.filter((finding) => finding.level === 'error')
  const warnings = report.findings.filter((finding) => finding.level === 'warning')
  let text = ''
  if (result.snapshotId !== null)
    text += `Snapshot of ${report.source.head ?? 'HEAD'} written to ${result.out}/tree: ${report.totals.files} files, ${report.totals.bytes} bytes.\nsnapshotId: ${result.snapshotId}\n`
  else text += `No snapshot written: ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}. Fix them, commit and run prepare again.\n`
  if (errors.length > 0) text += `\nErrors (${errors.length}):\n${errors.map(findingLine).join('')}`
  if (warnings.length > 0) text += `\nWarnings (${warnings.length}), review them before you publish:\n${warnings.map(findingLine).join('')}`
  if (report.env.emptied.length > 0) text += `\nEmptied in .env.example: ${report.env.emptied.join(', ')}\n`
  if (report.env.kept.length > 0) text += `Kept in .env.example (--keep-env): ${report.env.kept.join(', ')}\n`
  text += `\nNotices:\n${report.notices.map((notice) => `  ${notice.code}${notice.detail ? `: ${notice.detail}` : ''}\n`).join('')}`
  text += `\nReport: ${result.out}/report.json\n`
  return text
}

function stringList(value: true | string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : []
}

/** `prepare`: maps the flags to `prepare()` and reports its result. */
export const runPrepare: Dispatch = async (_command, args) => {
  const out = args.options['--out']
  if (typeof out !== 'string')
    throw new CliError('prepare needs --out <dir>: a new or empty directory outside the app. Nothing was read or written.', exitCodes.usage)
  const result = prepare({
    app: args.positionals[0] ?? '.',
    out,
    includeUncommitted: args.options['--include-uncommitted'] === true,
    allowFiles: stringList(args.options['--allow-file']),
    keepEnv: stringList(args.options['--keep-env']),
  })
  return outcome({
    exitCode: result.exitCode,
    failures: result.failures.map(failureOf),
    fields: { out: result.out, snapshotId: result.snapshotId, report: result.report },
    text: prepareText(result),
    ...(result.exitCode === 0
      ? {}
      : { error: `prepare found ${result.failures.length} ${result.failures.length === 1 ? 'error' : 'errors'}; no snapshot was written. See ${result.out}/report.json.` }),
  })
}

function usage(message: string): CliError {
  return new CliError(`${message} Nothing was read or changed.`, exitCodes.usage)
}

/** Whether `publish` may prompt (Q11): stdin and stdout are both a terminal. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/** The prompt (Q11): repo, visibility, snapshotId and the counts of the verified tree; default no. */
export async function askApproval(summary: ApprovalSummary): Promise<boolean> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      `Publish snapshot ${summary.snapshotId}\n(${summary.files} files, ${summary.images} images) to ${summary.repo} as a ${summary.visibility} repository? [y/N] `,
    )
    return /^(y|yes)$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

/** The envelope fields of `publish` (spec, "--json shape"). */
function publishFields(result: PublishResult): Record<string, unknown> {
  return { snapshotId: result.snapshotId, repo: result.repo, commit: result.commit, steps: result.steps, retry: result.retry }
}

/**
 * `publish`: every usage problem is exit 2 before any Git read or GitHub
 * call (it may stat `--from`); then `publish()` runs the eight steps.
 */
export const runPublish: Dispatch = async (_command, args) => {
  const from = args.options['--from']
  const repo = args.options['--repo']
  const expect = args.options['--expect']
  if (typeof from !== 'string') throw usage('publish needs --from <dir>: a prepare output directory.')
  if (typeof repo !== 'string') throw usage('publish needs --repo <owner/name>.')
  if (parseRepo(repo) === null) throw usage(`--repo ${repo} is not a GitHub <owner>/<name>.`)
  if (args.options['--public'] !== true && args.options['--private'] !== true)
    throw usage('publish needs --public or --private: the repository visibility is never chosen for you.')
  if (expect !== undefined && (typeof expect !== 'string' || !snapshotIdPattern.test(expect)))
    throw usage('--expect takes a snapshotId: 64 lower-case hex characters, as prepare prints it.')
  if (expect === undefined && args.json) throw usage('publish --json needs --expect <snapshotId>: --json never prompts.')
  if (expect === undefined && !isInteractive()) throw usage('publish needs --expect <snapshotId> when it runs without a terminal.')
  let stat: fs.Stats | null = null
  try {
    stat = fs.statSync(from)
  } catch {}
  if (!stat?.isDirectory()) throw usage(`--from ${from} is not a directory. Run prepare first.`)
  const result = await publish({
    from,
    repo,
    visibility: args.options['--public'] === true ? 'public' : 'private',
    ...(typeof expect === 'string' ? { expect } : {}),
    resume: args.options['--resume'] === true,
    confirm: askApproval,
  })
  return outcome({
    exitCode: result.exitCode,
    failures: result.failures,
    fields: publishFields(result),
    text: result.text,
    ...(result.exitCode === exitCodes.ok ? {} : { error: result.failures[0]?.message ?? result.failures[0]?.rule ?? 'publish failed.' }),
  })
}

/** The commands that are implemented; the others answer "not implemented yet". */
const dispatchCommand: Dispatch = async (command, args) =>
  command === 'prepare' ? runPrepare(command, args) : command === 'publish' ? runPublish(command, args) : notImplemented(command, args)

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

/**
 * Redacts an unexpected error message like command output, and also removes
 * email addresses: no output field may carry one (spec, "--json shape").
 */
export function redact(message: string): string {
  return safeCommandOutput(message).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[EMAIL]')
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
  dispatch: Dispatch = dispatchCommand,
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
    const value = await dispatch(command, parsed)
    const result = isOutcome(value) ? value : outcome({ exitCode: exitCodes.ok, failures: [], fields: value ?? {}, text: '' })
    if (parsed.json) io.stdout(`${JSON.stringify(envelope(command, result.exitCode, result.failures, result.fields), null, 2)}\n`)
    else {
      if (result.text !== '') io.stdout(result.text)
      if (result.exitCode !== exitCodes.ok && result.error) io.stderr(`\nError: ${result.error}\n`)
    }
    return result.exitCode
  } catch (error) {
    const known = error instanceof CliError && failureCodes.includes(error.exitCode)
    const exitCode: ExitCode = known ? error.exitCode : exitCodes.check
    const failure: Failure = known
      ? error.failure
      : { rule: 'internal', message: redact(error instanceof Error ? error.message : String(error)) }
    if (parsed?.json)
      io.stdout(`${JSON.stringify(envelope(parsed.command, exitCode, [failure]), null, 2)}\n`)
    else io.stderr(`\nError: ${failure.message ?? failure.rule}\n`)
    return exitCode
  }
}
