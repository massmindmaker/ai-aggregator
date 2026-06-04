import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * GET /api/tma/me/author-income — READ-ONLY money DISPLAY for the authed author.
 *
 * NO money MOVES here. The author's rental income is already credited atomically
 * by the Slice-2 rent route into tg_user_balances.balance_credits; this route only
 * SHOWS it. FD-2 (cash-out) is deferred → the UI shows an honest «скоро» label.
 *
 * EVERYTHING is scoped to the caller's verified tg_user_id (x-tma-user-id, set by
 * middleware from the HS256-pinned JWT `sub`). NEVER another user's rows, NO secrets,
 * NO renter PII beyond a count. Prepared statements only (postgres tagged templates).
 */
interface TemplateRow {
  id: string;
  name: string | null;
  price_credits: string | null;
  clone_count: number;
  visibility: string;
  rental_count: number;
  earned_credits: string;
}

export async function GET(req: NextRequest) {
  const authorId = req.headers.get('x-tma-user-id');
  if (!authorId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    // Lifetime rental earnings: sum of every 'rent_credit' ledger entry that landed
    // on THIS author. Scoped: WHERE tg_user_id = author AND kind = 'rent_credit'.
    const incomeRows = (await sql`
      SELECT COALESCE(SUM(delta_credits), 0)::text AS total_income_credits
      FROM tg_ledger_entries
      WHERE tg_user_id = ${authorId}::bigint
        AND kind = 'rent_credit'
    `) as unknown as Array<{ total_income_credits: string }>;
    const total_income_credits = incomeRows[0]?.total_income_credits ?? '0';

    // Current spendable balance (income is spendable in-app now). Scoped:
    // WHERE tg_user_id = author.
    const balanceRows = (await sql`
      SELECT balance_credits::text AS balance_credits
      FROM tg_user_balances
      WHERE tg_user_id = ${authorId}::bigint
      LIMIT 1
    `) as unknown as Array<{ balance_credits: string }>;
    const spendable_credits = balanceRows[0]?.balance_credits ?? '0';

    // Per-template breakdown — ONLY this author's published templates. Scoped:
    // WHERE t.author_tg_user_id = author. rental_count is a COUNT (no renter PII),
    // earned_credits sums settled charges that paid THIS author, joined to the
    // template via the rental (rc.author_tg_user_id = author is redundant-but-safe
    // belt-and-suspenders so a charge can never be attributed to the wrong author).
    const templates = (await sql`
      SELECT
        t.id::text AS id,
        t.name,
        t.price_credits::text AS price_credits,
        t.clone_count,
        t.visibility,
        (SELECT count(*)::int FROM template_rentals tr
           WHERE tr.template_id = t.id)                       AS rental_count,
        (SELECT COALESCE(SUM(rc.amount_credits), 0)::text
           FROM rent_charges rc
           JOIN template_rentals tr2 ON tr2.id = rc.rental_id
          WHERE tr2.template_id = t.id
            AND rc.author_tg_user_id = ${authorId}::bigint
            AND rc.status = 'settled')                        AS earned_credits
      FROM agent_templates t
      WHERE t.author_tg_user_id = ${authorId}::bigint
      ORDER BY t.created_at DESC
      LIMIT 200
    `) as unknown as TemplateRow[];

    return NextResponse.json({
      total_income_credits,
      spendable_credits,
      templates,
    });
  } catch (e) {
    // Return a real error (NOT a zeroed 200) — a transient DB failure must show the
    // page's «Ошибка» state, never tell an author they earned 0 when they didn't.
    console.error('author-income error:', e);
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 });
  }
}
