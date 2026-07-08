import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // e2e/ is a self-contained harness with its own package.json and tooling.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'e2e/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JS/MJS files (scripts, config) run on Node and use its globals.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
)
