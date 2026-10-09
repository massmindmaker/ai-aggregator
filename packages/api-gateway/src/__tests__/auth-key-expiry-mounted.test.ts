import { beforeEach, describe, expect, it, vi } from 'vitest';

// Reproduces the round-1 review finding against the REAL server assembly:
// restricted.onError must keep KEY_EXPIRED a 401 on stored execution paths
// (POST/PUT/...) instead of falling through to the 503 request-state envelope
// with Retry-After, which would tell clients to retry a dead key.
// Mount pattern follows stored-chat-composition.test.ts (config mode getter +
// dependency mocks + the real `app` from ../server).
const spies = vi.hoisted(() => ({
  read: vi.fn(),
  claim: vi.fn(),
  prepare: vi.fn(),
  resolve: vi.fn(),
  attempt: vi.fn(),
  run: vi.fn(),
  byokAttempt: vi.fn(),
  byokRun: vi.fn(),
  admit: vi.fn(),
  reject: vi.fn(),
  outcome: vi.fn(),
  legacy: vi.fn(),
  query: vi.fn(),
  eval: vi.fn(),
  spending: vi.fn(),
  catalog: vi.fn(),
  order: [] as string[],
}));
vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config');
  return {
    config: {
      ...actual.config,
      get GATEWAY_HTTP_EXECUTION_MODE() {
        // Minimal stored assembly: POST /v1/chat/completions is mounted and
        // every other execution verb falls to the unsupported handler — both
        // go through restricted.onError.
        return 'stored_chat_only' as const;
      },
    },
  };
});
vi.mock('../lib/db', () => ({ sql: spies.query }));
vi.mock('../egress-executor', () => ({
  registerGatewayEgressExecutor: vi.fn(),
}));
vi.mock('../catalog/public-catalog', () => ({
  PublicCatalogError: class PublicCatalogError extends Error { constructor(readonly kind: string) { super(kind); } },
  readPublicCatalog: spies.catalog,
}));
vi.mock('../billing/http-storage', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-storage')>(
    '../billing/http-storage',
  )),
  claimGatewayHttpRequest: spies.claim,
  recordGatewayHttpOutcome: spies.outcome,
}));
vi.mock('../billing/http-terminal-recovery', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-terminal-recovery')>(
    '../billing/http-terminal-recovery',
  )),
  readGatewayHttpResultV2: spies.read,
  admitGatewayHttpCharge: spies.admit,
  rejectUnstartedGatewayHttpRequest: spies.reject,
}));
vi.mock('../billing/stored-chat-attempt', () => ({
  createStoredChatAttempt: spies.attempt,
}));
vi.mock('../billing/stored-chat-byok-attempt', () => ({
  createStoredChatByokAttempt: spies.byokAttempt,
}));
vi.mock('../billing/stored-chat-fresh-policy', async () => ({
  ...(await vi.importActual<
    typeof import('../billing/stored-chat-fresh-policy')
  >('../billing/stored-chat-fresh-policy')),
  prepareStoredChatFreshPolicy: spies.prepare,
}));
vi.mock('../routing/stored-chat-fresh-resolver', async () => ({
  ...(await vi.importActual<
    typeof import('../routing/stored-chat-fresh-resolver')
  >('../routing/stored-chat-fresh-resolver')),
  resolveStoredChatFreshModel: spies.resolve,
}));
vi.mock('../routes/v1/chat', async () => {
  const { Hono } = await import('hono');
  return {
    chat: new Hono().post('/completions', (c) => {
      spies.legacy();
      return c.json({ legacy: true });
    }),
  };
});

import { app } from '../server';
import {
  setApiKeyResolver,
  type AuthenticatedApiKey,
} from '../middleware/auth-plan04';
import { setRedisFactory } from '../lib/redis';

const uuid = '00000000-0000-4000-8000-000000000001';
const baseKey: AuthenticatedApiKey = {
  id: uuid,
  org_id: '00000000-0000-4000-8000-000000000002',
  policies: {},
  rpm_limit: 100,
  batch_rpm_limit: 1,
  daily_usd_cap: 1,
  model_whitelist: [],
  ru_residency_only: false,
};
const EXPIRED = '2020-01-01T00:00:00.000000Z';
const body = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
};

function request(method: 'POST' | 'PUT') {
  return app.request('/v1/chat/completions', {
    method,
    headers: {
      authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}`,
      'content-type': 'application/json',
      'idempotency-key': 'unit-request',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.order.length = 0;
  spies.eval.mockImplementation(async () => {
    spies.order.push('rpm');
    return [1, 0];
  });
  setRedisFactory(() => ({ eval: spies.eval, get: spies.spending }) as never);
  spies.query.mockResolvedValue([]);
  spies.read.mockImplementation(async () => {
    spies.order.push('read');
    return { contractVersion: 1, status: 'pending', billingRequestId: uuid };
  });
  spies.resolve.mockImplementation(async () => {
    spies.order.push('resolve');
    return { slug: body.model, type: 'chat', candidates: [] };
  });
  spies.prepare.mockImplementation(() => {
    spies.order.push('policy');
    return {
      model: { slug: body.model, type: 'chat', candidates: [] },
      policy: {},
      requestedMode: 'auto',
    };
  });
  spies.attempt.mockImplementation(() => {
    spies.order.push('attempt');
    return { status: 'ready', billingRequestId: uuid, run: spies.run };
  });
  spies.run.mockImplementation(async () => {
    spies.order.push('run');
    return {
      kind: 'settled_success',
      billingRequestId: uuid,
      actualCostCredits: 0n,
      response: {},
      admission: { state: 'settled', billingRequestId: uuid },
    };
  });
  spies.claim.mockImplementation(async () => {
    spies.order.push('claim');
    return { didClaim: true, billingRequestId: uuid };
  });
});

describe('stored assembly surfaces key expiry as 401 KEY_EXPIRED (server.ts onError whitelist)', () => {
  it.each([
    ['POST (stored execution path)', 'POST'],
    ['PUT (unsupported-method path)', 'PUT'],
  ])('rejects an expired key with 401 KEY_EXPIRED on %s', async (_label, method) => {
    setApiKeyResolver(async () => {
      spies.order.push('auth');
      return { ...baseKey, expires_at: EXPIRED };
    });

    const response = await request(method as 'POST' | 'PUT');
    const bodyJson = await response.json() as { error: { code: string; message: string } };

    // The masking bug produced 503 REQUEST_STATE_UNAVAILABLE + Retry-After: 2
    // here, inviting clients to retry a dead key.
    expect(response.status).toBe(401);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(bodyJson.error).toEqual({ code: 'KEY_EXPIRED', message: 'API key expired' });
    expect(spies.order).toEqual(['auth']);
  });

  it('keeps an unexpired key operational on the same POST path (401 is expiry-driven)', async () => {
    setApiKeyResolver(async () => {
      spies.order.push('auth');
      return { ...baseKey, expires_at: '2099-01-01T00:00:00.000000Z' };
    });

    const response = await request('POST');

    expect(response.status).toBe(202);
    expect(spies.order).toEqual(['auth', 'rpm', 'read']);
  });
});
