import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/test-helpers.ts', 'src/kdf.worker.ts'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
