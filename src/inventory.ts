/**
 * Module inventory (spec, "Module inventory"): the modules an app registers
 * in `src/modules.ts`, read from the snapshot with the `typescript` parser.
 * Static only: no type checking, no module resolution beyond the one
 * relative import a loop reads, and no app code run. Anything the reader
 * cannot follow is listed as `unparsed` with its line, never dropped
 * silently. Findings name the path and line, never source text.
 */
import * as posix from 'node:path/posix'
import ts from 'typescript'
import type { Finding } from './policy/entries.js'

export const modulesPath = 'src/modules.ts'
/** The catalog's `MAX_PARSE_BYTES`: a larger file is `modules-unparsed` as a whole. */
export const maxParseBytes = 2_000_000
/** A missing `from` means core, as the scaffold's `ModuleEntry` type says. */
export const defaultFrom = '@open-mercato/core'
export const appFrom = '@app'

/** The catalog's `ModuleId` (`lib/schema/common.ts`). */
export const moduleIdPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
/** The catalog's `EnvName`. */
export const envNamePattern = /^[A-Z][A-Z0-9_]{1,63}$/
/** The catalog's `NpmName`. */
export const npmNamePattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export type InventoryEntry = {
  id: string
  from: string
  /** Q3 grammar: env names and `module:<id>` terms, each optionally `!`, joined with ` && `; or `custom`. Absent when unconditional. */
  when?: string
  /** The line in `src/modules.ts` that registers the entry. */
  line: number
}

export type Unparsed = { line: number; reason: string }

export type Inventory = {
  entries: InventoryEntry[]
  unparsed: Unparsed[]
  /** `modules-ts` (error), `modules-unparsed` and `module-from-unknown` (warnings). */
  findings: Finding[]
}

/** True when `from` is `@app` or an npm package name; anything else is `module-from-unknown`. */
export function isKnownFrom(from: string): boolean {
  return from === appFrom || (from.length <= 214 && npmNamePattern.test(from))
}

/** Where an addition is written to the list. */
type Context = {
  /** The `when` terms of the enclosing conditions, in order. */
  terms: string[]
  /** The line of an enclosing condition outside the grammar, or null. */
  custom: number | null
}

const unconditional: Context = { terms: [], custom: null }

/** Array methods that never change the array or its entries' registration. `forEach` is not one: its callback may. */
const readOnlyMethods = new Set(['some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'includes', 'indexOf', 'lastIndexOf', 'map', 'filter', 'flatMap', 'reduce', 'slice', 'concat', 'join', 'at', 'entries', 'keys', 'values', 'toString'])

/** Array methods that change the array in place. */
const mutatingMethods = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'sort', 'reverse', 'fill', 'copyWithin'])

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    )
      current = current.expression
    else return current
  }
}

function stringValue(node: ts.Expression | undefined): string | null {
  if (!node) return null
  const value = unwrap(node)
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : null
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return null
}

