/**
 * POST /mcp — MCP facade for headless agents (Task 11, plan 2026-10-09).
 *
 * The properties this file exists to pin:
 *  1. AUTH: mounted behind requireApiKey — no key, no MCP (401); an expired
 *     key is the 401 KEY_EXPIRED envelope BEFORE any JSON-RPC code runs.
 *  2. initialize handshake: JSON-RPC result with serverInfo.name
 *     'aiag-gateway' and a supported protocolVersion.
 *  3. tools/list: ALL NINE aiag_* tools are advertised.
 *  4. tools/call aiag_get_balance: the /v1/balance payload crosses the MCP
 *     boundary as structuredContent (mocked organizations row).
 *  5. tools/call aiag_create_topup_invoice: the invoice card (invoiceId,
 *     transferHint, ISO timestamps) — the real POST /v1/agent/topup logic,
 *     reached in-process (service mock + policy row fakes).
 *  6. tools/call aiag_chat_completion: the non-streaming /v1/chat/completions
 *     proxy — upstream adapter mock, charge settles through the same seam.
 *  7. Service errors keep the gateway envelope 1:1 inside the MCP error
 *     channel (isError + structuredContent.error.code), and protocol errors
 *     (unknown method) are JSON-RPC errors (-32601).
 *  8. resources/list advertises aiag://catalog; GET /mcp is 405.
 *
 * Mount assembly mirrors server.ts exactly: requireApiKey + rateLimit ahead
 * of the facade, everything else mocked at module seams.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import IORedisMock from 'ioredis-mock';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const ORG = '41000000-0000-4000-8000-0000000000a1';
const KEY_ID = '55555555-5555-4555-8555-5555555555aa';
const INVOICE = '66000000-0000-4000-8000-0000000000a3';
const OTHER_KEY_ID = '77777777-7777-4777-8777-7777777777bb';

// ── Task 5/7/8 service mocks (the unit under test is the FACADE) ─────────────
const service = vi.hoisted(() => ({
  createTopup: vi.fn(),
  readTopup: vi.fn(),
  revokePrincipal: vi.fn(),
  readPolicy: vi.fn(),
  updatePolicy: vi.fn(),
}));
vi.mock('@aiag/database', () => {
  class AgentTopupError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AgentTopupError';
    }
  }
  class AgentAuthError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AgentAuthError';
    }
  }
  class AgentPolicyError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AgentPolicyError';
    }
  }
  return {
    AgentTopupError,
    AgentAuthError,
    AgentPolicyError,
    createAgentTopupInvoice: service.createTopup,
    readAgentTopupInvoice: service.readTopup,
    revokeAgentPrincipal: service.revokePrincipal,
    readAgentPolicy: service.readPolicy,
    updateAgentPolicy: service.updatePolicy,
  };
});

// ── pg fake (balance / models / keys SQL + topup policy SELECT) ──────────────
// postgres.js semantics: sql`` builds a LAZY pending query — it executes only
// when awaited. Fragments embedded into other templates (authorVersionListed)
// are values, never standalone queries, so they must NOT consume a scripted
// result. Hence each template call returns a thenable that shifts the queue
// only on await.
const db = vi.hoisted(() => {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const results: unknown[] = [];

  const exec = (text: string, values: unknown[]) => {
    statements.push({ text, values });
    const next = results.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  const makePending = (text: string, values: unknown[]) => ({
    then: <T>(
      onFulfilled?: (value: unknown) => T | PromiseLike<T>,
      onRejected?: (reason: unknown) => T | PromiseLike<T>,
    ) => exec(text, values).then(onFulfilled, onRejected),
    catch: (onRejected?: (reason: unknown) => unknown) => exec(text, values).catch(onRejected),
    finally: (onFinally?: () => void) => exec(text, values).finally(onFinally),
  });

  const tagCall = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    makePending(strings.join('?'), values),
  );
  const unsafe = vi.fn((text: string, values: readonly unknown[] = []) => makePending(text, [...values]));
  // begin is variadic on purpose: the agent rails call begin(work) while
  // public-catalog calls begin('isolation level ...', work).
  const begin = vi.fn((...args: unknown[]) => {
    const work = args[args.length - 1] as (client: unknown) => unknown;
    return Promise.resolve(work(sqlObject));
  });
  const sqlObject = Object.assign(tagCall, {
    json: (value: unknown) => JSON.stringify(value),
    array: (value: unknown) => value,
    begin,
    unsafe,
  });
  return { statements, results, sql: sqlObject };
});
vi.mock('../lib/db', () => ({ sql: db.sql }));

// ── chat-execution mocks (same seams as chat-execution-contract.test.ts) ─────
const spies = vi.hoisted(() => ({
  resolveModelWithOverride: vi.fn(),
  getUpstream: vi.fn(),
  assertPositiveBalance: vi.fn(),
  settleCharge: vi.fn(),
  incrementSpendCounters: vi.fn(),
  logRequest: vi.fn(),
}));
vi.mock('../routing/resolver', () => ({
  resolveModelWithOverride: spies.resolveModelWithOverride,
}));
vi.mock('../upstreams/registry', () => ({ getUpstream: spies.getUpstream }));
vi.mock('../billing/settle', async () => ({
  ...(await vi.importActual<typeof import('../billing/settle')>('../billing/settle')),
  assertPositiveBalance: spies.assertPositiveBalance,
  settleCharge: spies.settleCharge,
}));
vi.mock('../billing/spend-counters', () => ({ incrementSpendCounters: spies.incrementSpendCounters }));
vi.mock('../logging/stream', () => ({ logRequest: spies.logRequest }));

import { applyAiagErrorHandler } from '../lib/errors';
import { setRedisFactory } from '../lib/redis';
import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';
import { rateLimit } from '../middleware/rate-limit-plan04';
import { mcpFacade } from '../mcp/server';
import { AIAG_TOOL_NAMES } from '../mcp/tools';

const KEY = 'sk_aiag_live_aaaaaaaaaaaaaaaaaaaa';

const CANDIDATE = {
  id: '11111111-1111-1111-1111-111111111111',
  provider: 'mock',
  upstream_id: 'up-1',
  upstream_model_id: 'mock/small',
  price_per_1k_input: 0.1,
  price_per_1k_output: 0.2,
  latency_p50_ms: 300,
  uptime: 99.9,
  ru_residency: true,
  markup: 1.5,
  priority: 100,
};

function setupRedis(): void {
  const instance = new (IORedisMock as any)();
  // ioredis-mock shares one module-level keyspace across instances — flush.
  void instance.flushall();
  setRedisFactory(() => instance as any);
}

function mount(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app);
  // Same assembly the real server uses (server.ts): auth + RPM ahead of the facade.
  app.use('/mcp', requireApiKey);
  app.use('/mcp', rateLimit);
  app.route('/mcp', mcpFacade);
  return app;
}

type JsonRpc = { jsonrpc: string; id: number | string | null; result?: unknown; error?: { code: number; message: string } };

const rpc = (method: string, params: unknown, id: number | string, key = KEY) =>
  mount().request('http://gw.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

const json = async (res: Response): Promise<JsonRpc> => (await res.json()) as JsonRpc;

beforeEach(() => {
  db.statements.length = 0;
  db.results.length = 0;
  db.sql.mockClear();
  service.createTopup.mockReset();
  service.readTopup.mockReset();
  service.revokePrincipal.mockReset();
  service.readPolicy.mockReset();
  service.updatePolicy.mockReset();
  Object.values(spies).forEach((spy) => spy.mockReset());
  setupRedis();
  setApiKeyResolver(async () => ({
    id: KEY_ID,
    org_id: ORG,
    policies: {},
    rpm_limit: 60,
    batch_rpm_limit: 10,
    daily_usd_cap: null,
  }));
});

describe('auth boundary (mounted ahead of any JSON-RPC code)', () => {
  it('401 without an Authorization header', async () => {
    const res = await mount().request('http://gw.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('401 UNAUTHORIZED with an unknown key', async () => {
    setApiKeyResolver(async () => null);
    const res = await rpc('initialize', {}, 1, 'sk_aiag_live_cccccccccccccccccccc');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 KEY_EXPIRED for an expired key (the 0105 path applies to /mcp too)', async () => {
    setApiKeyResolver(async () => ({
      id: KEY_ID,
      org_id: ORG,
      policies: {},
      rpm_limit: 60,
      batch_rpm_limit: 10,
      daily_usd_cap: null,
      expires_at: '2000-01-01T00:00:00.000Z',
    }));
    const res = await rpc('tools/list', {}, 1);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('KEY_EXPIRED');
  });
});

describe('initialize handshake', () => {
  it('returns serverInfo aiag-gateway and a supported protocolVersion', async () => {
    const res = await rpc(
      'initialize',
      {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agent-test', version: '0.0.1' },
      },
      7,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await json(res);
    expect(body.error).toBeUndefined();
    const result = body.result as { serverInfo: { name: string }; protocolVersion: string };
    expect(result.serverInfo.name).toBe('aiag-gateway');
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe('tools/list', () => {
  it('advertises exactly the nine aiag_* tools', async () => {
    const res = await rpc('tools/list', {}, 8);
    const body = await json(res);
    const result = body.result as { tools: Array<{ name: string; description: string }> };
    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...AIAG_TOOL_NAMES].sort());
    // Discovery contract: every tool carries a description.
    for (const tool of result.tools) expect(tool.description.length).toBeGreaterThan(10);
  });

  it('lists the aiag://catalog resource', async () => {
    const res = await rpc('resources/list', {}, 9);
    const body = await json(res);
    const result = body.result as { resources: Array<{ uri: string }> };
    expect(result.resources.map((r) => r.uri)).toContain('aiag://catalog');
  });
});

describe('tools/call', () => {
  it('aiag_get_balance returns the /v1/balance payload as structuredContent', async () => {
    db.results.push([
      { subscription_credits: '100000', payg_credits: '50000', subscription_credits_expires_at: null },
    ]);
    const res = await rpc('tools/call', { name: 'aiag_get_balance', arguments: {} }, 10);
    const body = await json(res);
    expect(body.error).toBeUndefined();
    const result = body.result as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.total_credits).toBe(150);
    expect(result.structuredContent.subscription_credits).toBe(100);
    expect(result.structuredContent.payg_credits).toBe(50);
  });

  it('aiag_list_models proxies the /v1/models projection', async () => {
    db.results.push([
      {
        slug: 'mock/small',
        type: 'chat',
        created: 1700000000,
        author_version_id: null,
        price_microcredits: null,
        policy_digest: null,
      },
    ]);
    const res = await rpc('tools/call', { name: 'aiag_list_models', arguments: {} }, 11);
    const body = await json(res);
    const result = body.result as { structuredContent: { object: string; data: Array<{ id: string; object: string }> } };
    expect(result.structuredContent.object).toBe('list');
    expect(result.structuredContent.data[0]!.id).toBe('mock/small');
    expect(result.structuredContent.data[0]!.object).toBe('model');
  });

  it('aiag_create_topup_invoice returns the invoice card through the real topup route', async () => {
    db.results.push([policyRow()]);
    service.createTopup.mockResolvedValue(gramInvoice());

    const res = await rpc(
      'tools/call',
      {
        name: 'aiag_create_topup_invoice',
        arguments: { asset: 'gram', credits: '100', idempotencyKey: 'mcp-topup-1' },
      },
      12,
    );
    const body = await json(res);
    expect(body.error).toBeUndefined();
    const result = body.result as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.invoiceId).toBe(INVOICE);
    expect(result.structuredContent.grantMicrocredits).toBe('100000');
    expect(result.structuredContent.transferHint).toEqual({ mode: 'native-comment' });
    // The route logic itself ran (policy read + service called with the
    // authenticated key id / org id) — the facade is pure delegation.
    expect(service.createTopup).toHaveBeenCalledTimes(1);
    const [, input] = service.createTopup.mock.calls[0]!;
    expect(input).toEqual({ keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'mcp-topup-1' });
  });

  it('aiag_get_invoice_status proxies GET /v1/agent/invoices/:id', async () => {
    service.readTopup.mockResolvedValue({
      invoiceId: INVOICE,
      status: 'settled',
      grantMicrocredits: '100000',
      settledAt: '2026-10-09T11:59:59.000Z',
    });
    const res = await rpc('tools/call', { name: 'aiag_get_invoice_status', arguments: { invoiceId: INVOICE } }, 13);
    const body = await json(res);
    const result = body.result as { structuredContent: Record<string, unknown> };
    expect(result.structuredContent.status).toBe('settled');
    expect(service.readTopup).toHaveBeenCalledWith(expect.anything(), { keyId: KEY_ID, invoiceId: INVOICE });
  });

  it('aiag_chat_completion proxies a non-streaming /v1/chat/completions round trip', async () => {
    spies.resolveModelWithOverride.mockResolvedValue({
      slug: 'mock/small',
      type: 'chat',
      candidates: [CANDIDATE],
    });
    spies.assertPositiveBalance.mockResolvedValue(undefined);
    spies.settleCharge.mockResolvedValue(undefined);
    spies.incrementSpendCounters.mockResolvedValue(undefined);
    spies.logRequest.mockResolvedValue(undefined);
    spies.getUpstream.mockReturnValue({
      chat: vi.fn(async () => ({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'mock/small',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi from upstream' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
    });

    const res = await rpc(
      'tools/call',
      {
        name: 'aiag_chat_completion',
        arguments: {
          model: 'mock/small',
          messages: [{ role: 'user', content: 'say hi' }],
          max_tokens: 32,
        },
      },
      14,
    );
    const body = await json(res);
    expect(body.error).toBeUndefined();
    const result = body.result as { isError?: boolean; structuredContent: Record<string, any> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.choices[0].message.content).toBe('hi from upstream');
    expect(result.structuredContent.usage.total_tokens).toBe(15);
    // The proxy really ran the billing pipeline of the legacy chat route.
    expect(spies.settleCharge).toHaveBeenCalledTimes(1);
    expect(spies.getUpstream).toHaveBeenCalledWith(CANDIDATE.provider);
  });

  it('aiag_list_keys returns the org key inventory without secrets', async () => {
    db.results.push(
      // Review wave (T-a1): the agent key lifecycle now opens with the
      // active-agent-principal gate (agent-keys.ts), so the scripted DB
      // serves its row first, then the inventory.
      [{ ok: true }],
      [
        {
          id: OTHER_KEY_ID,
          name: 'agent-bootstrap',
          key_prefix: 'sk_aiag_live_abc',
          expires_at: null,
          created_at: '2026-10-09T00:00:00.000000Z',
          last_used_at: null,
          revoked_at: null,
        },
      ],
    );
    const res = await rpc('tools/call', { name: 'aiag_list_keys', arguments: {} }, 15);
    const body = await json(res);
    const result = body.result as { structuredContent: { object: string; data: Array<Record<string, unknown>> } };
    expect(result.structuredContent.object).toBe('list');
    expect(result.structuredContent.data[0]!.id).toBe(OTHER_KEY_ID);
    // No plaintext, no hash ever leaves the key table through this path.
    const select = db.statements.find((s) => /FROM gateway_api_keys/.test(s.text))!;
    expect(select.text).not.toContain('key_hash');
  });

  it('aiag_set_routing_policy PUTs the patch through the Task 8 route', async () => {
    service.updatePolicy.mockResolvedValue({
      policies: { default_mode: 'cheapest' },
      modelWhitelist: [],
      quotas: { sessionMicrocredits: null, monthlyCredits: null, dailyOrgUsdMicro: null },
    });
    const res = await rpc(
      'tools/call',
      {
        name: 'aiag_set_routing_policy',
        arguments: { default_mode: 'cheapest', forbid_non_ru: false },
      },
      16,
    );
    const body = await json(res);
    const result = body.result as { structuredContent: Record<string, unknown> };
    expect(result.structuredContent.policies).toEqual({ default_mode: 'cheapest' });
    expect(service.updatePolicy).toHaveBeenCalledTimes(1);
  });
});

describe('error channel', () => {
  it('a gateway service error keeps its envelope 1:1 (isError + structuredContent.error)', async () => {
    // No organizations row → the balance route throws NOT_FOUND 404.
    db.results.push([]);
    const res = await rpc('tools/call', { name: 'aiag_get_balance', arguments: {} }, 20);
    const body = await json(res);
    const result = body.result as { isError: boolean; structuredContent: { error: { code: string; message: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('NOT_FOUND');
    expect(typeof result.structuredContent.error.message).toBe('string');
  });

  it('a bad invoice id is refused by the route schema (400 envelope through MCP)', async () => {
    const res = await rpc('tools/call', { name: 'aiag_get_invoice_status', arguments: { invoiceId: 'not-a-uuid' } }, 21);
    const body = await json(res);
    // UUID shape is enforced at the tool schema already → SDK InvalidParams.
    expect(body.error ?? (body.result as { isError?: boolean }).isError).toBeTruthy();
  });

  it('an unknown method is a JSON-RPC protocol error (-32601)', async () => {
    const res = await rpc('wat/method', {}, 22);
    const body = await json(res);
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32601);
  });

  it('malformed JSON-RPC is a protocol error, not a 500', async () => {
    const res = await mount().request('http://gw.example/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${KEY}`,
      },
      body: 'this is not json-rpc',
    });
    const body = (await res.json()) as JsonRpc;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32700);
  });
});

// ── Guard parity (review wave, T-a2): the legacy /v1/* chain inside the app ──
// server.ts mounts keyLimits → piiFilter → modelStatusMiddleware on /v1/* in
// the legacy assembly; the facade's sub-app must run the same three guards on
// its in-process dispatch, or an MCP caller would bypass the key's
// model_whitelist / monthly cap, PII transborder policy and model freeze
// state while an HTTP caller is rejected.
describe('guard parity: /v1/* execution guards apply to MCP tool calls', () => {
  it('model_whitelist: a key restricted to another model → 403 FORBIDDEN as isError, no upstream work', async () => {
    setApiKeyResolver(async () => ({
      id: KEY_ID,
      org_id: ORG,
      policies: {},
      rpm_limit: 60,
      batch_rpm_limit: 10,
      daily_usd_cap: null,
      model_whitelist: ['mock/other'],
    }));

    const res = await rpc(
      'tools/call',
      {
        name: 'aiag_chat_completion',
        arguments: {
          model: 'mock/small',
          messages: [{ role: 'user', content: 'say hi' }],
          max_tokens: 8,
        },
      },
      30,
    );
    const body = await json(res);
    expect(body.error).toBeUndefined();
    const result = body.result as {
      isError: boolean;
      structuredContent: { error: { code: string; message: string } };
    };
    expect(result.isError).toBe(true);
    // The gateway 403 envelope crosses the MCP boundary 1:1.
    expect(result.structuredContent.error.code).toBe('FORBIDDEN');
    expect(typeof result.structuredContent.error.message).toBe('string');
    // The guard fired BEFORE any routing/billing/upstream work.
    expect(spies.resolveModelWithOverride).not.toHaveBeenCalled();
    expect(spies.getUpstream).not.toHaveBeenCalled();
    expect(spies.settleCharge).not.toHaveBeenCalled();
  });

  it('frozen model → 503 MODEL_FROZEN envelope as isError, before routing/billing', async () => {
    // The model-status SELECT is the first SQL the dispatch awaits, so this
    // queued row answers exactly that lookup.
    db.results.push([{ status: 'frozen' }]);

    const res = await rpc(
      'tools/call',
      {
        name: 'aiag_chat_completion',
        arguments: {
          model: 'mock/small',
          messages: [{ role: 'user', content: 'say hi' }],
          max_tokens: 8,
        },
      },
      31,
    );
    const body = await json(res);
    expect(body.error).toBeUndefined();
    const result = body.result as {
      isError: boolean;
      structuredContent: { error: unknown; model?: string; status?: string };
    };
    expect(result.isError).toBe(true);
    // The middleware's flat legacy envelope is carried through unchanged.
    expect(result.structuredContent.error).toBe('MODEL_FROZEN');
    expect(result.structuredContent.model).toBe('mock/small');
    expect(result.structuredContent.status).toBe('frozen');
    expect(spies.resolveModelWithOverride).not.toHaveBeenCalled();
    expect(spies.settleCharge).not.toHaveBeenCalled();
  });
});

describe('transport surface', () => {
  it('GET /mcp answers 405 (POST-only facade)', async () => {
    const res = await mount().request('http://gw.example/mcp', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(405);
  });

  it('a notifications-only POST is accepted with 202', async () => {
    const res = await mount().request('http://gw.example/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
  });
});

// ── fixtures (same shapes as agent-topup-route.test.ts) ───────────────────────
const RECIPIENT = `0:${'ab'.repeat(32)}`;

function policyRow(): { value: string } {
  const now = Date.now();
  return {
    value: JSON.stringify({
      revision: 'rev-2026-10-09',
      recipient: RECIPIENT,
      network: 'tvm:-3',
      finalityPolicyId: 'finality-v1',
      verifierVersion: 'verifier-v1',
      quoteLifetimeSeconds: 120,
      maxFxAgeSeconds: 60,
      fx: {
        numerator: '10000000000',
        denominator: '5200000',
        rounding: 'ceil',
        source: 'coingecko:the-open-network',
        observedAtMs: now - 1000,
        expiresAtMs: now + 60_000,
      },
      additionalFeeAtomic: '0',
    }),
  };
}

function gramInvoice(): Record<string, unknown> {
  return {
    invoiceId: INVOICE,
    network: 'tvm:-3',
    asset: { network: 'tvm:-3', kind: 'native', decimals: 9 },
    amountAtomic: '1923076924',
    recipient: RECIPIENT,
    reference: 'aiag-ton:1b0f0f0e-0000-4000-8000-0000000000ff',
    grantMicrocredits: '100000',
    expiresAt: '2026-10-09T12:00:00.000Z',
    status: 'pending',
  };
}
