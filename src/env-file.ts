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

const active = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
// A commented assignment needs an upper-case key (spec, Env diff item 1), so
// prose such as `# note=hello` stays a comment.
const commented = /^#\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/

/**
 * Every assignment in `text`, in file order. A commented assignment is a line
 * whose text after `#` is an assignment with an upper-case key
 * (`# REDIS_URL=redis://...`); other comment lines and blank lines are skipped.
 */
export function parseEnvAssignments(text: string): EnvAssignment[] {
  const result: EnvAssignment[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    const isComment = line.startsWith('#')
    const match = (isComment ? commented : active).exec(line)
    if (!match) continue
    result.push({ key: match[1], value: match[2].trim(), commented: isComment, line: index + 1 })
  }
  return result
}
