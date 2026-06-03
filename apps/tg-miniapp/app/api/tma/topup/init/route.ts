import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { beginCell } from '@ton/core';
import { getTonUsdRate } from '@/lib/ton-rate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Body {
  amount_credits: number;
  wallet_address: string;
}

// D-1: amounts are integer credits (US cents, 1 credit = $0.01).
// MIN 100 credits ($1), MAX 50_000 credits ($500).
const MIN_CREDITS = 100;
const MAX_CREDITS = 50_000;
const TX_VALID_FOR_S = 600; // 10 min

function randomTag(len = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const receiver = process.env.TMA_TOPUP_WALLET_ADDRESS;
  if (!receiver) {
    return NextResponse.json({ error: 'topup_not_configured' }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const amountCredits = Number(body.amount_credits);
  const walletAddress = body.wallet_address;
  if (
    !Number.isFinite(amountCredits) ||
    !Number.isInteger(amountCredits) ||
    amountCredits < MIN_CREDITS ||
    amountCredits > MAX_CREDITS
  ) {
    return NextResponse.json(
      { error: 'amount_out_of_range', min: MIN_CREDITS, max: MAX_CREDITS },
      { status: 400 },
    );
  }
  if (!walletAddress || typeof walletAddress !== 'string') {
    return NextResponse.json({ error: 'wallet_address_required' }, { status: 400 });
  }

  let rateUsd: number;
  try {
    rateUsd = await getTonUsdRate(); // USD per 1 TON
  } catch (e) {
    return NextResponse.json(
      { error: 'rate_unavailable', detail: e instanceof Error ? e.message : 'rate' },
      { status: 502 },
    );
  }

  // credits are US cents → dollars; amount_nano_ton = ceil(amount_usd / rate * 1e9)
  const amountUsd = amountCredits / 100;
  const amountNanoBig = BigInt(Math.ceil((amountUsd / rateUsd) * 1e9));
  // Audit the conversion rate at top-up time, in US cents per TON (integer).
  const rateUsdCentsPerTon = Math.round(rateUsd * 100);

  const tag = randomTag(8);
  const comment = `topup:${tag}`;

  // TON text comment: opcode 0 (32 bits) + utf8 string tail.
  const cell = beginCell().storeUint(0, 32).storeStringTail(comment).endCell();
  const payload = cell.toBoc().toString('base64');

  const ins = (await sql`
    INSERT INTO tg_topups (
      tg_user_id, wallet_address, amount_nano_ton, rate_usd_cents_per_ton,
      amount_credits, status, comment_tag, created_at
    )
    VALUES (
      ${tgUserId}::bigint,
      ${walletAddress},
      ${amountNanoBig.toString()}::bigint,
      ${rateUsdCentsPerTon}::bigint,
      ${amountCredits}::bigint,
      'pending',
      ${tag},
      NOW()
    )
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;
  const topupId = ins[0]?.id;
  if (!topupId) {
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  const validUntil = Math.floor(Date.now() / 1000) + TX_VALID_FOR_S;

  return NextResponse.json({
    topup_id: topupId,
    amount_credits: amountCredits,
    amount_nano_ton: amountNanoBig.toString(),
    rate_usd_cents_per_ton: rateUsdCentsPerTon,
    comment,
    comment_tag: tag,
    transaction: {
      validUntil,
      messages: [
        {
          address: receiver,
          amount: amountNanoBig.toString(),
          payload,
        },
      ],
    },
  });
}
