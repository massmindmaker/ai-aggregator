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
// USDT-on-TON jetton has 6 decimals → 1 USDT = 1_000_000 smallest units, and the
// USD-peg credit rule is fixed (no oracle): 1 USDT = 100 credits ($1 = 100 cents).
// expected_amount on a USDT topup row is already in jetton smallest units, so the
// reconciler only has to compare received >= expected and credit amount_credits.
const USDT_MASTER_DEFAULT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'; // USD₮ jetton master (mainnet)
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
  asset: string;            // 'TON' | 'USDT' (0043); legacy rows default 'TON'
  expected_amount: string | null; // smallest-unit expected (USDT jetton: 1e6/USDT)
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
    // Issue #4: no verifiable on-chain tx hash → NO-match. Never credit a
    // hash-less deposit, and never let '' act as the global dedup key.
    const hash = tx.transaction_id?.hash ?? tx.hash ?? '';
    if (!hash) continue;
    return hash;
  }
  return null;
}

// --- USDT-on-TON (jetton) branch (R2-readiness, 0043) ---------------------
//
// Native-TON is matched above off the receiver's plain `/transactions` in_msg
// comment. USDT-on-TON is a JETTON transfer: the value rides a separate jetton
// wallet, not the TON `value`, so we read TonCenter v3 `/jetton/transfers` for
// the receiver, match on the forward-payload comment `topup:<tag>` and on
// received jetton amount >= expected_amount, and credit with the SAME idempotent
// creditTopup path (status-guard + uq_ledger_ref). No native logic is touched.
//
// TODO(testnet): verify the exact v3 jetton-transfer field shape against a real
// testnet transfer — comment location (forward_payload vs decoded comment),
// `destination`/`source` address form, and the amount field key can differ by
// TonCenter version. Adjust extractJettonComment / amount parse if so.

interface TonCenterJettonTransfer {
  transaction_hash?: string;
  transaction_id?: { hash?: string };
  hash?: string;
  amount?: string | number;            // jetton smallest units
  destination?: string;                // receiver (our wallet) for inbound
  jetton_master?: string;
  comment?: string;                    // v3 sometimes decodes the text comment
  forward_payload?: string;
  custom_payload?: string;
  transaction_now?: number;
}

async function fetchRecentJettonTransfers(
  receiver: string,
): Promise<TonCenterJettonTransfer[] | null> {
  const tcBase = process.env.TONCENTER_API_URL ?? 'https://toncenter.com/api/v3';
  const url = new URL(`${tcBase.replace(/\/$/, '')}/jetton/transfers`);
  // Inbound transfers landing on our receiver wallet. v3 supports owner_address
  // (the jetton-wallet owner). direction=in narrows to received transfers.
  url.searchParams.set('owner_address', receiver);
  url.searchParams.set('direction', 'in');
  const usdtMaster = process.env.TMA_USDT_JETTON_MASTER ?? USDT_MASTER_DEFAULT;
  if (usdtMaster) url.searchParams.set('jetton_master', usdtMaster);
  url.searchParams.set('limit', String(TX_PAGE_LIMIT));
  url.searchParams.set('sort', 'desc');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.TONCENTER_API_KEY) headers['X-API-Key'] = process.env.TONCENTER_API_KEY;

  try {
    const r = await fetch(url.toString(), { headers });
    if (!r.ok) {
      console.warn(`[topup-reconciler] toncenter jetton ${r.status} — usdt tick skipped`);
      return null;
    }
    const j = (await r.json()) as {
      jetton_transfers?: TonCenterJettonTransfer[];
      transfers?: TonCenterJettonTransfer[];
      result?: TonCenterJettonTransfer[];
    };
    return j.jetton_transfers ?? j.transfers ?? j.result ?? [];
  } catch (e) {
    console.warn(`[topup-reconciler] jetton fetch failed: ${(e as Error).message}`);
    return null;
  }
}

/** Best-effort extraction of the text comment carried by a jetton transfer.
 *  v3 may surface it pre-decoded (`comment`) or only as a forward_payload cell —
 *  we accept either and just substring-match the tag. TODO(testnet): confirm. */
function extractJettonComment(t: TonCenterJettonTransfer): string {
  if (typeof t.comment === 'string' && t.comment) return t.comment;
  if (typeof t.forward_payload === 'string') return t.forward_payload;
  return '';
}

