/**
 * A linear-time matcher for the secret rules that `src/rules/pattern.ts`
 * cannot prove linear under JavaScript's backtracking engine (spec, Secret
 * scan, "Scan cost"). It is a Pike VM, the method RE2 uses: every way of
 * matching advances one character at a time, at most one thread per
 * instruction, so a text of n characters costs at most n times the size of
 * the program, whatever the pattern. Threads keep the backtracking order
 * (leftmost start first, then the order a backtracking engine tries
 * alternatives and repetitions), so the match and its groups are the ones
 * `RegExp.prototype.exec` returns.
 *
 * It covers the subset the pattern reader parses, with three limits, each a
 * `PatternError`: no lookaround but `(?![\s\S])` (end of text) and
 * `(?<![\s\S])` (start of text), no repetition of something that can match
 * nothing (JavaScript skips such an iteration; this VM would not), and no
 * program larger than `maxProgram`.
 *
 * Work is counted in steps (a thread visiting an instruction), never timed:
 * past `limit` steps the run stops with `limit`, and the scan reports
 * `scan-limit`.
 */
import type { ConvertedRegex } from './gitleaks.js'
import { type PatternNode, PatternError, parsePattern } from './pattern.js'

const Op = { Char: 0, Split: 1, Jump: 2, Save: 3, Clear: 4, Start: 5, End: 6, Word: 7, NotWord: 8, Match: 9 } as const
type Op = (typeof Op)[keyof typeof Op]

/** One instruction: `Split` prefers `a` to `b`; `Clear` empties the groups `a` to `b` (exclusive). */
type Instruction = { op: Op; a: number; b: number }

/** The most instructions a program may have. */
export const maxProgram = 20000

export type Program = {
  instructions: Instruction[]
  /** Per `Char` instruction index into `sets`: whether a code unit is a member. */
  sets: ((code: number) => boolean)[]
  /** Number of capture groups, without the whole match. */
  groups: number
  /** The work arrays of `scanProgram`, made once per program and reused. */
  buffers?: Buffers
}

type Buffers = { runs: number; visitedRun: Int32Array; visitedAt: Int32Array; stack: Int32Array; lists: [Int32Array, Int32Array, Int32Array, Int32Array] }

function newBuffers(size: number): Buffers {
  const list = () => new Int32Array(size)
  return { runs: 0, visitedRun: new Int32Array(size), visitedAt: new Int32Array(size), stack: new Int32Array(2 * size + 2), lists: [list(), list(), list(), list()] }
}

/** Membership of a character node, decided by its own regex once per code unit. */
function memberTest(source: string, ignoreCase: boolean): (code: number) => boolean {
  const regex = new RegExp(`^(?:${source})$`, ignoreCase ? 'i' : '')
  const known = new Int8Array(65536)
  return (code) => {
    let value = known[code]
    if (value === 0) {
      value = regex.test(String.fromCharCode(code)) ? 1 : -1
      known[code] = value
    }
    return value === 1
  }
}

function nullable(node: PatternNode): boolean {
  switch (node.kind) {
    case 'char':
      return false
    case 'assert':
      return true
    case 'group':
      return node.look || nullable(node.child)
    case 'seq':
      return node.items.every(nullable)
    case 'alt':
      return node.branches.some(nullable)
    case 'repeat':
      return node.min === 0 || nullable(node.child)
  }
}

/** The capture groups below a node, numbered in source order from `first`: their count. */
function groupCount(node: PatternNode): number {
  switch (node.kind) {
    case 'group':
      return (node.capture ? 1 : 0) + groupCount(node.child)
    case 'seq':
      return node.items.reduce((sum, item) => sum + groupCount(item), 0)
    case 'alt':
      return node.branches.reduce((sum, item) => sum + groupCount(item), 0)
    case 'repeat':
      return groupCount(node.child)
    default:
      return 0
  }
}

