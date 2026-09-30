import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

/**
 * AG-7 Task 3 — mobile (390 px) + keyboard acceptance for the buyer, author
 * and administrator surfaces.
 *
 * Design rules kept deliberately:
 *  - every assertion is computed from the rendered DOM, never "assert nothing";
 *  - no axe-core / no new dependency — the four properties the plan asks for
 *    (no horizontal overflow, reachability, visible focus, sane tab order) are
 *    directly measurable and the checks below stay debuggable;
 *  - real HTTP credentials and real forms, but the disposable owned server only.
 *
 * Run with:  node scripts/verify-owned-auth.mjs --a11y
 *      (see playwright.a11y-owned.config.ts)
 */

const MOBILE = { width: 390, height: 844 } as const;
const EVIDENCE = resolve('.superpowers/sdd/2026-09-30-ag7-acceptance/mobile-a11y');

// ---------------------------------------------------------------------------
// 1. Horizontal overflow at 390 px
// ---------------------------------------------------------------------------

interface OverflowReport {
  scrollWidth: number;
  clientWidth: number;
  innerWidth: number;
  /** Unclipped elements whose right edge leaves the viewport: hard failure. */
  offenders: string[];
  /**
   * Elements wider than the viewport but sitting inside an `overflow-x:
   * hidden` ancestor. They do not make the page scroll sideways, so they are
   * reported (they mean content is cut off) but are not a hard failure — the
   * intentional marquee on `/` looks exactly like this.
   */
  clipped: string[];
}

/**
 * document.scrollWidth alone is not sufficient here: /dashboard and /admin wrap
 * their content in `overflow-x-hidden`, so a too-wide table is clipped silently
 * and the document still reports 390. We therefore walk the DOM as well and
 * report every rendered element whose right edge leaves the viewport, skipping
 * intentional horizontal scrollers and elements already clipped by a hidden
 * ancestor (that clipping ancestor is itself reported, earlier in document
 * order, so nothing is lost).
 */
