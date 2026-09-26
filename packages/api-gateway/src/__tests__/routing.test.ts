import { describe, it, expect } from 'vitest';
import {
  pickUpstream,
  effCost,
  norm,
  type UpstreamCandidate,
  type ApiKeyPolicies,
} from '../routing/engine';

function mk(
  id: string,
  provider: string,
  price_in: number,
  price_out: number,
  lat: number,
  up: number,
  ru: boolean
): UpstreamCandidate {
  return {
    id,
    provider,
    price_per_1k_input: price_in,
    price_per_1k_output: price_out,
    latency_p50_ms: lat,
    uptime: up,
    ru_residency: ru,
    upstream_id: id,
    upstream_model_id: `${id}/model`,
    markup: 1.25,
  };
}

const yandex = mk('yandex', 'yandex', 0.0008, 0.0024, 200, 0.99, true);
const openai = mk('openai-via-or', 'openrouter', 0.03, 0.06, 300, 0.98, false);
const together = mk('together', 'together', 0.0015, 0.003, 400, 0.97, false);
const pool = [yandex, openai, together];

describe('norm helper', () => {
  it('handles flat inputs (max===min) without NaN', () => {
    expect(norm([1, 1, 1])).toEqual([1, 1, 1]);
  });
  it('normalizes to 0..1', () => {
    const r = norm([10, 20, 30]);
    expect(r[0]).toBe(0);
    expect(r[2]).toBe(1);
    expect(r[1]).toBeCloseTo(0.5, 6);
  });
});

describe('effCost', () => {
  it('chat metric: 70/30 input/output weighted average', () => {
    expect(effCost(yandex, 'chat')).toBeCloseTo(
      0.0008 * 0.7 + 0.0024 * 0.3,
      8
    );
  });
  it('embedding metric: input-only', () => {
    expect(effCost(yandex, 'embedding')).toBe(0.0008);
  });
  it('media metrics use the v1 per-job price authority', () => {
    const media = { ...yandex, price_per_image: 7 };
    expect(effCost(media, 'image')).toBe(7);
    expect(effCost(media, 'video')).toBe(7);
    expect(effCost(media, 'audio')).toBe(7);
  });
});

describe('pickUpstream — 5 modes', () => {
  const policies: ApiKeyPolicies = {};

  it('fastest: picks lowest-latency (yandex 200ms)', () => {
    expect(pickUpstream(pool, 'fastest', policies).id).toBe('yandex');
  });

  it('cheapest: picks lowest effective cost (yandex)', () => {
    expect(pickUpstream(pool, 'cheapest', policies).id).toBe('yandex');
  });

  it('ru-only: filters to RU-hosted upstreams only', () => {
    expect(pickUpstream(pool, 'ru-only', policies).id).toBe('yandex');
  });

  it('balanced: formula is deterministic on fixed inputs', () => {
    const small = [
      mk('a', 'x', 1, 1, 100, 0.99, false),
      mk('b', 'x', 2, 2, 50, 0.99, false),
    ];
    // price weight (0.5) dominates over latency (0.3): cheaper wins
    expect(pickUpstream(small, 'balanced', {}).id).toBe('a');
  });

  it('auto: single candidate returns that upstream', () => {
    const one = [yandex];
    expect(pickUpstream(one, 'auto', policies).id).toBe('yandex');
  });

  it('forbid_non_ru policy overrides client mode=fastest', () => {
    expect(
      pickUpstream(pool, 'fastest', { forbid_non_ru: true }).id
    ).toBe('yandex');
  });

  it('allowed_providers intersect', () => {
    const picked = pickUpstream(pool, 'auto', {
      allowed_providers: ['together'],
    });
    expect(picked.id).toBe('together');
  });

  it('blocked_providers filter', () => {
    const picked = pickUpstream(pool, 'cheapest', {
      blocked_providers: ['yandex'],
    });
    expect(picked.id).not.toBe('yandex');
  });

  it('no matching upstream → throws BAD_REQUEST', () => {
    expect(() =>
      pickUpstream(pool, 'ru-only', { blocked_providers: ['yandex'] })
    ).toThrow(/No upstream matches/);
  });
});
