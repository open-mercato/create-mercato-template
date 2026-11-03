// Finds `scheme://user:password@host` strings with a non-empty password
// (spec, Secret scan item 3). Shared by the stock table generator
// (scripts/build-stock-table.mts, which runs this file directly with Node's
// type stripping) and the tool, so this module imports nothing.

/** One credential URL found in a text. `url` is the exact string. */
export type CredentialUrl = {
  url: string
  /** The password part, as written (it may be a `${NAME}` reference). */
  password: string
  /** 1-based line number. */
  line: number
}

// The userinfo runs to the first `@` and holds no whitespace, `/`, `?`, `#` or quote.
// The URL ends at whitespace, a quote, a backtick or an angle bracket.
const candidate = /[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/?#@'"`<>]+)@[^\s'"`<>]*/g
const trailing = /[.,;)\]]+$/

/**
 * Splits userinfo at the first `:` that is not inside a `${...}` reference, so
 * `${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}` gives the second
 * reference as the password. Returns null when there is no password separator.
 */
function passwordOf(userinfo: string): string | null {
  let depth = 0
  for (let index = 0; index < userinfo.length; index += 1) {
    const character = userinfo[index]
    if (character === '$' && userinfo[index + 1] === '{') {
      depth += 1
      index += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
    } else if (character === ':' && depth === 0) {
      return userinfo.slice(index + 1)
    }
  }
  return null
}

/** Every credential URL in `text` with a non-empty password, in order. */
export function findCredentialUrls(text: string): CredentialUrl[] {
  const result: CredentialUrl[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(candidate)) {
      const password = passwordOf(match[1])
      if (!password) continue
      result.push({ url: match[0].replace(trailing, ''), password, line: index + 1 })
    }
  }
  return result
}
