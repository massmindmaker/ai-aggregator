/**
 * Failover + circuit breaker tests (native egress integration, T3).
 * DB-less: breaker persistence is best-effort and degrades to memory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeWithFailover,
  orderCandidates,
  MAX_FAILOVER_ATTEMPTS,
} from '../routing/failover';
import {
  check,
  recordFailure,
  __resetBreakerForTests,
  __entryForTests,
  __setOpenedUntilForTests,
} from '../failover/breaker';
import { classify429FromError } from '../failover/classify';
import type { UpstreamCandidate } from '../routing/engine';

function cand(id: string): UpstreamCandidate {
  return {
    id,
    provider: 'openrouter',
    price_per_1k_input: 0.1,
    price_per_1k_output: 0.2,
    latency_p50_ms: 300,
    uptime: 99.9,
    ru_residency: false,
    upstream_id: id,
    upstream_model_id: `m/${id}`,
    markup: 1.8,
    priority: 100,
  };
}

function err429(message: string): Error {
  return Object.assign(new Error(message), { status: 429 });
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => __resetBreakerForTests());
afterEach(() => __resetBreakerForTests());

describe('executeWithFailover', () => {
  it('first candidate fails → second serves; winner returned for settle', async () => {
    const calls: string[] = [];
    const { resp, usedUpstream } = await executeWithFailover(
      orderCandidates([cand(A), cand(B)], cand(A)),
      async (u) => {
        calls.push(u.upstream_id);
        if (u.upstream_id === A) throw new Error('boom 500');
        return 'ok-from-B';
      }
    );
    expect(calls).toEqual([A, B]);
    expect(resp).toBe('ok-from-B');
    expect(usedUpstream.upstream_id).toBe(B);
  });

  it(`stops at MAX_FAILOVER_ATTEMPTS=${MAX_FAILOVER_ATTEMPTS} real attempts`, async () => {
    const many = [cand(A), cand(B), cand('3'), cand('4'), cand('5')];
    const calls: string[] = [];
    await expect(
      executeWithFailover(orderCandidates(many, cand(A)), async (u) => {
        calls.push(u.upstream_id);
        throw new Error('down');
      })
    ).rejects.toMatchObject({ status: 502 });
    expect(calls.length).toBe(MAX_FAILOVER_ATTEMPTS);
  });

  it('BYOK passthrough: single candidate, no breaker, raw error propagates', async () => {
    const raw = new Error('raw adapter error');
    await expect(
      executeWithFailover(
        [cand(A)],
        async () => {
          throw raw;
        },
        { useBreaker: false, wrapErrors: false }
      )
    ).rejects.toBe(raw);
    expect(__entryForTests(A)).toBeUndefined();
  });

  it('breaker skip costs no attempt budget', async () => {
    // Quota failure opens A immediately.
    await recordFailure(A, err429('monthly limit reached'));
    const calls: string[] = [];
    const { usedUpstream } = await executeWithFailover(
      [cand(A), cand(B)],
      async (u) => {
        calls.push(u.upstream_id);
        return u.upstream_id;
      }
    );
    expect(calls).toEqual([B]);
    expect(usedUpstream.upstream_id).toBe(B);
  });
});

describe('circuit breaker transitions', () => {
  it('closed → open on quota failure → half_open probe via failover → closed on success', async () => {
    await recordFailure(A, err429('quota exceeded for the month'));
    expect(__entryForTests(A)?.state).toBe('open');

    // Cooldown not elapsed → skip.
    expect(await check(A)).toBe('skip');

    // Forge elapsed cooldown → the NEXT execution owns the single probe.
    __setOpenedUntilForTests(A, Date.now() - 1);
    const { resp } = await executeWithFailover([cand(A)], async () => 'probe-ok');
    expect(resp).toBe('probe-ok');
    // Probe succeeded → closed again.
    expect(__entryForTests(A)?.state).toBe('closed');
  });

  it('transient failures accumulate to the threshold before opening', async () => {
    for (let i = 0; i < 4; i++) await recordFailure(A, new Error('ECONNRESET-ish'));
    expect(__entryForTests(A)?.state).toBe('closed');
    expect(await check(A)).toBe('allow');
    await recordFailure(A, new Error('again'));
    expect(__entryForTests(A)?.state).toBe('open');
  });

  it('re-open doubles the cooldown', async () => {
    await recordFailure(A, err429('daily limit'));
    const first = __entryForTests(A)!.openedUntilMs!;
    __setOpenedUntilForTests(A, Date.now() - 1);
    expect(await check(A)).toBe('half-open-probe');
    await recordFailure(A, err429('daily limit again')); // probe failed → re-open
    const second = __entryForTests(A)!.openedUntilMs!;
    expect(second).toBeGreaterThan(first);
  });
});

describe('classify429FromError', () => {
  it('quota-exhausted patterns open immediately', () => {
    expect(classify429FromError(err429('You hit your daily limit'))).toBe('quota_exhausted');
    expect(classify429FromError(err429('monthly quota exceeded'))).toBe('quota_exhausted');
  });

  it('plain 429 without quota keywords = rate_limit', () => {
    expect(classify429FromError(err429('Too many requests, slow down'))).toBe('rate_limit');
  });

  it('5xx classifies as transient; status-less errors are unclassified', () => {
    const e = Object.assign(new Error('upstream blew up'), { status: 502 });
    expect(classify429FromError(e)).toBe('transient');
    expect(classify429FromError(new Error('Internal Server Error'))).toBeUndefined();
  });
});
