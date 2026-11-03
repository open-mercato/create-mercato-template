// Reads assignments from a `.env`-style file. Shared by the stock table
// generator (scripts/build-stock-table.mts, which runs this file directly with
// Node's type stripping) and the tool, so this module imports nothing.

/** One `KEY=value` line, active or commented out (`# KEY=value`). */
export type EnvAssignment = {
  key: string
  /** The raw text after `=`, without surrounding whitespace. Quotes are kept. */
  value: string
  commented: boolean
  /** 1-based line number. */
  line: number
}

const assignment = /^(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/**
 * Every assignment in `text`, in file order. A commented assignment is a line
 * whose text after `#` is itself an assignment (`# REDIS_URL=redis://...`);
 * other comment lines and blank lines are skipped.
 */
export function parseEnvAssignments(text: string): EnvAssignment[] {
  const result: EnvAssignment[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = assignment.exec(lines[index].trim())
    if (!match) continue
    result.push({ key: match[2], value: match[3].trim(), commented: match[1] !== undefined, line: index + 1 })
  }
  return result
}
