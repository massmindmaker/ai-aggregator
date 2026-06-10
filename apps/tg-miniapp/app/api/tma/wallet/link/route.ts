import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { verifyTonProof, type TonProofPayload } from '@/lib/ton-proof';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Body {
  address: string;
  public_key?: string;
  /** base64 BoC of the wallet stateInit (required for verified link) */
  wallet_state_init?: string;
  /** TON Connect ton_proof signed over OUR proof-payload challenge */
  proof?: TonProofPayload;
}

/**
 * Link a TON wallet to the current TMA user.
 * R2.1-A2: when the client sends a ton_proof (signed over our proof-payload
 * challenge) + stateInit, we STRICTLY verify it and link with is_verified=TRUE.
 * A provided-but-invalid proof fails LOUDLY (400) — never silently downgraded.
 * Without a proof the legacy advisory link remains (is_verified=FALSE).
 * Idempotent via UNIQUE (tg_user_id, address); is_verified never downgrades.
 */
export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { address, public_key, wallet_state_init, proof } = body;
  if (!address || typeof address !== 'string' || address.length < 10) {
    return NextResponse.json({ error: 'address_required' }, { status: 400 });
  }

  let verified = false;
  if (proof) {
    if (!public_key || !wallet_state_init) {
      return NextResponse.json({ error: 'proof_incomplete' }, { status: 400 });
    }
    const res = verifyTonProof({ address, public_key, wallet_state_init, proof });
    if (!res.ok) {
      return NextResponse.json({ error: 'proof_invalid', reason: res.reason }, { status: 400 });
    }
    verified = true;
  }

  const rows = (await sql`
    INSERT INTO ton_wallets (tg_user_id, address, public_key, is_verified, linked_at, last_seen_at)
    VALUES (${tgUserId}::bigint, ${address}, ${public_key ?? null}, ${verified}, NOW(), NOW())
    ON CONFLICT (tg_user_id, address) DO UPDATE
      SET last_seen_at = NOW(),
          public_key = COALESCE(EXCLUDED.public_key, ton_wallets.public_key),
          is_verified = ton_wallets.is_verified OR EXCLUDED.is_verified
    RETURNING id::text, tg_user_id::text AS tg_user_id, address, public_key, is_verified,
              linked_at, last_seen_at
  `) as unknown as Array<{
    id: string;
    tg_user_id: string;
    address: string;
    public_key: string | null;
    is_verified: boolean;
    linked_at: string;
    last_seen_at: string;
  }>;

  return NextResponse.json({ wallet: rows[0] });
}