async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const innerWidth = window.innerWidth;
    const root = document.documentElement;
    const describe = (el: Element) => {
      const r = el.getBoundingClientRect();
      const id = el.getAttribute('id');
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${cls ? `.${cls}` : ''} right=${Math.round(r.right)} width=${Math.round(r.width)} "${text}"`;
    };
    const ancestorScroller = (el: Element): false | 'scroll' | 'clipped' => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return 'scroll';
        if (ox === 'hidden' || ox === 'clip') return 'clipped';
      }
      return false;
    };
    const offenders: string[] = [];
    const clipped: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right <= innerWidth + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"],[inert]')) continue;
      const scroller = ancestorScroller(el);
      if (scroller === 'scroll') continue; // intentional horizontal scroller
      if (scroller === 'clipped') {
        if (clipped.length < 10) clipped.push(describe(el));
        continue;
      }
      offenders.push(describe(el));
      if (offenders.length >= 10) break;
    }
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, innerWidth, offenders, clipped };
  });
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const report = await measureOverflow(page);
  expect(
    report.offenders,
    `${label}: elements leaving the ${MOBILE.width}px viewport at ${page.url()}\n  ${report.offenders.join('\n  ')}`,
  ).toEqual([]);
  expect(
    report.scrollWidth,
    `${label}: document.scrollWidth must fit the viewport at ${page.url()}`,
  ).toBeLessThanOrEqual(report.clientWidth + 1);
  // Attach the cut-off list to the report so a failure message or a later
  // manual read of test-results shows what was clipped, not just what broke.
  if (report.clipped.length) {
    console.log(
      `[a11y-mobile] ${label}: ${report.clipped.length} element(s) clipped by an overflow-x:hidden ancestor at ${page.url()}\n  ${report.clipped.join('\n  ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Keyboard traversal: reachability, visible focus, DOM order
// ---------------------------------------------------------------------------

interface FocusStop {
  idx: number;
  role: string;
  name: string;
  href: string | null;
  focusStyleChanged: boolean;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/**
 * Stamp every focusable element with its DOM-order index and snapshot each
 * element's unfocused computed style. The snapshot is what makes "visible
 * focus" measurable without a CSS-specific assumption: the diff covers the UA
 * default outline, Tailwind rings (box-shadow) and colour/background cues.
 */
async function prepareTraversal(page: Page) {
  const count = await page.evaluate((selector) => {
    let i = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      el.setAttribute('data-a11y-idx', String(i++));
    }
    return i;
  }, FOCUSABLE);
  expect(count, `${page.url()} exposes no keyboard-reachable controls at all`).toBeGreaterThan(0);
  const restStyles = await page.evaluate(() => {
    const map: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-a11y-idx]'))) {
      const cs = getComputedStyle(el);
      map[el.getAttribute('data-a11y-idx')!] = [cs.outline, cs.boxShadow, cs.borderColor, cs.backgroundColor, cs.color].join(' | ');
    }
    return map;
  });
  return { count, restStyles };
}

async function readStop(page: Page, restStyles: Record<string, string>): Promise<FocusStop | null> {
  return page.evaluate(
    (restMap) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement) return null;
      const idx = el.getAttribute('data-a11y-idx');
      if (idx === null) return null;
      const cs = getComputedStyle(el);
      const focused = [cs.outline, cs.boxShadow, cs.borderColor, cs.backgroundColor, cs.color].join(' | ');
      const tag = el.tagName.toLowerCase();
      const role =
        tag === 'a' ? 'link'
        : tag === 'button' ? 'button'
        : tag === 'input' ? `input:${(el as HTMLInputElement).type}`
        : tag === 'select' ? 'combobox'
        : tag === 'textarea' ? 'textbox'
        : tag;
      const name = (
        el.getAttribute('aria-label')
        ?? (el as HTMLInputElement).labels?.[0]?.textContent
        ?? el.getAttribute('placeholder')
        ?? el.textContent
        ?? ''
      ).replace(/\s+/g, ' ').trim().slice(0, 60);
      return {
        idx: Number(idx),
        role,
        name,
        href: el.getAttribute('href'),
        focusStyleChanged: focused !== restMap[idx],
      };
    },
    restStyles,
  );
}

/** Walk forward with Tab from the current focus, collecting distinct stops. */
async function tabThrough(page: Page, maxStops: number, restStyles: Record<string, string>): Promise<FocusStop[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const stops: FocusStop[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    const stop = await readStop(page, restStyles);
    if (!stop) continue;
    if (seen.has(stop.idx)) break; // focus wrapped: traversal complete
    seen.add(stop.idx);
    stops.push(stop);
  }
  return stops;
}

/** Continue tabbing from wherever focus currently is until `match` hits. */
async function tabUntil(page: Page, restStyles: Record<string, string>, match: (stop: FocusStop) => boolean, max = 25) {
  const walked: FocusStop[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await readStop(page, restStyles);
    if (!stop) continue;
    walked.push(stop);
    if (match(stop)) return stop;
  }
  throw new Error(
    `no focusable stop matched within ${max} tabs; walked: ${JSON.stringify(walked.map((s) => `${s.role}:${s.name || s.href}`))}`,
  );
}

function expectDomOrder(stops: FocusStop[], label: string) {
  const order = stops.map((s) => s.idx);
  expect(
    order,
    `${label}: Tab order must follow DOM order; seen ${JSON.stringify(stops.map((s) => `${s.role}:${s.name || s.href}`))}`,
  ).toEqual([...order].sort((a, b) => a - b));
}

