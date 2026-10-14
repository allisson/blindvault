import { defineConfig, devices } from '@playwright/test';

// The self-hosting test (D195): the specs below against a server of e2e/self-hosting/serve.sh,
// which serves dist/ with a configuration of deploy/. Chromium only: what differs is the host, and
// the main suite covers every browser.
const baseURL = process.env.BLINDVAULT_URL;
if (!baseURL) throw new Error('Set BLINDVAULT_URL to the server of e2e/self-hosting/serve.sh');

export default defineConfig({
  testDir: './e2e',
  testMatch: ['self-hosting.spec.ts', 'smoke.spec.ts', 'pwa.spec.ts', 'about.spec.ts'],
  outputDir: 'test-results/self-hosting',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