/** Compiles a pattern for the VM. Throws `PatternError` outside the subset above. */
export function compileProgram(regex: ConvertedRegex): Program {
  const root = parsePattern(regex.source, regex.flags)
  const instructions: Instruction[] = []
  const sets: ((code: number) => boolean)[] = []
  const tests = new Map<string, (code: number) => boolean>()
  let nextGroup = 1
  const emit = (op: Op, a = 0, b = 0): number => {
    if (instructions.length >= maxProgram) throw new PatternError(`a program of more than ${maxProgram} instructions`)
    instructions.push({ op, a, b })
    return instructions.length - 1
  }
  const fail = (node: PatternNode, message: string): never => {
    throw new PatternError(`${message} at offset ${node.start}`)
  }

  function compile(node: PatternNode): void {
    switch (node.kind) {
      case 'char': {
        const source = regex.source.slice(node.start, node.end)
        const key = `${node.ignoreCase ? 'i' : ''}/${source}`
        let test = tests.get(key)
        if (test === undefined) {
          test = memberTest(source, node.ignoreCase)
          tests.set(key, test)
        }
        sets.push(test)
        emit(Op.Char, sets.length - 1)
        return
      }
      case 'assert': {
        const text = regex.source.slice(node.start, node.end)
        emit(text === '^' ? Op.Start : text === '$' ? Op.End : text === '\\b' ? Op.Word : Op.NotWord)
        return
      }
      case 'group': {
        if (node.look) {
          const text = regex.source.slice(node.start, node.end)
          if (text === '(?![\\s\\S])') emit(Op.End)
          else if (text === '(?<![\\s\\S])') emit(Op.Start)
          else fail(node, 'a lookaround the matcher does not run')
          return
        }
        if (!node.capture) return compile(node.child)
        const group = nextGroup++
        emit(Op.Save, 2 * group)
        compile(node.child)
        emit(Op.Save, 2 * group + 1)
        return
      }
      case 'seq':
        for (const item of node.items) compile(item)
        return
      case 'alt': {
        const jumps: number[] = []
        node.branches.forEach((branch, index) => {
          if (index < node.branches.length - 1) {
            const split = emit(Op.Split)
            instructions[split].a = split + 1
            compile(branch)
            jumps.push(emit(Op.Jump))
            instructions[split].b = instructions.length
          } else compile(branch)
        })
        for (const jump of jumps) instructions[jump].a = instructions.length
        return
      }
      case 'repeat': {
        if (node.max > node.min && nullable(node.child)) fail(node, 'a repetition of something that can match nothing')
        // Each iteration starts with the groups inside it empty, as in JavaScript.
        const first = nextGroup
        const inner = groupCount(node.child)
        const iteration = () => {
          nextGroup = first
          if (inner > 0) emit(Op.Clear, 2 * first, 2 * (first + inner))
          compile(node.child)
        }
        for (let count = 0; count < node.min; count++) iteration()
        if (!Number.isFinite(node.max)) {
          const loop = emit(Op.Split)
          iteration()
          emit(Op.Jump, loop)
          const body = loop + 1
          const exit = instructions.length
          instructions[loop].a = node.lazy ? exit : body
          instructions[loop].b = node.lazy ? body : exit
        } else {
          const splits: number[] = []
          for (let count = node.min; count < node.max; count++) {
            splits.push(emit(Op.Split))
            iteration()
          }
          const exit = instructions.length
          for (const split of splits) {
            instructions[split].a = node.lazy ? exit : split + 1
            instructions[split].b = node.lazy ? split + 1 : exit
          }
        }
        nextGroup = first + inner
        return
      }
    }
  }

  compile(root)
  emit(Op.Match)
  return { instructions, sets, groups: nextGroup - 1 }
}

const isWord = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95

/** A match: where it starts and ends, and each group as `[start, end]` or undefined. */
export type VmMatch = { start: number; end: number; groups: ([number, number] | undefined)[] }

/** The outcome of a run: the leftmost match, none, or the position where the step limit stopped it. */
export type VmResult = { match: VmMatch } | { none: true } | { limit: number }

type Thread = { pc: number; slots: number[] }

/**
 * The leftmost match that starts at or after `from` at a position
 * `canStart` allows (every match starts at one), as `exec` finds it. `work`
 * carries the steps spent so far, across runs on one text.
 */
export function runProgram(
  program: Program,
  text: string,
  from: number,
  canStart: (position: number) => boolean,
  nextStart: (position: number) => number,
  work: { steps: number; limit: number },
): VmResult {
  const { instructions, sets } = program
  const slotCount = 2 * (program.groups + 1)
  const visited = new Int32Array(instructions.length).fill(-1)
  let current: Thread[] = []
  let found: number[] | null = null
  let position = from

  /** Follows the instructions that consume nothing, in priority order, into `list`. */
  const add = (list: Thread[], pc: number, slots: number[], at: number): boolean => {
    const stack: { pc: number; slots: number[] }[] = [{ pc, slots }]
    while (stack.length > 0) {
      const { pc: here, slots: own } = stack.pop()!
      if (visited[here] === at) continue
      visited[here] = at
      if (++work.steps > work.limit) return false
      const instruction = instructions[here]
      switch (instruction.op) {
        case Op.Jump:
          stack.push({ pc: instruction.a, slots: own })
          break
        case Op.Split:
          stack.push({ pc: instruction.b, slots: own }, { pc: instruction.a, slots: own })
          break
        case Op.Save: {
          const copy = own.slice()
          copy[instruction.a] = at
          stack.push({ pc: here + 1, slots: copy })
          break
        }
        case Op.Clear: {
          const copy = own.slice()
          copy.fill(-1, instruction.a, instruction.b)
          stack.push({ pc: here + 1, slots: copy })
          break
        }
        case Op.Start:
          if (at === 0) stack.push({ pc: here + 1, slots: own })
          break
        case Op.End:
          if (at === text.length) stack.push({ pc: here + 1, slots: own })
          break
        case Op.Word:
        case Op.NotWord: {
          const before = at > 0 && isWord(text.charCodeAt(at - 1))
          const after = at < text.length && isWord(text.charCodeAt(at))
          if ((before !== after) === (instruction.op === Op.Word)) stack.push({ pc: here + 1, slots: own })
          break
        }
        default:
          list.push({ pc: here, slots: own })
      }
    }
    return true
  }

  while (position <= text.length) {
    if (found === null && canStart(position)) {
      const slots = new Array<number>(slotCount).fill(-1)
      slots[0] = position
      if (!add(current, 0, slots, position)) return { limit: position }
    }
    if (current.length === 0) {
      if (found !== null) break
      const next = nextStart(position + 1)
      if (next > text.length) break
      position = next
      continue
    }
    const next: Thread[] = []
    const code = position < text.length ? text.charCodeAt(position) : -1
    for (const thread of current) {
      if (++work.steps > work.limit) return { limit: position }
      const instruction = instructions[thread.pc]
      if (instruction.op === Op.Match) {
        found = thread.slots.slice()
        found[1] = position
        break
      }
      if (code >= 0 && sets[instruction.a](code) && !add(next, thread.pc + 1, thread.slots, position + 1)) return { limit: position }
    }
    current = next
    position++
  }
  if (found === null) return { none: true }
  const groups: ([number, number] | undefined)[] = []
  for (let group = 1; group <= program.groups; group++) {
    const start = found[2 * group]
    const end = found[2 * group + 1]
    groups.push(start >= 0 && end >= 0 ? [start, end] : undefined)
  }
  return { match: { start: found[0], end: found[1], groups } }
}

