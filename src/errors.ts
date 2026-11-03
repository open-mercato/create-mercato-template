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

export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes]

/**
 * One entry of the `--json` envelope's `failures`. `rule` is a value of the
 * spec's Rule table; the other fields depend on the rule. No field ever holds a
 * secret, a matched string, an env value or an email address.
 */
export type Failure = {
  rule: string
  message?: string
  path?: string
  [field: string]: unknown
}

/**
 * An error that carries its exit code and the `rule` it reports. The CLI's
 * top-level handler keeps the code; any other error becomes exit 1 with
 * `rule: "internal"`.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode
  readonly failure: Failure

  constructor(message: string, exitCode: ExitCode, failure: Failure = { rule: ruleFor(exitCode) }) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.failure = { ...failure, message }
  }
}

function ruleFor(exitCode: ExitCode): string {
  if (exitCode === exitCodes.usage) return 'usage'
  if (exitCode === exitCodes.githubAuth) return 'github-auth'
  if (exitCode === exitCodes.githubStep) return 'github-step'
  return 'internal'
}
