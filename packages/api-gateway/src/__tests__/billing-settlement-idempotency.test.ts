/**
 * CRITICAL money regression (2026-09-30): the legacy billing path settled under
 * the CLIENT's `X-Request-Id`.
 *
 * `aiag_settle_charge_credits` treats an existing `api_usage` row for a
 * `request_id` as "already charged" and returns `idempotent=TRUE` without
 * touching the balance. Because the request id came straight from a header and
 * the idempotency query matched on `request_id` ALONE (no `org_id`), two
 * distinct bypasses existed, both reachable with an ordinary API key:
 *
 *   1. Send ONE fixed `X-Request-Id` forever → the first call charges, every
 *      later call is "already charged" → unlimited free inference.
 *   2. Reuse another org's `X-Request-Id` → their rows are found, this org is
 *      never charged.
 *
 * The fix has two halves that must BOTH hold, and this file pins each:
 *   - the gateway mints `stl_<uuid>` per request and never lets a header reach
 *     a money function (`requestIdMiddleware` + `settleCharge`'s guard);
 *   - the SQL scopes the idempotency lookup and its UNIQUE index by `org_id`.
 *
 * The SQL half is asserted against the real deployed artifacts (both copies of
 * the function plus the index migration) because there is no live DB here.
 * The gateway half runs for real: same client header twice, in-process, and
 * asserts the second call is charged on its own id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AiagError, errors } from '../lib/errors';
import {
  settleCharge,
  assertServerSettlementId,
  SETTLEMENT_ID_RE,
  type SettleArgs,
} from '../billing/settle';
import {
  requestIdMiddleware,
  CLIENT_TRACE_ID_RE,
  resolveTraceRequestId,
} from '../middleware/request-id';

const REPO = join(__dirname, '..', '..', '..', '..');
const read = (...segs: string[]): string =>
  readFileSync(join(REPO, ...segs), 'utf8');

/**
 * Minimal in-process model of `aiag_settle_charge_credits`' idempotency, kept
 * deliberately faithful to the deployed SQL: rows are keyed by
 * (org_id, request_id, source) — the identity the 0096 index now enforces —
 * and an existing api_usage row for that key short-circuits to
 * `idempotent=TRUE` with no balance change.
 */
function fakeSettlementStore() {
  const rows: Array<{ orgId: string; requestId: string; source: string; delta: number }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const args = Object.fromEntries(
      strings.map((chunk, i) => [
        `$${[i]}`,
        values[i],
      ])
    ) as Record<string, unknown>;
    // Tagged-template client: the params are interpolated values; recover
    // them positionally from the statement instead of relying on names.
    void args;
    const orgId = String(values[0]);
    const requestId = String(values[1]);
    const costCredits = Number(values[2]);
    const existing = rows.filter(
      (r) =>
        r.orgId === orgId &&
        r.requestId === requestId &&
        (r.source === 'subscription' || r.source === 'payg')
    );
    if (existing.length > 0) {
      return Promise.resolve([
        {
          sub_portion: String(
            existing.filter((r) => r.source === 'subscription').reduce((a, r) => a + r.delta, 0)
          ),
          payg_portion: String(
            existing.filter((r) => r.source === 'payg').reduce((a, r) => a + r.delta, 0)
          ),
          new_sub: '0',
          new_payg: '0',
          idempotent: true,
        },
      ]);
    }
    rows.push({ orgId, requestId, source: 'payg', delta: costCredits });
    return Promise.resolve([
      {
        sub_portion: '0',
        payg_portion: String(costCredits),
        new_sub: '0',
        new_payg: '0',
        idempotent: false,
      },
    ]);
  }) as unknown as Parameters<typeof settleCharge>[1];
  return { sql, rows };
}

