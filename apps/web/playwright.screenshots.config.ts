import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config';

// The README's screenshots (e2e/readme-screenshots.spec.ts), on Chromium with the main suite's
// servers.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: 'readme-screenshots.spec.ts',
  outputDir: 'test-results/screenshots',
  retries: 0,
  reporter: 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
