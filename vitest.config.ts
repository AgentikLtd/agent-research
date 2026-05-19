import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // We deliberately include test/evals/**/*.test.ts. Each eval suite
    // uses `describe.skipIf(!process.env.HUB_BASE_URL || ...)` so a run
    // without credentials is a SKIP not a SPEND. CI does not set
    // HUB_BASE_URL / HUB_AGENT_TOKEN, so evals stay skipped there.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', 'dist/**', 'node_modules/**', 'test/evals/**'],
    },
  },
});
