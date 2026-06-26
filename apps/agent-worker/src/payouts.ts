// payouts.ts — author-payout SCAFFOLD (R2-readiness, 0043). MONEY-OUT.
//
// ⚠️ SAFETY CONTRACT (read first):
//   Real on-chain sends happen ONLY when BOTH hold:
//     1. process.env.TON_PAYOUTS_ENABLED === 'true'
//     2. a payout wallet is configured (TON_PAYOUT_MNEMONIC set)
//   Otherwise EVERY path here is a no-op write: a payout REQUEST is recorded in
//   author_payouts as 'pending' and NOTHING leaves the wallet. This is the default.
//   The on-chain send is intentionally a thin, audited-later wrapper — the contract
//   layer + mainnet send wait for the audit (R&D synthesis 2026-06-13). settleRun
//   and the debit path are NOT touched by this file.
//
// Accrual model: an author's income is the SUM of their 'rent_credit' ledger
// entries MINUS any income already consumed by prior payouts. A payout request
// (a) checks available income, (b) inserts an author_payouts row 'pending', and
// (c) posts the matching OFF-CHAIN debit ledger entry (kind='author_payout',
// ref_id=payout.id) under the live uq_ledger_ref idempotency index — so the same
// income can never be paid out twice. The actual USDT transfer is a SEPARATE step
// (batchPayout), gated by the flag.

import { sql } from './db.js';

const PAYOUT_ASSET = 'USDT';
// USDT-on-TON peg (mirror of topup/init): 1 USDT = 100 credits ($1); 6 decimals.
const USDT_UNITS_PER_CENT = 10_000n;

export function payoutsEnabled(): boolean {
  return process.env.TON_PAYOUTS_ENABLED === 'true' && !!process.env.TON_PAYOUT_MNEMONIC;
}

/** Lifetime income (US cents) credited to an author via rent_credit ledger rows. */
async function lifetimeIncomeCredits(authorTgUserId: string): Promise<bigint> {
  const rows = (await sql`
    SELECT COALESCE(SUM(delta_credits), 0)::text AS total
    FROM tg_ledger_entries
    WHERE tg_user_id = ${authorTgUserId}::bigint
      AND kind = 'rent_credit'
  `) as unknown as Array<{ total: string }>;
  return BigInt(rows[0]?.total ?? '0');
}

/** Income already committed to payouts (any non-failed payout). The off-chain
 *  debit ledger row exists for these, so they are "spent" income. */
async function committedPayoutCredits(authorTgUserId: string): Promise<bigint> {
  const rows = (await sql`
    SELECT COALESCE(SUM(amount_credits), 0)::text AS total
    FROM author_payouts
    WHERE author_tg_user_id = ${authorTgUserId}::bigint
      AND status <> 'failed'
  `) as unknown as Array<{ total: string }>;
  return BigInt(rows[0]?.total ?? '0');
}

/** Current spendable balance (US cents) — rent income lands here too. */
async function spendableBalanceCredits(authorTgUserId: string): Promise<bigint> {
  const rows = (await sql`
    SELECT COALESCE(balance_credits, 0)::text AS bal
    FROM tg_user_balances
    WHERE tg_user_id = ${authorTgUserId}::bigint
    LIMIT 1
  `) as unknown as Array<{ bal: string }>;
  return BigInt(rows[0]?.bal ?? '0');
}

/**
 * Income an author can still withdraw = lifetime income − committed payouts,
 * CAPPED by the current spendable balance.
 *
 * H1 DOUBLE-COUNT GUARD (mirror of author-income GET): rent income credits land in
 * the SAME spendable balance the author already spends on runs/rent. So
 * `income − committed` over-states the withdrawable amount once income was spent —
 * paying it out would double-count. min(income−committed, spendable_balance) is the
 * simplest robust cap so the worker never pays more than is actually backed.
 */
export async function availableIncomeCredits(authorTgUserId: string): Promise<bigint> {
  const [income, committed, spendable] = await Promise.all([
    lifetimeIncomeCredits(authorTgUserId),
    committedPayoutCredits(authorTgUserId),
    spendableBalanceCredits(authorTgUserId),
  ]);
  const earnedMinusPaid = income - committed;
  const capped = earnedMinusPaid < spendable ? earnedMinusPaid : spendable;
  return capped > 0n ? capped : 0n;
}

