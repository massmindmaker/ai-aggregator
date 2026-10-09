/**
 * packages/database agent-topup service — payload assembly seam.
 *
 * The route tests (api-gateway) mock this module away, so this file pins the
 * service's own contract against the 0106 SQL:
 *  1. Gram payload: strict key set, policy FX threaded through createQuote,
 *     quote expiry capped by the FX window.
 *  2. USDT payload: oracle-free peg — numerator 10 / denominator 1 / fee 0,
 *     amountAtomic === grantMicrocredits × 10, mainnet master in raw form.
 *  3. Org-scoped idempotent replay: a stored invoice with the same request
 *     fingerprint returns WITHOUT building a second quote or hitting the
 *     create entrypoint; a different fingerprint is a conflict.
 *  4. Stale policy FX fails closed before any write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentTopupFingerprint,
  createAgentTopupInvoice,
} from '../agent-topup';
import type { AgentTopupPolicy } from '../agent-topup';
import type { TonSqlClient } from '../ton-payment-types';

const KEY_ID = '55555555-5555-4555-8555-5555555555aa';
const ORG = '41000000-0000-4000-8000-0000000000a1';
const OWNER = '33000000-0000-4000-8000-0000000000ee';
const INVOICE = '66000000-0000-4000-8000-0000000000a3';
const RECIPIENT = `0:${'ab'.repeat(32)}`;
const USDT_MASTER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

/** Scripted query results, consumed in call order; the statement text is captured. */
function fakeDb(scripted: Array<unknown[] | Error>) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const queue = [...scripted];
  const tx: TonSqlClient = {
    query: async <R extends Record<string, unknown>>(config: {
      text: string;
      values: readonly unknown[];
    }) => {
      statements.push({ text: config.text, values: [...config.values] });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { rows: (next ?? []) as R[], rowCount: (next ?? []).length };
    },
  };
  return {
    statements,
    db: {
      transaction: async <T>(run: (client: TonSqlClient) => Promise<T>) => run(tx),
    },
  };
}

function policy(now: number): AgentTopupPolicy {
  return {
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
  };
}

/** invoice json exactly as aiag_ton_invoice_json_v1 renders it. */
function invoiceJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    product: 'aggregator',
    purpose: 'agent_topup',
    invoiceId: INVOICE,
    ownerId: OWNER,
    orgId: ORG,
    orderId: null,
    idempotencyKey: 'k',
    quoteId: 'q',
    quote: {},
    grantMicrocredits: '100000',
    priceRevision: 'rev-2026-10-09',
    network: 'tvm:-3',
    asset: { network: 'tvm:-3', kind: 'native', decimals: 9 },
    amountAtomic: '19230800',
    recipient: RECIPIENT,
    reference: 'aiag-ton:1b0f0f0e-0000-4000-8000-0000000000ff',
    expectedSender: null,
    finalityPolicyId: 'finality-v1',
    verifierVersion: 'verifier-v1',
    expiresAt: '2026-10-09T12:00:00.000000+00:00',
    createdAt: '2026-10-09T11:58:00.000000+00:00',
    status: 'pending',
    reviewReason: null,
    ...overrides,
  });
}

const NOW = 1_790_000_000_000;

let clockNow = NOW;
const policyFn = vi.fn(() => policy(clockNow));

/** owner row + empty replay lookup + db clock. */
function freshInvoiceScript(): Array<unknown[] | Error> {
  return [
    [{ owner: OWNER }],
    [],
    [{ now_ms: String(NOW) }],
    [{ invoice: invoiceJson() }],
  ];
}

beforeEach(() => {
  clockNow = NOW;
  policyFn.mockClear();
  policyFn.mockImplementation(() => policy(clockNow));
});