function hasExport(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function blockStatements(statement: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(statement) ? statement.statements : [statement]
}

function hasIdProperty(node: ts.Expression): boolean {
  const value = unwrap(node)
  return ts.isObjectLiteralExpression(value) && value.properties.some((property) => property.name !== undefined && propertyName(property.name) === 'id')
}

/** The syntax errors of a TypeScript file: the parser's own diagnostics, no type checking. */
function syntaxErrorCount(fileName: string, text: string): number {
  const output = ts.transpileModule(text, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { noResolve: true, noLib: true, isolatedModules: false, target: ts.ScriptTarget.ES2022 },
  })
  return (output.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length
}

type ObjectRead = { id: string; from: string } | { reason: string }

/** Reads one `{id, from}` object literal. */
function readObject(node: ts.ObjectLiteralExpression): ObjectRead {
  const values = new Map<string, ts.Expression | null>()
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) return { reason: 'an entry with a spread (...) the inventory cannot read' }
    const name = property.name === undefined ? null : propertyName(property.name)
    if (name === null) return { reason: 'an entry with a computed property name' }
    if (ts.isPropertyAssignment(property)) values.set(name, property.initializer)
    else values.set(name, null)
  }
  if (!values.has('id')) return { reason: 'an entry without an id' }
  const id = stringValue(values.get('id') ?? undefined)
  if (id === null) return { reason: 'an entry whose id is not a string literal' }
  if (!moduleIdPattern.test(id) || id.length > 64) return { reason: 'an entry whose id is not a module id (lower-case snake_case)' }
  if (!values.has('from')) return { id, from: defaultFrom }
  const from = stringValue(values.get('from') ?? undefined)
  if (from === null || from === '') return { reason: 'an entry whose from is not a string literal' }
  // An unknown from is kept (module-from-unknown) only when it looks like a
  // path or alias; anything else (a URL that may hold a credential, a line
  // break) is never copied into the manifest.
  if (!isKnownFrom(from) && !/^[A-Za-z0-9@~._/-]{1,214}$/.test(from)) return { reason: 'an entry whose from is neither @app, an npm package name nor a path' }
  return { id, from }
}

/**
 * Reads the inventory of `src/modules.ts` from the snapshot. `contents` maps
 * every exported path to its bytes; the one relative import a loop reads
 * (`./official-modules.generated`, Q5) is looked up there too.
 */
export function readInventory(contents: ReadonlyMap<string, Buffer>): Inventory {
  const inventory: Inventory = { entries: [], unparsed: [], findings: [] }
  const content = contents.get(modulesPath)
  if (content === undefined) {
    inventory.findings.push({
      rule: 'modules-ts',
      level: 'error',
      path: modulesPath,
      message: 'The snapshot has no src/modules.ts: it is not in the commit, or it is not a regular file, or export-ignore left it out. A template must register its modules there.',
    })
    return inventory
  }
  if (content.length > maxParseBytes) {
    inventory.unparsed.push({ line: 1, reason: `src/modules.ts is larger than ${maxParseBytes} bytes and is not read` })
    return finish(inventory)
  }
  const text = content.toString('utf8')
  try {
    return readSource(contents, text, inventory)
  } catch (caught) {
    // The TypeScript parser recurses: a file nested thousands of levels deep
    // (`!!!!...`, `((((...`) overflows the stack well below the size limit.
    if (!(caught instanceof RangeError)) throw caught
    return finish({ entries: [], unparsed: [{ line: 1, reason: 'src/modules.ts is nested too deeply to read' }], findings: [] })
  }
}

function readSource(contents: ReadonlyMap<string, Buffer>, text: string, inventory: Inventory): Inventory {
  if (syntaxErrorCount(modulesPath, text) > 0) {
    inventory.findings.push({
      rule: 'modules-ts',
      level: 'error',
      path: modulesPath,
      message: 'src/modules.ts has a syntax error. Fix it and commit, then retry.',
    })
    return inventory
  }
  new Reader(contents, ts.createSourceFile(modulesPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), inventory).read()
  return finish(inventory)
}

/** Adds one `modules-unparsed` warning per unparsed construct and one `module-from-unknown` per entry, sorted by line. */
function finish(inventory: Inventory): Inventory {
  inventory.unparsed.sort((left, right) => left.line - right.line)
  for (const item of inventory.unparsed)
    inventory.findings.push({ rule: 'modules-unparsed', level: 'warning', path: modulesPath, line: item.line, message: `Not read: ${item.reason}. Check this line by hand.` })
  for (const entry of inventory.entries)
    if (!isKnownFrom(entry.from))
      inventory.findings.push({
        rule: 'module-from-unknown',
        level: 'warning',
        path: modulesPath,
        line: entry.line,
        message: `Module ${entry.id}: from is neither @app nor an npm package name.`,
      })
  return inventory
}

