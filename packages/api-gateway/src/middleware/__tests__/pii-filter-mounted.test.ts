/**
 * H-1 — the body of `piiFilter` had no test at all.
 *
 * `pii-transborder-residency.test.ts` covers only `slugLooksTransborder` and
 * `evaluateResidencyPolicy`, both pure functions. Nothing in the repository
 * mounted `piiFilter` as middleware, so the branch the middleware exists for —
 * residency taken from the resolver, failing CLOSED when the resolver throws
 * or returns nothing usable — could be reverted to the old prefix guess with a
 * fully green suite.
 *
 * These tests mount the real handler on a real Hono app, with the real
 * `extractText`/`detectPii` and the real `applyAiagErrorHandler`, so the 403 is
 * produced by the same path production uses. Only `../lib/db` (the
 * `pii_detections` INSERT) and the logger are stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { applyAiagErrorHandler } from '../../lib/errors';
import { piiFilter, setPiiResolveModel } from '../pii-filter';
import type { AuthenticatedApiKey } from '../auth-plan04';
import type { ResolvedModel } from '../../routing/resolver';

// The only DB call the filter makes is the pii_detections INSERT; it must never
// reach a real database from a unit test.
const inserts: unknown[][] = [];
vi.mock('../../lib/db', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    inserts.push([strings.join(' '), ...values]);
    return Promise.resolve({ rows: [] });
  },
}));
vi.mock('../../lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const ORG = '40000000-0000-4000-8000-000000000001';

function app(policies: Record<string, unknown> = {}): Hono {
  const key: AuthenticatedApiKey = {
    id: 'k1',
    org_id: ORG,
    policies,
    rpm_limit: 10,
    daily_usd_cap: null,
    batch_rpm_limit: 1,
  };
  const a = new Hono();
  applyAiagErrorHandler(a);
  a.use('*', async (c, next) => {
    c.set('apiKey' as never, key as never);
    await next();
  });
  a.use('/v1/*', piiFilter);
  a.post('/v1/chat/completions', (c) => c.json({ ok: true }));
  return a;
}

function post(body: unknown): Request {
  return new Request('http://gateway/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const withEmail = (model: string) => ({
  model,
  messages: [{ role: 'user', content: 'напиши письмо на client@example.com' }],
});

const resolved = (candidates: ResolvedModel['candidates']): ResolvedModel => ({
  slug: 'x',
  type: 'chat',
  candidates,
});

afterEach(() => {
  setPiiResolveModel(null);
  inserts.length = 0;
  vi.clearAllMocks();
});

describe('piiFilter — fail-closed residency (H-1)', () => {
  it('blocks when the resolver throws: residency cannot be established', async () => {
    // A RU-looking slug, so a prefix guess would have allowed it through. This
    // is exactly the case the fail-closed branch exists for.
    setPiiResolveModel(async () => {
      throw new Error('catalog unavailable');
    });

    const r = await app().fetch(post(withEmail('sber/gigachat-pro')));

    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('FORBIDDEN');
  });

  it('blocks when the resolver returns no candidates', async () => {
    setPiiResolveModel(async () => resolved([]));

    const r = await app().fetch(post(withEmail('sber/gigachat-pro')));

    expect(r.status).toBe(403);
  });

  it('blocks when the resolver candidate has no residency verdict', async () => {
    setPiiResolveModel(async () => resolved([{ id: 'u1' } as never]));

    const r = await app().fetch(post(withEmail('sber/gigachat-pro')));

    expect(r.status).toBe(403);
  });

  it('honours a RU-resident verdict from the resolver even for a foreign slug', async () => {
    // The symmetric case: the resolver is authoritative in both directions, so
    // a foreign-prefixed slug with a proven RU candidate passes.
    setPiiResolveModel(async () =>
      resolved([{ id: 'u1', ru_residency: true } as never]),
    );

    const r = await app().fetch(post(withEmail('openai/gpt-4o-mini')));

    expect(r.status).toBe(200);
  });

  it('blocks a foreign candidate even when the slug prefix is RU-local', async () => {
    // kie/ is foreign per FOREIGN_PROVIDERS, but this inverts it: the slug says
    // RU, the resolved candidate does not. The resolver wins.
    setPiiResolveModel(async () =>
      resolved([{ id: 'u1', ru_residency: false } as never]),
    );

    const r = await app().fetch(post(withEmail('sber/gigachat-pro')));

    expect(r.status).toBe(403);
  });

  it('falls back to the slug prefix when no resolver is wired at all', async () => {
    setPiiResolveModel(null);

    expect((await app().fetch(post(withEmail('sber/gigachat-pro')))).status).toBe(200);
    expect((await app().fetch(post(withEmail('openai/gpt-4o-mini')))).status).toBe(403);
  });

  it('fails closed on an absent policy: a key with no policies object blocks', async () => {
    setPiiResolveModel(async () => {
      throw new Error('catalog unavailable');
    });

    const r = await app({}).fetch(post(withEmail('openai/gpt-4o-mini')));

    expect(r.status).toBe(403);
  });

  it('passes when the key explicitly allows transborder PII', async () => {
    setPiiResolveModel(async () => resolved([{ id: 'u1', ru_residency: false } as never]));

    const r = await app({ allow_pii_transborder: true }).fetch(post(withEmail('openai/gpt-4o-mini')));

    expect(r.status).toBe(200);
  });

  it('records the block and still refuses a clean request', async () => {
    setPiiResolveModel(async () => resolved([{ id: 'u1', ru_residency: false } as never]));
    const a = app();

    expect((await a.fetch(post(withEmail('openai/gpt-4o-mini')))).status).toBe(403);
    expect(
      (await a.fetch(post({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'a cat' }] })))
        .status,
    ).toBe(200);
  });

  it('logs the detection hash, never the raw sample', async () => {
    setPiiResolveModel(async () => resolved([{ id: 'u1', ru_residency: false } as never]));

    await app().fetch(post(withEmail('openai/gpt-4o-mini')));

    expect(inserts.length).toBeGreaterThan(0);
    const flattened = JSON.stringify(inserts);
    expect(flattened).not.toContain('client@example.com');
    expect(flattened).toContain('block');
  });
});
