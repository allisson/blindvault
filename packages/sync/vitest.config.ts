import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // connection.ts needs a browser's WebRTC: the Playwright tests in e2e/ cover it.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/connection.ts'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
