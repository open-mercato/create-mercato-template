#!/usr/bin/env node
// Exit codes 0-4 are a contract (BACKWARD_COMPATIBILITY.md). main() prints its
// own output and returns the code; only a code within that range is kept, and
// anything else, or an error main() did not handle, exits 1.
const contractExitCodes = [0, 1, 2, 3, 4]

require('../dist/cli.js')
  .main()
  .then(
    (code) => {
      process.exitCode = contractExitCodes.includes(code) ? code : 1
    },
    (error) => {
      console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode =
        error && error.name === 'CliError' && contractExitCodes.includes(error.exitCode)
          ? error.exitCode
          : 1
    },
  )
