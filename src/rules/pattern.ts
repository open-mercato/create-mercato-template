/**
 * Static facts about one secret rule pattern, read from its JavaScript source
 * (the converted gitleaks pattern or an extra rule), for the secret scan's
 * cost bound (spec, Secret scan, "Scan cost"):
 *
 * - `maxLength`: the longest text any match can span, in UTF-16 units, or
 *   null when a quantifier is unbounded (`*`, `+`, `{n,}`).
 * - `anchor`: a part of the pattern that every match contains, at a bounded
 *   distance from the start of the match, and that is mostly literal text
 *   (a keyword or a prefix such as `ghp_`). A match can then only start in
 *   the window `[q - before.max, q - before.min]` before a position `q`
 *   where the anchor matches, so the scan tries the rule only there, and
 *   finds exactly the matches a scan of every position finds.
 *
 * - `engine`: `regexp` when one backtracking try has a proven bound (a
 *   bounded length with at most `maxWays` ways, or unbounded quantifiers
 *   proven linear; the time per MB is measured, not proven), else `vm`: the rule runs on the linear matcher of
 *   `src/rules/pike.ts`.
 * - `split`: for a pattern that starts with a repeated character before its
 *   anchors, the prefix and the tail.
 *
 * The reader covers the subset that `scripts/build-secret-rules.mts` emits
 * and the extra rules use. Anything else (a backreference, a construct it
 * does not know) is a `PatternError`. The rules build and a test check that
 * every bundled and extra rule reads and compiles, so the scan never meets one.
 */
import type { ConvertedRegex } from './gitleaks.js'

export class PatternError extends Error {}

/**
 * The characters a character node can match: the ASCII ones as bits of a
 * bigint (exact, case folding included), and how much of U+0080 to U+FFFF
 * (`some` is any part, so tests on it stay on the safe side).
 */
export type CharSet = { ascii: bigint; high: 'none' | 'some' | 'all' }

const allAscii = (1n << 128n) - 1n

function union(left: CharSet, right: CharSet): CharSet {
  const high = left.high === 'all' || right.high === 'all' ? 'all' : left.high === 'some' || right.high === 'some' ? 'some' : 'none'
  return { ascii: left.ascii | right.ascii, high }
}

const emptySet: CharSet = { ascii: 0n, high: 'none' }

/** True when no character is in both. */
function disjoint(left: CharSet, right: CharSet): boolean {
  return (left.ascii & right.ascii) === 0n && (left.high === 'none' || right.high === 'none')
}

/** True when every character of `inner` is in `outer`. */
function subset(inner: CharSet, outer: CharSet): boolean {
  return (inner.ascii & ~outer.ascii & allAscii) === 0n && (inner.high === 'none' || outer.high === 'all')
}

type Node =
  | { kind: 'char'; literal: boolean; set: CharSet; ignoreCase: boolean; start: number; end: number }
  | { kind: 'assert'; start: number; end: number }
  | { kind: 'seq'; items: Node[]; start: number; end: number }
  | { kind: 'alt'; branches: Node[]; start: number; end: number }
  | { kind: 'group'; open: string; capture: boolean; look: boolean; child: Node; start: number; end: number }
  | { kind: 'repeat'; child: Node; min: number; max: number; lazy: boolean; start: number; end: number }

const hexDigits = /^[0-9A-Fa-f]+$/

/** The ASCII members of a character node, by testing each ASCII character against it. */
function asciiOf(source: string, ignoreCase: boolean): bigint {
  const regex = new RegExp(`^(?:${source})$`, ignoreCase ? 'i' : '')
  let bits = 0n
  for (let code = 0; code < 128; code++) if (regex.test(String.fromCharCode(code))) bits |= 1n << BigInt(code)
  return bits
}

/** How much of U+0080 to U+FFFF the ranges cover, or their complement when negated. */
function highOf(ranges: [number, number][], negated: boolean): CharSet['high'] {
  const high = ranges
    .filter(([, last]) => last >= 0x80)
    .map(([first, last]): [number, number] => [Math.max(first, 0x80), last])
    .sort((left, right) => left[0] - right[0])
  let covered = 0x7f
  for (const [first, last] of high) {
    if (first > covered + 1) break
    covered = Math.max(covered, last)
  }
  const all = covered >= 0xffff
  if (negated) return high.length === 0 ? 'all' : all ? 'none' : 'some'
  return high.length === 0 ? 'none' : all ? 'all' : 'some'
}

