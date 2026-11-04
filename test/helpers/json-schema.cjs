// A small JSON Schema (2020-12) validator for the keywords the vendored
// catalog schemas use, and the common ones they may grow, so the tests need
// no new dependency. An unknown keyword throws before any value is checked,
// so a schema that grows a keyword this file does not know fails loudly
// instead of passing silently. `$ref` resolves local pointers (`#`, `#/...`)
// only. `format` is an annotation, as it is by default in 2020-12.
const annotations = new Set([
  '$schema',
  '$id',
  '$comment',
  '$anchor',
  'title',
  'description',
  'default',
  'examples',
  'format',
  'deprecated',
  'readOnly',
  'writeOnly',
  'contentMediaType',
  'contentEncoding',
])
const assertions = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'required',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minContains',
  'maxContains',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'dependentRequired',
])
// Keywords whose value is one subschema, a list of them, or a map of them.
const oneSchema = new Set(['items', 'additionalProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else'])
const listOfSchemas = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const mapOfSchemas = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs'])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Throws on the first keyword this file does not know, anywhere in `schema`, taken branch or not. */
function assertKnown(schema, pointer = '#') {
  if (typeof schema === 'boolean') return
  if (!isObject(schema)) throw new Error(`json-schema.cjs: ${pointer} is not a schema`)
  for (const [keyword, value] of Object.entries(schema)) {
    const at = `${pointer}/${keyword}`
    if (annotations.has(keyword) || assertions.has(keyword)) continue
    if (oneSchema.has(keyword)) assertKnown(value, at)
    else if (listOfSchemas.has(keyword)) {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`json-schema.cjs: ${at} is not a non-empty list`)
      value.forEach((item, index) => assertKnown(item, `${at}/${index}`))
    } else if (mapOfSchemas.has(keyword)) for (const [name, item] of Object.entries(value)) assertKnown(item, `${at}/${name}`)
    else throw new Error(`json-schema.cjs does not know the keyword ${keyword}`)
  }
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(value, type) {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

/** JSON equality with object keys in any order, as `const`, `enum` and `uniqueItems` compare. */
function equal(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left === right
  const kind = typeOf(left)
  if (kind !== typeOf(right)) return false
  if (kind === 'array') return left.length === right.length && left.every((item, index) => equal(item, right[index]))
  if (kind === 'object') {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  }
  return left === right
}

function resolveRef(root, ref) {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) throw new Error(`json-schema.cjs resolves local $ref only, not ${ref}`)
  let target = root
  for (const raw of ref.slice(2).split('/')) {
    const part = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isObject(target) && !Array.isArray(target)) throw new Error(`json-schema.cjs: $ref ${ref} does not resolve`)
    if (!Object.hasOwn(target, part)) throw new Error(`json-schema.cjs: $ref ${ref} does not resolve`)
    target = target[part]
  }
  return target
}

function passes(schema, value, root) {
  return check(schema, value, '', root).length === 0
}

/**
 * The checks, after the keyword check. Subschemas of `allOf`, `then` and the
 * rest constrain the value as the top schema does; `additionalProperties`
 * sees only the `properties` and `patternProperties` of its own schema object.
 */
