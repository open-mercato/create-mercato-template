#!/usr/bin/env node
// Exit codes 0-4 are a contract (BACKWARD_COMPATIBILITY.md). Only a CliError
// may choose its code, and only within that range; anything else exits 1.
const contractExitCodes = [0, 1, 2, 3, 4]

require('../dist/cli.js')
  .main()
  .catch((error) => {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode =
      error && error.name === 'CliError' && contractExitCodes.includes(error.exitCode)
        ? error.exitCode
        : 1
  })
