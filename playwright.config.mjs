import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'browser.spec.mjs', fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4318', viewport: { width: 1440, height: 1100 }, headless: true },
  webServer: { command: 'node server.mjs', env: { PORT: '4318', REACH_PROVIDER: 'demo' }, url: 'http://127.0.0.1:4318', reuseExistingServer: false },
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-results.json' }]]
});