function matchJettonTransfer(
  transfers: TonCenterJettonTransfer[],
  commentTag: string,
  expectedUnits: bigint,
): string | null {
  const expectedComment = `topup:${commentTag}`;
  for (const t of transfers) {
    const text = extractJettonComment(t);
    if (!text || !text.includes(expectedComment)) continue;
    const raw = t.amount;
    const units =
      typeof raw === 'string' ? BigInt(raw) :
      typeof raw === 'number' ? BigInt(Math.floor(raw)) :
      0n;
    if (units < expectedUnits) continue;
    // Issue #4: same rule as native TON — hash-less transfer is NO-match.
    const hash = t.transaction_hash ?? t.transaction_id?.hash ?? t.hash ?? '';
    if (!hash) continue;
    return hash;
  }
  return null;
}

/** Confirm + credit ONE matched topup. Mirrors topup/check/[id] exactly:
 *  tx_hash claim (issue #4 global dedup) → status-guarded UPDATE → balance
 *  upsert → append-only ledger (uq_ledger_ref), all in one transaction. */
async function creditTopup(t: PendingTopup, txHash: string): Promise<boolean> {
  if (!txHash) return false; // defensive: matchers already skip hash-less txs
  let credited = false;
  try {
    await sql.begin(async (sql) => {
      // Issue #4 (CRIT): one on-chain tx may credit at most ONE topup row.
      // The claims PK is the only cross-row guard — a payment whose comment
      // matches several pending tags must not confirm more than one of them.
      const claim = (await sql`
        INSERT INTO tg_topup_tx_claims (tx_hash, topup_id)
        VALUES (${txHash}, ${t.id}::uuid)
        ON CONFLICT (tx_hash) DO NOTHING
        RETURNING tx_hash
      `) as unknown as Array<{ tx_hash: string }>;
      if (claim.length === 0) return; // tx already claimed — no new credit

      const upd = (await sql`
        UPDATE tg_topups
        SET status = 'confirmed', tx_hash = ${txHash}, confirmed_at = NOW()
        WHERE id = ${t.id}::uuid AND status = 'pending'
        RETURNING id::text
      `) as unknown as Array<{ id: string }>;
      // Confirmed by a concurrent client poll — roll back our claim too
      // (that poll's own transaction holds the claim for this tx).
      if (upd.length === 0) throw new Error('race_already_confirmed');

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
  } catch (e) {
    if (!(e instanceof Error && e.message === 'race_already_confirmed')) throw e;
    // race: rolled back, nothing credited by this tick for the row.
  }
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
             comment_tag,
             COALESCE(asset, 'TON') AS asset,
             expected_amount::text AS expected_amount
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
    // Split by asset so each on-chain source is queried at most once per tick.
    const tonPending = pending.filter((t) => t.asset !== 'USDT');
    const usdtPending = pending.filter((t) => t.asset === 'USDT');

    // --- native TON branch (unchanged) ---
    if (tonPending.length > 0) {
      const txs = await fetchRecentInboundTxs(receiver);
      if (txs === null) return; // TonCenter down — rows stay pending, next tick retries
      for (const t of tonPending) {
        try {
          const hash = matchTx(txs, t.comment_tag, BigInt(t.amount_nano_ton));
          if (!hash) continue;
          const credited = await creditTopup(t, hash);
          if (credited) {
            console.log(
              `[topup-reconciler] credited TON topup=${t.id} user=${t.tg_user_id} credits=${t.amount_credits} tx=${hash}`,
            );
          }
        } catch (e) {
          // One bad row must not abort the rest of the sweep.
          console.error(`[topup-reconciler] credit failed topup=${t.id}: ${(e as Error).message}`);
        }
      }
    }

    // --- USDT-on-TON jetton branch (0043) ---
    // Same idempotent creditTopup → uq_ledger_ref guard, so a concurrent client
    // poll can never double-credit. Expected jetton units live in expected_amount.
    if (usdtPending.length > 0) {
      const transfers = await fetchRecentJettonTransfers(receiver);
      if (transfers !== null) {
        for (const t of usdtPending) {
          try {
            // expected_amount should always be set for a USDT row (init route),
            // but if missing, derive from amount_credits: credits are cents,
            // 1 USDT = 100 credits = 1e6 jetton units → units = credits/100 * 1e6
            // = credits * 1e4. Defensive only.
            const expectedUnits =
              t.expected_amount !== null
                ? BigInt(t.expected_amount)
                : BigInt(t.amount_credits) * 10_000n;
            const hash = matchJettonTransfer(transfers, t.comment_tag, expectedUnits);
            if (!hash) continue;
            const credited = await creditTopup(t, hash);
            if (credited) {
              console.log(
                `[topup-reconciler] credited USDT topup=${t.id} user=${t.tg_user_id} credits=${t.amount_credits} tx=${hash}`,
              );
            }
          } catch (e) {
            console.error(
              `[topup-reconciler] usdt credit failed topup=${t.id}: ${(e as Error).message}`,
            );
          }
        }
      }
      // transfers === null (TonCenter down) → USDT rows stay pending, next tick retries.
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
