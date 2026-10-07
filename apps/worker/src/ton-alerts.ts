/**
 * TON operator alerts over the telegram-alerts package (plan AG-TON-L task 6.1).
 *
 * Escalations: review_required observations fire immediately (critical);
 * settlement successes aggregate once per hour (info); a source that fails
 * three sweeps in a row warns once per streak; FX degradation (oracle down or
 * a stale rate refusing to be re-stamped) warns at most once per five minutes.
 * Without TELEGRAM_ALERT_* env the sink itself is a graceful no-op.
 */
import { sendAlert } from '@aiag/telegram-alerts';

export interface TonAlertsDeps {
  send?(text: string, severity: 'critical' | 'warning' | 'info' | 'resolved'): Promise<void>;
  flushMs?: number;
}

type Severity = 'critical' | 'warning' | 'info' | 'resolved';

export interface TonObservationAlertResult {
  kind: 'verified_candidate' | 'observed' | 'unmatched' | 'review_required' | 'source_error';
  reason?: string;
}

export interface TonAlerts {
  onObservation(result: TonObservationAlertResult): void;
  onSettlement(result: { kind: string }): void;
  onSourceResult(sourceId: string, result: { kind: string; reason?: string }): void;
  onFxDegraded(reason: string): void;
  close(): Promise<void>;
}

const DEFAULT_FLUSH_MS = 3_600_000;
const FX_DEDUPE_MS = 300_000;
const SOURCE_FAIL_STREAK = 3;

export function createTonAlerts(deps: TonAlertsDeps = {}): TonAlerts {
  const send = deps.send ?? (async (text: string, severity: Severity) => {
    await sendAlert(text, severity);
  });
  const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;

  let settledCount = 0;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const sourceStreaks = new Map<string, number>();
  const alertedSources = new Set<string>();
  let lastFxAlertAt = 0;
  let lastClock = 0;
  const clock = () => {
    // Monotonic-ish tick counter driven by test timers via Date.now().
    return Date.now();
  };
  void lastClock;

  const emit = (text: string, severity: Severity) => {
    if (closed) return;
    void send(text, severity).catch(() => {
      /* alert failures must never break the worker loop */
    });
  };

  const flushSettlements = () => {
    if (settledCount > 0) {
      emit(`TON settlement: ${settledCount} invoice(s) settled in the last hour.`, 'info');
      settledCount = 0;
    }
  };
  flushTimer = setInterval(flushSettlements, flushMs);
  flushTimer.unref?.();

  return {
    onObservation(result) {
      if (result.kind === 'review_required') {
        emit(
          `TON review_required: ${result.reason ?? 'unknown'} — открой /admin/ton (runbook: docs/ops/ton-review-runbook.md).`,
          'critical',
        );
      }
    },
    onSettlement(result) {
      if (result.kind === 'settled') {
        settledCount += 1;
        return;
      }
      if (result.kind === 'already_settled') return;
      emit(`TON settlement abnormal outcome: ${result.kind}.`, 'warning');
    },
    onSourceResult(sourceId, result) {
      if (result.kind === 'completed') {
        sourceStreaks.set(sourceId, 0);
        alertedSources.delete(sourceId);
        return;
      }
      const streak = (sourceStreaks.get(sourceId) ?? 0) + 1;
      sourceStreaks.set(sourceId, streak);
      if (streak >= SOURCE_FAIL_STREAK && !alertedSources.has(sourceId)) {
        alertedSources.add(sourceId);
        emit(
          `TON source ${sourceId} failed ${streak} sweeps in a row (last: ${result.kind}${result.reason ? `/${result.reason}` : ''}).`,
          'warning',
        );
      }
    },
    onFxDegraded(reason) {
      const now = clock();
      if (now - lastFxAlertAt < FX_DEDUPE_MS) return;
      lastFxAlertAt = now;
      emit(`TON FX degraded: ${reason} — checkout отклоняет новые счета (TON_CHECKOUT_FX_STALE).`, 'warning');
    },
    close() {
      return (async () => {
        closed = true;
        if (flushTimer) clearInterval(flushTimer);
        flushSettlements();
      })();
    },
  };
}
