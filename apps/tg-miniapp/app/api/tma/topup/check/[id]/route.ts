import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Topup {
  id: string;
  tg_user_id: string;
  amount_nano_ton: string;
  amount_rub: string;
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
           amount_rub::text AS amount_rub,
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
    matched = { hash, value: valueNano };
    break;
  }

  if (!matched) {
    return NextResponse.json({ status: 'pending' });
  }

  // Atomic confirm + credit. Re-check status in WHERE to avoid double-credit.
  const upd = (await sql`
    UPDATE tg_topups
    SET status = 'confirmed', tx_hash = ${matched.hash}, confirmed_at = NOW()
    WHERE id = ${topup.id}::uuid AND status = 'pending'
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;

  if (upd.length === 0) {
    // Already confirmed by a concurrent call — re-read final state.
    const re = (await sql`
      SELECT status, tx_hash FROM tg_topups WHERE id = ${topup.id}::uuid LIMIT 1
    `) as unknown as Array<{ status: string; tx_hash: string | null }>;
    return NextResponse.json({ status: re[0]?.status ?? 'confirmed', tx_hash: re[0]?.tx_hash });
  }

  await sql`
    INSERT INTO tg_user_balances (tg_user_id, balance_rub, updated_at)
    VALUES (${topup.tg_user_id}::bigint, ${topup.amount_rub}::numeric, NOW())
    ON CONFLICT (tg_user_id) DO UPDATE
      SET balance_rub = tg_user_balances.balance_rub + EXCLUDED.balance_rub,
          updated_at = NOW()
  `;

  return NextResponse.json({
    status: 'confirmed',
    tx_hash: matched.hash,
    credited_rub: topup.amount_rub,
  });
}
