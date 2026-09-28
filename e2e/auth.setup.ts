import { test as setup, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

setup('real registration, credentials login and tenant boundary', async ({ page, baseURL }) => {
  if (process.env.AIAG_E2E_OWNED_SERVER !== '1' || baseURL !== 'http://127.0.0.1:3107') {
    throw new Error('Run with scripts/verify-owned-auth.mjs inside the disposable native service runner');
  }
  const email = `review-${randomUUID()}@example.test`;
  const password = `Review1-${randomUUID()}`;
  const payload = { name: 'Local Review User', email, password,
    consentProcessing: true, consentTransborder: true, consentMarketing: false };
  const rejected = await page.request.post('/api/auth/register', {
    data: { ...payload, consentProcessing: false },
  });
  expect(rejected.status()).toBe(400);
  const registered = await page.request.post('/api/auth/register', { data: payload });
  expect(registered.status()).toBe(201);
  const { user } = await registered.json();
  expect(user.email).toBe(email);
  const duplicate = await page.request.post('/api/auth/register', { data: payload });
  expect(duplicate.status()).toBe(409);
  expect(await (await page.request.get('/api/auth/session')).json()).toBeNull();

  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const serverErrors: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 500 && response.url().startsWith(baseURL!)) serverErrors.push(new URL(response.url()).pathname);
  });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('WrongPassword1');
  await page.getByRole('button', { name: 'Войти с email', exact: true }).click();
  await expect(page.getByText('Неверный email или пароль', { exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/auth/session')).json()).toBeNull();
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти с email', exact: true }).click();
  await page.waitForURL(/\/dashboard(?:[/?#]|$)/);
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.user).toMatchObject({ id: user.id, email });
  expect((await page.request.get('/api/admin/settings')).status()).toBe(403);
  await expect(page.locator('[data-nextjs-dialog]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(80);
  const output = resolve('.superpowers/sdd/2026-09-28-release-remediation');
  await mkdir(output, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: resolve(output, 'dashboard-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: resolve(output, 'dashboard-mobile.png'), fullPage: true });
  await page.goto('/marketplace');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const detail = await page.locator('a[href^="/marketplace/"]').evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')).find((href) => href && /^\/marketplace\/[^/]+\/[^/?#]+$/.test(href) && !href.includes('/scenarios/')));
  expect(detail).toBeTruthy();
  await page.goto(detail!);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  expect(serverErrors).toEqual([]);
  expect(runtimeErrors).toEqual([]);
  const authFile = resolve(output, 'auth-state.json');
  await page.context().storageState({ path: authFile });
  await chmod(authFile, 0o600);
});
