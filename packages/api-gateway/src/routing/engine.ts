/**
 * Plan 04 routing engine — 5 modes (spec §16):
 *   auto | fastest | cheapest | balanced | ru-only
 *
 * Balanced formula:
 *   0.5 × norm(price⁻¹) + 0.3 × norm(latency⁻¹) + 0.2 × norm(uptime)
 *
 * Policy merge:
 *   forbid_non_ru → forces ru-only
 *   allowed_providers / blocked_providers filter upfront
 */
import { errors } from '../lib/errors';

export type Upstream = {
  id: string;
  provider: string;
  price_per_1k_input: number;
  price_per_1k_output: number;
  price_per_image?: number;
  latency_p50_ms: number;
  uptime: number;
  ru_residency: boolean;
};

// FIX H7: type used throughout gateway — enriches Upstream with resolver data.
export type UpstreamCandidate = Upstream & {
  upstream_id: string;
  upstream_model_id: string;
  markup: number;
};

export type Mode = 'auto' | 'fastest' | 'cheapest' | 'balanced' | 'ru-only';
export type CostMetric = 'chat' | 'embedding' | 'image';

export type ApiKeyPolicies = {
  default_mode?: Mode;
  allowed_providers?: string[];
  blocked_providers?: string[];
  forbid_non_ru?: boolean;
  allow_pii_transborder?: boolean;
  per_session_budget_cap_rub?: number;
  forbid_streaming_prompts?: boolean;
};

// FIX H4.1: explicit metric-aware cost
export function effCost(u: Upstream, metric: CostMetric = 'chat'): number {
  if (metric === 'image') return u.price_per_image ?? 0.01;
  if (metric === 'embedding') return u.price_per_1k_input;
  // chat: input-heavy weighted average (70/30)
  return u.price_per_1k_input * 0.7 + u.price_per_1k_output * 0.3;
}

// FIX H4.2: guard against max === min (flat inputs).
export function norm(arr: number[]): number[] {
  if (arr.length === 0) return [];
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (max === min) return arr.map(() => 1);
  return arr.map((v) => (v - min) / (max - min));
}

function filterByPolicy<T extends Upstream>(
  pool: T[],
  policy: ApiKeyPolicies
): T[] {
  let out = pool;
  if (policy.allowed_providers?.length) {
    out = out.filter((u) => policy.allowed_providers!.includes(u.provider));
  }
  if (policy.blocked_providers?.length) {
    out = out.filter((u) => !policy.blocked_providers!.includes(u.provider));
  }
  return out;
}

function pickBalanced<T extends Upstream>(pool: T[], metric: CostMetric): T {
  const nPrice = norm(pool.map((u) => 1 / Math.max(effCost(u, metric), 1e-9)));
  const nLat = norm(pool.map((u) => 1 / Math.max(u.latency_p50_ms, 1)));
  const nUp = norm(pool.map((u) => u.uptime));
  let best = pool[0]!;
  let bestScore = -Infinity;
  pool.forEach((u, i) => {
    const s = 0.5 * (nPrice[i] ?? 0) + 0.3 * (nLat[i] ?? 0) + 0.2 * (nUp[i] ?? 0);
    if (s > bestScore) {
      bestScore = s;
      best = u;
    }
  });
  return best;
}

export function pickUpstream<T extends Upstream>(
  candidates: T[],
  requestedMode: Mode,
  policy: ApiKeyPolicies,
  metric: CostMetric = 'chat'
): T {
  let mode: Mode = requestedMode;
  if (policy.forbid_non_ru) mode = 'ru-only';

  let pool = filterByPolicy(candidates, policy);
  if (mode === 'ru-only') pool = pool.filter((u) => u.ru_residency);
  if (pool.length === 0) {
    throw errors.badRequest('No upstream matches policy/mode');
  }

  if (mode === 'auto') {
    return pool.length === 1 ? pool[0]! : pickBalanced(pool, metric);
  }
  if (mode === 'fastest') {
    return pool.reduce((a, b) => (a.latency_p50_ms <= b.latency_p50_ms ? a : b));
  }
  if (mode === 'cheapest') {
    return pool.reduce((a, b) => (effCost(a, metric) <= effCost(b, metric) ? a : b));
  }
  // 'balanced' or 'ru-only' after filter
  return pickBalanced(pool, metric);
}
