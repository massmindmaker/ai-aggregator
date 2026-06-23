import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { Address, beginCell, toNano } from '@ton/core';
import { getTonUsdRate } from '@/lib/ton-rate';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

type Asset = 'TON' | 'USDT';

interface Body {
  amount_credits: number;
  wallet_address: string;
  asset?: Asset; // default 'TON' (backwards compatible with existing clients)
}

// D-1: amounts are integer credits (US cents, 1 credit = $0.01).
// MIN 100 credits ($1), MAX 50_000 credits ($500).
const MIN_CREDITS = 100;
const MAX_CREDITS = 50_000;
const TX_VALID_FOR_S = 600; // 10 min

// USDT-on-TON: USD-pegged credit WITHOUT an oracle — 1 USDT = 100 credits ($1).
// USDT-on-TON jetton has 6 decimals → 1 USDT = 1_000_000 smallest units, so
// jetton units = (amount_credits / 100) * 1e6 = amount_credits * 1e4 (cents→units).
const USDT_UNITS_PER_CENT = 10_000n;
const USDT_JETTON_DECIMALS = 6;
// Gas the WALLET must attach (in TON) so the jetton transfer message lands.
const USDT_TX_GAS_NANO = toNano('0.05').toString();
const USDT_FWD_TON_NANO = toNano('0.01').toString(); // forward amount → notify + carry comment

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

  // App-level spam guard (R2). Fail-open if Redis is down — money truth lives in the
  // reconciler over the verified on-chain deposit, this only throttles init spam.
  const rl = await checkRateLimit('topup', tgUserId);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'too_many_requests', retry_after: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

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
  const asset: Asset = body.asset === 'USDT' ? 'USDT' : 'TON';
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

  // ----- USDT-on-TON branch (0043): fixed USD peg, NO oracle rate -----
  if (asset === 'USDT') {
    return await initUsdtTopup(tgUserId, amountCredits, walletAddress);
  }

  // ----- native TON branch (UNCHANGED, oracle rate) -----
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
      amount_credits, status, comment_tag, asset, network, expected_amount,
      quote_ts, created_at
    )
    VALUES (
      ${tgUserId}::bigint,
      ${walletAddress},
      ${amountNanoBig.toString()}::bigint,
      ${rateUsdCentsPerTon}::bigint,
      ${amountCredits}::bigint,
      'pending',
      ${tag},
      'TON',
      'ton',
      ${amountNanoBig.toString()}::bigint,
      NOW(),
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

/**
 * USDT-on-TON top-up init (0043). USD-pegged credit WITHOUT an oracle: the credits
 * the user requested map 1:1 to a fixed-peg USDT amount (100 credits = 1 USDT), so
 * there is no rate quote to time-bound — the conversion is constant.
 *
 * On-chain shape (TEP-74 jetton transfer): the wallet sends a `transfer` message to
 * the USER's OWN USDT jetton-wallet (resolved client-side via TON Connect from the
 * jetton master), which forwards `amount` USDT to OUR receiver and carries the
 * `topup:<tag>` comment in the forward_payload. The reconciler matches that comment
 * + amount on TonCenter v3 `/jetton/transfers` and credits idempotently.
 *
 * We return the jetton `transfer` body (base64 BOC) + the destination + the gas to
 * attach. The CLIENT must set the message `address` to the sender's jetton wallet
 * (it knows the master from TMA_USDT_JETTON_MASTER / env). expected_amount is
 * persisted in jetton smallest units so the reconciler compares received >= expected.
 *
 * TODO(testnet): verify the jetton transfer op (0x0f8a7ea5) + forward_payload comment
 * lands as a readable comment on TonCenter v3 jetton-transfers before mainnet.
 */
async function initUsdtTopup(
  tgUserId: string,
  amountCredits: number,
  walletAddress: string,
): Promise<NextResponse> {
  const receiver = process.env.TMA_TOPUP_WALLET_ADDRESS;
  if (!receiver) {
    return NextResponse.json({ error: 'topup_not_configured' }, { status: 503 });
  }
  const jettonMaster = process.env.TMA_USDT_JETTON_MASTER;
  if (!jettonMaster) {
    // Honest 503 — do not pretend USDT is configured if the master isn't set.
    return NextResponse.json({ error: 'usdt_not_configured' }, { status: 503 });
  }

  // cents → jetton smallest units (6 decimals): credits * 1e4.
  const jettonUnits = BigInt(amountCredits) * USDT_UNITS_PER_CENT;

  const tag = randomTag(8);
  const comment = `topup:${tag}`;

  // TEP-74 jetton transfer body. forward_ton_amount > 0 so the comment is delivered
  // as a transfer notification the receiver (and TonCenter) can read.
  let destAddr: Address;
  try {
    destAddr = Address.parse(receiver);
  } catch {
    return NextResponse.json({ error: 'topup_misconfigured' }, { status: 500 });
  }
  const forwardComment = beginCell().storeUint(0, 32).storeStringTail(comment).endCell();
  const transferBody = beginCell()
    .storeUint(0x0f8a7ea5, 32) // op::transfer (TEP-74)
    .storeUint(0, 64) // query_id
    .storeCoins(jettonUnits) // jetton amount
    .storeAddress(destAddr) // destination (our receiver wallet)
    .storeAddress(destAddr) // response_destination (excess → us)
    .storeBit(0) // no custom_payload
    .storeCoins(BigInt(USDT_FWD_TON_NANO)) // forward_ton_amount
    .storeBit(1) // forward_payload stored as ref
    .storeRef(forwardComment)
    .endCell();
  const payload = transferBody.toBoc().toString('base64');

  const ins = (await sql`
    INSERT INTO tg_topups (
      tg_user_id, wallet_address, amount_nano_ton, rate_usd_cents_per_ton,
      amount_credits, status, comment_tag, asset, network, expected_amount,
      quote_ts, created_at
    )
    VALUES (
      ${tgUserId}::bigint,
      ${walletAddress},
      0,
      100,
      ${amountCredits}::bigint,
      'pending',
      ${tag},
      'USDT',
      'ton',
      ${jettonUnits.toString()}::bigint,
      NOW(),
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
    asset: 'USDT',
    amount_credits: amountCredits,
    amount_usdt: (amountCredits / 100).toFixed(2),
    jetton_units: jettonUnits.toString(),
    jetton_master: jettonMaster,
    jetton_decimals: USDT_JETTON_DECIMALS,
    receiver,
    comment,
    comment_tag: tag,
    // The wallet message must target the SENDER's jetton wallet (resolved from
    // jetton_master client-side); attach USDT_TX_GAS_NANO TON for gas.
    transaction: {
      validUntil,
      gas_nano_ton: USDT_TX_GAS_NANO,
      payload,
    },
  });
}
