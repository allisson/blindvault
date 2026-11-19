import { defineConfig } from 'vitest/config';

// D277: the unlock memory measurement, kept out of `pnpm test` since it takes minutes.
export default defineConfig({
  test: {
    include: ['memory/**/*.measure.ts'],
    pool: 'forks',
    silent: false,
  },
});
