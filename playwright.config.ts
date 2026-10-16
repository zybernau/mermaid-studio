import { defineConfig, devices } from '@playwright/test';

const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '.playwright-browsers';

// Runs against the Vite dev server so the app matches `npm run dev`.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Vite binds to `localhost` which resolves to ::1 first, so 127.0.0.1
    // (what Playwright polls) would time out. Bind explicitly.
    command: 'npx vite --port 5199 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH,
    },
  },
});
