/**
 * T10 (agentic rail, plan 2026-10-09): machine-readable 402 topup hint.
 *
 * Every gateway money refusal (preflight assertPositiveBalance, settleCharge
 * P0003, admission P0003) must render ONE envelope:
 *
 *   agent key (policies->>'kind' = 'agent'):
 *     402 {error:{code:'PAYMENT_REQUIRED',message:'Insufficient funds',
 *                 topup:{default_asset:'gram',endpoint:'POST /v1/agent/topup',
 *                        min_credits:100,assets:['gram','usdt']}}}
 *     + Retry-After: 30
 *
 *   human key: the legacy body byte-for-byte (no `topup`, no Retry-After) —
 *   a person tops up in the web UI.
 *
 * The `code` stays 'PAYMENT_REQUIRED' on purpose: stored attempt layers
 * (stored-chat-attempt.ts etc.) match on exactly this code, so the hint is
 * purely additive (the brief's `insufficient_funds` literal was superseded by
 * the backwards-compatibility requirement).
 *
 * Unit-level, following the neighboring billing-test patterns
 * (billing-preflight.test.ts fakeSql / billing-admission.test.ts P0003 rows).
 */
import { describe, expect, it, vi } from 'vitest';

// Import-time guard identical to auth-key-expiry.test.ts: lib/db builds a
// postgres client from config on import; unit tests must never reach it.
vi.mock('../lib/db', () => ({ sql: vi.fn() }));

import { Hono } from 'hono';
import {
  INSUFFICIENT_FUNDS_RETRY_AFTER_SECONDS,
  INSUFFICIENT_FUNDS_TOPUP_HINT,
  InsufficientFundsError,
  isAgentKeyPolicies,
  queryAdmission,
} from '../billing/admission-internal';
import { assertPositiveBalance, settleCharge } from '../billing/settle';
import { AiagError, applyAiagErrorHandler } from '../lib/errors';
import type { SqlClient } from '../lib/db';

const AGENT_POLICIES: Record<string, unknown> = {
  kind: 'agent',
  s2s_key_minting: true,
};

const EXPECTED_TOPUP = {
  default_asset: 'gram',
  endpoint: 'POST /v1/agent/topup',
  min_credits: 100,
  assets: ['gram', 'usdt'],
};

/** Tagged-template stand-in for the postgres.js client (billing-preflight pattern). */
function fakeSql(rows: unknown[]): any {
  return (..._args: unknown[]) => Promise.resolve(rows);
}

/**
 * Tagged-template stand-in whose every query rejects with a driver-shaped
 * error. The rejection is created only when a thenable is actually awaited —
 * fragments embedded as VALUES (never awaited) must not produce unhandled
 * promise rejections.
 */
function rejectingClient(error: unknown): SqlClient {
  const tag = (() => ({
    then(
      _onFulfilled: unknown,
      onRejected?: (reason: unknown) => unknown,
    ): unknown {
      return onRejected ? onRejected(error) : Promise.reject(error);
    },
  })) as unknown as SqlClient;
  return tag;
}

function stlId(): string {
  return `stl_${crypto.randomUUID()}`;
}

// ── The unified envelope itself ──────────────────────────────────────────────

describe('InsufficientFundsError — unified 402 body', () => {
  it('agent key: legacy fields unchanged + exact topup structure', () => {
    const e = new InsufficientFundsError(AGENT_POLICIES);
    expect(e).toBeInstanceOf(AiagError);
    expect(e.status).toBe(402);
    expect(e.code).toBe('PAYMENT_REQUIRED');
    expect(e.message).toBe('Insufficient funds');
    expect(e.retryAfterSeconds).toBe(30);
    expect(INSUFFICIENT_FUNDS_RETRY_AFTER_SECONDS).toBe(30);
    expect(e.topup).toEqual(EXPECTED_TOPUP);
    expect(e.toResponseBody()).toEqual({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'Insufficient funds',
        topup: EXPECTED_TOPUP,
      },
    });
  });

  it('agent key: the exported hint constant IS the appended value', () => {
    const body = new InsufficientFundsError({ kind: 'agent' }).toResponseBody();
    expect((body.error as { topup?: unknown }).topup).toBe(
      INSUFFICIENT_FUNDS_TOPUP_HINT,
    );
  });

  it.each([
    ['empty human policies', {}],
    ['no policies at all', undefined],
    ['other kind', { kind: 'human' }],
  ])('human key (%s): legacy body byte-for-byte, no topup key', (_label, policies) => {
    const e = new InsufficientFundsError(policies as Record<string, unknown> | undefined);
    expect(e.status).toBe(402);
    expect(e.code).toBe('PAYMENT_REQUIRED');
    expect(e.topup).toBeUndefined();
    expect(e.retryAfterSeconds).toBeUndefined();
    const body = e.toResponseBody() as { error: Record<string, unknown> };
    expect('topup' in body.error).toBe(false);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
    expect(body.error).toEqual({ code: 'PAYMENT_REQUIRED', message: 'Insufficient funds' });
  });

  it('isAgentKeyPolicies accepts only the strict agent marker', () => {
    expect(isAgentKeyPolicies({ kind: 'agent' })).toBe(true);
    expect(isAgentKeyPolicies({ kind: 'Agent' })).toBe(false); // case-sensitive
    expect(isAgentKeyPolicies({})).toBe(false);
    expect(isAgentKeyPolicies(undefined)).toBe(false);
    expect(isAgentKeyPolicies(null)).toBe(false);
    expect(isAgentKeyPolicies('agent')).toBe(false);
    expect(isAgentKeyPolicies(['agent'])).toBe(false);
  });
});

