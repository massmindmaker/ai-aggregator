import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * Startonus mint callback — the DOCUMENTED shape (docs research 2026-07-12,
 * bot.startonus.com/docs + OpenAPI). Mirrors `StartonusCallback` in
 * packages/shared/src/startonus.ts.
 *
 * ⚠️ `item` is an OBJECT `{index, address, owner, meta}` — NOT a bare address string.
 * Our earlier code typed it as a string and used it directly as an idempotency key, which
 * would have keyed on "[object Object]". On failure the payload carries `error:{code,message}`
 * — a field we previously did not model at all, so failures were silently ignored.
 */
interface MembershipCallback {
  success?: boolean;
  item?: { index?: number; address?: string; owner?: unknown; meta?: unknown };
  error?: { code?: string | number; message?: string };
  /** Echoed from GenerateInvoiceParams.userData = our tg_membership_charges.id */
  userData?: string;
}

/**
 * POST /api/tma/membership/webhook — Startonus mint callback receiver (issue #29).
 *
 * 🔴 THIS ROUTE DOES NOT GRANT MEMBERSHIP. It never did anything the chain can't prove.
 *
 * Why: the Startonus callback is (a) unsigned, (b) never retried, (c) unbacked by any status
 * endpoint we could poll. It is a HINT, not evidence. The authoritative grant happens in
 * apps/agent-worker/src/membership-reconciler.ts, which reads the CHAIN (tonapi) and grants
 * only when an item in OUR collection is actually owned by the charge's ton-proof-verified
 * recipient wallet, claimed exactly-once by the item's on-chain address.
 *
 * Consequences, by construction rather than by a check:
 *   - a FORGED callback (valid token, no real mint) grants nothing — the chain has no item;
 *   - a LOST callback (pm2 restart mid-deploy) costs nothing — the reconciler still grants;
 *   - a DOUBLE callback grants nothing twice — there is only one grant path, gated on a
 *     PK claim over the item address.
 *
 * What this route DOES do:
 *   1. record the item address the callback claims (a hint that lets the reconciler settle
 *      on its very next tick, and evidence that the user has paid — the purchase route's TTL
 *      sweep refuses to expire a charge carrying it, so nobody is asked to pay twice);
 *   2. handle the documented `error:{code,message}` branch — mark the charge `failed` and LOG
 *      the reason instead of silently leaving it pending.
 *
 * Auth (issue #29 round 6, MEDIUM): a DEDICATED `MEMBERSHIP_WEBHOOK_SECRET` — not
 * Phase-16's `TRANSFER_WEBHOOK_SECRET` — and the token is NOT the raw secret. The purchase
 * route computes HMAC-SHA256(MEMBERSHIP_WEBHOOK_SECRET, chargeId) per charge and puts THAT
 * in the callback URL; this route recomputes the same HMAC over the charge id the callback
 * body claims (`userData`) and compares. Startonus cannot send custom headers on its
 * callback (only a plain callbackUrl — packages/shared/src/startonus.ts:49-50 / their
 * OpenAPI has no header option), so a token still rides in the query string and can land in
 * access logs — but a per-charge HMAC means a leaked token authenticates callbacks for that
 * ONE charge only: it cannot be replayed against any other charge and does not expose the
 * master secret. Combined with "this route grants nothing" (above), a leaked token buys an
 * attacker at most a forged hint/failure on one already-known charge id, never a membership.
 * Header form (`x-webhook-token`) is still accepted first, for a future/nginx-injected path.
 */
export async function POST(req: NextRequest) {
  const WEBHOOK_SECRET = process.env.MEMBERSHIP_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length === 0) {
    console.error('[membership/webhook] MEMBERSHIP_WEBHOOK_SECRET unset — refusing (fail-hard)');
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
  }

  let body: MembershipCallback;
  try {
    body = (await req.json()) as MembershipCallback;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { userData, success, item, error } = body;
  if (!userData) {
    return NextResponse.json({ error: 'missing_user_data' }, { status: 400 });
  }

  {
    // Per-charge token verification (see auth note above) — must happen AFTER we know
    // `userData`, since the expected token is derived from it.
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(userData).digest('hex');
    const supplied =
      req.headers.get('x-webhook-token') ?? req.nextUrl.searchParams.get('token') ?? '';
    const got = Buffer.from(supplied);
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const rows = (await sql`
    SELECT id::text, status, tx_hash, item_address FROM tg_membership_charges
    WHERE id = ${userData}::uuid LIMIT 1
  `) as unknown as Array<{
    id: string;
    status: string;
    tx_hash: string | null;
    item_address: string | null;
  }>;
  const c = rows[0];
  if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // FAILED MINT — the documented error branch. Never silent: log the reason and make the
  // charge terminal so the user is not stuck behind the one-pending-per-user UNIQUE.
  //
  // 🔴 HIGH-4 / MEDIUM-1 (round 6): a forged/erroneous callback must not be able to BURY a
  // charge the user already paid for. Two layers now: (a) the reconciler's stuck pool
  // sweeps EVERY 'failed'/'needs_review' row regardless of evidence (round 6 fix — a charge
  // that error'd out in the window BEFORE evidence existed used to be invisible to every
  // pool forever), so a wrongly-`failed` paid charge is still periodically re-checked
  // against the chain and can self-heal to `settled`; (b) we still prefer `needs_review`
  // over `failed` whenever evidence already exists, purely for VISIBILITY — `needs_review`
  // triggers the loud "ALERT: N charge(s) in needs_review" log every sweep, `failed` does
  // not. Money-safety no longer depends on which of the two labels is chosen.
  if (success === false || error) {
    const hasEvidence = !!c.tx_hash || !!c.item_address;
    const reason = `minter_error: code=${error?.code ?? 'n/a'} message=${error?.message ?? 'n/a'}`;
    console.error(
      `[membership/webhook] mint failed charge=${c.id} hasEvidence=${hasEvidence} ${reason}`,
    );
    await sql`
      UPDATE tg_membership_charges
      SET status = ${hasEvidence ? 'needs_review' : 'failed'},
          failure_reason = ${reason}
      WHERE id = ${c.id}::uuid AND status NOT IN ('settled', 'failed', 'needs_review')
    `;
    return NextResponse.json({ ok: true });
  }

  // SUCCESS HINT. `item.address` is the on-chain identity; anything else is noise.
  const itemAddress = typeof item?.address === 'string' ? item.address : null;
  if (!itemAddress) {
    console.warn(`[membership/webhook] success callback without item.address charge=${c.id}`);
    return NextResponse.json({ ok: true, ignored: 'no_item_address' });
  }

  // Record the hint + the payment evidence. NOT a grant: the reconciler verifies this item
  // against the chain and grants there. Guarded on 'pending' so a settled/failed charge is
  // never rewritten by a late or replayed callback.
  await sql`
    UPDATE tg_membership_charges
    SET item_address = COALESCE(item_address, ${itemAddress})
    WHERE id = ${c.id}::uuid AND status = 'pending'
  `;

  return NextResponse.json({ ok: true, recorded: true });
}
