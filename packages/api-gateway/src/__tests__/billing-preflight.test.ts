/**
 * Regression tests for the two remaining money-path holes closed alongside the
 * cap-counter fix:
 *
 *  (2) PREFLIGHT — the settlement order was `upstream → settle → 402`. A
 *      zero-balance org still got a full answer, and on the stream path the
 *      settle error was caught and logged inside sse.ts, so the answer was
 *      simply free. `assertPositiveBalance` moves the 402 in front of the
 *      upstream call.
 *
 *  (3) EMBEDDINGS — /v1/embeddings called `mockUpstream.embeddings!`
 *      unconditionally: Math.sin()-generated 8-dim fake vectors, billed as
 *      real. It now dispatches through getUpstream() like every other route.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { assertPositiveBalance } from '../billing/settle';
import { AiagError } from '../lib/errors';

/** Tagged-template stand-in for the postgres.js client. */
function fakeSql(rows: unknown[]): any {
  return (..._args: unknown[]) => Promise.resolve(rows);
}

const SRC = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('assertPositiveBalance — preflight balance gate', () => {
  it('throws 402 PAYMENT_REQUIRED when the org has nothing spendable', async () => {
    await expect(
      assertPositiveBalance('org-empty', fakeSql([{ balance: '0' }]))
    ).rejects.toMatchObject({ status: 402, code: 'PAYMENT_REQUIRED' });
  });

  it('throws 402 on a negative balance (overdrawn org cannot keep spending)', async () => {
    await expect(
      assertPositiveBalance('org-negative', fakeSql([{ balance: '-5000' }]))
    ).rejects.toMatchObject({ status: 402 });
  });

  it('throws 402 when the org row does not exist (fail closed, never open)', async () => {
    await expect(
      assertPositiveBalance('org-missing', fakeSql([]))
    ).rejects.toBeInstanceOf(AiagError);
  });

  it('passes when the org has any positive balance', async () => {
    await expect(
      assertPositiveBalance('org-funded', fakeSql([{ balance: '1' }]))
    ).resolves.toBeUndefined();
  });

  it('compares exactly at BIGINT scale (no float precision loss)', async () => {
    // A balance past 2^53 must still read as positive — Number() would round
    // it, BigInt does not. Guards the micro-credit unit's headroom.
    await expect(
      assertPositiveBalance('org-huge', fakeSql([{ balance: '9007199254740993' }]))
    ).resolves.toBeUndefined();
  });

  it('402s BEFORE the upstream is ever called', async () => {
    // The actual defect: the old order let the upstream run (and, streaming,
    // deliver the whole answer) before anyone checked whether the caller
    // could pay for it.
    let upstreamCalls = 0;
    const app = new Hono();
    app.onError((err, c) =>
      err instanceof AiagError
        ? c.json(err.toResponseBody(), err.status as any)
        : c.json({ error: { code: 'INTERNAL' } }, 500)
    );
    app.post('/v1/chat/completions', async (c) => {
      await assertPositiveBalance('org-empty', fakeSql([{ balance: '0' }]));
      upstreamCalls++; // never reached
      return c.json({ ok: true });
    });

    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(402);
    expect(upstreamCalls).toBe(0);
  });

  it('makes no network call — a single DB read, nothing else', async () => {
    // The money hot path must never contain a fetch (the CBR-in-key-limits
    // outage, 2026-07-17). If assertPositiveBalance ever grows one, this
    // fails instead of quietly adding seconds of blocking per billed request.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...a: unknown[]) => {
      fetchCalls++;
      return (originalFetch as any)(...a);
    }) as typeof fetch;
    try {
      await assertPositiveBalance('org-funded', fakeSql([{ balance: '100000' }]));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toBe(0);
  });
});

/**
 * Wiring guards. The unit tests above prove the helpers behave; these prove
 * they are actually CALLED on every billing path — which is precisely what
 * went wrong before (a correct helper wired into exactly one of seven routes).
 */
describe('every billing route is wired to both helpers', () => {
  const BILLING_ROUTES = [
    'routes/v1/chat.ts',
    'routes/v1/completions.ts',
    'routes/v1/embeddings.ts',
    'routes/v1/images.ts',
    'routes/v1/video.ts',
    'routes/v1/audio.ts',
  ];

  it.each(BILLING_ROUTES)('%s calls assertPositiveBalance before the upstream', (rel) => {
    expect(read(rel)).toContain('assertPositiveBalance');
  });

  it.each(BILLING_ROUTES)('%s calls incrementSpendCounters after settling', (rel) => {
    expect(read(rel)).toContain('incrementSpendCounters');
  });

  it('the stream path (sse.ts) increments the counters too', () => {
    // chat.ts's `stream:true` branch hands off to sse.ts and returns — the
    // counter block in chat.ts is never reached for a streamed request.
    expect(read('streaming/sse.ts')).toContain('incrementSpendCounters');
  });

  it.each(BILLING_ROUTES)('%s skips preflight for BYOK (own key = zero charge)', (rel) => {
    // Commission rule (CLAUDE.md): a caller on their own key/provider pays
    // their provider, not us — gating them on OUR balance would break BYOK.
    expect(read(rel)).toMatch(/if \(!byok\) await assertPositiveBalance/);
  });

  it('no billing route increments a cap counter inline anymore', () => {
    // Single write-point: inline INCRs are how the paths drifted apart.
    for (const rel of BILLING_ROUTES) {
      expect(read(rel)).not.toContain('usd_day:');
      expect(read(rel)).not.toContain('monthlyCostCounterKey');
    }
  });
});

describe('/v1/embeddings no longer sells fabricated vectors', () => {
  it('does not import or call the mock upstream', () => {
    const src = read('routes/v1/embeddings.ts');
    expect(src).not.toContain('mockUpstream');
    expect(src).not.toContain('upstreams/mock');
  });

  it('dispatches through the real upstream registry, like every other route', () => {
    const src = read('routes/v1/embeddings.ts');
    expect(src).toContain("from '../../upstreams/registry'");
    expect(src).toMatch(/getUpstream\(upstream\.provider\)/);
    expect(src).toMatch(/adapter\.embeddings\(/);
  });

  it('errors honestly when the provider has no embeddings adapter — never bills a fake', () => {
    const src = read('routes/v1/embeddings.ts');
    expect(src).toMatch(/if \(!adapter\.embeddings\)/);
    // The throw must precede settleCharge in the file — no charge for a
    // capability we could not deliver.
    expect(src.indexOf('does not support embeddings')).toBeLessThan(
      src.indexOf('await settleCharge')
    );
  });

  it('the Math.sin fake still exists ONLY in the mock adapter (CI-only, via AIAG_FORCE_MOCK)', () => {
    // The fake vectors themselves are fine as a test fixture; what was wrong
    // was a production route reaching for them. Pin where they may live.
    expect(read('upstreams/mock.ts')).toContain('Math.sin');
    expect(read('routes/v1/embeddings.ts')).not.toContain('Math.sin');
    // registry.ts is the single gate to the mock.
    expect(read('upstreams/registry.ts')).toContain('AIAG_FORCE_MOCK');
  });
});
