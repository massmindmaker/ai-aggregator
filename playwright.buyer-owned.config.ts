import { defineConfig } from "@playwright/test";

/**
 * AG-7 buyer end-to-end acceptance.
 *
 * Separate from playwright.author-owned.config.ts on purpose: this spec brings
 * up its own gateway process (packages/api-gateway/src/server-node.ts on
 * 127.0.0.1:4000) plus a loopback provider stub, in addition to the owned web
 * preview. The machine has 6 GB of RAM, so it must not share a worker — or a
 * run — with the author lifecycle or the mobile/keyboard pass.
 *
 * Launched by `scripts/verify-owned-auth.mjs --buyer`, which provides the
 * disposable preview on 127.0.0.1:3107 and the disposable PostgreSQL/Redis.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "buyer-journey.owned.spec.ts",
  workers: 1,
  timeout: 300_000,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          ".superpowers/sdd/2026-09-30-ag7-acceptance/buyer-results.json",
      },
    ],
  ],
  outputDir: ".superpowers/sdd/2026-09-30-ag7-acceptance/buyer-artifacts",
  use: {
    baseURL: "http://127.0.0.1:3107",
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: process.env.AIAG_TEST_CHROMIUM },
    screenshot: "only-on-failure",
  },
});
