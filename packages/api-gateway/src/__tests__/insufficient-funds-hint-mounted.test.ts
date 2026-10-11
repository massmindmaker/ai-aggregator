/**
 * T10 fix round 1: the topup hint must reach a LIVE request — not just direct
 * unit calls. Mounted pattern follows auth-key-expiry-mounted.test.ts /
 * server.test.ts: the REAL `app` from ../server in legacy mode (the production
 * default assembly), real requireApiKey (DI resolver), real rate/key/pii/model
 * guards (redis + sql mocked), the REAL chat route — only the model resolver
 * is overridden so no upstream is ever reached. The preflight 402 fires before
 * any provider work, which is exactly the wiring under test: the route must
 * pass `key.policies` into assertPositiveBalance so an agent key's 402 body
 * carries the machine topup hint + Retry-After, while a human key's response
 * stays byte- and header-identical to the legacy envelope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  query: vi.fn(),
  eval: vi.fn(),
}));

vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config');
  return {
    config: {
      ...actual.config,
      get GATEWAY_HTTP_EXECUTION_MODE() {
        return 'legacy' as const;
      },
    },
  };
});
vi.mock('../lib/db', () => ({ sql: spies.query }));
vi.mock('../egress-executor', () => ({
  registerGatewayEgressExecutor: vi.fn(),
}));
vi.mock('../catalog/public-catalog', () => ({
  PublicCatalogError: class PublicCatalogError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  },
  readPublicCatalog: vi.fn(),
}));

import { app } from '../server';
import {
  setApiKeyResolver,
  type AuthenticatedApiKey,
} from '../middleware/auth-plan04';
import { setRedisFactory } from '../lib/redis';
import { setResolveModelOverride } from '../routing/resolver';

const baseKey: AuthenticatedApiKey = {
  id: '00000000-0000-4000-8000-000000000001',
  org_id: '00000000-0000-4000-8000-000000000002',
  policies: {},
  rpm_limit: 100,
  batch_rpm_limit: 1,
  daily_usd_cap: null,
  model_whitelist: [],
  ru_residency_only: false,
};

const EXPECTED_TOPUP = {
  default_asset: 'gram',
  endpoint: 'POST /v1/agent/topup',
  min_credits: 100,
  assets: ['gram', 'usdt'],
};

/**
 * Tagged-template sql stand-in dispatching on query text: the balance
 * preflight reads `FROM organizations`, everything else (model status, …)
 * returns no rows.
 */
function mockSql(balance: string): void {
  spies.query.mockImplementation(((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM organizations')) {
      return Promise.resolve([{ balance }]);
    }
    return Promise.resolve([]);
  }) as never);
}

function request(): Request {
  return new Request('http://x/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Rate limiter allows everything; no daily cap on the key.
  spies.eval.mockResolvedValue([1, 0]);
  setRedisFactory(() => ({ eval: spies.eval }) as never);
  // No model row in the DB → resolver override supplies a minimal live model
  // with one candidate, so routing reaches the preflight gate and stops there.
  setResolveModelOverride(async () => ({
    slug: 'openai/gpt-test',
    type: 'chat' as const,
    candidates: [
      {
        id: 'u1',
        provider: 'openai',
        price_per_1k_input: 1,
        price_per_1k_output: 2,
        latency_p50_ms: 100,
        uptime: 0.99,
        ru_residency: false,
        upstream_id: 'openai',
        upstream_model_id: 'gpt-test',
        markup: 0.2,
      },
    ],
  }) as never);
});

afterEach(() => {
  setApiKeyResolver(null);
  setResolveModelOverride(null);
});

describe('live legacy path: POST /v1/chat/completions preflight 402 (real app assembly)', () => {
  it('agent key + zero balance → 402 with topup hint and Retry-After: 30', async () => {
    setApiKeyResolver(async () => ({
      ...baseKey,
      policies: { kind: 'agent', s2s_key_minting: true },
    }));
    mockSql('0');

    const res = await app.fetch(request());
    const body = (await res.json()) as { error: Record<string, unknown> };

    expect(res.status).toBe(402);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(body.error).toEqual({
      code: 'PAYMENT_REQUIRED',
      message: 'Insufficient funds',
      topup: EXPECTED_TOPUP,
    });
  });

  it('human key + zero balance → 402 with the legacy body, no topup, no Retry-After', async () => {
    setApiKeyResolver(async () => ({ ...baseKey, policies: {} }));
    mockSql('0');

    const res = await app.fetch(request());
    const body = (await res.json()) as { error: Record<string, unknown> };

    expect(res.status).toBe(402);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect('topup' in body.error).toBe(false);
    expect(body.error).toEqual({
      code: 'PAYMENT_REQUIRED',
      message: 'Insufficient funds',
    });
  });

  it('the balance read went through the real preflight gate (query shape)', async () => {
    setApiKeyResolver(async () => ({
      ...baseKey,
      policies: { kind: 'agent' },
    }));
    mockSql('0');

    await app.fetch(request());

    const balanceCall = spies.query.mock.calls.find((call) =>
      String(call[0]).includes('FROM organizations'),
    ) as unknown as [TemplateStringsArray] | undefined;
    expect(balanceCall).toBeDefined();
  });
});
