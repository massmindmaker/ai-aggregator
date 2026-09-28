import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, open, readdir, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.superpowers/sdd/2026-09-28-release-remediation');
await mkdir(output, { recursive: true, mode: 0o700 });
const dbUrl = new URL(process.env.TEST_DATABASE_URL ?? '');
assert.equal(process.env.AIAG_TEST_DATABASE, '1');
assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
assert.equal(dbUrl.hostname, '127.0.0.1');
assert.equal(dbUrl.port, '15432');
assert.equal(dbUrl.pathname, '/ai_aggregator_test');
assert.equal(dbUrl.search, '');
await access(resolve(root, 'apps/web/.next/BUILD_ID'));
const client = new pg.Client({ connectionString: dbUrl.href });
await client.connect();
try {
  const result = await client.query('SELECT marker FROM public._aiag_test_database_marker WHERE singleton=true');
  assert.equal(result.rows[0]?.marker, 'ai-aggregator:test-database:v1');
} finally { await client.end(); }
const probe = createServer();
probe.listen(3107, '127.0.0.1');
await once(probe, 'listening');
await new Promise((resolveClose) => probe.close(resolveClose));
let browserExecutable = chromium.executablePath();
try { await access(browserExecutable); }
catch {
  const cache = resolve(process.env.HOME, '.cache/ms-playwright');
  const revisions = (await readdir(cache)).filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  if (!revisions[0]) throw new Error('Install a Playwright Chromium browser before the owned auth check');
  browserExecutable = resolve(cache, revisions[0], 'chrome-headless-shell-linux64/chrome-headless-shell');
  await access(browserExecutable);
  console.log('Using existing headless Chromium cache: ' + revisions[0]);
}
const baseURL = 'http://127.0.0.1:3107';
const secret = randomBytes(48).toString('hex');
const log = await open(resolve(output, 'auth-preview.log'), 'w', 0o600);
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8',
  DATABASE_URL: dbUrl.href, REDIS_URL: 'redis://127.0.0.1:16379/0', NODE_ENV: 'production',
  AUTH_SECRET: secret, NEXTAUTH_SECRET: secret, AUTH_URL: baseURL, NEXTAUTH_URL: baseURL,
  AUTH_TRUST_HOST: 'true', NEXT_TELEMETRY_DISABLED: '1',
};
const server = spawn('node', [resolve(root, 'node_modules/next/dist/bin/next'), 'start',
  '--hostname', '127.0.0.1', '--port', '3107'], {
  cwd: resolve(root, 'apps/web'), env, stdio: ['ignore', log.fd, log.fd],
});
let runner;
let stopped = false;
const stop = () => { stopped = true; runner?.kill('SIGTERM'); server.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  let ready = false;
  for (let attempt = 0; attempt < 90 && !stopped; attempt++) {
    if (server.exitCode !== null) throw new Error('Owned preview exited before ready');
    try { if ((await fetch(baseURL + '/api/auth/session', { signal: AbortSignal.timeout(800) })).status === 200) { ready = true; break; } } catch { /* startup */ }
    await delay(300);
  }
  assert.ok(ready, 'Owned preview did not become ready');
  runner = spawn('node', [resolve(root, 'node_modules/@playwright/test/cli.js'),
    'test', '--config=playwright.owned.config.ts'], {
    cwd: root, env: { ...env, NODE_ENV: 'test', AIAG_E2E_OWNED_SERVER: '1', AIAG_TEST_CHROMIUM: browserExecutable }, stdio: 'inherit',
  });
  const [code] = await once(runner, 'exit');
  assert.equal(code, 0, 'Real browser authentication gate failed');
} finally {
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  runner?.kill('SIGTERM');
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), delay(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await log.close();
  console.log('Owned authentication preview stopped. No production server was used.');
}
