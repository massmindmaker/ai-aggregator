// Smoke screenshots for AIAG live deploy.
// Run: node scripts/smoke-shots.mjs
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';

const OUT = process.env.SHOTS_DIR ||
  'C:/Users/боб/brain/Projects/AIAG/Sessions/2026-04-27-screenshots';
const BASE = 'https://ai-aggregator.ru';
const PATHS = ['/', '/marketplace', '/pricing', '/login',
               '/register', '/docs', '/dashboard', '/privacy'];

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const results = [];
for (const p of PATHS) {
  const errors = [];
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let status = 0;
  try {
    const resp = await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 25000 });
    status = resp ? resp.status() : 0;
  } catch (e) {
    errors.push('goto: ' + e.message);
  }
  const file = path.join(OUT, 'aiag' + p.replace(/\//g, '_') + '.png');
  try { await page.screenshot({ path: file, fullPage: false }); } catch {}
  results.push({ path: p, status, errors, file });
  console.log(JSON.stringify({ path: p, status, errors }));
}

await browser.close();
await fs.writeFile(path.join(OUT, '_results.json'), JSON.stringify(results, null, 2));
console.log('OUT=' + OUT);
