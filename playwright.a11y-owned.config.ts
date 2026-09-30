import { defineConfig } from "@playwright/test";

/**
 * AG-7 mobile + keyboard acceptance.
 *
 * Separate from playwright.author-owned.config.ts on purpose: this spec opens
 * several browser contexts at a 390 px mobile viewport, and the machine has
 * 6 GB of RAM, so it must not share a worker with the author lifecycle run.
 * Launched by scripts/verify-owned-auth.mjs --a11y, which provides the
 * disposable preview on 127.0.0.1:3107 and the test database.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "a11y-mobile.spec.ts",
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          ".superpowers/sdd/2026-09-30-ag7-acceptance/mobile-a11y-results.json",
      },
    ],
  ],
  outputDir: ".superpowers/sdd/2026-09-30-ag7-acceptance/mobile-a11y-artifacts",
  use: {
    baseURL: "http://127.0.0.1:3107",
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: process.env.AIAG_TEST_CHROMIUM },
    screenshot: "only-on-failure",
  },
});
