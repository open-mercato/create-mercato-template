const { test } = require('node:test')
const assert = require('node:assert/strict')
const { denyList, deniedBy, denyEntryMatches } = require('../dist/policy/deny.js')

// One row per deny list entry (spec, "Deny list": each entry with a test):
// paths it excludes, and nearby paths it must not touch.
const cases = {
  '**/.env*': {
    yes: ['.env', '.env.local', '.env.example', 'apps/web/.env.production', '.env.d/x'],
    no: ['env', 'src/env.ts', 'docs/my.env', 'src/environment/x'],
  },
  '/.mercato/*': { yes: ['.mercato/generated.ts', '.mercato/next/x.js'], no: ['.mercato', 'src/.mercato/x'] },
  '**/node_modules/': { yes: ['node_modules/a/index.js', 'packages/x/node_modules/y'], no: ['node_modules', 'src/node_modules.ts'] },
  '/.yarn/cache/': { yes: ['.yarn/cache/a.zip'], no: ['.yarn/releases/yarn.cjs', 'x/.yarn/cache/a.zip'] },
  '/.yarn/install-state.gz': { yes: ['.yarn/install-state.gz'], no: ['x/.yarn/install-state.gz'] },
  '/public/uploads/': { yes: ['public/uploads/a.png'], no: ['public/uploads', 'apps/public/uploads/a.png'] },
  '/storage/': { yes: ['storage/a'], no: ['src/storage/a.ts', 'storage'] },
  '/data/': { yes: ['data/x', 'data/a/b.json'], no: ['src/modules/x/data/entities.ts', 'data', 'database/x'] },
  '**/*.pem': { yes: ['key.pem', 'certs/a/server.pem'], no: ['key.pem.txt', 'pem'] },
  '**/.npmrc': { yes: ['.npmrc', 'packages/a/.npmrc'], no: ['.npmrc.example', 'npmrc'] },
  '**/.mcp.json': { yes: ['.mcp.json', 'apps/a/.mcp.json'], no: ['mcp.json'] },
  '**/.claude/': { yes: ['.claude/settings.json', 'a/.claude/x'], no: ['.claude', 'claude/x'] },
  '**/.codex/': { yes: ['.codex/config.toml', 'a/.codex/x'], no: ['codex/x'] },
  '/.cursor/mcp.json': { yes: ['.cursor/mcp.json'], no: ['.cursor/rules/a.mdc', 'x/.cursor/mcp.json'] },
  '/.playwright-mcp': { yes: ['.playwright-mcp', '.playwright-mcp/trace.zip'], no: ['x/.playwright-mcp'] },
  '/.agents/skills/': { yes: ['.agents/skills/a/SKILL.md'], no: ['.agents/README.md'] },
  '/skills-lock.json': { yes: ['skills-lock.json'], no: ['x/skills-lock.json'] },
  '/.ai/framework-context/': { yes: ['.ai/framework-context/a.md'], no: ['.ai/specs/a.md'] },
  '/.ai/harness/results/': { yes: ['.ai/harness/results/run.json'], no: ['.ai/harness/config.json'] },
  '/.ai/sessions*.json': { yes: ['.ai/sessions.json', '.ai/sessions-2026.json'], no: ['.ai/sessions/a.md', '.ai/a/sessions.json'] },
  '/.ai/session-exports/': { yes: ['.ai/session-exports/a.md'], no: ['.ai/session-exports.md'] },
  '/.ai/qa/test-env*': { yes: ['.ai/qa/test-env.json', '.ai/qa/test-env-local/x'], no: ['.ai/qa/notes.md'] },
  '/.ai/qa/artifacts_*/': { yes: ['.ai/qa/artifacts_123/a.png'], no: ['.ai/qa/artifacts.md'] },
  '/.ai/qa/ephemeral*': { yes: ['.ai/qa/ephemeral', '.ai/qa/ephemeral-1/x'], no: ['.ai/qa/plan.md'] },
  '/.ai/scripts/test-env-*': { yes: ['.ai/scripts/test-env-up.sh'], no: ['.ai/scripts/build.sh'] },
  '/.ai/.gate-state.json': { yes: ['.ai/.gate-state.json'], no: ['.ai/gate-state.json'] },
}

test('the deny list is exactly the catalog list, each entry with a test', () => {
  assert.deepEqual([...denyList].sort(), Object.keys(cases).sort())
})

for (const [entry, { yes, no }] of Object.entries(cases)) {
  test(`deny entry ${entry}`, () => {
    for (const item of yes) assert.equal(denyEntryMatches(entry, item), true, `${entry} should exclude ${item}`)
    for (const item of no) assert.equal(denyEntryMatches(entry, item), false, `${entry} should keep ${item}`)
  })
}

test('module data folders are never excluded; /data/ and .env.local are', () => {
  assert.equal(deniedBy('src/modules/x/data/entities.ts'), null)
  assert.equal(deniedBy('data/x'), '/data/')
  assert.equal(deniedBy('.env.local'), '**/.env*')
})

test('until Step 8 the root .env.example is excluded like any .env file', () => {
  assert.equal(deniedBy('.env.example'), '**/.env*')
})
