/**
 * TEMPORARY (AG-7 verification, 2026-09-30) — server-less config used to run
 * ONLY the static half of e2e/claims-vs-runtime.spec.ts.
 *
 * The main playwright.config.ts starts `npm run dev` via webServer and every
 * project depends on the auth setup, which needs a live app. Part A of the
 * claims spec reads source files and compares them against gateway code — no
 * server, no browser, no DB, no money — so it runs fine with no projects and
 * no webServer. Delete this file once the run is recorded.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /claims-vs-runtime\.spec\.ts/,
  reporter: [['list']],
});
