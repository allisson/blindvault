import { defineConfig } from '@playwright/test';

// The unpacked Chrome package (dist/chrome), loaded in Playwright's Chromium (e2e/fixtures.ts).
// `pnpm test:e2e` builds it first.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'on-first-retry' },
});
