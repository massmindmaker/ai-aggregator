import { describe, expect, it, vi } from 'vitest';
import { createTonInvoiceExpiryCron } from '../ton-invoice-expiry.js';

describe('TON invoice expiry cron (plan task 3.3)', () => {
  it('ticks immediately and then every five minutes, logging the expired count', async () => {
    vi.useFakeTimers();
    try {
      const expireStale = vi.fn(async () => 3);
      const logged: Array<{ count: number }> = [];
      const cron = createTonInvoiceExpiryCron({
        expireStale,
        log: (entry) => logged.push(entry),
        intervalMs: 300_000,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(expireStale).toHaveBeenCalledTimes(1);
      expect(expireStale).toHaveBeenCalledWith(100);
      expect(logged).toEqual([{ count: 3 }]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(expireStale).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(expireStale).toHaveBeenCalledTimes(3);
      await cron.close();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(expireStale).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ticking when a batch attempt fails, reporting the error without crashing', async () => {
    vi.useFakeTimers();
    try {
      const expireStale = vi.fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(1);
      const errors: unknown[] = [];
      const cron = createTonInvoiceExpiryCron({
        expireStale,
        onError: (error) => errors.push(error),
        intervalMs: 300_000,
      });
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(expireStale).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(1);
      await cron.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