// ── Refusal site 1: preflight assertPositiveBalance ─────────────────────────

describe('assertPositiveBalance — preflight 402', () => {
  it('agent key + zero balance → 402 with the topup hint', async () => {
    const zero = fakeSql([{ balance: '0' }]);
    const err = await assertPositiveBalance('org-empty', zero, AGENT_POLICIES).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).toResponseBody()).toEqual({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'Insufficient funds',
        topup: EXPECTED_TOPUP,
      },
    });
  });

  it('human key + zero balance → legacy 402 body without topup', async () => {
    const zero = fakeSql([{ balance: '0' }]);
    const err = await assertPositiveBalance('org-empty', zero).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    const body = (err as InsufficientFundsError).toResponseBody() as {
      error: Record<string, unknown>;
    };
    expect('topup' in body.error).toBe(false);
    expect(body.error).toEqual({ code: 'PAYMENT_REQUIRED', message: 'Insufficient funds' });
  });

  it('a funded agent-key org still passes (the hint never gates spending)', async () => {
    await expect(
      assertPositiveBalance('org-funded', fakeSql([{ balance: '1' }]), AGENT_POLICIES),
    ).resolves.toBeUndefined();
  });

  it('missing org row + agent key → same hinted 402 (fail closed)', async () => {
    const err = await assertPositiveBalance('org-missing', fakeSql([]), AGENT_POLICIES).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).topup).toEqual(EXPECTED_TOPUP);
  });
});

// ── Refusal site 2: settleCharge P0003 ───────────────────────────────────────

describe('settleCharge — P0003 mapping', () => {
  const baseArgs = (policies?: Record<string, unknown>) => ({
    orgId: '22222222-2222-4222-8222-222222222222',
    settlementRequestId: stlId(),
    costCredits: 1000,
    policies,
  });

  it('agent key → unified 402 body with the topup hint', async () => {
    const err = await settleCharge(
      baseArgs(AGENT_POLICIES),
      rejectingClient({ code: 'P0003' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).status).toBe(402);
    expect((err as InsufficientFundsError).toResponseBody()).toEqual({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'Insufficient funds',
        topup: EXPECTED_TOPUP,
      },
    });
  });

  it('no policies → legacy 402 body without topup', async () => {
    const err = await settleCharge(
      baseArgs(),
      rejectingClient({ code: 'P0003' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    const body = (err as InsufficientFundsError).toResponseBody() as {
      error: Record<string, unknown>;
    };
    expect('topup' in body.error).toBe(false);
  });

  it('non-money SQLSTATE mappings are unchanged (P0001 still BAD_REQUEST)', async () => {
    const err = await settleCharge(
      baseArgs(AGENT_POLICIES),
      rejectingClient({ code: 'P0001' }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
  });
});

// ── Refusal site 3: admission P0003 ──────────────────────────────────────────

describe('queryAdmission — P0003 mapping', () => {
  /** Any fragment works: the rejecting client ignores the embedded call. */
  const fragment = null as never;

  it('agent key policies → unified 402 body with the topup hint', async () => {
    const err = await queryAdmission(
      rejectingClient({ code: 'P0003' }),
      'admit',
      fragment,
      AGENT_POLICIES,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).status).toBe(402);
    expect((err as InsufficientFundsError).toResponseBody()).toEqual({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'Insufficient funds',
        topup: EXPECTED_TOPUP,
      },
    });
  });

  it('no policies → legacy 402 body without topup', async () => {
    const err = await queryAdmission(
      rejectingClient({ code: 'P0003' }),
      'admit',
      fragment,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    const body = (err as InsufficientFundsError).toResponseBody() as {
      error: Record<string, unknown>;
    };
    expect('topup' in body.error).toBe(false);
  });

  it('P0004 still maps to ADMISSION_UNAVAILABLE (transport mapping unchanged)', async () => {
    const err = await queryAdmission(
      rejectingClient({ code: 'P0004' }),
      'admit',
      fragment,
      AGENT_POLICIES,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ADMISSION_UNAVAILABLE', status: 503 });
  });
});

// ── HTTP rendering through the REAL gateway error handler ───────────────────

describe('HTTP 402 rendering via applyAiagErrorHandler', () => {
  function build(policies?: Record<string, unknown>): Hono {
    const app = new Hono();
    applyAiagErrorHandler(app);
    app.post('/v1/chat/completions', async (c) => {
      // Route-layer stand-in: the Hono context holder passes key.policies in.
      await assertPositiveBalance('org-empty', fakeSql([{ balance: '0' }]), policies);
      return c.json({ ok: true });
    });
    return app;
  }

  it('agent key: 402 + Retry-After: 30 + body with topup', async () => {
    const res = await build(AGENT_POLICIES).fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('Retry-After')).toBe('30');
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'Insufficient funds',
        topup: EXPECTED_TOPUP,
      },
    });
  });

  it('human key: 402, legacy body, NO Retry-After header', async () => {
    const res = await build().fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('Retry-After')).toBeNull();
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect('topup' in body.error).toBe(false);
    expect(body.error).toEqual({ code: 'PAYMENT_REQUIRED', message: 'Insufficient funds' });
  });

  it('a plain AiagError renders without a Retry-After header (change is additive)', async () => {
    const app = new Hono();
    applyAiagErrorHandler(app);
    app.post('/v1/x', () => {
      throw new AiagError('SERVICE_UNAVAILABLE', 503, 'x');
    });
    const res = await app.fetch(new Request('http://x/v1/x', { method: 'POST' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});
