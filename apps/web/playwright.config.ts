import { defineConfig, devices } from '@playwright/test';

const port = 4173;

/** Where the pairing spec runs (e2e/pairing.spec.ts). */
export const PAIRING_PORT = 4174;
export const PAIRING_URL = `http://127.0.0.1:${String(PAIRING_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  // Needs a server with the headers of deploy/ (playwright.self-hosting.config.ts).
  testIgnore: 'self-hosting.spec.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${String(port)}`,
    trace: 'on-first-retry',
  },
  // A fake camera with no prompt, for QR scanning (e2e/camera.ts, D208); WebKit takes the camera
  // permission per context.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
          },
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: `pnpm build && pnpm preview --port ${String(port)} --strictPort`,
      port,
      reuseExistingServer: !process.env.CI,
    },
    // The same build on 127.0.0.1, for pairing: Playwright's Firefox gathers no ICE candidate on
    // localhost (packages/sync). Started once the first one is up, so after the build.
    {
      command: `pnpm preview --host 127.0.0.1 --port ${String(PAIRING_PORT)} --strictPort`,
      url: PAIRING_URL,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
