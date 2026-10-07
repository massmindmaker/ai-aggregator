/**
 * Runtime TON checkout policy refresher (plan AG-TON-L task 3.4).
 *
 * Ticks the FX oracle, rebuilds the checkout policy through the pure builder,
 * and persists it to admin_settings for the web checkout (env stays the
 * local-dev fallback). The policy is anchored to the ORACLE observation
 * timestamp, never to the build moment: a stale-but-served rate is skipped,
 * not re-stamped fresh (plan Review Focus 3).
 */
export interface TonPolicyRefresherDeps {
  fetchRate(): Promise<number>;
  readObservation(): { usd: number; observedAtMs: number } | null;
  buildPolicy(input: { usdPerTon: number; observedAtMs: number }): string;
  writePolicy(policyJson: string): Promise<void>;
  onWrite?(entry: { ageMs: number }): void;
  onSkip?(reason: 'stale' | 'no_observation'): void;
  onError?(error: unknown): void;
  nowMs?(): number;
  maxFxAgeSeconds?: number;
  intervalMs?: number;
}

export interface TonPolicyRefresher {
  close(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_FX_AGE_SECONDS = 60;

export function createTonPolicyRefresher(deps: TonPolicyRefresherDeps): TonPolicyRefresher {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxFxAgeMs = (deps.maxFxAgeSeconds ?? DEFAULT_MAX_FX_AGE_SECONDS) * 1000;
  const nowMs = deps.nowMs ?? Date.now;
  let active: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const tick = () => {
    if (closed || active) return;
    active = (async () => {
      try {
        await deps.fetchRate();
        const observation = deps.readObservation();
        if (!observation) {
          deps.onSkip?.('no_observation');
          return;
        }
        const ageMs = nowMs() - observation.observedAtMs;
        if (ageMs < 0 || ageMs > maxFxAgeMs) {
          deps.onSkip?.('stale');
          return;
        }
        const policy = deps.buildPolicy({
          usdPerTon: observation.usd,
          observedAtMs: observation.observedAtMs,
        });
        await deps.writePolicy(policy);
        deps.onWrite?.({ ageMs });
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
