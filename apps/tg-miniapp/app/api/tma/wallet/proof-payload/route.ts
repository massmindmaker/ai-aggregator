import { NextRequest, NextResponse } from 'next/server';
import { generateProofPayload } from '@/lib/ton-proof';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tma/wallet/proof-payload — issue a ton_proof challenge payload.
 * The frontend feeds it to TonConnectUI.setConnectRequestParameters so the
 * wallet signs OUR nonce; wallet/link then verifies the returned proof.
 * Stateless (HMAC + timestamp), 15-minute TTL.
 */
export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ payload: generateProofPayload() });
}
