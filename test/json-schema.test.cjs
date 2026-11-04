// The small JSON Schema validator in test/helpers/json-schema.cjs, which the
// describe and inventory tests use against the catalog schemas vendored in
// test/fixtures/catalog/. Each keyword is checked on a small schema, then the
// rules of the real template-1.json that need the applicators.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validate } = require('./helpers/json-schema.cjs')

const catalog = path.join(__dirname, 'fixtures', 'catalog')
const templateSchema = JSON.parse(fs.readFileSync(path.join(catalog, 'template-1.json'), 'utf8'))
const entry = {
  github: 'acme/b2b-portal',
  useCase: 'b2b-portal',
  summary: 'B2B self-service portal with quotes and accounts.',
  whenToUse: 'Use when B2B customers need to request quotes and manage their own accounts.',
}

function valid(schema, value) {
  assert.deepEqual(validate(schema, value), [], JSON.stringify(value))
}

function invalid(schema, value, problem) {
  const problems = validate(schema, value)
  assert.ok(problems.some((item) => item.includes(problem)), `${JSON.stringify(value)}: ${JSON.stringify(problems)}`)
}

test('an unknown keyword throws, also in a branch the value never takes', () => {
  assert.throws(() => validate({ type: 'string', unknownKeyword: 1 }, 'x'), /does not know the keyword unknownKeyword/)
  assert.throws(() => validate({ if: { const: 1 }, then: { unknownKeyword: 1 } }, 2), /does not know the keyword unknownKeyword/)
  assert.throws(() => validate({ $defs: { a: { unknownKeyword: 1 } } }, 2), /does not know the keyword unknownKeyword/)
  assert.throws(() => validate({ allOf: [] }, 2), /not a non-empty list/)
})

test('type, const and enum, with JSON equality whatever the key order', () => {
  valid({ type: ['string', 'null'] }, null)
  invalid({ type: 'integer' }, 1.5, 'expected integer')
  valid({ type: 'number' }, 1)
  valid({ const: { a: 1, b: [1, 2] } }, { b: [1, 2], a: 1 })
  invalid({ const: { a: 1 } }, { a: 1, b: 2 }, 'expected')
  valid({ enum: ['a', { b: 1 }] }, { b: 1 })
  invalid({ enum: ['a'] }, 'b', 'not one of')
})

test('strings and numbers', () => {
  const string = { type: 'string', minLength: 2, maxLength: 3, pattern: '^a' }
  valid(string, 'ab')
  invalid(string, 'a', 'shorter than 2')
  invalid(string, 'abcd', 'longer than 3')
  invalid(string, 'bb', 'does not match')
  valid({ maxLength: 1 }, '\u{1F600}')
  const number = { minimum: 1, maximum: 9, exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 2 }
  valid(number, 4)
  invalid(number, 3, 'not a multiple of 2')
  invalid({ exclusiveMinimum: 0 }, 0, 'not above 0')
  invalid({ exclusiveMaximum: 10 }, 10, 'not below 10')
  invalid({ minimum: 1 }, 0, 'below 1')
  invalid({ maximum: 1 }, 2, 'above 1')
  valid({ multipleOf: 0.01 }, 0.07)
  valid({ multipleOf: 0.1 }, 0.3)
  invalid({ multipleOf: 0.01 }, 0.075, 'not a multiple of 0.01')
})

test('arrays: items, prefixItems, contains, uniqueItems and the bounds', () => {
  valid({ items: { type: 'string' }, minItems: 1, maxItems: 2 }, ['a'])
  invalid({ items: { type: 'string' } }, ['a', 1], '/1: expected string')
  invalid({ minItems: 1 }, [], 'fewer than 1 items')
  invalid({ maxItems: 1 }, [1, 2], 'more than 1 items')
  valid({ prefixItems: [{ type: 'integer' }], items: { type: 'string' } }, [1, 'a'])
  invalid({ prefixItems: [{ type: 'integer' }], items: { type: 'string' } }, [1, 2], '/1: expected string')
  valid({ contains: { const: 1 } }, [0, 1])
  invalid({ contains: { const: 1 } }, [0], 'fewer than 1 items match contains')
  invalid({ contains: { const: 1 }, maxContains: 1 }, [1, 1], 'more than 1 items match contains')
  invalid({ contains: { const: 1 }, minContains: 2 }, [1], 'fewer than 2 items match contains')
  valid({ uniqueItems: true }, [{ a: 1 }, { a: 2 }])
  invalid({ uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }], 'not unique')
})