describe('createAgentTopupInvoice — gram', () => {
  it('assembles the strict 0106 payload with policy FX and normalized ISO expiry', async () => {
    const { db, statements } = fakeDb(freshInvoiceScript());

    const invoice = await createAgentTopupInvoice(
      db,
      { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k' },
      policyFn,
    );

    expect(invoice.invoiceId).toBe(INVOICE);
    expect(invoice.expiresAt).toBe('2026-10-09T12:00:00.000Z'); // ISO ms, not PG text
    expect(invoice.status).toBe('pending');

    const create = statements.find((s) => s.text.includes('aiag_create_agent_ton_invoice_v1'))!;
    expect(create.values[0]).toBe(KEY_ID);
    const payload = JSON.parse(create.values[1] as string);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'schemaVersion', 'purpose', 'ownerId', 'orgId', 'idempotencyKey',
        'grantMicrocredits', 'priceRevision', 'quote', 'recipient',
        'finalityPolicyId', 'verifierVersion',
      ].sort(),
    );
    expect(payload.purpose).toBe('agent_topup');
    expect(payload.ownerId).toBe(OWNER);
    expect(payload.orgId).toBe(ORG);
    expect(payload.grantMicrocredits).toBe('100000'); // 100 credits × 1000 micro
    expect(payload.recipient).toBe(RECIPIENT);
    expect(payload.quote.asset).toEqual({ network: 'tvm:-3', kind: 'native', decimals: 9 });
    expect(payload.quote.sourcePrice).toEqual({ unit: 'gateway_microcredits', amountAtomic: '100000' });
    expect(payload.quote.fx.numerator).toBe('10000000000');
    expect(payload.quote.fx.denominator).toBe('5200000');
    expect(payload.quote.fx.rounding).toBe('ceil');
    // ceil(100000 × 10^10 / 5_200_000) = ceil(192307692.3…) = 192307693
    expect(payload.quote.amountAtomic).toBe('192307693');
    expect(payload.quote.expiresAtMs).toBeLessThanOrEqual(payload.quote.fx.expiresAtMs);
    // Fingerprint is sha256 of the canonical REQUEST body, not the payload.
    expect(create.values[2]).toBe(
      agentTopupFingerprint({ asset: 'gram', credits: '100', idempotencyKey: 'k' }),
    );
  });

  it('is stable across calls: same body, same fingerprint', () => {
    const a = agentTopupFingerprint({ asset: 'gram', credits: '100', idempotencyKey: 'k' });
    const b = agentTopupFingerprint({ asset: 'gram', credits: '100', idempotencyKey: 'k' });
    const c = agentTopupFingerprint({ asset: 'gram', credits: '101', idempotencyKey: 'k' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createAgentTopupInvoice — usdt peg', () => {
  it('amountAtomic = grant × 10, fee 0, mainnet master raw form, network tvm:-1', async () => {
    const { db, statements } = fakeDb(freshInvoiceScript());

    await createAgentTopupInvoice(
      db,
      { keyId: KEY_ID, orgId: ORG, asset: 'usdt', credits: '100', idempotencyKey: 'k' },
      policyFn,
    );

    const create = statements.find((s) => s.text.includes('aiag_create_agent_ton_invoice_v1'))!;
    const payload = JSON.parse(create.values[1] as string);
    expect(payload.grantMicrocredits).toBe('100000');
    expect(payload.quote.asset).toEqual({
      network: 'tvm:-1',
      kind: 'jetton',
      masterAddress: USDT_MASTER,
      decimals: 6,
    });
    expect(payload.quote.fx.numerator).toBe('10');
    expect(payload.quote.fx.denominator).toBe('1');
    expect(payload.quote.fx.rounding).toBe('floor');
    expect(payload.quote.additionalFeeAtomic).toBe('0');
    expect(payload.quote.amountAtomic).toBe('1000000'); // 1.000000 USDT
  });
});

describe('createAgentTopupInvoice — org-scoped idempotent replay', () => {
  it('same fingerprint replays the stored invoice without a new quote or SQL create', async () => {
    const { db, statements } = fakeDb([
      [{ owner: OWNER }],
      // Replay hit: fingerprint of {asset:'gram',credits:'100',idempotencyKey:'k'}.
      [
        {
          request_fingerprint: agentTopupFingerprint({ asset: 'gram', credits: '100', idempotencyKey: 'k' }),
          invoice: invoiceJson(),
        },
      ],
    ]);

    const invoice = await createAgentTopupInvoice(
      db,
      { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k' },
      policyFn,
    );

    expect(invoice.invoiceId).toBe(INVOICE);
    expect(policyFn).not.toHaveBeenCalled(); // no quote is built on replay
    expect(statements.filter((s) => s.text.includes('aiag_create_agent_ton_invoice_v1'))).toHaveLength(0);
    // The pre-lookup is authorized by the live-key + active-principal join.
    const lookup = statements.find((s) => s.text.includes('agent_principals'))!;
    expect(lookup.text).toContain('k.revoked_at IS NULL');
    expect(lookup.text).toContain("i.purpose = 'agent_topup'");
  });

  it('a different body under the same key is TON_IDEMPOTENCY_CONFLICT', async () => {
    const { db } = fakeDb([
      [{ owner: OWNER }],
      [
        {
          request_fingerprint: agentTopupFingerprint({ asset: 'gram', credits: '500', idempotencyKey: 'k' }),
          invoice: invoiceJson(),
        },
      ],
    ]);

    await expect(
      createAgentTopupInvoice(
        db,
        { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k' },
        policyFn,
      ),
    ).rejects.toMatchObject({ code: 'TON_IDEMPOTENCY_CONFLICT' });
  });

  it('a concurrent-insert unique violation from the SQL maps to the same conflict', async () => {
    const { db } = fakeDb([
      [{ owner: OWNER }],
      [],
      [{ now_ms: String(NOW) }],
      Object.assign(new Error('dup'), { code: '23505' }),
    ]);
    await expect(
      createAgentTopupInvoice(
        db,
        { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k' },
        policyFn,
      ),
    ).rejects.toMatchObject({ code: 'TON_IDEMPOTENCY_CONFLICT' });
  });
});

describe('createAgentTopupInvoice — guards', () => {
  it.each([
    ['credits below 100', { credits: '99' }, 'AGENT_GRANT_TOO_SMALL'],
    ['non-canonical credits', { credits: '0100' }, 'AGENT_TOPUP_INVALID'],
    ['bad idempotencyKey', { idempotencyKey: 'плюс' }, 'AGENT_TOPUP_INVALID'],
    ['unknown asset', { asset: 'notcoin' as never }, 'AGENT_TOPUP_INVALID'],
    ['bad keyId', { keyId: 'nope' }, 'AGENT_TOPUP_INVALID'],
    ['bad orgId', { orgId: 'nope' }, 'AGENT_TOPUP_INVALID'],
  ])('%s → %s (nothing written)', async (_label, override, code) => {
    const { db, statements } = fakeDb([]);
    await expect(
      createAgentTopupInvoice(
        db,
        { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k', ...override },
        policyFn,
      ),
    ).rejects.toMatchObject({ code });
    expect(statements).toHaveLength(0);
  });

  it('missing service owner → AGENT_NOT_AUTHORIZED before any payload work', async () => {
    const { db } = fakeDb([[{ owner: null }]]);
    await expect(
      createAgentTopupInvoice(
        db,
        { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k' },
        policyFn,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  });

  it('stale policy FX → TON_CHECKOUT_FX_STALE, create SQL never reached', async () => {
    clockNow = NOW;
    policyFn.mockImplementation(() => ({
      ...policy(NOW - 120_000), // observed 2 minutes ago, maxFxAge 60s
    }));
    const { db, statements } = fakeDb([[{ owner: OWNER }], [], [{ now_ms: String(NOW) }]]);
    await expect(
      createAgentTopupInvoice(
        db,
        { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k' },
        policyFn,
      ),
    ).rejects.toMatchObject({ code: 'TON_CHECKOUT_FX_STALE' });
    expect(statements.filter((s) => s.text.includes('aiag_create_agent_ton_invoice_v1'))).toHaveLength(0);
  });

  it('SQL RAISE codes pass through as AgentTopupError', async () => {
    const { db } = fakeDb([
      [{ owner: OWNER }],
      [],
      [{ now_ms: String(NOW) }],
      new Error('TON_ASSET_NOT_ALLOWLISTED'),
    ]);
    await expect(
      createAgentTopupInvoice(
        db,
        { keyId: KEY_ID, orgId: ORG, asset: 'usdt', credits: '100', idempotencyKey: 'k' },
        policyFn,
      ),
    ).rejects.toMatchObject({ code: 'TON_ASSET_NOT_ALLOWLISTED' });
  });

  it('unexpected SQL errors rethrow untouched (route renders bare INTERNAL)', async () => {
    const { db } = fakeDb([[{ owner: OWNER }], new Error('relation does not exist')]);
    await expect(
      createAgentTopupInvoice(
        db,
        { keyId: KEY_ID, orgId: ORG, asset: 'gram', credits: '100', idempotencyKey: 'k' },
        policyFn,
      ),
    ).rejects.toThrow('relation does not exist');
  });
});
