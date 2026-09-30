/**
 * GET /v1/usage/{billing_id} — authoritative charge receipt.
 *
 * The point of this route is AUTHORITY, not convenience: the buyer must be
 * able to learn what the gateway actually charged for one server-minted
 * billing id, without re-deriving a price from its own copy of the tariff.
 *
 * The authorization property under test is the dangerous one: a billing id
 * belonging to ANOTHER organization must be indistinguishable from one that
 * does not exist. That means 404 (not 403), and it means the org scope lives
 * in the WHERE clause of a single prepared statement — never as a
 * post-fetch "is this mine?" comparison in TypeScript, which would leak the
 * row's existence through a different status code or a different body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const OWN_ORG = '40000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '40000000-0000-4000-8000-0000000000bb';
const KEY_ID = '30000000-0000-4000-8000-0000000000cc';
const BILLING = '11111111-1111-4111-8111-111111111111';
const OTHER_BILLING = '22222222-2222-4222-8222-222222222222';

const db = vi.hoisted(() => {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const results: unknown[] = [];
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push({ text, values });
    const next = results.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  });
  const sql = Object.assign(tx, {
    begin: async (work: (client: typeof tx) => unknown) => work(tx),
  });
  return { statements, results, sql };
});

vi.mock('../lib/db', () => ({ sql: db.sql }));

import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';
import { applyAiagErrorHandler } from '../lib/errors';
import { usage } from '../routes/v1/usage';

const OWN_KEY = 'sk_aiag_live_aaaaaaaaaaaaaaaaaaaa';
const OTHER_KEY = 'sk_aiag_live_bbbbbbbbbbbbbbbbbbbb';

function apiKeyFor(orgId: string) {
  return {
    id: KEY_ID,
    org_id: orgId,
    policies: {},
    rpm_limit: 60,
    batch_rpm_limit: 10,
    daily_usd_cap: null,
    cost_limit_monthly_rub: null,
    model_whitelist: [],
    ru_residency_only: false,
  };
}

/** One resolver serving BOTH orgs — a second call must not shadow the first. */
function resolverFor(...orgs: Array<[string, string]>): void {
  const byKey = new Map(orgs.map(([key, orgId]) => [key, apiKeyFor(orgId)]));
  setApiKeyResolver(async (candidate) => byKey.get(candidate) ?? null);
}

function mounted(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app);
  // Same assembly the real server uses: auth first, then the route.
  app.use('/v1/usage/*', requireApiKey);
  app.route('/v1/usage', usage);
  return app;
}

const get = (path: string, key = OWN_KEY) =>
  mounted().request(path, { headers: { authorization: `Bearer ${key}` } });

/** A settled charge: 700 off subscription + 300 off payg = 1000 micro-credits. */
function settledRow(overrides: Record<string, unknown> = {}) {
  return {
    billing_id: BILLING,
    org_id: OWN_ORG,
    api_key_id: KEY_ID,
    route_kind: 'chat',
    billing_mode: 'stored',
    model_slug: 'deepseek/deepseek-chat',
    state: 'settled',
    outcome_kind: 'completed',
    client_request_id: 'trace-1',
    authorized_max_credits: '5000',
    held_subscription_credits: '5000',
    held_payg_credits: '0',
    actual_cost_credits: '1000',
    released_subscription_credits: '4300',
    released_payg_credits: '0',
    expired_subscription_credits: '0',
    debt_repaid_credits: '0',
    usage_snapshot: { input_tokens: 10, output_tokens: 20 },
    charged_subscription_microcredits: '700',
    charged_payg_microcredits: '300',
    refunded_subscription_microcredits: '0',
    refunded_payg_microcredits: '0',
    ledger_entries: [
      { source: 'subscription', type: 'api_usage', delta_microcredits: '-700', created_at: '2026-09-30T10:00:00.000000Z' },
    ],
    org_subscription_microcredits: '9000',
    org_payg_microcredits: '2000',
    org_refund_debt_microcredits: '0',
    created_at: '2026-09-30T09:59:59.000000Z',
    settled_at: '2026-09-30T10:00:00.000000Z',
    cancelled_at: null,
    reconcile_after: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.statements.length = 0;
  db.results.length = 0;
  db.sql.mockClear();
  setApiKeyResolver(null);
});

describe('GET /v1/usage/{billing_id} — authentication', () => {
  it('401 without a bearer key', async () => {
    const res = await mounted().request(`/v1/usage/${BILLING}`);
    expect(res.status).toBe(401);
    expect(db.statements).toHaveLength(0);
  });

  it('401 for a well-shaped key that resolves to nothing', async () => {
    setApiKeyResolver(async () => null);
    const res = await get(`/v1/usage/${BILLING}`);
    expect(res.status).toBe(401);
    expect(db.statements).toHaveLength(0);
  });
});

