import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AG-7 Task 2 — claims vs runtime.
 *
 * Storefront promises are compared against what the runtime can actually
 * serve. Source of truth is CODE, not documentation:
 *
 *  - sold v1 model scope: apps/web/src/lib/marketplace/catalog.ts::isSoldV1Model
 *    + packages/api-gateway/src/catalog/public-catalog.ts (SQL) and
 *    packages/database/migrations/0093_depublish_stt_v1.sql (STT disabled).
 *  - advertised capability contract: public-catalog.ts `capability` /
 *    `invocation.requestBody` (streaming:false, toolCalling:false,
 *    structuredOutput:false, multimodalMessageContent:'reject', tools/functions
 *    rejected, stream const false).
 *  - type support: public-catalog.ts projectModel() — only `chat` and
 *    `embedding` can ever be `available`; image/video/audio resolve to
 *    unavailable('no_admitted_deployment').
 *  - billing unit: credits (apps/web/src/lib/marketplace/pricing-calc.ts
 *    docblock, packages/api-gateway comments) — never ₽.
 *  - subscription tiers/rpm: apps/web/src/lib/payments/providers.ts::TIERS and
 *    packages/database/migrations/0004_gateway_core.sql (rpm_limit DEFAULT 60,
 *    per api_keys row, never written from the subscription plan).
 *
 * Part A is static (no server, no network, no money) and always runs.
 * Part B is a browser pass over the storefront and only runs against the
 * owned disposable server, like e2e/auth.setup.ts does.
 *
 * A green run means "claims match runtime as of this commit". It is NOT an
 * acceptance artifact on its own — the controller must keep the run output.
 */

const ROOT = process.cwd();

const read = (relative: string): string =>
  readFileSync(resolve(ROOT, relative), 'utf8');

/** Line number (1-based) of the first line matching `pattern`, or 0. */
function lineOf(source: string, pattern: RegExp): number {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) if (pattern.test(lines[i])) return i + 1;
  return 0;
}

/** Every line matching `pattern`, as `path:line` evidence strings. */
function hits(relative: string, pattern: RegExp): string[] {
  return read(relative)
    .split('\n')
    .map((line, index) => ({ line, n: index + 1 }))
    .filter(({ line }) => pattern.test(line))
    .map(({ line, n }) => `${relative}:${n} — ${line.trim().slice(0, 140)}`);
}

// ─────────────────────────── Part A: static claims vs runtime ───────────────

test.describe('sold v1 modality scope (STT withdrawn from sale)', () => {
  const catalogSource = read('apps/web/src/lib/marketplace/catalog.ts');
  const gatewayCatalog = read(
    'packages/api-gateway/src/catalog/public-catalog.ts',
  );
  const migration = read(
    'packages/database/migrations/0093_depublish_stt_v1.sql',
  );

  test('the runtime withdrawal of STT is real in code (all three layers)', () => {
    // web storefront filter
    expect(lineOf(catalogSource, /function isSoldV1Model/)).toBeGreaterThan(0);
    expect(catalogSource).toMatch(/model\.type === 'speech-to-text'.*return false/s);
    // gateway SQL filter
    expect(gatewayCatalog).toMatch(/slug <> 'whisper-large-v3'/);
    expect(gatewayCatalog).toMatch(/metadata->>'operation',''\)\) <> 'stt'/);
    // database layer
    expect(migration).toMatch(/SET enabled=FALSE/);
    expect(migration).toMatch(/v1_scope_stt_deferred/);
  });

  test('no storefront page advertises STT / Whisper as available', () => {
    // Every claim surface a visitor can read. `/docs` model list, hero copy,
    // hero price card, metadata description, scenario cards, filter panel,
    // the "request a model" form and the scenarios page modality legend.
    const surfaces: Array<[string, RegExp]> = [
      ['apps/web/src/app/page.tsx', /whisper/i],
      ['apps/web/src/app/page.tsx', /\bSTT\b/],
      ['apps/web/src/app/docs/page.tsx', /whisper/i],
      ['apps/web/src/app/docs/page.tsx', /\bSTT\b/],
      ['apps/web/src/components/marketplace/CodeExampleTabs.tsx', /whisper/i],
      ['apps/web/src/lib/marketplace/scenarios.ts', /whisper|stt|transcri/i],
      [
        'apps/web/src/app/(marketing)/marketplace/scenarios/page.tsx',
        /whisper|Распознавание речи/i,
      ],
    ];
    const found = surfaces.flatMap(([file, pattern]) => hits(file, pattern));
    // Migration 0093 withdrew STT from sold v1; any hit here is a live claim
    // for a modality the gateway refuses to sell.
    expect(found, `STT claims on the storefront:\n${found.join('\n')}`).toEqual(
      [],
    );
  });

  test('no storefront surface offers a modality the gateway cannot serve', () => {
    // public-catalog.ts projectModel(): anything that is neither `chat` nor
    // `embedding` is unavailable('no_admitted_deployment'). The catalog copy
    // nevertheless advertises image/video/audio as purchasable.
    const gatewayCatalog = read(
      'packages/api-gateway/src/catalog/public-catalog.ts',
    );
    expect(gatewayCatalog).toMatch(
      /if \(model\.type !== 'chat'\) return unavailable\(model, 'no_admitted_deployment'\)/,
    );
    const found = hits(
      'apps/web/src/app/page.tsx',
      /LLM \+ image \+ audio/,
    );
    expect(
      found,
      `comparison table claims modalities the catalog marks unavailable:\n${found.join('\n')}`,
    ).toEqual([]);
  });
});

