import { defineConfig } from 'vitest/config'

// Integration tests hit real preprod providers (Koios). They run only in the
// tighter CI gates (preprod and main) and are kept out of the default unit run.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    retry: 2,
  },
})
