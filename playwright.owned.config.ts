import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'auth.setup.ts', workers: 1,
  timeout: 90_000, retries: 0,
  reporter: [['list'], ['json', { outputFile: '.superpowers/sdd/2026-09-28-release-remediation/browser-results.json' }]],
  outputDir: '.superpowers/sdd/2026-09-28-release-remediation/browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:3107', browserName: 'chromium', headless: true,
    launchOptions: { executablePath: process.env.AIAG_TEST_CHROMIUM },
    viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
});
