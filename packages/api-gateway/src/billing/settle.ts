/**
 * Thin wrapper around the `aiag_settle_charge_credits` stored function.
 *
 * T1 (2026-07-16): retargeted from `aiag_settle_charge` (₽) to the credit-unit
 * twin `aiag_settle_charge_credits` (1 credit = 1 US cent, BIGINT) — see
 * packages/database/src/functions/settle-charge.sql. Deliberately a NEW
 * function name, not a rename: a stray call still passing a ₽ amount as
 * `costCredits` now fails loud (`function does not exist` / Postgres numeric
 * validation on a fractional BIGINT arg) instead of silently settling ~92×
 * the intended amount.
 *
 * FIX C2: No pre-check SELECT. Idempotency is handled INSIDE the stored
 * function (SELECT FOR UPDATE + existing api_usage lookup). Wrapper purely
 * translates Postgres error codes to AiagError instances.
 */
import { sql as defaultSql } from '../lib/db';
import { errors } from '../lib/errors';

export type SettleArgs = {
  orgId: string;
  requestId: string;
  /**
   * Whole MICRO-credits (1 credit = 1 US cent = 1000 micro). Integer — see
   * calcCostCredits/calcByokFeeCredits in lib/pricing.ts. Callers MUST guard
   * `costCredits > 0` before calling (a zero-cost micro-rounding is valid and
   * means "don't settle", not "settle for 0" — the stored function raises
   * P0001 INVALID_AMOUNT for <= 0).
   */
  costCredits: number;
  /** Optional per-request context (model_slug, input/output tokens) — written
   *  verbatim to gateway_transactions.metadata for the spend-by-model ledger. */
  metadata?: Record<string, unknown>;
};

export type SettleResult = {
  subPortion: number;
  paygPortion: number;
  newSub: number;
  newPayg: number;
  idempotent: boolean;
};

/**
 * PREFLIGHT balance gate — call at the TOP of every billing route, BEFORE the
 * upstream is invoked (and, for streaming, before a single chunk is sent).
 *
 * WHY: the settlement order was `upstream → settle → 402`, so a zero-balance
 * key still received a full (streamed) answer and only 402'd *after* the fact —
 * a free-answer leak on the stream path (sse.ts calls the upstream before any
 * balance check). This reads the org's spendable balance
 * (`subscription_credits + payg_credits`, BIGINT micro-credits) and throws 402
 * up front if it is <= 0.
 *
 * Constraints honoured: **one indexed SELECT, no network, no estimate.** It is
 * deliberately a coarse "is there anything to spend?" gate (<= 0), not a
 * per-request cost projection — the exact charge is still settled atomically
 * afterwards (settleCharge re-checks funds under `SELECT FOR UPDATE`, so this
 * is a cheap early-out, not the authority).
 *
 * NOT called for BYOK/external — the caller pays their own provider and the
 * commission rule charges zero for upstream (CLAUDE.md); callers guard with
 * `if (!byok)`.
 */
export async function assertPositiveBalance(
  orgId: string,
  client: typeof defaultSql = defaultSql
): Promise<void> {
  const rows = await client<Array<{ balance: string }>>`
    SELECT (subscription_credits + payg_credits)::text AS balance
      FROM organizations
     WHERE id = ${orgId}::uuid
  `;
  const row = rows[0];
  // No org row (shouldn't happen once auth resolved a key with this org_id) OR
  // a non-positive balance → fail closed with 402 before spending upstream.
  // BigInt keeps the comparison exact at the BIGINT micro-credit scale.
  if (!row || BigInt(row.balance) <= 0n) {
    throw errors.paymentRequired();
  }
}

/**
 * Accepts an injectable sql client to simplify testing.
 */
export async function settleCharge(
  args: SettleArgs,
  client: typeof defaultSql = defaultSql
): Promise<SettleResult> {
  try {
    const rows = await client<
      Array<{
        sub_portion: string;
        payg_portion: string;
        new_sub: string;
        new_payg: string;
        idempotent: boolean;
      }>
    >`
      SELECT sub_portion, payg_portion, new_sub, new_payg, idempotent
      FROM aiag_settle_charge_credits(
        ${args.orgId}::uuid,
        ${args.requestId},
        ${args.costCredits}::bigint,
        ${JSON.stringify(args.metadata ?? {})}::jsonb
      )
    `;
    const row = rows[0];
    if (!row) throw errors.unavailable('aiag_settle_charge_credits returned no row');
    return {
      subPortion: Number(row.sub_portion),
      paygPortion: Number(row.payg_portion),
      newSub: Number(row.new_sub),
      newPayg: Number(row.new_payg),
      idempotent: Boolean(row.idempotent),
    };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'P0001') throw errors.badRequest('Invalid amount');
    if (code === 'P0002') throw errors.badRequest('Unknown organization');
    if (code === 'P0003') throw errors.paymentRequired();
    if (code === 'P0004') throw errors.unavailable('Concurrent modification');
    throw e;
  }
}
