#!/usr/bin/env node
require('../dist/cli.js')
  .main()
  .catch((error) => {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`)
    // Exit codes 0-4 are a contract (BACKWARD_COMPATIBILITY.md): keep the
    // code a CliError carries instead of flattening every failure to 1.
    process.exitCode =
      error && typeof error.exitCode === 'number' ? error.exitCode : 1
  })
