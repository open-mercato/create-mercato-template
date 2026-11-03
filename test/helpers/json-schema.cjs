// A small JSON Schema (2020-12) validator for the keywords the vendored
// catalog schemas use, so the tests need no new dependency. An unknown
// keyword throws, so a schema that grows a keyword this file does not know
// fails loudly instead of passing silently.
const annotations = new Set(['$schema', '$id', '$comment', 'title', 'description'])
const known = new Set([
  ...annotations,
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
])

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

/** Returns the list of problems, each `<json pointer>: <reason>`; empty when `value` is valid. */
function validate(schema, value, pointer = '') {
  const problems = []
  for (const keyword of Object.keys(schema)) if (!known.has(keyword)) throw new Error(`json-schema.cjs does not know the keyword ${keyword}`)
  const at = pointer || '/'
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) return [`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`]
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) problems.push(`${at}: expected ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) problems.push(`${at}: not one of the allowed values`)
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) problems.push(`${at}: shorter than ${schema.minLength}`)
    if (schema.maxLength !== undefined && length > schema.maxLength) problems.push(`${at}: longer than ${schema.maxLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${at}: does not match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at}: below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at}: above ${schema.maximum}`)
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => problems.push(...validate(schema.items, item, `${pointer}/${index}`)))
  if (typeOf(value) === 'object') {
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) problems.push(`${at}: missing ${name}`)
    for (const [name, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, name)) problems.push(...validate(schema.properties[name], item, `${pointer}/${name}`))
      else if (schema.additionalProperties === false) problems.push(`${at}: unknown property ${name}`)
      else if (typeof schema.additionalProperties === 'object') problems.push(...validate(schema.additionalProperties, item, `${pointer}/${name}`))
    }
  }
  return problems
}

module.exports = { validate }