export class InsufficientIncomeError extends Error {
  constructor() {
    super('insufficient_income');
    this.name = 'InsufficientIncomeError';
  }
}

export interface PayoutRequestResult {
  payout_id: string;
  status: string; // 'pending' (always — sending is a separate, flag-gated step)
  amount_credits: string;
}

/**
 * Record an author-payout REQUEST. NO funds move here regardless of the flag —
 * this only reserves income (off-chain debit ledger row) and queues a 'pending'
 * payout. The transfer is done later by batchPayout (flag-gated).
 *
 * Atomicity: the available-income re-check, the author_payouts insert, and the
 * off-chain debit ledger entry all run in ONE sql.begin. The ledger insert is
 * idempotent (uq_ledger_ref on ref_kind='author_payout', ref_id=payout.id) so a
 * retry can't double-debit. We do NOT touch tg_user_balances — income spendability
 * is separate; this debit is the audit record that the income was committed to a
 * cash-out (it prevents paying the same income twice).
 */
export async function requestPayout(
  authorTgUserId: string,
  amountCredits: number,
  destAddress: string,
): Promise<PayoutRequestResult> {
  if (!Number.isInteger(amountCredits) || amountCredits <= 0) {
    throw new Error('invalid_amount');
  }
  if (!destAddress || typeof destAddress !== 'string') {
    throw new Error('dest_address_required');
  }
  const amount = BigInt(amountCredits);

  let result: PayoutRequestResult | null = null;
  await sql.begin(async (sql) => {
    // Re-check available income INSIDE the tx (committed-payouts sum is read here,
    // so two concurrent requests can't both pass the guard for the same income).
    const incomeRows = (await sql`
      SELECT COALESCE(SUM(delta_credits), 0)::text AS total
      FROM tg_ledger_entries
      WHERE tg_user_id = ${authorTgUserId}::bigint AND kind = 'rent_credit'
    `) as unknown as Array<{ total: string }>;
    const committedRows = (await sql`
      SELECT COALESCE(SUM(amount_credits), 0)::text AS total
      FROM author_payouts
      WHERE author_tg_user_id = ${authorTgUserId}::bigint AND status <> 'failed'
    `) as unknown as Array<{ total: string }>;
    const available = BigInt(incomeRows[0]?.total ?? '0') - BigInt(committedRows[0]?.total ?? '0');
    if (available < amount) throw new InsufficientIncomeError();

    const ins = (await sql`
      INSERT INTO author_payouts
        (author_tg_user_id, amount_credits, asset, dest_address, status)
      VALUES
        (${authorTgUserId}::bigint, ${amount.toString()}::bigint, ${PAYOUT_ASSET},
         ${destAddress}, 'pending')
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    const payoutId = ins[0]!.id;

    // Off-chain debit ledger row (audit; prevents double-payout of same income).
    // balance_after is the running rent income net of committed payouts — kept as
    // the audited figure for this kind (it does NOT touch tg_user_balances).
    await sql`
      INSERT INTO tg_ledger_entries
        (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES
        (${authorTgUserId}::bigint, ${(-amount).toString()}::bigint, 'author_payout',
         'author_payout', ${payoutId}::uuid, ${(available - amount).toString()}::bigint)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
    `;

    result = {
      payout_id: payoutId,
      status: 'pending',
      amount_credits: amount.toString(),
    };
  });

  if (!result) throw new Error('payout_request_failed');
  return result;
}

/**
 * Pay out queued 'pending' author_payouts via direct USDT-on-TON transfers.
 *
 * ⚠️ Real on-chain send ONLY when payoutsEnabled() (TON_PAYOUTS_ENABLED='true' AND
 * TON_PAYOUT_MNEMONIC set). Otherwise this is a NO-OP: it logs the count and returns
 * { sent: 0, skipped } without claiming or touching any row — funds never move.
 *
 * Single-worker seqno serialization: ONE payout wallet, ONE seqno; we claim rows
 * one at a time (status pending → sending guarded UPDATE), send, advance seqno,
 * then mark sent. Running this in a single worker process is the serialization
 * boundary (the same resident process owns the wallet seqno). Batched sequentially,
 * NOT in parallel, so seqno never collides.
 *
 * TODO(testnet): wire the real @ton/ton send (commented below) and verify on
 * testnet — WalletContractV4 jetton-wallet resolution, seqno wait, and the
 * jetton-transfer body — BEFORE flipping TON_PAYOUTS_ENABLED on mainnet (awaits audit).
 */
export interface BatchPayoutResult {
  enabled: boolean;
  claimed: number;
  sent: number;
  failed: number;
}

export async function batchPayout(maxBatch = 25): Promise<BatchPayoutResult> {
  if (!payoutsEnabled()) {
    // Safety default: count pending but DO NOT move funds or change state.
    const pend = (await sql`
      SELECT COUNT(*)::int AS n FROM author_payouts WHERE status = 'pending'
    `) as unknown as Array<{ n: number }>;
    const n = pend[0]?.n ?? 0;
    if (n > 0) {
      console.log(
        `[payouts] ${n} pending payout(s) — TON_PAYOUTS_ENABLED off / wallet unconfigured → NOT sending (scaffold)`,
      );
    }
    return { enabled: false, claimed: 0, sent: 0, failed: 0 };
  }

  // --- FLAG ON path (scaffold; real send is TODO(testnet)/audit-gated) ---
  // Lazy-load @ton/ton + @ton/crypto only when actually sending, so the import is
  // never pulled in on the default (disabled) path.
  let sent = 0;
  let failed = 0;
  let claimed = 0;

  // Claim pending rows one-by-one (seqno serialization → strictly sequential).
  for (let i = 0; i < maxBatch; i++) {
    const claimRows = (await sql`
      UPDATE author_payouts
      SET status = 'sending'
      WHERE id = (
        SELECT id FROM author_payouts
        WHERE status = 'pending'
        ORDER BY requested_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text, author_tg_user_id::text AS author_tg_user_id,
                amount_credits::text AS amount_credits, dest_address
    `) as unknown as Array<{
      id: string;
      author_tg_user_id: string;
      amount_credits: string;
      dest_address: string;
    }>;
    const row = claimRows[0];
    if (!row) break; // nothing left to claim
    claimed++;

    try {
      const jettonUnits = BigInt(row.amount_credits) * USDT_UNITS_PER_CENT;
      const txHash = await sendUsdtTransfer(row.dest_address, jettonUnits);
      await sql`
        UPDATE author_payouts
        SET status = 'sent', tx_hash = ${txHash}, sent_at = NOW()
        WHERE id = ${row.id}::uuid
      `;
      sent++;
      console.log(`[payouts] sent payout=${row.id} units=${jettonUnits} tx=${txHash}`);
    } catch (e) {
      failed++;
      await sql`
        UPDATE author_payouts
        SET status = 'failed', error = ${(e as Error).message.slice(0, 500)}
        WHERE id = ${row.id}::uuid
      `;
      console.error(`[payouts] send failed payout=${row.id}: ${(e as Error).message}`);
      // A failed send keeps the off-chain debit ledger row in place; the author can
      // re-request (a fresh payout id) — that is the intended retry path.
    }
  }

  return { enabled: true, claimed, sent, failed };
}

/**
 * Direct USDT-on-TON transfer from the payout wallet to dest. SCAFFOLD: the real
 * @ton/ton implementation is left as TODO(testnet) and only ever reached when the
 * flag is ON. Throws today so an accidental flag flip on an unaudited wallet does
 * NOT silently no-op as "sent" — it fails loudly and the row goes to 'failed'.
 *
 * Real implementation (to enable after testnet + audit):
 *   import { TonClient, WalletContractV4, internal, JettonMaster, JettonWallet } from '@ton/ton';
 *   import { mnemonicToWalletKey } from '@ton/crypto';
 *   - derive key from TON_PAYOUT_MNEMONIC, open WalletContractV4
 *   - resolve OUR jetton wallet from JettonMaster(TMA_USDT_JETTON_MASTER)
 *   - build TEP-74 transfer body (op 0x0f8a7ea5) to dest, forward 0.01 TON
 *   - read seqno, sendTransfer with internal() carrying gas (~0.05 TON)
 *   - poll until seqno advances, return the tx hash
 */
async function sendUsdtTransfer(_dest: string, _jettonUnits: bigint): Promise<string> {
  // TODO(testnet): implement real @ton/ton send + seqno wait + audit before mainnet.
  throw new Error('ton_payout_send_not_implemented');
}
