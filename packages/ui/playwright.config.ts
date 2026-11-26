import { defineConfig, devices } from '@playwright/test';

const PORT = 6007;

// Baselines are generated in mcr.microsoft.com/playwright:v1.59.1-noble, pinned by digest (pnpm
// stories:update), and checked in that same image in CI, so the snapshot path carries no platform suffix: there is exactly one platform.
export default defineConfig({
  testDir: 'stories-test',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    // Timestamp stories render in the browser's zone and locale; pin both so baselines are deterministic.
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'node stories-test/serve.mjs',
    url: `http://127.0.0.1:${PORT}/index.json`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