describe('GET /v1/usage/{billing_id} — the owner reads its own receipt', () => {
  it('reports the charged amount from the ledger, in exact decimal strings', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    db.results.push([settledRow()]);

    const res = await get(`/v1/usage/${BILLING}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.object).toBe('billing.receipt');
    expect(body.billing_id).toBe(BILLING);
    expect(body.state).toBe('settled');
    // Money as strings, never floats: 1000 micro-credits must not arrive as
    // 1000.0000001 or "1e3" at a B2B consumer.
    expect(body.unit).toBe('microcredits');
    expect(body.microcredits_per_credit).toBe(1000);
    expect(body.charged).toEqual({
      subscription_microcredits: '700',
      payg_microcredits: '300',
      total_microcredits: '1000',
    });
    expect(body.reserved.total_microcredits).toBe('5000');
    expect(body.released.total_microcredits).toBe('4300');
    expect(body.refunded.total_microcredits).toBe('0');
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(body.balance.payg_microcredits).toBe('2000');
    expect(body.client_request_id).toBe('trace-1');
  });

  it('scopes the query to the calling org inside the statement itself', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    db.results.push([settledRow()]);
    await get(`/v1/usage/${BILLING}`);

    expect(db.statements).toHaveLength(1);
    const [statement] = db.statements;
    // org_id is a bound parameter, and it is in the WHERE clause — not a
    // TypeScript comparison applied after the row was already fetched.
    expect(statement.text).toMatch(/org_id\s*=\s*\?/);
    expect(statement.values).toContain(OWN_ORG);
    expect(statement.values).toContain(BILLING);
    // Nothing user-controlled is ever interpolated into SQL text.
    expect(statement.text).not.toContain(OWN_ORG);
    expect(statement.text).not.toContain(BILLING);
  });

  it('marks an unsettled admission as unknown-amount rather than zero', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    db.results.push([
      settledRow({
        state: 'dispatched',
        actual_cost_credits: null,
        charged_subscription_microcredits: '0',
        charged_payg_microcredits: '0',
        settled_at: null,
        reconcile_after: '2026-09-30T11:00:00.000000Z',
      }),
    ]);

    const res = await get(`/v1/usage/${BILLING}`);
    const body = (await res.json()) as Record<string, any>;
    expect(body.state).toBe('dispatched');
    // null = "not known yet"; "0" = "confirmed nothing". Collapsing the two
    // is how a buyer concludes it was short-charged and retries.
    expect(body.charged).toBeNull();
    expect(body.reserved.total_microcredits).toBe('5000');
    expect(body.pending_reconciliation).toBe(true);
  });

  it('reports a cancelled admission as a confirmed zero charge', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    db.results.push([
      settledRow({
        state: 'cancelled',
        actual_cost_credits: null,
        charged_subscription_microcredits: '0',
        charged_payg_microcredits: '0',
        settled_at: null,
        cancelled_at: '2026-09-30T10:00:00.000000Z',
      }),
    ]);
    const res = await get(`/v1/usage/${BILLING}`);
    const body = (await res.json()) as Record<string, any>;
    expect(body.state).toBe('cancelled');
    expect(body.charged.total_microcredits).toBe('0');
    expect(body.pending_reconciliation).toBe(false);
  });
});

describe('GET /v1/usage/{billing_id} — another org is indistinguishable from nobody', () => {
  it('404 (never 403) for a billing id owned by a different organization', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    // The org-scoped statement simply returns nothing for a foreign billing id.
    db.results.push([]);

    const res = await get(`/v1/usage/${OTHER_BILLING}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Usage receipt not found' } });
  });

  it('returns a byte-identical body for "foreign id" and "id that never existed"', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    db.results.push([]);
    const foreign = await get(`/v1/usage/${OTHER_BILLING}`);
    const foreignBody = await foreign.text();

    db.results.push([]);
    const absent = await get(`/v1/usage/99999999-9999-4999-8999-999999999999`);
    const absentBody = await absent.text();

    expect(foreign.status).toBe(absent.status);
    expect(foreignBody).toBe(absentBody);
  });

  it('does not leak the owner org id of a foreign receipt in any field', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    db.results.push([]);
    const res = await get(`/v1/usage/${OTHER_BILLING}`);
    const raw = await res.text();
    expect(raw).not.toContain(OTHER_ORG);
    expect(raw.toLowerCase()).not.toContain('forbidden');
  });

  it('a different org key gets 404 on the same id that its own key could read', async () => {
    resolverFor([OWN_KEY, OWN_ORG], [OTHER_KEY, OTHER_ORG]);
    db.results.push([settledRow()]);
    const mine = await get(`/v1/usage/${BILLING}`);
    expect(mine.status).toBe(200);

    db.results.push([]);
    const theirs = await get(`/v1/usage/${BILLING}`, OTHER_KEY);
    expect(theirs.status).toBe(404);
  });
});

describe('GET /v1/usage/{billing_id} — input handling', () => {
  it('400 for a billing id that is not a uuid, without touching the database', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    const res = await get('/v1/usage/not-a-uuid');
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('400 for a uuid-shaped injection attempt, without touching the database', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    const res = await get(`/v1/usage/${BILLING}%27%20OR%201%3D1--`);
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('503 when the ledger cannot be read — never a fabricated zero', async () => {
    resolverFor([OWN_KEY, OWN_ORG]);
    db.results.push(new Error('connection terminated'));
    const res = await get(`/v1/usage/${BILLING}`);
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toMatch(/connection terminated/);
  });
});