test('objects: properties, required, additionalProperties, patternProperties, propertyNames and dependencies', () => {
  const schema = { properties: { a: { type: 'string' } }, patternProperties: { '^x-': { type: 'integer' } }, additionalProperties: false, required: ['a'] }
  valid(schema, { a: 'a', 'x-b': 1 })
  invalid(schema, { a: 'a', 'x-b': 'b' }, '/x-b: expected integer')
  invalid(schema, { a: 'a', c: 1 }, 'unknown property c')
  invalid(schema, {}, 'missing a')
  invalid({ additionalProperties: { type: 'string' } }, { c: 1 }, '/c: expected string')
  invalid({ propertyNames: { pattern: '^[a-z]+$' } }, { Bad: 1 }, 'property name Bad')
  invalid({ minProperties: 1 }, {}, 'fewer than 1 properties')
  invalid({ maxProperties: 1 }, { a: 1, b: 2 }, 'more than 1 properties')
  invalid({ dependentRequired: { a: ['b'] } }, { a: 1 }, 'a needs b')
  valid({ dependentRequired: { a: ['b'] } }, { c: 1 })
  invalid({ dependentSchemas: { a: { required: ['b'] } } }, { a: 1 }, 'missing b')
})

test('allOf, anyOf, oneOf and not', () => {
  invalid({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a', 'shorter than 2')
  valid({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 1)
  invalid({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, null, 'matches none of anyOf')
  valid({ oneOf: [{ minimum: 5 }, { maximum: 1 }] }, 0)
  invalid({ oneOf: [{ minimum: 0 }, { maximum: 10 }] }, 5, 'matches 2 of oneOf')
  invalid({ oneOf: [{ minimum: 5 }, { maximum: 1 }] }, 3, 'matches 0 of oneOf')
  invalid({ not: { const: 1 } }, 1, 'matches not')
  valid({ not: { const: 1 } }, 2)
})

test('if, then and else: only the taken branch counts, and a failed if adds no problem', () => {
  const schema = { if: { properties: { a: { const: 1 } }, required: ['a'] }, then: { required: ['b'] }, else: { required: ['c'] } }
  invalid(schema, { a: 1 }, 'missing b')
  valid(schema, { a: 1, b: 1 })
  invalid(schema, { a: 2 }, 'missing c')
  valid(schema, { a: 2, c: 1 })
  valid({ if: { const: 1 }, then: { const: 2 } }, 3)
})

test('boolean schemas, local $ref and $defs, and the annotations', () => {
  valid(true, 1)
  invalid(false, 1, 'not allowed')
  invalid({ properties: { a: false } }, { a: 1 }, '/a: not allowed')
  const schema = { $defs: { slug: { type: 'string', pattern: '^[a-z]+$' }, 'a/b': { const: 1 } }, properties: { name: { $ref: '#/$defs/slug' }, one: { $ref: '#/$defs/a~1b' }, self: { $ref: '#' } } }
  valid(schema, { name: 'abc', one: 1, self: { name: 'x' } })
  invalid(schema, { name: 'ABC' }, '/name: does not match')
  invalid(schema, { one: 2 }, '/one: expected 1')
  assert.throws(() => validate({ $ref: 'https://example.com/x.json' }, 1), /local \$ref only/)
  assert.throws(() => validate({ $ref: '#/$defs/missing' }, 1), /does not resolve/)
  assert.throws(() => validate({ $ref: '#' }, 1), /\$ref cycle at #/)
  assert.throws(() => validate({ $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' }, 1), /\$ref cycle at #\/\$defs\/a/)
  const tree = { properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } } }
  valid(tree, { name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }, { name: 'd' }] })
  invalid(tree, { children: [{ children: [{ name: 1 }] }] }, '/children/0/children/0/name: expected string')
  valid({ title: 't', description: 'd', default: 1, examples: [1], format: 'email', deprecated: false, readOnly: true, writeOnly: false, $comment: 'c' }, 'not an email')
})

test('template-1.json: a status other than active needs a reason, as the catalog says', () => {
  valid(templateSchema, entry)
  valid(templateSchema, { ...entry, status: 'active' })
  invalid(templateSchema, { ...entry, status: 'hold' }, 'missing reason')
  valid(templateSchema, { ...entry, status: 'hold', reason: 'Waiting for the maintainer to fix the import.' })
})

test('template-1.json: smoke with login false needs ready and at least one path', () => {
  invalid(templateSchema, { ...entry, smoke: { login: false } }, 'missing ready')
  invalid(templateSchema, { ...entry, smoke: { login: false, ready: '/' } }, 'missing paths')
  invalid(templateSchema, { ...entry, smoke: { login: false, ready: '/', paths: [] } }, 'fewer than 1 items')
  valid(templateSchema, { ...entry, smoke: { login: false, ready: '/', paths: ['/backend/quotes'] } })
  valid(templateSchema, { ...entry, smoke: { login: true } })
  valid(templateSchema, { ...entry, smoke: {} })
})

test('the vendored catalog schemas are the bytes SOURCE.md records', () => {
  const source = fs.readFileSync(path.join(catalog, 'SOURCE.md'), 'utf8')
  const rows = [...source.matchAll(/^\| `([^`]+\.json)` \| `([0-9a-f]{64})` \|$/gm)]
  assert.deepEqual(rows.map(([, file]) => file).sort(), ['mercato-template-1.json', 'template-1.json'])
  for (const [, file, sha256] of rows) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(catalog, file))).digest('hex'), sha256, file)
})
