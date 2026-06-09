import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Upper bound on sale price: 100000 cents = $1000. Rejects absurd / overflow prices.
// Mirrors publish/route.ts MAX_PRICE_CREDITS exactly.
const MAX_PRICE_CREDITS = 100_000;

interface MakeTransferableBody {
  transferable: boolean;
  // NULL / absent = gift-only (no sale price). A positive integer in (0, MAX] = sale price.
  price_credits?: number | null;
}

// POST /tg/api/tma/agents/[id]/make-transferable
//
// Owner opt-in: flips agents.transferable + (optionally) sets agents.transfer_price_credits.
// This is a FREE DB-flag write — NO mint, NO gas, NO chain, NO Startonus call.
// (CONTEXT.md decision #3: "Сделать передаваемым = бесплатный DB-флаг + цена (без газа)".
//  The real mint is lazy and happens in plan 03 at actual transfer.)
//
// Security: the ownership guard `WHERE id AND tg_user_id AND status != 'deleted'` is the
// sole authorization boundary — a non-owner caller gets 0 rows → 404. (T-16-05)
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: MakeTransferableBody;
  try {
    body = (await req.json()) as MakeTransferableBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body.transferable !== 'boolean') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { transferable } = body;

  // price_credits: validate only when enabling transferable.
  // When disabling (transferable: false), price is forced to NULL regardless of body.
  // Validation mirrors publish/route.ts exactly: NULL/absent = no price; else positive int in range.
  let priceCredits: number | null = null;
  if (transferable) {
    if (body.price_credits !== undefined && body.price_credits !== null) {
      const p = body.price_credits;
      if (!Number.isInteger(p) || p <= 0 || p > MAX_PRICE_CREDITS) {
        return NextResponse.json({ error: 'invalid_price' }, { status: 400 });
      }
      priceCredits = p;
    }
  }
  // When transferable = false, priceCredits stays null (forces the column to NULL in UPDATE).

  // Guarded UPDATE — the WHERE clause is the security boundary (T-16-05).
  // Non-owner or deleted agent → 0 rows → 404.
  const upd = (await sql`
    UPDATE agents
    SET transferable             = ${transferable},
        transfer_price_credits   = ${priceCredits},
        updated_at               = NOW()
    WHERE id             = ${params.id}::uuid
      AND tg_user_id     = ${tgUserId}::bigint
      AND status        != 'deleted'
    RETURNING id::text, transferable, transfer_price_credits::text AS transfer_price_credits
  `) as unknown as Array<{ id: string; transferable: boolean; transfer_price_credits: string | null }>;

  if (upd.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ agent: upd[0] }, { status: 200 });
}