function expectVisibleFocusEverywhere(stops: FocusStop[], label: string) {
  const blind = stops.filter((s) => !s.focusStyleChanged);
  expect(
    blind.map((s) => `${s.role}:${s.name || s.href}`),
    `${label}: these focusable elements showed no visual focus change`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------

test.describe('AG-7 mobile 390px and keyboard acceptance', () => {
  let db: pg.Client;
  const contexts: BrowserContext[] = [];
  const pageErrors = new WeakMap<Page, string[]>();

  const track = (page: Page) => {
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };

  async function openMobile(browser: Browser, baseURL: string, _label: string): Promise<Page> {
    const context = await browser.newContext({
      baseURL,
      viewport: { ...MOBILE },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    contexts.push(context);
    const page = track(await context.newPage());
    page.on('response', (r) => {
      if (r.status() >= 500 && r.url().startsWith(baseURL)) {
        (pageErrors.get(page) ?? []).push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
      }
    });
    return page;
  }

  test.beforeAll(async ({ baseURL }) => {
    if (process.env.AIAG_E2E_OWNED_SERVER !== '1' || baseURL !== 'http://127.0.0.1:3107')
      throw new Error('Owned test server required: run scripts/verify-owned-auth.mjs --a11y');
    if (process.env.AIAG_TEST_DATABASE !== '1') throw new Error('AIAG_TEST_DATABASE=1 required');
    const dbUrl = new URL(process.env.DATABASE_URL ?? '');
    if (dbUrl.hostname !== '127.0.0.1' || dbUrl.port !== '15432' || dbUrl.pathname !== '/ai_aggregator_test' || dbUrl.search)
      throw new Error('Disposable database required');
    db = new pg.Client({ connectionString: dbUrl.href });
    await db.connect();
    const [marker] = (await db.query('SELECT marker FROM public._aiag_test_database_marker WHERE singleton=true')).rows;
    expect(marker?.marker).toBe('ai-aggregator:test-database:v1');
    await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  });

  test.afterAll(async () => {
    for (const c of contexts) await c.close();
    await db?.end();
  });

  function expectCleanRuntime(page: Page) {
    expect(pageErrors.get(page) ?? [], `runtime/5xx errors on ${page.url()}`).toEqual([]);
  }

  /** Register a real user, sign in through the real form, optionally promote to admin. */
  async function signedIn(browser: Browser, baseURL: string, role: 'user' | 'admin') {
    const context = await browser.newContext({
      baseURL,
      viewport: { ...MOBILE },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    contexts.push(context);
    const page = track(await context.newPage());
    const email = `a11y-${role}-${randomUUID()}@example.test`;
    const password = `Owned1-${randomUUID()}`;
    const registration = await context.request.post('/api/auth/register', {
      data: { name: `A11y ${role}`, email, password, consentProcessing: true, consentTransborder: true, consentMarketing: false },
    });
    expect(registration.status()).toBe(201);
    const { user } = await registration.json();
    if (role === 'admin') {
      await db.query("UPDATE users SET role='admin' WHERE id=$1 AND email=$2", [user.id, email]);
    }
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Войти с email', exact: true }).click();
    await page.waitForURL(/\/dashboard(?:[/?#]|$)/);
    expect((await (await page.request.get('/api/auth/session')).json()).user?.email).toBe(email);
    if (role === 'admin') {
      const stepUp = await context.request.post('/api/admin/auth', { data: { email, password } });
      expect(stepUp.status()).toBe(200);
    }
    return { page, email, password };
  }

  // -------------------------------------------------------------------------

  test('buyer: catalogue, model card, pricing and login fit 390px', async ({ browser, baseURL }) => {
    const page = await openMobile(browser, baseURL!, 'buyer');
    for (const path of ['/', '/marketplace', '/pricing', '/login']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 }).first(), `${path} must render an h1`).toBeVisible();
      await expectNoHorizontalOverflow(page, `public ${path}`);
    }

    await page.goto('/marketplace', { waitUntil: 'domcontentloaded' });
    const detailHref = await page.locator('a[href^="/marketplace/"]').evaluateAll((links) =>
      links
        .map((l) => l.getAttribute('href'))
        .find((href) => href !== null && /^\/marketplace\/[^/]+\/[^/?#]+$/.test(href) && !href.includes('/scenarios/')),
    );
    expect(detailHref, 'the catalogue must expose at least one model card link').toBeTruthy();
    await page.goto(detailHref!, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, `buyer model card ${detailHref}`);
    await page.screenshot({ path: resolve(EVIDENCE, 'buyer-model-card-390.png'), fullPage: true });
    expectCleanRuntime(page);
  });

  test('buyer: the catalogue is fully keyboard navigable and a model card opens with Enter', async ({ browser, baseURL }) => {
    const page = await openMobile(browser, baseURL!, 'buyer-keyboard');
    await page.goto('/marketplace', { waitUntil: 'domcontentloaded' });
    const { restStyles } = await prepareTraversal(page);
    const stops = await tabThrough(page, 40, restStyles);

    expectDomOrder(stops, 'catalogue');
    expectVisibleFocusEverywhere(stops, 'catalogue');

    // The buyer's two primary controls — search field and filter trigger — must
    // be reachable, not mouse-only.
    const search = stops.find((s) => s.role === 'input:search');
    expect(search, `search field not reachable; seen ${JSON.stringify(stops.map((s) => `${s.role}:${s.name}`))}`).toBeTruthy();
    expect(search!.focusStyleChanged).toBe(true);
    expect(stops.some((s) => s.role === 'button' && /Фильтры/.test(s.name)), 'the mobile filter trigger must be Tab reachable').toBe(true);

    const card = stops.find((s) => s.role === 'link' && s.href !== null && /^\/marketplace\/[^/]+\/[^/?#]+$/.test(s.href) && !s.href.includes('/scenarios/'));
    expect(card, 'no model card link was reachable by keyboard').toBeTruthy();
    const targetHref = card!.href!;
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname === targetHref);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.screenshot({ path: resolve(EVIDENCE, 'buyer-keyboard-model-390.png'), fullPage: true });
    expectCleanRuntime(page);
  });

  test('buyer: sign-in is completable with the keyboard alone and does not disable zoom', async ({ browser, baseURL }) => {
    const page = await openMobile(browser, baseURL!, 'login-keyboard');
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expectNoHorizontalOverflow(page, 'login');

    const meta = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
    expect(meta, 'the login page must declare a viewport meta').not.toBe('');
    expect(meta, 'pinch zoom must stay available on a phone').not.toMatch(/user-scalable\s*=\s*no/);
    expect(meta, 'pinch zoom must stay available on a phone').not.toMatch(/maximum-scale\s*=\s*[01](\D|$)/);

    const { restStyles } = await prepareTraversal(page);
    const stops = await tabThrough(page, 25, restStyles);
    expectDomOrder(stops, 'login');
    expectVisibleFocusEverywhere(stops, 'login');

    const email = stops.find((s) => s.role === 'input:email');
    const password = stops.find((s) => s.role === 'input:password');
    const submit = stops.find((s) => s.role === 'button' && s.name === 'Войти с email');
    expect(email?.name).toBe('Email');
    expect(password?.name).toBe('Пароль');
    expect(submit, 'the primary sign-in action must be Tab reachable').toBeTruthy();
    // Logical order: both credentials precede the primary action.
    expect(email!.idx).toBeLessThan(password!.idx);
    expect(password!.idx).toBeLessThan(submit!.idx);
    // No credential field may sit after the submit control.
    expect(stops.filter((s) => s.idx > submit!.idx && s.role.startsWith('input:')), 'a text field sits after the primary sign-in action').toEqual([]);

    // Now actually sign in with Tab + type + Enter, no mouse and no fill().
    const email2 = `kb-${randomUUID()}@example.test`;
    const password2 = 'Owned1-keyboard';
    const registration = await page.request.post('/api/auth/register', {
      data: { name: 'A11y keyboard buyer', email: email2, password: password2, consentProcessing: true, consentTransborder: true, consentMarketing: false },
    });
    expect(registration.status()).toBe(201);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const { restStyles: live } = await prepareTraversal(page);
    // From a fresh document the first Tab lands on the brand link, then the
    // email field. No fill(), no click(): the walk itself is the assertion.
    await tabUntil(page, live, (s) => s.role === 'input:email', 6);
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.id)).toBe('email');
    await page.keyboard.type(email2);
    await page.keyboard.press('Tab');
    // The password field sits after the "Забыли пароль?" link, hence the bound.
    await tabUntil(page, live, (s) => s.role === 'input:password', 4);
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.id)).toBe('password');
    await page.keyboard.type(password2);
    // Enter inside the form must submit it (implicit submission).
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/dashboard(?:[/?#]|$)/, { timeout: 20_000 });
    const session = await (await page.request.get('/api/auth/session')).json();
    expect(session.user?.email).toBe(email2);
    await expectNoHorizontalOverflow(page, 'dashboard right after keyboard sign-in');
    await page.screenshot({ path: resolve(EVIDENCE, 'buyer-keyboard-login-390.png'), fullPage: true });
    expectCleanRuntime(page);
  });

  test('author: dashboard, billing, models and keys fit 390px', async ({ browser, baseURL }) => {
    const { page } = await signedIn(browser, baseURL!, 'user');
    for (const [path, heading] of [
      ['/dashboard', 'Личный кабинет'],
      ['/dashboard/billing', 'Биллинг'],
      ['/dashboard/models', 'Мои модели'],
      ['/dashboard/keys', 'API-ключи'],
    ] as const) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1, name: heading }), `${path} must render its h1`).toBeVisible();
      await expectNoHorizontalOverflow(page, `author ${path}`);
    }
    await page.goto('/dashboard/models', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: resolve(EVIDENCE, 'author-models-390.png'), fullPage: true });
    expectCleanRuntime(page);
  });

  test('author: submit-model form is keyboard operable end to end (no mouse, no API call)', async ({ browser, baseURL }) => {
    const { page } = await signedIn(browser, baseURL!, 'user');
    await page.goto('/dashboard/models', { waitUntil: 'domcontentloaded' });
    const { restStyles } = await prepareTraversal(page);
    const stops = await tabThrough(page, 30, restStyles);
    expectDomOrder(stops, 'author /dashboard/models');
    expectVisibleFocusEverywhere(stops, 'author /dashboard/models');

    const addLink = stops.find((s) => s.role === 'link' && /Добавить модель/.test(s.name));
    expect(addLink, '"+ Добавить модель" must be Tab reachable').toBeTruthy();
    expect(addLink!.focusStyleChanged).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/dashboard\/models\/new$/);
    await expectNoHorizontalOverflow(page, 'author /dashboard/models/new');

    // Wizard step 1: fill with the keyboard only, then reach "Далее" with Tab.
    // Re-stamp: the indices from /dashboard/models describe a different DOM.
    const { restStyles: form } = await prepareTraversal(page);
    await tabUntil(page, form, (s) => s.name === 'Название', 20);
    await page.keyboard.type('Клавиатурная модель');
    await page.keyboard.press('Tab');
    await page.keyboard.type(`kb-${randomUUID()}`);
    await page.keyboard.press('Tab');
    await page.keyboard.type('Модель, полностью заполненная с клавиатуры для проверки AG-7.');
    const next = await tabUntil(page, form, (s) => s.role === 'button' && s.name === 'Далее', 8);
    expect(next.focusStyleChanged, 'the wizard "Далее" control must show a visible focus ring').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Endpoint URL', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'author submit-model step 2');
    await page.screenshot({ path: resolve(EVIDENCE, 'author-submit-model-390.png'), fullPage: true });
    expectCleanRuntime(page);
  });

  test('author: billing top-up control reacts to keyboard activation and stays inside 390px', async ({ browser, baseURL }) => {
    const { page } = await signedIn(browser, baseURL!, 'user');
    await page.goto('/dashboard/billing', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: 'Биллинг' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'author /dashboard/billing');

    const topup = page.getByRole('button', { name: /^Пополнить на .*₽$/ });
    await expect(topup).toBeVisible();
    const before = (await topup.innerText()).trim();
    expect(before, 'the top-up button must state the selected amount').toMatch(/\d/);

    // Presets are state-only: activating one must change the primary action
    // label. No payment request is issued (the money button is never pressed).
    const preset = page.getByRole('button', { name: /^2\s?500\s₽$/ });
    await expect(preset).toBeVisible();
    await preset.focus();
    await page.keyboard.press('Enter');
    await expect(topup).toHaveText(/2\s?500/);
    await expect(topup).not.toHaveText(before);
    await page.screenshot({ path: resolve(EVIDENCE, 'author-billing-keyboard-390.png'), fullPage: true });
    expectCleanRuntime(page);
  });

  test('admin: author-model queue fits 390px and is keyboard navigable', async ({ browser, baseURL }) => {
    const { page } = await signedIn(browser, baseURL!, 'admin');
    await page.goto('/admin/author-models', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: 'Модели авторов' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'admin /admin/author-models');

    const { restStyles } = await prepareTraversal(page);
    const stops = await tabThrough(page, 25, restStyles);
    expectDomOrder(stops, 'admin /admin/author-models');
    expectVisibleFocusEverywhere(stops, 'admin /admin/author-models');

    const back = stops.find((s) => s.role === 'link' && /Все модели/.test(s.name));
    expect(back, '"← Все модели" must be Tab reachable').toBeTruthy();
    expect(back!.focusStyleChanged).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/admin\/models$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Модели' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'admin /admin/models');
    await page.screenshot({ path: resolve(EVIDENCE, 'admin-author-models-390.png'), fullPage: true });
    expectCleanRuntime(page);
  });

  test('safe-area: viewport-fit and env(safe-area-inset-*) are used consistently, fixed chrome stays on screen', async ({ browser, baseURL }) => {
    const page = await openMobile(browser, baseURL!, 'safe-area');
    for (const path of ['/', '/marketplace', '/marketplace/community', '/login']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const viewportMeta = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';

      const insets = await page.evaluate(() => {
        const found: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue; // cross-origin sheet: not readable from the page
          }
          for (const rule of Array.from(rules)) {
            if (rule.cssText.includes('safe-area-inset')) found.push(rule.cssText.slice(0, 200));
          }
        }
        return found;
      });
      // Consistency invariant, in both directions: a half-applied inset is a
      // real defect on a notched device, so neither combination may pass silently.
      const usesFit = /viewport-fit\s*=\s*cover/.test(viewportMeta);
      expect(
        usesFit === insets.length > 0,
        `${path}: viewport-fit=cover (${usesFit}) and safe-area-inset rules (${insets.length}) must agree; rules=${JSON.stringify(insets)}`,
      ).toBe(true);

      // Fixed/sticky chrome must remain inside the viewport, and no bottom-flush
      // fixed bar may exist (that is exactly what safe-area-inset-bottom is for).
      const chromeIssues = await page.evaluate(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const issues: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          if (r.left < -1 || r.right > vw + 1)
            issues.push(`offscreen ${el.tagName.toLowerCase()} left=${Math.round(r.left)} right=${Math.round(r.right)}`);
          if (cs.position === 'fixed' && r.top > vh - 56 && r.bottom >= vh - 1)
            issues.push(`bottom-flush fixed bar ${el.tagName.toLowerCase()} top=${Math.round(r.top)} needs safe-area-inset-bottom`);
        }
        return issues;
      });
      expect(chromeIssues, `${path}: fixed/sticky chrome issues at ${MOBILE.width}px`).toEqual([]);
    }
    expectCleanRuntime(page);
  });
});
