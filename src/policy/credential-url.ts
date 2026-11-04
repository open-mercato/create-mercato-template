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
//    port after a non-empty host (empty, or only digits, `$NAME`, `${...}` and
//    `{...}` placeholders, or the word `port`), the authority does not start
//    with `[` (an IPv6 literal), and the userinfo does not end in `/` (an `@`
//    right after a `/` starts a path segment: `/@scope`, `/@vite/client`). An
//    empty user (`redis://:123#abc@host`) has no host to give a port to, so
//    its password is reported whatever it holds. So `https://x.com/?to=a@b.com`
//    (no `:`), `https://x.com:8080/@scope/pkg`,
//    `http://${HOST}:${PORT}/?to=a@b.com`, `http://localhost:$PORT/@vite/client`
//    (a port) and `https://example.com/?u=a:b@c` (the `:` is in the query) are
//    not reported. A password after a non-empty user whose text before its
//    first raw `/`, `?` or `#` is only digits or placeholders (`u:2024/x@h`,
//    `${U}:${P}#x@h`) reads as a port and is missed, the price of not
//    reporting every `host:port/...@...` URL.
//
// gitleaks v8.30.1 has no generic rule for this: its URL rules anchor on known
// hosts with a fixed userinfo shape (`sidekiq-sensitive-url`), so it offers no
// separator rule to follow.
//
// The password is the userinfo after its first `:` outside a `${...}` reference,
// so `${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}` gives the
// second reference. A reference is `${NAME}` or `${NAME` followed by one of
// `:-?+=`; any other `${`, and an unclosed one, is plain text, so a typo cannot
// hide a literal password: `${DB_USER:secret@db` gives `secret`, and
// `u:${P@h/db}` gives `${P`.
//
// The scan is linear in the line length: the tokens, the references and the
// next `@` after every position are computed once per token, and a scan jumps
// over a closed reference in one step and stops at the end of the reference
// its scheme is written in. So the characters two scans walk never overlap: a
// scheme start outside the references a scan jumps over has a `/` that ends
// that scan, and one inside them stays inside.

const nameStart = /[A-Za-z_]/
const nameCharacter = /[A-Za-z0-9_]/

/** The index just after the name that starts at `index`, or `index` when none does. */
function nameEnd(text: string, index: number): number {
  if (index >= text.length || !nameStart.test(text[index])) return index
  let after = index + 1
  while (after < text.length && nameCharacter.test(text[after])) after += 1
  return after
}

type References = {
  /** For a `${` at `index` that opens a closed reference, the index of its `}`, else -1. */
  ends: Int32Array
  /** The end of the innermost closed reference around `index` (its `}`), or the text length. */
  enclosing: Int32Array
}

/**
 * The `${NAME}` and `${NAME<op>...}` references of `text` (`<op>` one of
 * `:-?+=`), matched by nesting. A `${` that is not followed by a name and one
 * of those characters, or that is never closed, is plain text.
 */
function referencesOf(text: string): References {
  const ends = new Int32Array(text.length).fill(-1)
  const open: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '$' && text[index + 1] === '{') {
      const after = nameEnd(text, index + 2)
      if (after > index + 2 && after < text.length && '}:-?+='.includes(text[after])) {
        open.push(index)
        index = after - 1
      }
    } else if (text[index] === '}' && open.length > 0) {
      ends[open.pop() as number] = index
    }
  }
  // Closed references nest properly, so the innermost one around a position is the top of a stack.
  const enclosing = new Int32Array(text.length)
  const around: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    while (around.length > 0 && around[around.length - 1] < index) around.pop()
    enclosing[index] = around.length > 0 ? around[around.length - 1] : text.length
    if (ends[index] !== -1) around.push(ends[index])
  }
  return { ends, enclosing }
}

/**
 * Whether the text between the `:` and the end of the authority reads as a
 * port: empty, or only digits, `$NAME`, `${...}` and `{...}` placeholders, or
 * the word `port`. A loop, not a regex, so a failing test cannot backtrack.
 */
function isPortLike(text: string): boolean {
  if (text.toLowerCase() === 'port') return true
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character >= '0' && character <= '9') {
      index += 1
    } else if (character === '{' || (character === '$' && text[index + 1] === '{')) {
      const close = text.indexOf('}', index)
      if (close === -1) return false
      index = close + 1
    } else if (character === '$' && nameEnd(text, index + 1) > index + 1) {
      index = nameEnd(text, index + 1)
    } else {
      return false
    }
  }
  return true
}

/** For each position in `text`, the index of the next `@` at or after it, or the text length. */
function nextAts(text: string): Int32Array {
  const next = new Int32Array(text.length + 1)
  next[text.length] = text.length
  for (let index = text.length - 1; index >= 0; index -= 1) next[index] = text[index] === '@' ? index : next[index + 1]
  return next
}

/**
 * The password of the URL whose authority starts at `start`, or null. The
 * URL ends at `limit`: the end of the token, or of the closed reference the
 * scheme is written in (`${DATABASE_URL:=postgres://u:p@h}`).
 */
function passwordAt(text: string, start: number, limit: number, references: References, next: () => Int32Array): string | null {
  let colon = -1
  let at = -1
  let index = start
  while (index < limit) {
    const character = text[index]
    const referenceEnd = character === '$' ? references.ends[index] : -1
    if (referenceEnd !== -1) {
      index = referenceEnd + 1
      continue
    }
    if (character === '/' || character === '?' || character === '#') break
    if (character === '@') at = index
    else if (character === ':' && colon === -1) colon = index
    index += 1
  }
  if (at !== -1) return colon !== -1 && colon < at ? text.slice(colon + 1, at) : null
  if (colon === -1 || index >= limit || text[start] === '[') return null
  if (colon > start && isPortLike(text.slice(colon + 1, index))) return null
  const userinfoEnd = next()[index]
  if (userinfoEnd >= limit || text[userinfoEnd - 1] === '/') return null
  return text.slice(colon + 1, userinfoEnd)
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
      const references = referencesOf(urls)
      let ats: Int32Array | undefined
      const next = (): Int32Array => (ats ??= nextAts(urls))
      for (const match of urls.matchAll(schemeStart)) {
        const password = passwordAt(urls, match.index + match[0].length, references.enclosing[match.index], references, next)
        if (!password) continue
        // The URL runs to the end of the token, so no other URL starts after it.
        result.push({ url: urls.slice(match.index), password, line: lineIndex + 1 })
        break
      }
    }
  }
  return result
}
