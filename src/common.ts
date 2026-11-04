// `run`, `Executor`, `RunOptions` and `safeCommandOutput` are copied from
// create-mercato-module f83233d (`src/common.ts`, `src/types.ts`), not
// imported: its dist/ exports are not a supported API. One change: when the
// command cannot start or times out, the thrown Error keeps the spawn error as
// `cause`, so callers can tell a missing binary (`ENOENT`) from other failures.
// `safeCommandOutput` is exported (upstream keeps it private) so the CLI can
// redact unexpected error messages the same way.
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'
import { spawnSync } from 'node:child_process'

export type RunOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> & {
  capture?: boolean
  allowFailure?: boolean
}

export type Executor = (
  command: string,
  args: string[],
  cwd: string,
  options?: RunOptions,
) => SpawnSyncReturns<string>

const captureTimeout = 120_000
const captureBuffer = 64 * 1024 * 1024

/** Runs a command with an argument array, never through a shell. */
export const run: Executor = (command, args, cwd, options = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...(options.capture ? { timeout: captureTimeout, maxBuffer: captureBuffer } : {}),
    ...options,
  })
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ETIMEDOUT')
      throw new Error(`${command} ${args[0] ?? ''} did not finish in time. Check network access and retry.`, {
        cause: result.error,
      })
    throw new Error(`Cannot run ${command}: ${safeCommandOutput(result.error.message, options.env)}`, {
      cause: result.error,
    })
  }
  if (result.status !== 0 && !options.allowFailure) {
    const details = options.capture
      ? safeCommandOutput(
          [result.stderr, result.stdout].filter((value) => typeof value === 'string' && value.trim()).join('\n'),
          options.env,
        )
      : ''
    throw new Error(
      `${command} failed (exit ${result.status ?? 'signal'}).${details ? `\n\n${details}\n\nFix this error and retry.` : ' Fix the reported error and retry.'}`,
    )
  }
  return result
}

/** Strips color codes and redacts credentials from command output before it is shown. */
export function safeCommandOutput(output: string, environment?: NodeJS.ProcessEnv): string {
  let sanitized = output
    // eslint-disable-next-line no-control-regex -- strips terminal color codes
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:npm_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9_]{15,})/g, '[REDACTED]')
    .replace(
      /((?:["']?)(?:[a-z0-9_-]*(?:token|secret|password|api[_-]?key)|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,&;]+)/gi,
      '$1[REDACTED]',
    )
  for (const source of [process.env, environment ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (value && value.length >= 8 && /token|secret|password|passwd|api_?key|authorization/i.test(key))
        sanitized = sanitized.split(value).join('[REDACTED]')
    }
  }
  sanitized = sanitized.trim()
  return sanitized.length > 3000 ? `…\n${sanitized.slice(-3000)}` : sanitized
}

/**
 * `safeCommandOutput`, and email addresses replaced with `[EMAIL]`: no
 * output field may carry one (spec, "--json shape").
 */
export function redactMessage(message: string, environment?: NodeJS.ProcessEnv): string {
  return safeCommandOutput(message, environment).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[EMAIL]')
}

export type BytesResult = { status: number | null; stdout: Buffer; stderr: string }

export type BytesOptions = { input?: Buffer; env?: NodeJS.ProcessEnv }

/**
 * Runs a command with an argument array, never through a shell, and returns
 * stdout as raw bytes. Git prints paths as bytes (`-z` output), and a path
 * that is not valid UTF-8 must reach the `unsafe-path` rule unchanged, so the
 * snapshot reads cannot use the UTF-8 `run`. Same capture timeout as `run`;
 * a larger buffer, because `cat-file --batch` returns every blob at once.
 */
export type BytesExecutor = (command: string, args: string[], cwd: string, options?: BytesOptions) => BytesResult

const bytesBuffer = 1024 * 1024 * 1024

export const runBytes: BytesExecutor = (command, args, cwd, options = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: options.env,
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: captureTimeout,
    maxBuffer: bytesBuffer,
  })
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ETIMEDOUT')
      throw new Error(`${command} ${args[0] ?? ''} did not finish in time.`, { cause: result.error })
    throw new Error(`Cannot run ${command}: ${safeCommandOutput(result.error.message, options.env)}`, {
      cause: result.error,
    })
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8') }
}
