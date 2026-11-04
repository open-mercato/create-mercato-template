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

// A URL runs from its scheme to the end of its token: whitespace, a quote, a
// backtick or an angle bracket ends it, and trailing `.,;)]` is not part of it.
// The lookbehind starts the scheme only at a word start, so a long run of
// letters or digits is scanned once, not once per position.
const token = /[^\s'"`<>]+/g
const schemeStart = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\//g
const trailing = '.,;)]'
// The text between the `:` and the first `/`, `?` or `#` of a URL with no
// userinfo: a port, digits or `${...}` references, possibly empty.
const portOnly = /^(?:\d|\$\{[^}]*\})*$/

// Which `@` ends the userinfo (issue #10).
//
// The authority is the text after `scheme://` up to the first `/`, `?` or `#`
// that is not inside a `${...}` reference.
//
// 1. When the authority holds an `@`, the userinfo runs to the LAST `@` of the
//    authority, as WHATWG URL parsing reads it, so a raw `@` in the password
//    (`u:p@ss@host`) stays in the password, and an `@` later in the path or
//    query (`https://registry.npmjs.org/@scope/pkg`, `?to=a@b.com`) is never
//    the separator.
// 2. Otherwise a password may hold a raw `/`, `?` or `#` (`redis://:abc#123@host`,
//    `postgres://u:a/b@h/db`). WHATWG and most drivers read such a string as a
//    host and a path, but the password is written in the file all the same, and
//    a secret scan must not miss it. The userinfo then runs to the FIRST `@`
//    after the authority, and it is a credential only when the authority holds
//    a `:`, the text between that `:` and the end of the authority is not a
//    port (digits or `${...}` references, possibly empty) after a non-empty
//    host, and the authority does not start with `[` (an IPv6 literal). An
//    empty user (`redis://:123#abc@host`) has no host to give a port to, so
//    its password is reported whatever it holds. So `https://x.com/?to=a@b.com`
//    (no `:`), `https://x.com:8080/@scope/pkg` and
//    `http://${HOST}:${PORT}/?to=a@b.com` (a port) and
//    `https://example.com/?u=a:b@c` (the `:` is in the query) are not reported.
//    A password after a non-empty user whose text before its first raw `/`,
//    `?` or `#` is only digits (`u:2024/x@h`) reads as a port and is missed,
//    the price of not reporting every `host:port/...@...` URL.
//
// gitleaks v8.30.1 has no generic rule for this: its URL rules anchor on known
// hosts with a fixed userinfo shape (`sidekiq-sensitive-url`), so it offers no
// separator rule to follow.
//
// The password is the userinfo after its first `:` outside a `${...}` reference,
// so `${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}` gives the
// second reference. An unclosed `${` is plain text, so a typo cannot hide a
// literal password: `${DB_USER:secret@db` gives `secret`.
//
// The scan is linear in the line length: the tokens, the matching `}` of every
// `${` and the next `@` after every position are computed once per token, a
// scan jumps over a closed reference in one step, and the authorities that the
// scans walk do not overlap.

/** For each `${` in `text[0, end)` with a matching `}`, the index of that `}`. */
function referenceEnds(text: string, end: number): Map<number, number> {
  const ends = new Map<number, number>()
  const open: number[] = []
  for (let index = 0; index < end; index += 1) {
    if (text[index] === '$' && text[index + 1] === '{') {
      open.push(index)
      index += 1
    } else if (text[index] === '}' && open.length > 0) {
      ends.set(open.pop() as number, index)
    }
  }
  return ends
}

/** For each position in `text[0, end]`, the index of the next `@` at or after it, or `end`. */
function nextAts(text: string, end: number): Int32Array {
  const next = new Int32Array(end + 1)
  next[end] = end
  for (let index = end - 1; index >= 0; index -= 1) next[index] = text[index] === '@' ? index : next[index + 1]
  return next
}

/** The password of the URL whose authority starts at `start`, or null. */
function passwordAt(text: string, start: number, end: number, references: Map<number, number>, next: () => Int32Array): string | null {
  let colon = -1
  let at = -1
  let index = start
  while (index < end) {
    const character = text[index]
    const referenceEnd = character === '$' ? references.get(index) : undefined
    if (referenceEnd !== undefined) {
      index = referenceEnd + 1
      continue
    }
    if (character === '/' || character === '?' || character === '#') break
    if (character === '@') at = index
    else if (character === ':' && colon === -1) colon = index
    index += 1
  }
  if (at !== -1) return colon !== -1 && colon < at ? text.slice(colon + 1, at) : null
  if (colon === -1 || index === end || text[start] === '[') return null
  if (colon > start && portOnly.test(text.slice(colon + 1, index))) return null
  const userinfoEnd = next()[index]
  return userinfoEnd < end ? text.slice(colon + 1, userinfoEnd) : null
}

/** Every credential URL in `text` with a non-empty password, in order. */
export function findCredentialUrls(text: string): CredentialUrl[] {
  const result: CredentialUrl[] = []
  const lines = text.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!lines[lineIndex].includes('://')) continue
    for (const [word] of lines[lineIndex].matchAll(token)) {
      if (!word.includes('://')) continue
      let end = word.length
      while (end > 0 && trailing.includes(word[end - 1])) end -= 1
      const urls = word.slice(0, end)
      const references = referenceEnds(urls, end)
      let ats: Int32Array | undefined
      const next = (): Int32Array => (ats ??= nextAts(urls, end))
      for (const match of urls.matchAll(schemeStart)) {
        const password = passwordAt(urls, match.index + match[0].length, end, references, next)
        if (!password) continue
        // The URL runs to the end of the token, so no other URL starts after it.
        result.push({ url: urls.slice(match.index), password, line: lineIndex + 1 })
        break
      }
    }
  }
  return result
}