class Reader {
  private readonly handled = new Set<ts.Node>()
  private readonly reported = new Set<string>()
  private binding: ts.Identifier | null = null
  private readonly contents: ReadonlyMap<string, Buffer>
  private readonly source: ts.SourceFile
  private readonly inventory: Inventory

  constructor(contents: ReadonlyMap<string, Buffer>, source: ts.SourceFile, inventory: Inventory) {
    this.contents = contents
    this.source = source
    this.inventory = inventory
  }

  read(): void {
    const statements = this.source.statements
    const found = this.findBinding()
    if (found === null) {
      this.unparsed(1, 'no exported array of {id, from} module entries')
      return
    }
    const { index, name, array } = found
    this.binding = name
    for (const element of array.elements) this.addElement(element, unconditional, 'end')
    this.walk(statements.slice(index + 1), unconditional)
    this.scanMutations()
  }

  private line(node: ts.Node): number {
    return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1
  }

  private unparsed(line: number, reason: string): void {
    const key = `${line}\n${reason}`
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.inventory.unparsed.push({ line, reason })
  }

  private isBinding(node: ts.Expression): boolean {
    const value = unwrap(node)
    return this.binding !== null && ts.isIdentifier(value) && value.text === this.binding.text
  }

  /** Step 1: the first exported array binding that holds `{id, ...}` object literals. */
  private findBinding(): { index: number; name: ts.Identifier; array: ts.ArrayLiteralExpression } | null {
    const statements = this.source.statements
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]
      if (!ts.isVariableStatement(statement) || !hasExport(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
        const array = unwrap(declaration.initializer)
        if (ts.isArrayLiteralExpression(array) && array.elements.some((element) => hasIdProperty(element)))
          return { index, name: declaration.name, array }
      }
    }
    return null
  }

  private whenOf(context: Context): string | undefined {
    if (context.custom !== null) return 'custom'
    return context.terms.length > 0 ? context.terms.join(' && ') : undefined
  }

  private add(entries: InventoryEntry[], position: 'start' | 'end'): void {
    if (position === 'end') this.inventory.entries.push(...entries)
    else this.inventory.entries.unshift(...entries)
  }

  private entry(id: string, from: string, context: Context, line: number): InventoryEntry {
    if (context.custom !== null) this.unparsed(context.custom, 'a condition outside the when grammar (entry kept with when: "custom")')
    const when = this.whenOf(context)
    return when === undefined ? { id, from, line } : { id, from, when, line }
  }

  /** One element of the initial array, a `push`/`unshift` argument or a reassigned array. */
  private elementEntries(element: ts.Expression, context: Context): InventoryEntry[] {
    const value = unwrap(element)
    const line = this.line(element)
    if (ts.isObjectLiteralExpression(value)) {
      const read = readObject(value)
      if ('reason' in read) {
        this.unparsed(line, read.reason)
        return []
      }
      return [this.entry(read.id, read.from, context, line)]
    }
    if (ts.isSpreadElement(value) && this.isBinding(value.expression)) {
      this.unparsed(line, 'a spread of the module list into itself')
      return []
    }
    if (ts.isSpreadElement(value) && ts.isIdentifier(unwrap(value.expression))) {
      const array = this.readArray(unwrap(value.expression) as ts.Identifier, line)
      if (array === null) return []
      return array.map((item) => this.entry(item.id, item.from, context, line))
    }
    this.unparsed(line, ts.isSpreadElement(value) ? 'a spread of an expression the inventory cannot read' : 'an addition that is not an object literal')
    return []
  }

  private addElement(element: ts.Expression, context: Context, position: 'start' | 'end'): void {
    this.add(this.elementEntries(element, context), position)
  }

  /** Step 2 and 3: the statements after the initial array, in source order, with their conditions. */
  private walk(statements: readonly ts.Statement[], context: Context): void {
    // A block that declares its own variable of the list's name holds another
    // list: its additions are not registrations (scanMutations lists them).
    if (this.binding !== null && declaresName(statements, this.binding.text)) return
    for (const statement of statements) {
      if (ts.isBlock(statement)) this.walk(statement.statements, context)
      else if (ts.isExpressionStatement(statement)) this.expression(statement.expression, context)
      else if (ts.isIfStatement(statement)) this.ifStatement(statement, context)
      else if (ts.isForOfStatement(statement)) this.loop(statement, context)
      // Any other statement that changes the list is found by scanMutations.
    }
  }

  private expression(node: ts.Expression, context: Context): void {
    const value = unwrap(node)
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && this.isBinding(value.expression.expression)) {
      const method = value.expression.name.text
      if (method !== 'push' && method !== 'unshift') return
      this.handled.add(value)
      const added = value.arguments.flatMap((argument) => this.elementEntries(argument, context))
      this.add(added, method === 'push' ? 'end' : 'start')
      return
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken && this.isBinding(value.left)) {
      this.handled.add(value)
      const right = unwrap(value.right)
      const self = ts.isArrayLiteralExpression(right)
        ? right.elements.map((element, index) => (ts.isSpreadElement(element) && this.isBinding(element.expression) ? index : -1)).filter((index) => index >= 0)
        : []
      if (!ts.isArrayLiteralExpression(right) || self.length !== 1) {
        this.unparsed(this.line(value), 'a reassignment of the module list the inventory cannot read')
        return
      }
      const before = right.elements.slice(0, self[0]).flatMap((element) => this.elementEntries(element, context))
      const after = right.elements.slice(self[0] + 1).flatMap((element) => this.elementEntries(element, context))
      this.add(before, 'start')
      this.add(after, 'end')
    }
  }

  private ifStatement(statement: ts.IfStatement, context: Context): void {
    const line = this.line(statement)
    const terms = this.termsOf(statement.expression)
    this.walk(blockStatements(statement.thenStatement), this.join(context, terms, line))
    if (statement.elseStatement === undefined) return
    // The else of a one-term condition negates it; any other else is custom.
    const negated = terms !== null && terms.length === 1 ? [negate(terms[0])] : null
    this.walk(blockStatements(statement.elseStatement), this.join(context, negated, line))
  }

  private join(context: Context, terms: string[] | null, line: number): Context {
    if (context.custom !== null) return context
    if (terms === null) return { terms: context.terms, custom: line }
    const joined = [...context.terms]
    for (const term of terms) if (!joined.includes(term)) joined.push(term)
    return { terms: joined, custom: null }
  }

  /** The `when` terms of a condition, or null when it is outside the grammar. */
  private termsOf(node: ts.Expression): string[] | null {
    const value = unwrap(node)
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = this.termsOf(value.left)
      const right = this.termsOf(value.right)
      return left === null || right === null ? null : [...left, ...right]
    }
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = this.termsOf(value.operand)
      return inner !== null && inner.length === 1 ? [negate(inner[0])] : null
    }
    if (ts.isIdentifier(value)) {
      const initializer = this.constInitializer(value.text)
      const name = initializer === null ? null : envRead(initializer)
      return name === null ? null : [name]
    }
    const name = envRead(value)
    if (name !== null) return [name]
    const id = this.someIdCheck(value)
    return id === null ? null : [`module:${id}`]
  }

  /** The initializer of a top-level `const` of this name, or null. */
  private constInitializer(name: string): ts.Expression | null {
    for (const statement of this.source.statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer ?? null
    }
    return null
  }

  /** `<binding>.some((x) => x.id === '<id>')` gives `<id>`. */
  private someIdCheck(node: ts.Expression): string | null {
    if (!ts.isCallExpression(node) || node.arguments.length !== 1) return null
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'some' || !this.isBinding(callee.expression)) return null
    const predicate = unwrap(node.arguments[0])
    if (!ts.isArrowFunction(predicate) || predicate.parameters.length !== 1 || !ts.isIdentifier(predicate.parameters[0].name)) return null
    if (ts.isBlock(predicate.body)) return null
    const parameter = predicate.parameters[0].name.text
    const body = unwrap(predicate.body)
    if (!ts.isBinaryExpression(body) || !isEquality(body.operatorToken.kind)) return null
    const sides = [unwrap(body.left), unwrap(body.right)]
    const literal = sides.map((side) => stringValue(side)).find((text) => text !== null)
    const reads = sides.some((side) => isPropertyRead(side, parameter, 'id'))
    return reads && literal !== undefined && literal !== null && moduleIdPattern.test(literal) ? literal : null
  }

  /**
   * Step 4: `for (const entry of <array>) <binding>.push(entry)`, with or
   * without the dedupe guard `if (!<binding>.some((existing) => existing.id === entry.id))`.
   * The array is read from the file it is imported from (Q5).
   */
  private loop(statement: ts.ForOfStatement, context: Context): void {
    const line = this.line(statement)
    const list = statement.initializer
    const iterated = unwrap(statement.expression)
    if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1 || !ts.isIdentifier(list.declarations[0].name) || !ts.isIdentifier(iterated))
      return
    const variable = list.declarations[0].name.text
    const body = blockStatements(statement.statement)
    if (body.length !== 1) return
    let push: ts.Statement = body[0]
    let dedupe = false
    if (ts.isIfStatement(push) && push.elseStatement === undefined && this.isDedupeGuard(push.expression, variable)) {
      const inner = blockStatements(push.thenStatement)
      if (inner.length !== 1) return
      push = inner[0]
      dedupe = true
    }
    if (!ts.isExpressionStatement(push)) return
    const call = unwrap(push.expression)
    if (
      !ts.isCallExpression(call) ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== 'push' ||
      !this.isBinding(call.expression.expression) ||
      call.arguments.length !== 1 ||
      !isIdentifierNamed(call.arguments[0], variable)
    )
      return
    this.handled.add(call)
    const array = this.readArray(iterated, line)
    if (array === null) return
    const ids = new Set(this.inventory.entries.map((entry) => entry.id))
    for (const item of array) {
      if (dedupe && ids.has(item.id)) continue
      ids.add(item.id)
      this.inventory.entries.push(this.entry(item.id, item.from, context, line))
    }
  }

  /** `!<binding>.some((existing) => existing.id === <variable>.id)`. */
  private isDedupeGuard(node: ts.Expression, variable: string): boolean {
    const value = unwrap(node)
    if (!ts.isPrefixUnaryExpression(value) || value.operator !== ts.SyntaxKind.ExclamationToken) return false
    const call = unwrap(value.operand)
    if (!ts.isCallExpression(call) || call.arguments.length !== 1) return false
    const callee = call.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'some' || !this.isBinding(callee.expression)) return false
    const predicate = unwrap(call.arguments[0])
    if (!ts.isArrowFunction(predicate) || predicate.parameters.length !== 1 || !ts.isIdentifier(predicate.parameters[0].name) || ts.isBlock(predicate.body))
      return false
    const parameter = predicate.parameters[0].name.text
    const body = unwrap(predicate.body)
    if (!ts.isBinaryExpression(body) || !isEquality(body.operatorToken.kind)) return false
    const left = unwrap(body.left)
    const right = unwrap(body.right)
    return (
      (isPropertyRead(left, parameter, 'id') && isPropertyRead(right, variable, 'id')) ||
      (isPropertyRead(left, variable, 'id') && isPropertyRead(right, parameter, 'id'))
    )
  }

  /**
   * The `{id, from}` entries of an array named by an identifier: a top-level
   * `const` array of this file, or an array exported by the relative module
   * it is imported from. Null, with an `unparsed` item, when it cannot be read.
   */
  private readArray(identifier: ts.Identifier, line: number): Array<{ id: string; from: string }> | null {
    const local = this.constInitializer(identifier.text)
    if (local !== null) {
      const array = unwrap(local)
      return ts.isArrayLiteralExpression(array) ? this.arrayEntries(array, this.source, line) : this.fail(line, 'the array the loop reads is not an array literal')
    }
    const imported = this.importOf(identifier.text)
    if (imported === null) return this.fail(line, 'the array the loop reads is neither declared in src/modules.ts nor imported from a relative module')
    const file = resolveImport(this.contents, imported.specifier)
    if (file === null) return this.fail(line, 'the module the array is imported from is not in the snapshot')
    const content = this.contents.get(file) as Buffer
    if (content.length > maxParseBytes) return this.fail(line, `${file} is larger than ${maxParseBytes} bytes`)
    const text = content.toString('utf8')
    let source: ts.SourceFile
    try {
      if (syntaxErrorCount(file, text) > 0) return this.fail(line, `${file} has a syntax error`)
      source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    } catch (caught) {
      if (!(caught instanceof RangeError)) throw caught
      return this.fail(line, `${file} is nested too deeply to read`)
    }
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !hasExport(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== imported.name || declaration.initializer === undefined) continue
        const array = unwrap(declaration.initializer)
        if (!ts.isArrayLiteralExpression(array)) return this.fail(line, `${file}: the imported array is not an array literal`)
        return this.arrayEntries(array, source, line)
      }
    }
    return this.fail(line, `${file} does not export the imported array as a const array`)
  }

  private fail(line: number, reason: string): null {
    this.unparsed(line, reason)
    return null
  }

  private arrayEntries(array: ts.ArrayLiteralExpression, source: ts.SourceFile, line: number): Array<{ id: string; from: string }> {
    const entries: Array<{ id: string; from: string }> = []
    for (const element of array.elements) {
      const value = unwrap(element)
      const at = source === this.source ? '' : `${source.fileName} line ${source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1}: `
      if (!ts.isObjectLiteralExpression(value)) {
        this.unparsed(line, `${at}an element that is not an object literal`)
        continue
      }
      const read = readObject(value)
      if ('reason' in read) this.unparsed(line, `${at}${read.reason}`)
      else entries.push(read)
    }
    return entries
  }

  /** The module specifier and exported name of a named import, or null. */
  private importOf(local: string): { specifier: string; name: string } | null {
    for (const statement of this.source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements)
        if (element.name.text === local) return { specifier: statement.moduleSpecifier.text, name: (element.propertyName ?? element.name).text }
    }
    return null
  }

  /**
   * Step 6: every other reference that can change the list (a mutating
   * method not read above, an assignment, the list passed to a function or
   * aliased) is `unparsed` with its line. Reads (`some`, `map`, `length`,
   * `export`) are not.
   */
  private scanMutations(): void {
    const binding = this.binding as ts.Identifier
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== binding && node.text === binding.text) this.classify(node)
      ts.forEachChild(node, visit)
    }
    visit(this.source)
  }

  /**
   * One reference to the list's name. Only an explicit set of uses is safe:
   * the forms read above, a read-only method, `length`, a spread copy, an
   * export or a type query. Every other use (a mutating or unknown method,
   * an element access, an assignment, an alias, a return, the list passed
   * on or stored, a loop over it, a variable of the same name) is
   * `unparsed` with its line. Reasons never name source identifiers.
   */
  private classify(node: ts.Identifier): void {
    const parent = node.parent
    // The name itself in another role: `x.enabledModules`, `{ enabledModules: ... }`, an export or import.
    if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)) return
    if (ts.isExportSpecifier(parent) || ts.isImportSpecifier(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) return
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) {
      this.unparsed(this.line(parent), 'another variable with the name of the module list')
      return
    }
    let top: ts.Node = node
    while (
      ts.isParenthesizedExpression(top.parent) ||
      ts.isAsExpression(top.parent) ||
      ts.isSatisfiesExpression(top.parent) ||
      ts.isNonNullExpression(top.parent) ||
      ts.isTypeAssertionExpression(top.parent)
    )
      top = top.parent
    const user = top.parent
    if (ts.isExportAssignment(user) || ts.isSpreadElement(user)) return
    if (ts.isPropertyAccessExpression(user) && user.expression === top) {
      const method = user.name.text
      const call = user.parent
      if (ts.isCallExpression(call) && call.expression === user) {
        if (this.handled.has(call) || readOnlyMethods.has(method)) return
        this.unparsed(this.line(call), mutatingMethods.has(method) ? `a ${method}() on the module list in a form the inventory cannot read` : 'a method call on the module list the inventory cannot follow')
        return
      }
      if (method === 'length' && !isAssignmentTarget(user)) return
      this.unparsed(this.line(user), 'a use of the module list the inventory cannot follow')
      return
    }
    if (ts.isBinaryExpression(user) && user.left === top && isAssignmentOperator(user.operatorToken.kind)) {
      if (!this.handled.has(user)) this.unparsed(this.line(user), 'an assignment to the module list the inventory cannot read')
      return
    }
    if ((ts.isCallExpression(user) || ts.isNewExpression(user)) && user.expression !== top) {
      this.unparsed(this.line(user), 'the module list passed to a function, which may add modules')
      return
    }
    this.unparsed(this.line(user), 'a use of the module list the inventory cannot follow')
  }
}

