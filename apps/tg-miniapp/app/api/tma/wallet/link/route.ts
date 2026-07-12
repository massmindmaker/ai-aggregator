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

  // migration 0048 added a partial UNIQUE uq_ton_wallets_verified_address
  // (address) WHERE is_verified=true — a wallet can be the VERIFIED wallet of
  // at most one account (the reconciler's ownership check depends on this).
  // The ON CONFLICT target above only covers (tg_user_id, address); a verified
  // link attempt on an address already verified by a DIFFERENT tg_user_id does
  // not hit that target — it falls through to the INSERT/UPDATE and trips the
  // partial index instead, which Postgres raises as 23505. Catch exactly that
  // constraint and answer with a clean 409; do NOT reassign/steal the wallet —
  // ownership stays with whoever verified it first (money-path invariant,
  // canon §29 review). Anything else (e.g. a different 23505) is a bug, not an
  // expected race, and must keep propagating as a 500.
  let rows: Array<{
    id: string;
    tg_user_id: string;
    address: string;
    public_key: string | null;
    is_verified: boolean;
    linked_at: string;
    last_seen_at: string;
  }>;
  try {
    rows = (await sql`
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
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    if (err.code === '23505' && err.constraint_name === 'uq_ton_wallets_verified_address') {
      return NextResponse.json(
        { error: 'wallet_already_linked', message: 'Этот кошелёк уже привязан к другому аккаунту' },
        { status: 409 },
      );
    }
    throw e;
  }

  return NextResponse.json({ wallet: rows[0] });
}