const uuid = (n: number): string =>
  `stl_${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;

function args(over: Partial<SettleArgs> = {}): SettleArgs {
  return {
    orgId: '11111111-1111-4111-8111-111111111111',
    settlementRequestId: uuid(1),
    costCredits: 10,
    ...over,
  };
}

describe('CRITICAL: legacy settlement must not key on the client X-Request-Id', () => {
  describe('the bypass itself', () => {
    it('a client replaying ONE fixed X-Request-Id is charged on every call', async () => {
      // The attack, end to end: a Hono app with the real request-id middleware
      // and the real settleCharge, driven by a client that always sends the
      // same header. Every request must land on its OWN settlement id.
      const FIXED_CLIENT_HEADER = 'req-00000000-0000-4000-8000-000000000001';
      const { sql, rows } = fakeSettlementStore();

      const app = new Hono();
      app.onError((err, c) =>
        err instanceof AiagError
          ? c.json(err.toResponseBody(), err.status as never)
          : c.json({ error: { code: 'INTERNAL' } }, 500)
      );
      app.use('*', requestIdMiddleware());
      app.post('/v1/chat/completions', async (c) =>
        c.json(
          await settleCharge(
            {
              orgId: '11111111-1111-4111-8111-111111111111',
              settlementRequestId: c.get('settlementRequestId' as never) as string,
              traceRequestId: c.get('requestId' as never) as string,
              costCredits: 10,
            },
            sql
          )
        )
      );

      const send = () =>
        app.fetch(
          new Request('http://gateway.test/v1/chat/completions', {
            method: 'POST',
            headers: { 'X-Request-Id': FIXED_CLIENT_HEADER },
          })
        );

      const first = (await (await send()).json()) as { idempotent: boolean };
      const second = (await (await send()).json()) as { idempotent: boolean };
      const third = (await (await send()).json()) as { idempotent: boolean };

      // Before the fix: second/third were idempotent=TRUE → free inference.
      expect([first.idempotent, second.idempotent, third.idempotent]).toEqual([
        false,
        false,
        false,
      ]);
      // Three charges, on three distinct server ids.
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.requestId)).size).toBe(3);
      // The client's constant header never became a financial identity.
      expect(rows.map((r) => r.requestId)).not.toContain(FIXED_CLIENT_HEADER);
    });

    it('two orgs sending the same client header do not intersect', async () => {
      // Cross-org leak: with a `request_id`-only lookup, org B found org A's
      // rows and returned idempotent=TRUE without being charged. Post-fix the
      // settlement ids differ per request AND the SQL scopes by org_id.
      const { sql, rows } = fakeSettlementStore();
      const orgA = '11111111-1111-4111-8111-111111111111';
      const orgB = '22222222-2222-4222-8222-222222222222';

      const a = await settleCharge(
        args({ orgId: orgA, settlementRequestId: uuid(7), traceRequestId: 'client-says-abc' }),
        sql
      );
      const b = await settleCharge(
        args({ orgId: orgB, settlementRequestId: uuid(7), traceRequestId: 'client-says-abc' }),
        sql
      );

      // Same id, different org → B is charged, not treated as a replay.
      expect(a.idempotent).toBe(false);
      expect(b.idempotent).toBe(false);
      expect(rows.map((r) => r.orgId)).toEqual([orgA, orgB]);
    });

    it('genuine replay of the SAME server settlement id stays idempotent', async () => {
      // The fix must not delete idempotency — it must re-own it. An internal
      // retry under one server-minted id still settles once.
      const { sql, rows } = fakeSettlementStore();
      const first = await settleCharge(args({ settlementRequestId: uuid(3) }), sql);
      const replay = await settleCharge(args({ settlementRequestId: uuid(3) }), sql);

      expect(first.idempotent).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(rows).toHaveLength(1);
    });
  });

  describe('settleCharge refuses anything that is not a server-minted id', () => {
    it('rejects the client header shape before touching SQL', async () => {
      const sql = vi.fn();
      for (const bad of [
        'req-abc-123',
        'req_00000000-0000-4000-8000-000000000001',
        'stl_not-a-uuid',
        'stl_00000000-0000-4000-8000-00000000000Z',
        'stl_' + 'x'.repeat(36),
      ]) {
        await expect(
          settleCharge(
            { orgId: 'org', settlementRequestId: bad, costCredits: 1 } as SettleArgs,
            sql as never
          )
        ).rejects.toMatchObject({ status: 400 });
      }
      // Not one of them reached the database.
      expect(sql).not.toHaveBeenCalled();
    });

    it('accepts a server-minted id', async () => {
      expect(assertServerSettlementId(uuid(9))).toBe(uuid(9));
      expect(SETTLEMENT_ID_RE.test(uuid(9))).toBe(true);
    });

    it('rejects caller-chosen values, including ones that stringify to a valid id', () => {
      expect(() => assertServerSettlementId(42)).toThrow(AiagError);
      expect(() => assertServerSettlementId({ toString: () => uuid(1) })).toThrow(AiagError);
      expect(() => assertServerSettlementId('req-abc-123')).toThrow(AiagError);
    });

    it('mints a server id when the caller supplied none, rather than throwing', () => {
      // On the SSE path a settle throw is swallowed into a delivered answer,
      // so a missing id must still CHARGE. Minting keeps the money path closed.
      for (const missing of [undefined, null]) {
        const minted = assertServerSettlementId(missing);
        expect(SETTLEMENT_ID_RE.test(minted)).toBe(true);
      }
      expect(assertServerSettlementId(undefined)).not.toBe(
        assertServerSettlementId(undefined)
      );
    });

    it('keeps the trace id out of the financial position', async () => {
      const seen: string[] = [];
      const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        seen.push(...values.map(String));
        return Promise.resolve([
          { sub_portion: '0', payg_portion: '1', new_sub: '0', new_payg: '0', idempotent: false },
        ]);
      }) as never;
      await settleCharge(args({ traceRequestId: 'client-says-abc' }), sql);
      // Position 1 is the money id; the client's value only rides in metadata.
      expect(seen[1]).toBe(uuid(1));
      expect(seen[1]).not.toBe('client-says-abc');
      expect(seen.some((v) => v.includes('client-says-abc'))).toBe(true);
    });

    it('maps a UNIQUE violation to a typed error instead of a bare 500', async () => {
      const boom = Object.assign(new Error('duplicate key'), { code: '23505' });
      const sql = (() => Promise.reject(boom)) as never;
      await expect(settleCharge(args(), sql)).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
    });
  });

  describe('request-id middleware: header is trace-only and bounded', () => {
    it('mints a distinct settlement id per request, whatever the header says', async () => {
      const seen: string[] = [];
      const app = new Hono();
      app.use('*', requestIdMiddleware());
      app.get('/', (c) => {
        seen.push(c.get('settlementRequestId' as never) as string);
        return c.json({ ok: true });
      });
      const send = () =>
        app.fetch(new Request('http://x/', { headers: { 'X-Request-Id': 'constant' } }));

      await send();
      await send();
      await send();
      expect(new Set(seen).size).toBe(3);
      for (const id of seen) expect(SETTLEMENT_ID_RE.test(id)).toBe(true);
    });

    it('still honors a well-formed client id as the TRACE id (unchanged behaviour)', async () => {
      const app = new Hono();
      app.use('*', requestIdMiddleware());
      app.get('/', (c) => c.json({ rid: c.get('requestId' as never) }));
      const res = await app.fetch(
        new Request('http://x/', { headers: { 'X-Request-Id': 'req-abc-123' } })
      );
      expect(res.headers.get('X-Request-Id')).toBe('req-abc-123');
      expect(((await res.json()) as { rid: string }).rid).toBe('req-abc-123');
    });

    it('substitutes a server id for a header that could break request_id VARCHAR(64)', () => {
      // 65 chars + a hostile charset: rejected, replaced — never passed through
      // to SQL, where it would fail the INSERT *after* the provider was paid
      // (and, on the SSE path, be swallowed into a free answer).
      for (const bad of ['x'.repeat(65), 'a b', 'a\nb', 'req/../etc', 'юникод', 'a'.repeat(64) + '!']) {
        expect(CLIENT_TRACE_ID_RE.test(bad)).toBe(false);
        expect(resolveTraceRequestId(bad)).toMatch(/^req_[0-9a-f-]{36}$/);
      }
      expect(resolveTraceRequestId(undefined)).toMatch(/^req_/);
      expect(resolveTraceRequestId('')).toMatch(/^req_/);
    });

    it('accepts exactly the documented 1..64 ASCII set', () => {
      expect(CLIENT_TRACE_ID_RE.test('a')).toBe(true);
      expect(CLIENT_TRACE_ID_RE.test('A-Za-z0-9._:-'.repeat(5).slice(0, 64))).toBe(true);
      expect(CLIENT_TRACE_ID_RE.test('a'.repeat(64))).toBe(true);
      expect(CLIENT_TRACE_ID_RE.test('a'.repeat(65))).toBe(false);
    });
  });

  describe('deployed SQL artifacts (the half that cannot be unit-tested here)', () => {
    const MIRROR =
      'packages/database/src/functions/settle-charge.sql';
    const DEPLOY =
      'packages/database/migrations/0058_settle_charge_credits_fn.sql';
    const INDEX_MIGRATION =
      'packages/database/migrations/0096_settle_idempotency_org_scope.sql';

    /** The idempotency lookup inside the credits function. */
    function idempotencyLookup(sql: string): string {
      const start = sql.indexOf(
        'CREATE OR REPLACE FUNCTION aiag_settle_charge_credits('
      );
      expect(start).toBeGreaterThan(-1);
      const body = sql.slice(start);
      const at = body.indexOf('FROM gateway_transactions');
      expect(at).toBeGreaterThan(-1);
      return body.slice(at, body.indexOf(';', at));
    }

    it('the idempotency lookup is org-scoped in BOTH copies', () => {
      for (const file of [MIRROR, DEPLOY]) {
        const lookup = idempotencyLookup(read(file));
        expect(lookup, file).toMatch(/WHERE\s+org_id\s*=\s*_org_id/);
        expect(lookup, file).toMatch(/AND\s+request_id\s*=\s*_request_id/);
        // The org predicate must come FIRST so no request_id-only match can
        // leak across tenants even if the clause order is ever rewritten.
        expect(lookup.indexOf('org_id = _org_id')).toBeLessThan(
          lookup.indexOf('request_id = _request_id')
        );
      }
    });

    it('the two copies of the credits function are byte-identical', () => {
      const body = (sql: string): string => {
        const start = sql.indexOf(
          'CREATE OR REPLACE FUNCTION aiag_settle_charge_credits('
        );
        return sql.slice(start).split('$$;')[0] + '$$;';
      };
      expect(body(read(MIRROR))).toBe(body(read(DEPLOY)));
    });

    it('the rollback ₽ twin is org-scoped too (it shares the table)', () => {
      const lookup = idempotencyLookupLegacy(read(MIRROR));
      expect(lookup).toMatch(/WHERE\s+org_id\s*=\s*_org_id/);
    });

    it('the UNIQUE index migration re-scopes to org_id and drops the global one', () => {
      const sql = read(INDEX_MIGRATION);
      expect(sql).toMatch(/DROP INDEX IF EXISTS gateway_transactions_api_usage_uniq/);
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS gateway_transactions_api_usage_uniq[\s\S]*ON gateway_transactions \(org_id, request_id, source\)[\s\S]*WHERE type = 'api_usage'/
      );
      // Must NOT edit the already-applied 0004 (prod migrations are manual).
      expect(read('packages/database/migrations/0004_gateway_core.sql')).toMatch(
        /ON gateway_transactions \(request_id, source\)/
      );
    });

    it('settlement is still one parameterized stored-function call (no inline SQL)', () => {
      const settleSrc = read('packages/api-gateway/src/billing/settle.ts');
      expect(settleSrc).toMatch(/FROM aiag_settle_charge_credits\(/);
      expect(settleSrc).not.toMatch(/UPDATE\s+organizations/i);
      // Still the credit-unit function; the ₽ twin must never be called.
      expect(settleSrc).not.toMatch(/aiag_settle_charge\(/);
    });
  });
});

function idempotencyLookupLegacy(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION aiag_settle_charge(');
  expect(start).toBeGreaterThan(-1);
  const body = sql.slice(start);
  const at = body.indexOf('FROM gateway_transactions');
  expect(at).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf(';', at));
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});