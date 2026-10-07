import { describe, expect, it, vi } from 'vitest';
import { createTonPolicyRefresher } from '../ton-policy-refresher.js';

const observation = (ageMs: number, usd = 5.5) => ({
  usd,
  observedAtMs: Date.now() - ageMs,
});

describe('TON checkout policy refresher (plan task 3.4)', () => {
  it('writes a policy anchored to the oracle observation timestamp when fresh', async () => {
    vi.useFakeTimers();
    try {
      const obs = observation(5_000, 6.25);
      const writes: Array<{ policy: string }> = [];
      const buildPolicy = vi.fn((input: { usdPerTon: number; observedAtMs: number }) => {
        expect(input.usdPerTon).toBe(6.25);
        expect(input.observedAtMs).toBe(obs.observedAtMs);
        return JSON.stringify({ fx: { observedAtMs: input.observedAtMs } });
      });
      const refresher = createTonPolicyRefresher({
        fetchRate: vi.fn(async () => obs.usd),
        readObservation: () => obs,
        buildPolicy,
        writePolicy: async (policy) => { writes.push({ policy }); },
        intervalMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(buildPolicy).toHaveBeenCalledTimes(1);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.policy).toContain(String(obs.observedAtMs));
      await refresher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never writes a policy anchored to a stale observation (Review Focus 3)', async () => {
    vi.useFakeTimers();
    try {
      const stale = observation(10 * 60_000, 5.0); // 10 minutes old
      const skipped: string[] = [];
      const refresher = createTonPolicyRefresher({
        fetchRate: vi.fn(async () => stale.usd), // stale-ok oracle serves it
        readObservation: () => stale,
        buildPolicy: () => { throw new Error('must not build from a stale rate'); },
        writePolicy: vi.fn(async () => { throw new Error('must not write'); }),
        onSkip: (reason) => skipped.push(reason),
        intervalMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(skipped).toEqual(['stale']);
      await refresher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports oracle failures and retries on the next tick', async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const obs = observation(1_000);
      const refresher = createTonPolicyRefresher({
        fetchRate: vi.fn()
          .mockRejectedValueOnce(new Error('TON_FX_UNAVAILABLE'))
          .mockResolvedValueOnce(obs.usd),
        readObservation: () => obs,
        buildPolicy: () => '{}',
        writePolicy: vi.fn(async () => {}),
        onError: (error) => errors.push(error),
        intervalMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(errors).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errors).toHaveLength(1);
      await refresher.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