/** True when the statements declare a variable, function or class of this name at their own level. */
function declaresName(statements: readonly ts.Statement[], name: string): boolean {
  return statements.some(
    (statement) =>
      (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)) ||
      ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name),
  )
}

function negate(term: string): string {
  return term.startsWith('!') ? term.slice(1) : `!${term}`
}

function isEquality(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken
}

function isIdentifierNamed(node: ts.Expression, name: string): boolean {
  const value = unwrap(node)
  return ts.isIdentifier(value) && value.text === name
}

/** `<object>.<property>` where `<object>` is the identifier `object`. */
function isPropertyRead(node: ts.Expression, object: string, property: string): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === property && isIdentifierNamed(node.expression, object)
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function isAssignmentTarget(node: ts.Expression): boolean {
  const parent = node.parent
  if (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) return true
  return (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)
}

/**
 * `process.env.NAME` or `process.env['NAME']`, directly or as the first
 * argument of a call such as `parseBooleanWithDefault(process.env.NAME, false)`
 * (no other argument reading `process.env`), gives `NAME`.
 */
function envRead(node: ts.Expression): string | null {
  const value = unwrap(node)
  const direct = envName(value)
  if (direct !== null) return direct
  if (!ts.isCallExpression(value) || value.arguments.length === 0) return null
  const name = envName(unwrap(value.arguments[0]))
  if (name === null) return null
  return value.arguments.slice(1).some((argument) => mentionsProcessEnv(argument)) ? null : name
}

function envName(node: ts.Expression): string | null {
  let name: string | null
  let object: ts.Expression
  if (ts.isPropertyAccessExpression(node)) {
    name = node.name.text
    object = unwrap(node.expression)
  } else if (ts.isElementAccessExpression(node)) {
    name = stringValue(node.argumentExpression)
    object = unwrap(node.expression)
  } else return null
  if (name === null || !envNamePattern.test(name)) return null
  return ts.isPropertyAccessExpression(object) && object.name.text === 'env' && isIdentifierNamed(object.expression, 'process') ? name : null
}

function mentionsProcessEnv(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'process') return true
  return ts.forEachChild(node, mentionsProcessEnv) ?? false
}

/** The snapshot path of a relative import from `src/modules.ts`, or null. */
export function resolveImport(contents: ReadonlyMap<string, Buffer>, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  const base = posix.normalize(posix.join(posix.dirname(modulesPath), specifier))
  if (base.startsWith('../')) return null
  const stem = base.replace(/\.(?:js|mjs|cjs)$/, '')
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}/index.ts`])
    if (/\.(?:ts|tsx|mts)$/.test(candidate) && contents.has(candidate)) return candidate
  return null
}