/** Parses the converted source into a tree with source offsets. */
function parse(source: string, flags: string): Node {
  let index = 0
  /** The code unit of the last single-character escape read. */
  let lastCode = 0
  const ignoreCase = [flags.includes('i')]
  const char = (literal: boolean, start: number, high: CharSet['high']): Node => ({
    kind: 'char',
    literal,
    set: { ascii: asciiOf(source.slice(start, index), ignoreCase[ignoreCase.length - 1]), high },
    ignoreCase: ignoreCase[ignoreCase.length - 1],
    start,
    end: index,
  })
  const fail = (message: string): never => {
    throw new PatternError(`${message} at offset ${index}`)
  }

  function alternation(): Node {
    const start = index
    const branches = [sequence()]
    while (source[index] === '|') {
      index++
      branches.push(sequence())
    }
    return branches.length === 1 ? branches[0] : { kind: 'alt', branches, start, end: index }
  }

  function sequence(): Node {
    const start = index
    const items: Node[] = []
    while (index < source.length && source[index] !== '|' && source[index] !== ')') items.push(quantified(atom()))
    return { kind: 'seq', items, start, end: index }
  }

  function quantified(node: Node): Node {
    const start = node.start
    let min: number
    let max: number
    const character = source[index]
    if (character === '*' || character === '+' || character === '?') {
      min = character === '+' ? 1 : 0
      max = character === '?' ? 1 : Number.POSITIVE_INFINITY
      index++
    } else if (character === '{') {
      const brace = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(index))
      if (!brace) return node
      min = Number(brace[1])
      max = brace[2] === undefined ? min : brace[3] === '' ? Number.POSITIVE_INFINITY : Number(brace[3])
      index += brace[0].length
    } else return node
    if (node.kind === 'assert' || (node.kind === 'group' && node.look)) fail('a quantified assertion')
    const lazy = source[index] === '?'
    if (lazy) index++
    return quantified({ kind: 'repeat', child: node, min, max, lazy, start, end: index })
  }

  function atom(): Node {
    const start = index
    const character = source[index]
    if (character === '^' || character === '$') {
      index++
      return { kind: 'assert', start, end: index }
    }
    if (character === '.') {
      index++
      return char(false, start, 'some')
    }
    if (character === '[') return characterClass()
    if (character === '(') return group()
    if (character === '\\') {
      const next = source[index + 1]
      if (next === 'b' || next === 'B') {
        index += 2
        return { kind: 'assert', start, end: index }
      }
      const ranges: [number, number][] = []
      const kind = escape(false, ranges)
      return char(kind === 'literal', start, highOf(ranges, false))
    }
    if (character === '*' || character === '+' || character === '?') fail('a quantifier with nothing to repeat')
    index++
    const code = character.charCodeAt(0)
    return char(true, start, code >= 0x80 ? 'some' : 'none')
  }

  /**
   * One escape at `index`: `literal` for a single character, `set` for a
   * class shorthand. Adds the code units it stands for to `ranges` when they
   * reach above U+007F (`\\s` has Unicode spaces, `\\D`, `\\W` and `\\S` all of them).
   * Returns the code unit of a single character as `code`.
   */
  function escape(inClass: boolean, ranges: [number, number][]): 'literal' | 'set' {
    const next = source[index + 1]
    if (next === undefined) fail('a trailing backslash')
    if ('dDwWsS'.includes(next)) {
      index += 2
      if (next === 's') ranges.push([0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff])
      if ('DWS'.includes(next)) ranges.push([0x80, 0xffff])
      return 'set'
    }
    if ('fnrtv'.includes(next)) {
      index += 2
      lastCode = { f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b }[next as 'f']
      return 'literal'
    }
    if (next === 'x' || next === 'u') {
      const length = next === 'x' ? 2 : 4
      const digits = source.slice(index + 2, index + 2 + length)
      if (!hexDigits.test(digits) || digits.length !== length) fail(`a bad \\${next} escape`)
      index += 2 + length
      lastCode = Number.parseInt(digits, 16)
      if (lastCode >= 0x80) ranges.push([lastCode, lastCode])
      return 'literal'
    }
    if (inClass && next === 'b') {
      index += 2
      lastCode = 0x08
      return 'literal'
    }
    if (/[!-/:-@[-`{-~]/.test(next)) {
      index += 2
      lastCode = next.charCodeAt(0)
      return 'literal'
    }
    return fail(`the escape \\${next} is not known`)
  }

  /** A bracket class: literal when it holds one or two single characters and is not negated (`[Aa]`). */
  function characterClass(): Node {
    const start = index
    index++
    let negated = false
    if (source[index] === '^') {
      negated = true
      index++
    }
    let members = 0
    let simple = !negated
    const ranges: [number, number][] = []
    /** One class member at `index`: its code unit, or null for a set such as `\\w`. */
    const member = (): number | null => {
      if (source[index] === '\\') return escape(true, ranges) === 'set' ? null : lastCode
      return source.charCodeAt(index++)
    }
    for (;;) {
      if (index >= source.length) fail('an unclosed [')
      if (source[index] === ']') {
        index++
        break
      }
      const first = member()
      if (first === null) simple = false
      if (source[index] === '-' && source[index + 1] !== ']') {
        simple = false
        index++
        const last = member()
        if (first === null || last === null) fail('a class range with a set at one end')
        ranges.push([first as number, last as number])
      } else if (first !== null) ranges.push([first, first])
      members++
    }
    return char(simple && members > 0 && members <= 2, start, highOf(ranges, negated))
  }

  function group(): Node {
    const start = index
    index++
    let open = '('
    let capture = true
    let look = false
    if (source[index] === '?') {
      const head = /^\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>|[imsx]*(?:-[imsx]+)?:)/.exec(source.slice(index))
      if (!head) fail('a group syntax that is not known')
      open = `(${head![0]}`
      index += head![0].length
      look = /^\?(?:=|!|<=|<!)/.test(head![0])
      capture = head![0].startsWith('?<') && !look
    }
    const modifier = /^\(\?([a-z]*)(?:-([a-z]+))?:$/.exec(open)
    let current = ignoreCase[ignoreCase.length - 1]
    if (modifier?.[1]?.includes('i')) current = true
    if (modifier?.[2]?.includes('i')) current = false
    ignoreCase.push(current)
    const child = alternation()
    ignoreCase.pop()
    if (source[index] !== ')') fail('an unclosed (')
    index++
    return { kind: 'group', open, capture, look, child, start, end: index }
  }

  const root = alternation()
  if (index !== source.length) fail('an unbalanced )')
  return root
}

/** Shortest and longest text a node can match (`max` may be infinite). */
function lengths(node: Node): { min: number; max: number } {
  switch (node.kind) {
    case 'char':
      return { min: 1, max: 1 }
    case 'assert':
      return { min: 0, max: 0 }
    case 'group':
      return node.look ? { min: 0, max: 0 } : lengths(node.child)
    case 'seq':
      return node.items.map(lengths).reduce((sum, item) => ({ min: sum.min + item.min, max: sum.max + item.max }), { min: 0, max: 0 })
    case 'alt': {
      const all = node.branches.map(lengths)
      return { min: Math.min(...all.map((item) => item.min)), max: Math.max(...all.map((item) => item.max)) }
    }
    case 'repeat': {
      const child = lengths(node.child)
      return { min: node.min * child.min, max: child.max === 0 ? 0 : node.max * child.max }
    }
  }
}

/**
 * The fewest literal characters any match of the node holds, or -1 when the
 * node is not anchor material: only literal characters, assertions, groups
 * of them, alternation and bounded repetition.
 */
function literals(node: Node): number {
  switch (node.kind) {
    case 'char':
      return node.literal ? 1 : -1
    case 'assert':
      return 0
    case 'group':
      return node.look ? -1 : literals(node.child)
    case 'seq': {
      let total = 0
      for (const item of node.items) {
        const count = literals(item)
        if (count < 0) return -1
        total += count
      }
      return total
    }
    case 'alt': {
      const all = node.branches.map(literals)
      return all.some((count) => count < 0) ? -1 : Math.min(...all)
    }
    case 'repeat': {
      if (node.max === Number.POSITIVE_INFINITY) return -1
      const count = literals(node.child)
      return count < 0 ? -1 : node.min * count
    }
  }
}

/** The fewest literal characters an anchor needs; with fewer, it would match at too many places to save work. */
export const minAnchorLiterals = 2

export type PatternAnchor = {
  /** The anchor alone, for `new RegExp(source, flags)` with the flags of the pattern. */
  source: string
  /** How far from the start of a match the anchor can start. */
  before: { min: number; max: number }
}

type Prefix = { source: string; literals: number }

/** True for a group that changes no flag: `(`, `(?:` or a named group. */
const plainGroup = (node: Node & { kind: 'group' }) => /^\((?:\?:|\?<[A-Za-z_]|$)/.test(node.open)

/**
 * The longest part every match of `items` starts with that is anchor
 * material: the leading run of material items, then the prefix of the first
 * other item when it is a group, an alternation or a repetition of at least
 * one. Groups become non-capturing; a flag group keeps its flags.
 */
function prefixOfItems(source: string, items: Node[]): Prefix | null {
  let text = ''
  let count = 0
  for (const item of items) {
    const material = literals(item)
    if (material >= 0) {
      text += source.slice(item.start, item.end)
      count += material
      continue
    }
    const inner = prefixOf(source, item)
    if (inner !== null) {
      text += inner.source
      count += inner.literals
    }
    break
  }
  return text === '' ? null : { source: text, literals: count }
}

function prefixOf(source: string, node: Node): Prefix | null {
  switch (node.kind) {
    case 'seq':
      return prefixOfItems(source, node.items)
    case 'alt': {
      const all = node.branches.map((branch) => prefixOf(source, branch))
      if (all.some((item) => item === null)) return null
      const prefixes = all as Prefix[]
      return { source: `(?:${prefixes.map((item) => item.source).join('|')})`, literals: Math.min(...prefixes.map((item) => item.literals)) }
    }
    case 'group': {
      if (node.look) return null
      const inner = prefixOf(source, node.child)
      if (inner === null) return null
      return { source: `${plainGroup(node) ? '(?:' : node.open}${inner.source})`, literals: inner.literals }
    }
    case 'repeat':
      return node.min >= 1 ? prefixOf(source, node.child) : null
    default:
      return literals(node) >= 0 ? { source: source.slice(node.start, node.end), literals: literals(node) } : null
  }
}

type Bounds = { min: number; max: number }

/**
 * The anchors of a node: at the first place in its sequence where what
 * follows starts with at least `minAnchorLiterals` literal characters and
 * only parts of bounded length come before it. A group on the way is
 * entered (its flags kept); an alternation needs an anchor in every branch.
 * Null when there is none.
 */
function anchorsOf(source: string, node: Node, start: Bounds, wrap: (text: string) => string): PatternAnchor[] | null {
  if (node.kind === 'alt') {
    const all: PatternAnchor[] = []
    for (const branch of node.branches) {
      const found = anchorsOf(source, branch, start, wrap)
      if (found === null) return null
      all.push(...found)
    }
    return all
  }
  const items = node.kind === 'seq' ? node.items : [node]
  let before = start
  for (let first = 0; first < items.length; first++) {
    if (before.max === Number.POSITIVE_INFINITY) return null
    const prefix = prefixOfItems(source, items.slice(first))
    if (prefix !== null && prefix.literals >= minAnchorLiterals) return [{ source: wrap(prefix.source), before }]
    const item = items[first]
    if (item.kind === 'group' && !item.look) {
      const inner = plainGroup(item) ? wrap : (text: string) => wrap(`${item.open}${text})`)
      const found = anchorsOf(source, item.child, before, inner)
      if (found !== null) return found
    }
    before = add(before, lengths(item))
  }
  return null
}

function add(left: Bounds, right: Bounds): Bounds {
  return { min: left.min + right.min, max: left.max + right.max }
}

/** True when the node holds an unbounded quantifier. */
function unbounded(node: Node): boolean {
  switch (node.kind) {
    case 'seq':
      return node.items.some(unbounded)
    case 'alt':
      return node.branches.some(unbounded)
    case 'group':
      return unbounded(node.child)
    case 'repeat':
      return !Number.isFinite(node.max) || unbounded(node.child)
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Linear unbounded quantifiers. A backtracking scan of an unbounded
// quantifier `c{n,}` over a single character set C costs at most the length
// of the run of C characters it reads, times the cost of one try of what
// follows, when both hold:
// - fenced: the character just before the run is never in C (a mandatory
//   part whose last character is outside C, `^`, or `\b` before word
//   characters), so the runs of different tries never overlap, and only the
//   tries that start a bounded distance before one fence reach its run;
// - cheap to go back: what comes after cannot start with a character of C,
//   so going back inside the run fails at once, or what comes after has a
//   bounded length.
// A quantifier at the end of the pattern (only parts that always succeed
// after it) needs neither: the first try that reaches it matches, and the
// next try starts after the match. A pattern whose unbounded quantifiers are
// all linear is scanned as written with `RegExp`; any other runs on the
// linear matcher of `src/rules/pike.ts`.
// ---------------------------------------------------------------------------

const wordSet = (): CharSet => ({ ascii: asciiOf('\\w', false), high: 'none' })

type Edge = { set: CharSet; nullable: boolean }

/** Every character a node can consume. */
function charsOf(node: Node): CharSet {
  switch (node.kind) {
    case 'char':
      return node.set
    case 'assert':
      return emptySet
    case 'group':
      return node.look ? emptySet : charsOf(node.child)
    case 'seq':
      return node.items.map(charsOf).reduce(union, emptySet)
    case 'alt':
      return node.branches.map(charsOf).reduce(union, emptySet)
    case 'repeat':
      return node.max === 0 ? emptySet : charsOf(node.child)
  }
}

/**
 * The first (`end: "first"`) or last character of a match of the node, and
 * whether it can match nothing. Inside a run, `^` and `$` fail, so they
 * count as consuming nothing they could match; `\b`, `\B` and a lookaround
 * are passed through.
 */
function edgeOf(node: Node, end: 'first' | 'last'): Edge {
  switch (node.kind) {
    case 'char':
      return { set: node.set, nullable: false }
    case 'assert':
      return { set: emptySet, nullable: node.end - node.start !== 1 }
    case 'group':
      return node.look ? { set: emptySet, nullable: true } : edgeOf(node.child, end)
    case 'alt': {
      const all = node.branches.map((branch) => edgeOf(branch, end))
      return { set: all.map((item) => item.set).reduce(union, emptySet), nullable: all.some((item) => item.nullable) }
    }
    case 'repeat': {
      if (node.max === 0) return { set: emptySet, nullable: true }
      const child = edgeOf(node.child, end)
      return { set: child.set, nullable: node.min === 0 || child.nullable }
    }
    case 'seq': {
      const items = end === 'first' ? node.items : [...node.items].reverse()
      let set = emptySet
      for (const item of items) {
        const edge = edgeOf(item, end)
        set = union(set, edge.set)
        if (!edge.nullable) return { set, nullable: false }
      }
      return { set, nullable: true }
    }
  }
}

/** True when the node always matches, if only the empty text: it cannot make a try fail. */
function alwaysMatches(node: Node): boolean {
  switch (node.kind) {
    case 'repeat':
      return node.min === 0
    case 'seq':
      return node.items.every(alwaysMatches)
    case 'alt':
      return node.branches.some(alwaysMatches)
    case 'group':
      return !node.look && alwaysMatches(node.child)
    default:
      return false
  }
}

/** Where a node sits: the sequences around it, innermost first, each with the node's index. */
type Frame = { items: Node[]; index: number }

/** The parts after the quantifier: a first character outside C, or nothing that can fail. */
function followed(frames: Frame[], set: CharSet): boolean {
  for (const frame of frames) {
    for (const item of frame.items.slice(frame.index + 1)) {
      const edge = edgeOf(item, 'first')
      if (!disjoint(edge.set, set)) return false
      if (!edge.nullable) return true
    }
  }
  return true
}

/** The parts before the quantifier: characters of C, then a fence. */
function fenced(source: string, frames: Frame[], set: CharSet, mandatory: boolean): boolean {
  let chain = mandatory
  for (const frame of frames) {
    for (const item of frame.items.slice(0, frame.index).reverse()) {
      if (item.kind === 'assert') {
        if (source[item.start] === '^') return true
        if (source.slice(item.start, item.end) === '\\b' && chain && subset(set, wordSet())) return true
        continue
      }
      if (item.kind === 'group' && item.look) continue
      if (subset(charsOf(item), set)) {
        if (lengths(item).min > 0) chain = true
        continue
      }
      const edge = edgeOf(item, 'last')
      if (!disjoint(edge.set, set)) return false
      if (!edge.nullable) return true
    }
  }
  return false
}

/** True when every unbounded quantifier of the pattern is linear (see above). */
function linear(source: string, root: Node): boolean {
  const visit = (node: Node, frames: Frame[], repeated: boolean): boolean => {
    switch (node.kind) {
      case 'seq':
        return node.items.every((item, index) => visit(item, [{ items: node.items, index }, ...frames], repeated))
      case 'alt':
        return node.branches.every((branch) => visit(branch, frames, repeated))
      case 'group':
        return node.look ? !unbounded(node.child) : visit(node.child, frames, repeated)
      case 'repeat': {
        // `?` repeats nothing: what is around it stays where it is.
        if (Number.isFinite(node.max)) return visit(node.child, frames, repeated || node.max > 1)
        if (repeated || node.child.kind !== 'char') return false
        const set = node.child.set
        const after = frames.flatMap((frame) => frame.items.slice(frame.index + 1))
        if (after.every(alwaysMatches)) return true
        const cheapBack = followed(frames, set) || after.every((item) => !unbounded(item))
        return cheapBack && fenced(source, frames, set, node.min > 0)
      }
      default:
        return true
    }
  }
  return visit(root, [], false)
}

/**
 * A pattern that is a repeated character `c{min,max}` (lazy or greedy, max
 * bounded) followed by a tail whose anchors start it: a match starts at `s`
 * exactly when the tail matches at the first (lazy) or last (greedy)
 * anchor position `q` with `min <= q - s <= max` and only `c` characters in
 * between. The scan then tries the tail once per anchor position, instead of
 * the whole pattern at every position before it.
 */
export type PatternSplit = {
  prefix: { source: string; flags: string; min: number; max: number; lazy: boolean }
  tail: string
  /** The anchors of the tail, each at its start. */
  tailAnchors: string[]
}

/**
 * `maxLength`: see the top of the file. `anchors`: every match holds one of
 * them (one per branch of a top-level alternation), or null when the
 * pattern has none to prove. `engine`: `regexp` when a backtracking try is
 * proven bounded (bounded length with few ways to match, or linear unbounded
 * quantifiers), else `vm` (`src/rules/pike.ts`); for a split pattern this
 * is about its tail. `split`: see `PatternSplit`.
 */
export type PatternFacts = {
  maxLength: number | null
  anchors: PatternAnchor[] | null
  engine: 'regexp' | 'vm'
  split: PatternSplit | null
}

/**
 * The most ways one backtracking try of a node can go on past one
 * character, an upper bound: a repetition `{min,max}` counts its
 * `max - min + 1` lengths and a nested or sequential choice multiplies,
 * except that a repetition of one character followed by a part that must
 * start with a character outside it counts as one (going back inside it
 * fails at once on that part). `follow` is the first character of what
 * comes after the node, or null when unknown. An unbounded repetition
 * counts as one, so this is used together with `linear`.
 */
function ways(node: Node, follow: Edge | null): number {
  const cap = (value: number) => Math.min(value, Number.MAX_VALUE)
  switch (node.kind) {
    case 'char':
    case 'assert':
      return 1
    case 'group':
      return node.look ? 1 : ways(node.child, follow)
    case 'seq': {
      let product = 1
      let after = follow
      for (let index = node.items.length - 1; index >= 0; index--) {
        const item = node.items[index]
        product = cap(product * ways(item, after))
        const edge = edgeOf(item, 'first')
        after = edge.nullable ? (after === null ? null : { set: union(edge.set, after.set), nullable: after.nullable }) : edge
      }
      return product
    }
    case 'alt':
      return node.branches.reduce((sum, branch) => cap(sum + ways(branch, follow)), 0)
    case 'repeat': {
      if (node.child.kind === 'char' && follow !== null && !follow.nullable && disjoint(follow.set, node.child.set)) return 1
      const child = ways(node.child, null)
      if (!Number.isFinite(node.max)) return child
      let total = 0
      for (let count = node.min; count <= node.max && total < Number.MAX_VALUE; count++) total = cap(total + child ** count)
      return total
    }
  }
}

/**
 * The most ways a backtracking try may take before the pattern runs on the
 * linear matcher instead: with at most this many ways, each at most the
 * longest match long, one try stays cheap.
 */
export const maxWays = 1_000_000

function splitOf(source: string, flags: string, root: Node): PatternSplit | null {
  if (root.kind !== 'seq' || root.items.length < 2) return null
  const first = root.items[0]
  if (first.kind !== 'repeat' || !Number.isFinite(first.max) || first.child.kind !== 'char') return null
  const child = first.child
  let min = first.min
  let max = first.max
  const next = root.items[1]
  let tail = source.slice(next.start, root.end)
  if (next.kind === 'group' && !next.look && next.child.kind === 'seq' && next.child.items.length > 1) {
    const inner = next.child.items[0]
    if (
      inner.kind === 'repeat' &&
      Number.isFinite(inner.max) &&
      inner.lazy === first.lazy &&
      inner.child.kind === 'char' &&
      inner.child.set.ascii === child.set.ascii &&
      inner.child.set.high === 'none' &&
      child.set.high === 'none'
    ) {
      const innerRest = next.child.items.slice(1)
      min += inner.min
      max += inner.max
      tail = `${next.open}${source.slice(innerRest[0].start, next.child.end)})${source.slice(next.end, root.end)}`
    }
  }
  // The anchors of the tail are read from the tail's own source, so a part
  // the merge removed can never be one.
  const tailRoot = parse(tail, flags)
  const anchors = anchorsOf(tail, tailRoot, { min: 0, max: 0 }, (text) => text)
  if (anchors === null || anchors.some((anchor) => anchor.before.max !== 0)) return null
  return {
    prefix: { source: source.slice(child.start, child.end), flags: child.ignoreCase ? 'i' : '', min, max, lazy: first.lazy },
    tail,
    tailAnchors: anchors.map((anchor) => anchor.source),
  }
}

/** The facts of one pattern. Throws `PatternError` on a construct the reader does not know. */
export function analyzePattern(regex: ConvertedRegex): PatternFacts {
  const root = parse(regex.source, regex.flags)
  // A lookaround reads text its match does not hold: only a bounded one keeps `maxLength` a bound on what a try reads.
  const looks = (node: Node): void => {
    if (node.kind === 'group' && node.look && !Number.isFinite(lengths(node.child).max))
      throw new PatternError(`an unbounded lookaround at offset ${node.start}`)
    if (node.kind === 'seq') node.items.forEach(looks)
    else if (node.kind === 'alt') node.branches.forEach(looks)
    else if (node.kind === 'group' || node.kind === 'repeat') looks(node.child)
  }
  looks(root)
  const { max } = lengths(root)
  const anchors = anchorsOf(regex.source, root, { min: 0, max: 0 }, (text) => text)
  const split = splitOf(regex.source, regex.flags, root)
  // A split rule tries only its tail with `RegExp`; its prefix is walked by the scan.
  const tried = split ? parse(split.tail, regex.flags) : root
  const cheap = (Number.isFinite(max) || linear(regex.source, root)) && ways(tried, null) <= maxWays
  return { maxLength: Number.isFinite(max) ? max : null, anchors, engine: cheap ? 'regexp' : 'vm', split }
}

/** The reader's tree of a pattern, for the linear matcher (`src/rules/pike.ts`). */
export type PatternNode = Node

/** Parses a converted pattern. Throws `PatternError` on a construct the reader does not know. */
export function parsePattern(source: string, flags: string): PatternNode {
  return parse(source, flags)
}
