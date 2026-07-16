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
  /** Whole credits (1 credit = 1 US cent). Integer, >= 1 — see calcCostCredits. */
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