/**
 * `runProgram` without groups, for the scan: only where the match starts and
 * ends. The same order and the same steps counted, with typed arrays
 * instead of a group array per thread.
 */
export function scanProgram(
  program: Program,
  text: string,
  from: number,
  canStart: (position: number) => boolean,
  nextStart: (position: number) => number,
  work: { steps: number; limit: number },
): VmResult {
  const { instructions, sets } = program
  const buffers = (program.buffers ??= newBuffers(instructions.length))
  // A visit counts at this position in this run only: no clearing between runs.
  const run = ++buffers.runs
  const { visitedRun, visitedAt, stack } = buffers
  let [currentPc, currentStart, nextPc, nextStartOf] = buffers.lists
  let currentCount = 0
  let nextCount = 0
  let foundStart = -1
  let foundEnd = -1
  let position = from

  /** Adds the threads reached from `pc` at `at` without consuming, in priority order; false past the limit. */
  const add = (toNext: boolean, pc: number, start: number, at: number): boolean => {
    let top = 0
    stack[top++] = pc
    while (top > 0) {
      const here = stack[--top]
      if (visitedRun[here] === run && visitedAt[here] === at) continue
      visitedRun[here] = run
      visitedAt[here] = at
      if (++work.steps > work.limit) return false
      const instruction = instructions[here]
      switch (instruction.op) {
        case Op.Jump:
          stack[top++] = instruction.a
          break
        case Op.Split:
          stack[top++] = instruction.b
          stack[top++] = instruction.a
          break
        case Op.Save:
        case Op.Clear:
          stack[top++] = here + 1
          break
        case Op.Start:
          if (at === 0) stack[top++] = here + 1
          break
        case Op.End:
          if (at === text.length) stack[top++] = here + 1
          break
        case Op.Word:
        case Op.NotWord: {
          const before = at > 0 && isWord(text.charCodeAt(at - 1))
          const after = at < text.length && isWord(text.charCodeAt(at))
          if ((before !== after) === (instruction.op === Op.Word)) stack[top++] = here + 1
          break
        }
        default:
          if (toNext) {
            nextPc[nextCount] = here
            nextStartOf[nextCount++] = start
          } else {
            currentPc[currentCount] = here
            currentStart[currentCount++] = start
          }
      }
    }
    return true
  }

  while (position <= text.length) {
    if (foundStart < 0 && canStart(position) && !add(false, 0, position, position)) return { limit: position }
    if (currentCount === 0) {
      if (foundStart >= 0) break
      const next = nextStart(position + 1)
      if (next > text.length) break
      position = next
      continue
    }
    nextCount = 0
    const code = position < text.length ? text.charCodeAt(position) : -1
    for (let index = 0; index < currentCount; index++) {
      if (++work.steps > work.limit) return { limit: position }
      const instruction = instructions[currentPc[index]]
      if (instruction.op === Op.Match) {
        foundStart = currentStart[index]
        foundEnd = position
        break
      }
      if (code >= 0 && sets[instruction.a](code) && !add(true, currentPc[index] + 1, currentStart[index], position + 1)) return { limit: position }
    }
    ;[currentPc, nextPc] = [nextPc, currentPc]
    ;[currentStart, nextStartOf] = [nextStartOf, currentStart]
    currentCount = nextCount
    position++
  }
  return foundStart < 0 ? { none: true } : { match: { start: foundStart, end: foundEnd, groups: [] } }
}
