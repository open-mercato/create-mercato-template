import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.agents/', '.claude/', 'test/fixtures/scaffold/', 'test/fixtures/catalog/modules-from-modules-ts/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Probing optional files and commands is expected to fail quietly.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['bin/**/*.cjs', 'test/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly', console: 'readonly', setTimeout: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', Buffer: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // test/release-e2e/gh-shim.mjs arrives in Step 9, the release checks in Step 11.
    files: ['test/release-e2e/**/*.{mts,mjs}', 'test/helpers/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly', Response: 'readonly', Buffer: 'readonly' } },
  },
)
