import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', timeout: 60_000, reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4176', headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    { command: 'node server.mjs', url: 'http://127.0.0.1:4177/api/health', reuseExistingServer: !process.env.CI, timeout: 10_000 },
    { command: 'npm run dev -- --port 4176 --strictPort', url: 'http://127.0.0.1:4176', reuseExistingServer: !process.env.CI, timeout: 30_000 }
  ]
});
