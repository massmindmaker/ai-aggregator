/**
 * Periodic TON invoice expiry sweep (plan AG-TON-L task 3.3).
 *
 * The reconciliation claim path already refuses expired invoices (0092
 * trigger), so nothing re-credits them; this cron only closes the garbage
 * `pending` tail in bounded batches so operators and users see honest state.
 * Failures never crash the worker: the next tick retries.
 */
export interface TonInvoiceExpiryCronDeps {
  /** Runs one bounded batch; returns how many invoices transitioned to expired. */
  expireStale(limit: number): Promise<number>;
  log?(entry: { count: number }): void;
  onError?(error: unknown): void;
  intervalMs?: number;
}

export interface TonInvoiceExpiryCron {
  close(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 300_000;
const BATCH_LIMIT = 100;

export function createTonInvoiceExpiryCron(deps: TonInvoiceExpiryCronDeps): TonInvoiceExpiryCron {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let active: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const tick = () => {
    if (closed || active) return;
    active = (async () => {
      try {
        const count = await deps.expireStale(BATCH_LIMIT);
        deps.log?.({ count });
      } catch (error) {
        deps.onError?.(error);
      } finally {
        active = undefined;
      }
    })();
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return {
    close() {
      closing ??= (async () => {
        closed = true;
        clearInterval(timer);
        await active;
      })();
      return closing;
    },
  };
}