function check(schema, value, pointer, root) {
  const at = pointer || '/'
  if (schema === true) return []
  if (schema === false) return [`${at}: not allowed`]
  const problems = []
  if (schema.$ref !== undefined) problems.push(...check(resolveRef(root, schema.$ref), value, pointer, root))
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) return [...problems, `${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`]
  }
  if ('const' in schema && !equal(schema.const, value)) problems.push(`${at}: expected ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some((item) => equal(item, value))) problems.push(`${at}: not one of the allowed values`)
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) problems.push(`${at}: shorter than ${schema.minLength}`)
    if (schema.maxLength !== undefined && length > schema.maxLength) problems.push(`${at}: longer than ${schema.maxLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${at}: does not match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at}: below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at}: above ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) problems.push(`${at}: not above ${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) problems.push(`${at}: not below ${schema.exclusiveMaximum}`)
    if (schema.multipleOf !== undefined && !Number.isInteger(value / schema.multipleOf)) problems.push(`${at}: not a multiple of ${schema.multipleOf}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at}: fewer than ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at}: more than ${schema.maxItems} items`)
    if (schema.uniqueItems === true && value.some((item, index) => value.findIndex((other) => equal(other, item)) !== index)) problems.push(`${at}: items are not unique`)
    const prefix = schema.prefixItems ?? []
    prefix.forEach((item, index) => {
      if (index < value.length) problems.push(...check(item, value[index], `${pointer}/${index}`, root))
    })
    if (schema.items !== undefined) for (let index = prefix.length; index < value.length; index++) problems.push(...check(schema.items, value[index], `${pointer}/${index}`, root))
    if (schema.contains !== undefined) {
      const count = value.filter((item) => passes(schema.contains, item, root)).length
      const min = schema.minContains ?? 1
      if (count < min) problems.push(`${at}: fewer than ${min} items match contains`)
      if (schema.maxContains !== undefined && count > schema.maxContains) problems.push(`${at}: more than ${schema.maxContains} items match contains`)
    }
  }
  if (typeOf(value) === 'object') {
    const names = Object.keys(value)
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) problems.push(`${at}: missing ${name}`)
    if (schema.minProperties !== undefined && names.length < schema.minProperties) problems.push(`${at}: fewer than ${schema.minProperties} properties`)
    if (schema.maxProperties !== undefined && names.length > schema.maxProperties) problems.push(`${at}: more than ${schema.maxProperties} properties`)
    for (const [name, needed] of Object.entries(schema.dependentRequired ?? {}))
      if (Object.hasOwn(value, name)) for (const other of needed) if (!Object.hasOwn(value, other)) problems.push(`${at}: ${name} needs ${other}`)
    for (const [name, item] of Object.entries(schema.dependentSchemas ?? {})) if (Object.hasOwn(value, name)) problems.push(...check(item, value, pointer, root))
    for (const name of names) {
      if (schema.propertyNames !== undefined && !passes(schema.propertyNames, name, root)) problems.push(`${at}: property name ${name} is not allowed`)
      let matched = false
      if (schema.properties && Object.hasOwn(schema.properties, name)) {
        matched = true
        problems.push(...check(schema.properties[name], value[name], `${pointer}/${name}`, root))
      }
      for (const [source, item] of Object.entries(schema.patternProperties ?? {}))
        if (new RegExp(source, 'u').test(name)) {
          matched = true
          problems.push(...check(item, value[name], `${pointer}/${name}`, root))
        }
      if (matched || schema.additionalProperties === undefined) continue
      if (schema.additionalProperties === false) problems.push(`${at}: unknown property ${name}`)
      else problems.push(...check(schema.additionalProperties, value[name], `${pointer}/${name}`, root))
    }
  }
  for (const item of schema.allOf ?? []) problems.push(...check(item, value, pointer, root))
  if (schema.anyOf && !schema.anyOf.some((item) => passes(item, value, root))) problems.push(`${at}: matches none of anyOf`)
  if (schema.oneOf) {
    const count = schema.oneOf.filter((item) => passes(item, value, root)).length
    if (count !== 1) problems.push(`${at}: matches ${count} of oneOf, expected exactly 1`)
  }
  if (schema.not !== undefined && passes(schema.not, value, root)) problems.push(`${at}: matches not`)
  if (schema.if !== undefined) {
    const branch = passes(schema.if, value, root) ? schema.then : schema.else
    if (branch !== undefined) problems.push(...check(branch, value, pointer, root))
  }
  return problems
}

/** Returns the list of problems, each `<json pointer>: <reason>`; empty when `value` is valid. Throws on a keyword it does not know. */
function validate(schema, value) {
  assertKnown(schema)
  return check(schema, value, '', schema)
}

module.exports = { validate }