test.describe('advertised capability contract', () => {
  const gatewayCatalog = read(
    'packages/api-gateway/src/catalog/public-catalog.ts',
  );

  test('runtime capability is plaintext, non-streaming, no tools', () => {
    expect(gatewayCatalog).toMatch(/streaming: false as const/);
    expect(gatewayCatalog).toMatch(/toolCalling: false as const/);
    expect(gatewayCatalog).toMatch(/structuredOutput: false as const/);
    expect(gatewayCatalog).toMatch(/multimodalMessageContent: 'reject'/);
    expect(gatewayCatalog).toMatch(
      /unsupportedExecutionFields: Object\.freeze\(\['tools', 'functions', 'tool_choice'/,
    );
    expect(gatewayCatalog).toMatch(/const: false as const, normalizedDefault: false/);
  });

  test('storefront does not badge streaming / tool-calling / vision / json schema', () => {
    const detail = read(
      'apps/web/src/app/(marketing)/marketplace/[org]/[model]/page.tsx',
    );
    const bad = ['Streaming', 'Tool-calling', 'Vision', 'JSON schema']
      .map((label) => lineOf(detail, new RegExp(`label="${label}"`)))
      .filter((n) => n > 0)
      .map((n) => `${n}: capability badge rendered from static catalog data`);
    expect(
      bad,
      `model detail page badges capabilities the gateway rejects:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  test('filter panel does not offer capability filters for unsupported features', () => {
    const panel = read('apps/web/src/components/marketplace/FilterPanel.tsx');
    const bad = hits(
      'apps/web/src/components/marketplace/FilterPanel.tsx',
      /label: '(Streaming|Function calling|Vision|JSON Schema|Batch API)'/,
    );
    expect(panel).toBeTruthy();
    expect(
      bad,
      `capability filters promise features the sold contract rejects:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  test('docs and code examples do not teach streaming', () => {
    const docs = read('apps/web/src/app/docs/page.tsx');
    expect(
      docs,
      'docs advertise SSE streaming; the sold catalog declares stream const false',
    ).not.toMatch(/stream=True/);
    expect(docs).not.toMatch(/потоковая выдача/);
    const tabs = read('apps/web/src/components/marketplace/CodeExampleTabs.tsx');
    const bad = hits(
      'apps/web/src/components/marketplace/CodeExampleTabs.tsx',
      /"stream":\s*true/,
    );
    expect(
      bad,
      `copy-paste samples request streaming, which is rejected:\n${bad.join('\n')}`,
    ).toEqual([]);
  });
});

test.describe('price unit and tier claims', () => {
  test('storefront quotes credits, not rubles', () => {
    const pricing = read('apps/web/src/lib/marketplace/pricing-calc.ts');
    expect(pricing).toMatch(/CREDITS \(1 credit = 1 US cent\), NOT rubles/);
    const home = read('apps/web/src/app/page.tsx');
    const bad = hits(
      'apps/web/src/app/page.tsx',
      /\d\s*(₽|\\u20bd)|₽\s*\/\s*(1k|img|мин)|Цены в ₽|оплата в ₽/i,
    );
    expect(
      bad,
      `home page quotes ruble prices; billing unit is credits:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  test('subscription tiers on the storefront equal TIERS in code', () => {
    const providers = read('apps/web/src/lib/payments/providers.ts');
    const tierIds = [...providers.matchAll(/^\s{2}(\w+):\s*\{\s*name:/gm)].map(
      (m) => m[1],
    );
    expect(tierIds.length).toBeGreaterThan(0);
    const home = read('apps/web/src/app/page.tsx');
    const advertised = [
      'Basic',
      'Starter',
      'Growth',
      'Pro',
      'Business',
    ].filter((tier) => new RegExp(`tier: '${tier}'`).test(home));
    expect(
      advertised.filter((tier) => !tierIds.includes(tier.toLowerCase())),
      `home page sells tiers absent from providers.ts::TIERS (${tierIds.join(', ')})`,
    ).toEqual([]);
  });

  test('per-tier rpm claims have no runtime source', () => {
    // gateway enforces rpm_limit per api_keys row (default 60); nothing in the
    // web app writes it from the subscription plan.
    const migration = read('packages/database/migrations/0004_gateway_core.sql');
    expect(migration).toMatch(/rpm_limit\s+INTEGER NOT NULL DEFAULT 60/);
    const claimed = hits(
      'apps/web/src/app/pricing/PricingClient.tsx',
      /'\d+ запросов в минуту'/,
    );
    const enforced = [...migration.matchAll(/DEFAULT (\d+)/g)].map(
      (m) => Number(m[1]),
    );
    expect(
      claimed.filter((c) => !enforced.some((rpm) => c.includes(`${rpm} `))),
      `pricing page promises rpm values the gateway never grants: ${claimed.length} claim(s)`,
    ).toEqual([]);
  });
});

test.describe('storefront surface integrity', () => {
  test('filter type list only offers types present in the live catalog', () => {
    const generated = read(
      'apps/web/src/lib/marketplace/catalog.generated.ts',
    );
    const liveTypes = new Set(
      [...generated.matchAll(/type: "([a-z-]+)"/g)].map((m) => m[1]),
    );
    const panel = read('apps/web/src/components/marketplace/FilterPanel.tsx');
    const block = panel.slice(
      panel.indexOf('const ALL_TYPES'),
      panel.indexOf('];', panel.indexOf('const ALL_TYPES')),
    );
    const offered = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(offered.length).toBeGreaterThan(0);
    const empty = offered.filter((type) => !liveTypes.has(type));
    expect(
      empty,
      `filter offers model types no catalog entry has (yields an empty page): ${empty.join(', ')}`,
    ).toEqual([]);
  });

  test('docs page only names model slugs that exist in the catalog', () => {
    const generated = read(
      'apps/web/src/lib/marketplace/catalog.generated.ts',
    );
    const slugs = new Set([
      ...[...generated.matchAll(/slug: "([^"]+)"/g)].map((m) => m[1]),
      ...[...generated.matchAll(/modelSlug: "([^"]+)"/g)].map((m) => m[1]),
    ]);
    const docs = read('apps/web/src/app/docs/page.tsx');
    const section = docs.slice(
      docs.indexOf('<section id="models"'),
      docs.indexOf('<section id="examples"'),
    );
    const named = [
      ...section.matchAll(/font-semibold text-primary font-mono">\s*([^<]+)</g),
    ]
      .flatMap((m) =>
        m[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    expect(
      named.filter((n) => !slugs.has(n)),
      `docs list model slugs absent from the live catalog: ${named
        .filter((n) => !slugs.has(n))
        .join(', ')}`,
    ).toEqual([]);
  });

  test('playground is not offered for models the chat-only route cannot run', () => {
    const detail = read(
      'apps/web/src/app/(marketing)/marketplace/[org]/[model]/page.tsx',
    );
    const run = read('apps/web/src/app/api/playground/run/route.ts');
    // The playground always posts to /v1/chat/completions regardless of type.
    expect(run).toMatch(/\/v1\/chat\/completions/);
    expect(
      detail,
      'every model page offers the Playground, but the playground posts to /v1/chat/completions for image/video/audio/embedding models too',
    ).not.toMatch(/\/playground`/);
  });
});

// ───────────────────────── Part B: rendered storefront (owned server) ────────

test.describe('rendered storefront', () => {
  test.skip(
    () => process.env.AIAG_E2E_OWNED_SERVER !== '1',
    'Requires the owned disposable server (AIAG_E2E_OWNED_SERVER=1)',
  );

  test('marketplace and docs pages render no STT claim', async ({ page, baseURL }) => {
    if (baseURL !== 'http://127.0.0.1:3107')
      throw new Error('Owned test server required');
    for (const path of ['/marketplace', '/docs', '/marketplace/scenarios']) {
      await page.goto(path);
      const text = await page.locator('body').innerText();
      expect(text, `${path} must not advertise withdrawn STT`).not.toMatch(
        /whisper/i,
      );
      expect(text, `${path} must not advertise withdrawn STT`).not.toMatch(
        /\bSTT\b/,
      );
    }
  });

  test('home page shows no ruble price and no STT claim', async ({ page }) => {
    await page.goto('/');
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/whisper/i);
    expect(text).not.toMatch(/\d\s*₽\s*\/\s*(1k|img|мин)/);
  });

  test('a sold model page does not badge rejected capabilities', async ({
    page,
  }) => {
    await page.goto('/marketplace');
    const href = await page
      .locator('a[href^="/marketplace/"]')
      .evaluateAll((links) =>
        links
          .map((l) => l.getAttribute('href'))
          .find(
            (h) =>
              h &&
              /^\/marketplace\/[^/]+\/[^/?#]+$/.test(h) &&
              !h.includes('/scenarios/'),
          ),
      );
    expect(href).toBeTruthy();
    await page.goto(href!);
    await page.getByRole('tab', { name: /Характеристики|Specs/i }).click().catch(() => {});
    const specs = (await page.locator('body').innerText()).slice();
    for (const label of ['Streaming', 'Tool-calling', 'Vision', 'JSON schema'])
      expect(specs, `${href} badges ${label}`).not.toContain(`${label}`);
  });
});
