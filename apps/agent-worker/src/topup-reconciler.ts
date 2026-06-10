import { sql } from './db.js';

// Server-side reconciler for TON top-ups (R2.1-A1). The TMA's topup/check route
// is a CLIENT-driven poll: if the user closes the Mini App after paying, nobody
// ever matches the on-chain transfer and the topup is stranded `pending` while
// the funds sit on our wallet (R-04 loss-mode 1). This resident tick closes that
// hole: it sweeps ALL pending tg_topups against the receiver wallet's recent
// inbound txs and credits matches with the EXACT same atomic, idempotent
// transaction the route uses — so a concurrent client poll can never double-credit
// (both paths guard on `status='pending'` + the uq_ledger_ref ON CONFLICT).
//
// One tick = ONE TonCenter call (single receiver wallet serves every topup).

const TICK_MS = 120_000; // 2 min — reconciliation fallback, not a latency path
const TX_PAGE_LIMIT = 50;
// Expire only after 7 DAYS pending (UI window is 10 min). The sweep runs
// continuously, so any real payment is matched within minutes of landing;
// a week-old pending row is an abandoned invoice, not lost money.
const EXPIRE_DAYS = 7;

interface PendingTopup {
  id: string;
  tg_user_id: string;
  amount_nano_ton: string;
  amount_credits: string; // US cents, BIGINT as text (D-1)
  comment_tag: string;
}

interface TonCenterTx {
  transaction_id?: { hash?: string };
  hash?: string;
  in_msg?: {
    value?: string | number;
    message?: string;
    msg_data?: { '@type'?: string; text?: string };
  };
}

async function fetchRecentInboundTxs(receiver: string): Promise<TonCenterTx[] | null> {
  const tcBase = process.env.TONCENTER_API_URL ?? 'https://toncenter.com/api/v3';
  const url = new URL(`${tcBase.replace(/\/$/, '')}/transactions`);
  url.searchParams.set('account', receiver);
  url.searchParams.set('limit', String(TX_PAGE_LIMIT));
  url.searchParams.set('sort', 'desc');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.TONCENTER_API_KEY) headers['X-API-Key'] = process.env.TONCENTER_API_KEY;

  try {
    const r = await fetch(url.toString(), { headers });
    if (!r.ok) {
      console.warn(`[topup-reconciler] toncenter ${r.status} — tick skipped`);
      return null;
    }
    const j = (await r.json()) as { transactions?: TonCenterTx[]; result?: TonCenterTx[] };
    return j.transactions ?? j.result ?? [];
  } catch (e) {
    console.warn(`[topup-reconciler] toncenter fetch failed: ${(e as Error).message}`);
    return null;
  }
}

function matchTx(txs: TonCenterTx[], commentTag: string, expectedNano: bigint): string | null {
  const expectedComment = `topup:${commentTag}`;
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    const text =
      typeof inMsg.message === 'string' ? inMsg.message : inMsg.msg_data?.text ?? '';
    if (!text || !text.includes(expectedComment)) continue;
    const rawValue = inMsg.value;
    const valueNano =
      typeof rawValue === 'string' ? BigInt(rawValue) :
      typeof rawValue === 'number' ? BigInt(Math.floor(rawValue)) :
      0n;
    if (valueNano < expectedNano) continue;
    return tx.transaction_id?.hash ?? tx.hash ?? '';
  }
  return null;
}

/** Confirm + credit ONE matched topup. Mirrors topup/check/[id] exactly:
 *  status-guarded UPDATE → balance upsert → append-only ledger (uq_ledger_ref). */
async function creditTopup(t: PendingTopup, txHash: string): Promise<boolean> {
  let credited = false;
  await sql.begin(async (sql) => {
    const upd = (await sql`
      UPDATE tg_topups
      SET status = 'confirmed', tx_hash = ${txHash}, confirmed_at = NOW()
      WHERE id = ${t.id}::uuid AND status = 'pending'
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    if (upd.length === 0) return; // already confirmed by a concurrent client poll

    const bal = (await sql`
      INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
      VALUES (${t.tg_user_id}::bigint, ${t.amount_credits}::bigint, NOW())
      ON CONFLICT (tg_user_id) DO UPDATE
        SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits,
            updated_at = NOW()
      RETURNING balance_credits::text AS balance_credits
    `) as unknown as Array<{ balance_credits: string }>;

    await sql`
      INSERT INTO tg_ledger_entries
        (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES
        (${t.tg_user_id}::bigint, ${t.amount_credits}::bigint, 'topup',
         'tg_topup', ${t.id}::uuid, ${bal[0]!.balance_credits}::bigint)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
    `;
    credited = true;
  });
  return credited;
}

/** One reconcile tick. Exported so it is unit-testable, like runScheduleTick. */
export async function runTopupReconcileTick(): Promise<void> {
  const receiver = process.env.TMA_TOPUP_WALLET_ADDRESS;
  if (!receiver) return; // top-up not configured on this box — nothing to reconcile

  let pending: PendingTopup[];
  try {
    pending = (await sql`
      SELECT id::text,
             tg_user_id::text AS tg_user_id,
             amount_nano_ton::text AS amount_nano_ton,
             amount_credits::text AS amount_credits,
             comment_tag
      FROM tg_topups
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 200
    `) as unknown as PendingTopup[];
  } catch (e) {
    console.error(`[topup-reconciler] pending query failed: ${(e as Error).message}`);
    return;
  }

  if (pending.length > 0) {
    const txs = await fetchRecentInboundTxs(receiver);
    if (txs === null) return; // TonCenter down — rows stay pending, next tick retries

    for (const t of pending) {
      try {
        const hash = matchTx(txs, t.comment_tag, BigInt(t.amount_nano_ton));
        if (!hash) continue;
        const credited = await creditTopup(t, hash);
        if (credited) {
          console.log(
            `[topup-reconciler] credited topup=${t.id} user=${t.tg_user_id} credits=${t.amount_credits} tx=${hash}`,
          );
        }
      } catch (e) {
        // One bad row must not abort the rest of the sweep.
        console.error(`[topup-reconciler] credit failed topup=${t.id}: ${(e as Error).message}`);
      }
    }
  }

  // Conservative expiry — abandoned invoices only, never recent ones.
  try {
    const expired = (await sql`
      UPDATE tg_topups SET status = 'expired'
      WHERE status = 'pending' AND created_at < NOW() - make_interval(days => ${EXPIRE_DAYS})
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    if (expired.length > 0) {
      console.log(`[topup-reconciler] expired ${expired.length} abandoned topup(s)`);
    }
  } catch (e) {
    console.error(`[topup-reconciler] expiry failed: ${(e as Error).message}`);
  }
}

/** Start the resident reconciler loop. Same shape as startScheduler. */
export function startTopupReconciler(): { stop: () => void } {
  const timer = setInterval(() => {
    void runTopupReconcileTick();
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[topup-reconciler] reconcile-tick every ${TICK_MS / 1000}s`);
  return { stop: () => clearInterval(timer) };
}
