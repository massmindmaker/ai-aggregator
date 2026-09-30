/**
 * Regression tests for the cap-counter bypass.
 *
 * THE BUG: the three enforced spend counters (daily USD / monthly cost /
 * per-session budget) were INCR'd inline in chat.ts's NON-STREAM branch only.
 * The cap *reads* are global middlewares on `/v1/*`, but the *writes* were
 * chat-only — so every other billing path (chat STREAM via sse.ts,
 * completions, embeddings, images, video, audio) debited real money while the
 * counters stayed at zero. A key with a daily/monthly cap was bypassable by
 * switching endpoint or setting `stream:true`.
 *
 * These tests pin the fix at both levels: the shared helper's own behaviour,
 * and the end-to-end consequence (a NON-chat settlement now actually trips the
 * middleware that reads the counter).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import IORedisMock from 'ioredis-mock';
import { setRedisFactory } from '../lib/redis';
import { incrementSpendCounters } from '../billing/spend-counters';
import { keyLimits, monthlyCostCounterKey } from '../middleware/key-limits';
import { AiagError } from '../lib/errors';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';

// Keep the stream/settle test off a real Postgres socket: settle.ts and
// logging/stream.ts both import lib/db at module load. The stub returns a
// settlement-shaped row so settleCharge SUCCEEDS — the counters are
// deliberately gated on a successful charge, so an empty stub here would make
// the stream test pass/fail for the wrong reason.
vi.mock('../lib/db', () => ({
  sql: (..._a: unknown[]) =>
    Promise.resolve([
      {
        sub_portion: '0',
        payg_portion: '2700',
        new_sub: '0',
        new_payg: '97300',
        idempotent: false,
      },
    ]),
}));

const todayKey = (orgId: string): string =>
  `usd_day:${orgId}:${new Date().toISOString().slice(0, 10)}`;

const sessionKey = (keyId: string, sid: string): string =>
  `session:${keyId}:${sid}:cost_rub`;

function makeKey(over: Partial<AuthenticatedApiKey> = {}): AuthenticatedApiKey {
  return {
    id: 'k-spend',
    org_id: 'org-spend',
    policies: {},
    rpm_limit: 60,
    daily_usd_cap: 10,
    batch_rpm_limit: 10,
    cost_limit_monthly_rub: 100,
    ...over,
  };
}

describe('incrementSpendCounters — the shared write-point', () => {
  let redis: any;
  beforeEach(() => {
    redis = new (IORedisMock as any)();
    setRedisFactory(() => redis);
  });

  it('bumps ALL THREE counters in the exact keyspace the readers use', async () => {
    const key = makeKey({
      id: 'k-all3',
      org_id: 'org-all3',
      policies: { per_session_budget_cap_rub: 500 },
    });
    await incrementSpendCounters({
      key,
      byok: false,
      upstreamCents: 250, // $2.50 of upstream cost
      costCredits: 4500, // 4.5 credits, in micro
      sessionId: 'sess-1',
    });

    // daily USD cap accumulates REAL USD (cents / 100) — same unit
    // rate-limit-plan04.ts compares against daily_usd_cap.
    expect(parseFloat((await redis.get(todayKey('org-all3'))) ?? '0')).toBeCloseTo(2.5, 6);
    // monthly counter accumulates MICRO-credits — the unit key-limits.ts reads.
    expect(parseFloat((await redis.get(monthlyCostCounterKey('k-all3'))) ?? '0')).toBe(4500);
    // per-session budget, keyed exactly as routing/policies.ts reads it.
    expect(parseFloat((await redis.get(sessionKey('k-all3', 'sess-1'))) ?? '0')).toBe(4500);
  });

  it('accumulates across calls (a second billed request adds to the first)', async () => {
    const key = makeKey({ id: 'k-accum', org_id: 'org-accum' });
    for (let i = 0; i < 3; i++) {
      await incrementSpendCounters({
        key,
        byok: false,
        upstreamCents: 100,
        costCredits: 1000,
      });
    }
    expect(parseFloat((await redis.get(todayKey('org-accum'))) ?? '0')).toBeCloseTo(3, 6);
    expect(parseFloat((await redis.get(monthlyCostCounterKey('k-accum'))) ?? '0')).toBe(3000);
  });

  it('BYOK skips the daily-USD accumulator but still counts the fee monthly', async () => {
    // BYOK bears no upstream cost we pay for → nothing to add to the org's
    // daily USD spend; the fixed BYOK fee is still a charge, so it counts.
    const key = makeKey({ id: 'k-byok', org_id: 'org-byok' });
    await incrementSpendCounters({
      key,
      byok: true,
      upstreamCents: 0,
      costCredits: 1000,
    });
    expect(await redis.get(todayKey('org-byok'))).toBeNull();
    expect(parseFloat((await redis.get(monthlyCostCounterKey('k-byok'))) ?? '0')).toBe(1000);
  });

  it('writes nothing when the key has no caps configured (NULL = unlimited)', async () => {
    const key = makeKey({
      id: 'k-nocap',
      org_id: 'org-nocap',
      daily_usd_cap: null,
      cost_limit_monthly_rub: null,
    });
    await incrementSpendCounters({
      key,
      byok: false,
      upstreamCents: 500,
      costCredits: 9000,
    });
    expect(await redis.get(todayKey('org-nocap'))).toBeNull();
    expect(await redis.get(monthlyCostCounterKey('k-nocap'))).toBeNull();
  });

  it('skips the session counter when no session id was sent', async () => {
    const key = makeKey({
      id: 'k-nosid',
      org_id: 'org-nosid',
      policies: { per_session_budget_cap_rub: 500 },
    });
    await incrementSpendCounters({
      key,
      byok: false,
      upstreamCents: 100,
      costCredits: 1000,
      sessionId: null,
    });
    expect(await redis.get(sessionKey('k-nosid', 'undefined'))).toBeNull();
  });

  it('a Redis failure cannot break an already-charged request', async () => {
    // The counters run AFTER settlement — swallowing the error loses a
    // counter tick, throwing would 500 a request the caller already paid for.
    setRedisFactory(
      () =>
        ({
          incrbyfloat: () => Promise.reject(new Error('redis down')),
          expireat: () => Promise.reject(new Error('redis down')),
          expire: () => Promise.reject(new Error('redis down')),
          get: () => Promise.resolve(null),
        }) as any
    );
    await expect(
      incrementSpendCounters({
        key: makeKey({ id: 'k-redisdown' }),
        byok: false,
        upstreamCents: 100,
        costCredits: 1000,
      })
    ).resolves.toBeUndefined();
  });
});

describe('cap enforcement now reaches NON-chat billing paths (the bug)', () => {
  beforeEach(() => setRedisFactory(() => new (IORedisMock as any)()));

  function appFor(key: AuthenticatedApiKey): Hono {
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof AiagError) return c.json(err.toResponseBody(), err.status as any);
      return c.json({ error: { code: 'INTERNAL', message: String(err) } }, 500);
    });
    app.use('*', async (c, next) => {
      c.set('apiKey' as never, key as never);
      await next();
    });
    app.use('/v1/*', keyLimits);
    app.post('/v1/embeddings', (c) => c.json({ ok: true }));
    return app;
  }

  it('spend settled on a non-chat route trips the monthly cap on the next request', async () => {
    const redis: any = new (IORedisMock as any)();
    setRedisFactory(() => redis);
    const key = makeKey({ id: 'k-nonchat', org_id: 'org-nonchat', cost_limit_monthly_rub: 5 });

    // Before: fresh key, nothing spent → request passes.
    expect((await appFor(key).fetch(new Request('http://x/v1/embeddings', { method: 'POST' }))).status).toBe(200);

    // A NON-chat billing path settles 5 credits (5000 micro) — exactly the
    // cap. Pre-fix this incremented nothing, so the cap never engaged no
    // matter how much such a key spent.
    await incrementSpendCounters({
      key,
      byok: false,
      upstreamCents: 300,
      costCredits: 5000,
    });

    const res = await appFor(key).fetch(new Request('http://x/v1/embeddings', { method: 'POST' }));
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.code).toBe('PAYMENT_REQUIRED');
  });
});

describe('chat STREAM path settles AND moves the counters', () => {
  let redis: any;
  beforeEach(() => {
    redis = new (IORedisMock as any)();
    setRedisFactory(() => redis);
  });

  it('a streamed response bumps the monthly cap counter (stream:true was a free bypass)', async () => {
    const { streamSseAndSettle } = await import('../streaming/sse');
    const key = makeKey({
      id: 'k-stream',
      org_id: 'org-stream',
      // All three caps configured, so all three counters are in scope.
      policies: { per_session_budget_cap_rub: 500 },
    });

    const app = new Hono();
    app.post('/v1/chat/completions', async (c) => {
      async function* chunks(): AsyncIterable<unknown> {
        yield { choices: [{ index: 0, delta: { content: 'hello world ' } }] };
        yield {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        };
      }
      return streamSseAndSettle(c, chunks(), {
        upstream: {
          upstream_id: 'u1',
          upstream_model_id: 'm1',
          provider: 'mock',
          markup: 1.8,
          price_per_1k_input: 0.3,
          price_per_1k_output: 1.5,
        } as any,
        model: { slug: 'test-model', type: 'chat' },
        key,
        sessionId: 'sess-stream',
        requestId: 'req-stream-1',
        settlementRequestId: 'stl_11111111-2222-4333-8444-555555555555',
        byok: false,
      });
    });

    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so the settle/counter block runs

    // The counters moved — that is the whole point. Exact amounts are the
    // pricing module's contract (pricing.test.ts owns those); here we assert
    // the stream path is no longer a zero.
    const monthly = parseFloat((await redis.get(monthlyCostCounterKey('k-stream'))) ?? '0');
    expect(monthly).toBeGreaterThan(0);
    const daily = parseFloat((await redis.get(todayKey('org-stream'))) ?? '0');
    expect(daily).toBeGreaterThan(0);
    const session = parseFloat((await redis.get(sessionKey('k-stream', 'sess-stream'))) ?? '0');
    expect(session).toBeGreaterThan(0);
  });
});
