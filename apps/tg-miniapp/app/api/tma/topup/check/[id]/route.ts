import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Topup {
  id: string;
  tg_user_id: string;
  amount_nano_ton: string;
  amount_credits: string; // D-1: credited amount in US cents (BIGINT as text)
  comment_tag: string;
  status: string;
  tx_hash: string | null;
}

interface TonCenterTx {
  transaction_id?: { hash?: string };
  hash?: string;
  in_msg?: {
    value?: string | number;
    message?: string;
    source?: string;
    msg_data?: { '@type'?: string; text?: string };
  };
  utime?: number;
}

/**
 * POST /api/tma/topup/check/:id — reconcile a pending topup against TonCenter.
 * Searches recent inbound txs on TMA_TOPUP_WALLET_ADDRESS for a message comment
 * matching `topup:<tag>` and value >= expected nano. On match — credit balance.
 *
 * MVP: client-driven poll (no cron). Idempotent via tg_topups.status guard.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const receiver = process.env.TMA_TOPUP_WALLET_ADDRESS;
  if (!receiver) return NextResponse.json({ error: 'topup_not_configured' }, { status: 503 });

  const rows = (await sql`
    SELECT id::text,
           tg_user_id::text AS tg_user_id,
           amount_nano_ton::text AS amount_nano_ton,
           amount_credits::text AS amount_credits,
           comment_tag,
           status,
           tx_hash
    FROM tg_topups
    WHERE id = ${params.id}::uuid AND tg_user_id = ${tgUserId}::bigint
    LIMIT 1
  `) as unknown as Topup[];
  const topup = rows[0];
  if (!topup) return NextResponse.json({ error: 'topup_not_found' }, { status: 404 });

  if (topup.status === 'confirmed') {
    return NextResponse.json({ status: 'confirmed', tx_hash: topup.tx_hash });
  }
  if (topup.status === 'failed' || topup.status === 'expired') {
    return NextResponse.json({ status: topup.status });
  }

  const expectedComment = `topup:${topup.comment_tag}`;
  const expectedNano = BigInt(topup.amount_nano_ton);

  // Query TonCenter v3 (works on testnet/mainnet via base url env)
  const tcBase = process.env.TONCENTER_API_URL ?? 'https://toncenter.com/api/v3';
  const url = new URL(`${tcBase.replace(/\/$/, '')}/transactions`);
  url.searchParams.set('account', receiver);
  url.searchParams.set('limit', '20');
  url.searchParams.set('sort', 'desc');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.TONCENTER_API_KEY) {
    headers['X-API-Key'] = process.env.TONCENTER_API_KEY;
  }

  let txs: TonCenterTx[] = [];
  try {
    const r = await fetch(url.toString(), { headers, cache: 'no-store' });
    if (!r.ok) {
      return NextResponse.json(
        { status: 'pending', error: 'toncenter_unavailable', code: r.status },
        { status: 200 },
      );
    }
    const j = (await r.json()) as { transactions?: TonCenterTx[]; result?: TonCenterTx[] };
    txs = j.transactions ?? j.result ?? [];
  } catch (e) {
    return NextResponse.json(
      {
        status: 'pending',
        error: 'toncenter_fetch_failed',
        detail: e instanceof Error ? e.message : 'fetch',
      },
      { status: 200 },
    );
  }

  let matched: { hash: string; value: bigint } | null = null;
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    const text =
      typeof inMsg.message === 'string'
        ? inMsg.message
        : inMsg.msg_data?.text ?? '';
    if (!text || !text.includes(expectedComment)) continue;

    const rawValue = inMsg.value;
    const valueNano =
      typeof rawValue === 'string' ? BigInt(rawValue) :
      typeof rawValue === 'number' ? BigInt(Math.floor(rawValue)) :
      0n;
    if (valueNano < expectedNano) continue;

    const hash = tx.transaction_id?.hash ?? tx.hash ?? '';
    // Issue #4: a deposit without a verifiable on-chain tx hash is NO-match —
    // never credit it, and never let '' become a global dedup key (the first
    // hash-less credit would permanently occupy the '' slot in the claims table).
    if (!hash) continue;
    matched = { hash, value: valueNano };
    break;
  }

  if (!matched) {
    return NextResponse.json({ status: 'pending' });
  }

  // Atomic confirm + credit + ledger, all in ONE transaction so the cached
  // balance and the append-only ledger can never diverge. Re-check status in the
  // WHERE to avoid a double-credit under concurrent polls.
  //
  // Issue #4 (CRIT): the tx_hash claim is the GLOBAL dedup — one on-chain tx can
  // credit at most ONE topup row, ever. Without it, a single payment whose
  // comment substring-matches several pending tags (`topup:A topup:B ...`) would
  // confirm every one of them: the per-row `status='pending'` guard does nothing
  // across DIFFERENT rows. The claim INSERT must be the first write of the same
  // transaction that credits, so a rollback releases nothing incorrectly.
  let credited = false;
  try {
    await sql.begin(async (sql) => {
      const claim = (await sql`
        INSERT INTO tg_topup_tx_claims (tx_hash, topup_id)
        VALUES (${matched!.hash}, ${topup.id}::uuid)
        ON CONFLICT (tx_hash) DO NOTHING
        RETURNING tx_hash
      `) as unknown as Array<{ tx_hash: string }>;
      // tx already claimed (by this or another topup) — no new credit, ever.
      if (claim.length === 0) return;

      const upd = (await sql`
        UPDATE tg_topups
        SET status = 'confirmed', tx_hash = ${matched!.hash}, confirmed_at = NOW()
        WHERE id = ${topup.id}::uuid AND status = 'pending'
        RETURNING id::text
      `) as unknown as Array<{ id: string }>;

      // Confirmed by a concurrent call between our SELECT and this transaction —
      // throw to roll back the claim insert too (that concurrent call owns it).
      if (upd.length === 0) throw new Error('race_already_confirmed');

      // D-1: credit the spendable balance in credits (US cents, BIGINT), and
      // capture the post-credit balance for the ledger's balance_after.
      const bal = (await sql`
        INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
        VALUES (${topup.tg_user_id}::bigint, ${topup.amount_credits}::bigint, NOW())
        ON CONFLICT (tg_user_id) DO UPDATE
          SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits,
              updated_at = NOW()
        RETURNING balance_credits::text AS balance_credits
      `) as unknown as Array<{ balance_credits: string }>;

      // Append-only ledger topup entry (idempotent via uq_ledger_ref).
      await sql`
        INSERT INTO tg_ledger_entries
          (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
        VALUES
          (${topup.tg_user_id}::bigint, ${topup.amount_credits}::bigint, 'topup',
           'tg_topup', ${topup.id}::uuid, ${bal[0]!.balance_credits}::bigint)
        ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
      `;
      credited = true;
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === 'race_already_confirmed')) throw e;
    // race: transaction rolled back, nothing was credited on this call.
  }

  if (!credited) {
    // tx_hash already claimed, or this row was confirmed concurrently —
    // re-read final state and report it honestly. No credit happened here.
    const re = (await sql`
      SELECT status, tx_hash FROM tg_topups WHERE id = ${topup.id}::uuid LIMIT 1
    `) as unknown as Array<{ status: string; tx_hash: string | null }>;
    const finalStatus = re[0]?.status ?? 'pending';
    if (finalStatus === 'confirmed') {
      return NextResponse.json({ status: 'confirmed', tx_hash: re[0]?.tx_hash });
    }
    return NextResponse.json({ status: 'pending', error: 'tx_already_claimed' });
  }

  return NextResponse.json({
    status: 'confirmed',
    tx_hash: matched.hash,
    credited_credits: topup.amount_credits,
  });
}
