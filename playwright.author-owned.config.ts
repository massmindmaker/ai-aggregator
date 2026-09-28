import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "author-lifecycle.owned.spec.ts",
  workers: 1,
  timeout: 150_000,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          ".superpowers/sdd/2026-09-28-ag-author-version-v1/author-browser-results.json",
      },
    ],
  ],
  outputDir:
    ".superpowers/sdd/2026-09-28-ag-author-version-v1/browser-artifacts",
  use: {
    baseURL: "http://127.0.0.1:3107",
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: process.env.AIAG_TEST_CHROMIUM },
    screenshot: "only-on-failure",
  },
});
