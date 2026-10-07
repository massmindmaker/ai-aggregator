import { describe, expect, it, vi } from 'vitest';
import { createTonAlerts } from '../ton-alerts.js';

describe('TON telegram alerts (plan task 6.1)', () => {
  it('escalates every review_required observation immediately as critical', async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ text: string; severity: string }> = [];
      const alerts = createTonAlerts({
        send: async (text, severity) => { sent.push({ text, severity }); },
      });
      alerts.onObservation({ kind: 'review_required', reason: 'underpayment', evidenceDigest: 'a'.repeat(64) });
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.severity).toBe('critical');
      expect(sent[0]!.text).toContain('underpayment');
      alerts.onObservation({ kind: 'review_required', reason: 'overpayment', evidenceDigest: 'b'.repeat(64) });
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(2);
      await alerts.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates settlement successes hourly and warns on a failed settle', async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ text: string; severity: string }> = [];
      const alerts = createTonAlerts({
        send: async (text, severity) => { sent.push({ text, severity }); },
        flushMs: 3_600_000,
      });
      for (let i = 0; i < 3; i += 1) {
        alerts.onSettlement({ kind: 'settled', receipt: {} } as never);
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.severity).toBe('info');
      expect(sent[0]!.text).toContain('3');
      alerts.onSettlement({ kind: 'not_found' } as never);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.severity).toBe('warning');
      await alerts.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns once when a source fails three times in a row and resets on success', async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ text: string; severity: string }> = [];
      const alerts = createTonAlerts({
        send: async (text, severity) => { sent.push({ text, severity }); },
      });
      const fail = { kind: 'stopped', reason: 'db_error', processed: 0, pagesAdvanced: 0 } as const;
      alerts.onSourceResult('source-1', fail);
      alerts.onSourceResult('source-1', fail);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(0);
      alerts.onSourceResult('source-1', fail);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.severity).toBe('warning');
      // No repeat while the streak continues.
      alerts.onSourceResult('source-1', fail);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      // A success resets the streak; a fresh 3-fail run alerts again.
      alerts.onSourceResult('source-1', { kind: 'completed', processed: 1, pagesAdvanced: 1 });
      alerts.onSourceResult('source-1', fail);
      alerts.onSourceResult('source-1', fail);
      alerts.onSourceResult('source-1', fail);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(2);
      await alerts.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns on FX degradation at most once per five minutes', async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ text: string; severity: string }> = [];
      const alerts = createTonAlerts({
        send: async (text, severity) => { sent.push({ text, severity }); },
      });
      alerts.onFxDegraded('stale');
      alerts.onFxDegraded('TON_FX_UNAVAILABLE');
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.severity).toBe('warning');
      await vi.advanceTimersByTimeAsync(240_000);
      alerts.onFxDegraded('stale');
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000 + 1);
      alerts.onFxDegraded('stale');
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(2);
      await alerts.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
