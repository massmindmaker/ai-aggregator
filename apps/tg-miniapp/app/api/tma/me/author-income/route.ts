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

interface IncomeEntryRow {
  id: string;
  template_name: string | null;
  kind: string;
  amount_credits: string;
  created_at: string;
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

    // This calendar month's earnings (server time, month boundary in UTC — good
    // enough for a display figure; the ledger stays the source of truth).
    const monthRows = (await sql`
      SELECT COALESCE(SUM(delta_credits), 0)::text AS month_income_credits
      FROM tg_ledger_entries
      WHERE tg_user_id = ${authorId}::bigint
        AND kind = 'rent_credit'
        AND created_at >= date_trunc('month', NOW())
    `) as unknown as Array<{ month_income_credits: string }>;
    const month_income_credits = monthRows[0]?.month_income_credits ?? '0';

    // Recent income entries: every 'rent_credit' that landed on THIS author,
    // resolved back to the template via charge → rental (LEFT JOINs — a deleted
    // template must not hide the money row). No renter PII is selected.
    const recent_entries = (await sql`
      SELECT le.id::text AS id,
             t.name AS template_name,
             le.kind,
             le.delta_credits::text AS amount_credits,
             le.created_at
      FROM tg_ledger_entries le
      LEFT JOIN rent_charges rc
        ON le.ref_kind = 'rent_charge' AND rc.id = le.ref_id
      LEFT JOIN template_rentals tr ON tr.id = rc.rental_id
      LEFT JOIN agent_templates t ON t.id = tr.template_id
      WHERE le.tg_user_id = ${authorId}::bigint
        AND le.kind = 'rent_credit'
      ORDER BY le.created_at DESC
      LIMIT 20
    `) as unknown as IncomeEntryRow[];

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

    // Available-to-withdraw = lifetime rent income − income already committed to a
    // payout request (any non-failed author_payouts row). This is what POST can
    // request a cash-out for. Read-only here.
    //
    // H1 DOUBLE-COUNT GUARD: rent income lands in the SAME spendable balance
    // (tg_user_balances) and can already be spent in-app on runs/rent. So
    // `earned − paid_out` alone over-states what is actually withdrawable once the
    // author has spent income — when TON_PAYOUTS_ENABLED flips on it would over-pay.
    // Cap the figure at the current spendable balance (the simplest robust guard):
    // available = max(0, min(earned − paid_out, spendable_balance)).
    const availRows = (await sql`
      SELECT (
        COALESCE((
          SELECT SUM(delta_credits) FROM tg_ledger_entries
          WHERE tg_user_id = ${authorId}::bigint AND kind = 'rent_credit'
        ), 0)
        - COALESCE((
          SELECT SUM(amount_credits) FROM author_payouts
          WHERE author_tg_user_id = ${authorId}::bigint AND status <> 'failed'
        ), 0)
      )::text AS available
    `) as unknown as Array<{ available: string }>;
    const earnedMinusPaid = Number(availRows[0]?.available ?? '0');
    const spendableNum = Number(spendable_credits);
    const capped = Math.min(
      earnedMinusPaid,
      Number.isFinite(spendableNum) ? spendableNum : 0,
    );
    const available_income_credits = (capped > 0 ? capped : 0).toString();

    // Recent payout requests (status only — pending until the flag-gated worker
    // batch actually sends). No secrets.
    const payouts = (await sql`
      SELECT id::text AS id,
             amount_credits::text AS amount_credits,
             status,
             tx_hash,
             requested_at
      FROM author_payouts
      WHERE author_tg_user_id = ${authorId}::bigint
      ORDER BY requested_at DESC
      LIMIT 20
    `) as unknown as Array<{
      id: string;
      amount_credits: string;
      status: string;
      tx_hash: string | null;
      requested_at: string;
    }>;

    return NextResponse.json({
      total_income_credits,
      month_income_credits,
      spendable_credits,
      available_income_credits,
      templates,
      recent_entries,
      payouts,
      payouts_enabled: process.env.TON_PAYOUTS_ENABLED === 'true',
    });
  } catch (e) {
    // Return a real error (NOT a zeroed 200) — a transient DB failure must show the
    // page's «Ошибка» state, never tell an author they earned 0 when they didn't.
    console.error('author-income error:', e);
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 });
  }
}

/**
 * POST /api/tma/me/author-income — create an author-payout REQUEST (cash-out).
 *
 * MONEY-OUT SAFETY: this records a 'pending' payout + an off-chain debit ledger row
 * (so the same income can't be requested twice). It NEVER moves funds — the actual
 * USDT transfer is done by the flag-gated worker batch (apps/agent-worker payouts.ts),
 * which is a no-op unless TON_PAYOUTS_ENABLED='true' AND a payout wallet is configured.
 * With the flag off, a request just sits 'pending' and nothing leaves the wallet.
 *
 * Scoped to the authed author (x-tma-user-id). Prepared statements only.
 */
interface PayoutBody {
  amount_credits: number;
  dest_address: string;
}

export async function POST(req: NextRequest) {
  const authorId = req.headers.get('x-tma-user-id');
  if (!authorId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: PayoutBody;
  try {
    body = (await req.json()) as PayoutBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const amount = Number(body.amount_credits);
  const dest = body.dest_address;
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
  }
  if (!dest || typeof dest !== 'string' || dest.length < 10) {
    return NextResponse.json({ error: 'dest_address_required' }, { status: 400 });
  }
  const amountBig = BigInt(amount);

  try {
    let payoutId: string | null = null;
    let insufficient = false;
    await sql.begin(async (sql) => {
      // Re-check available income INSIDE the tx so two concurrent requests can't
      // both pass the guard for the same income.
      const incomeRows = (await sql`
        SELECT COALESCE(SUM(delta_credits), 0)::text AS total
        FROM tg_ledger_entries
        WHERE tg_user_id = ${authorId}::bigint AND kind = 'rent_credit'
      `) as unknown as Array<{ total: string }>;
      const committedRows = (await sql`
        SELECT COALESCE(SUM(amount_credits), 0)::text AS total
        FROM author_payouts
        WHERE author_tg_user_id = ${authorId}::bigint AND status <> 'failed'
      `) as unknown as Array<{ total: string }>;
      const available =
        BigInt(incomeRows[0]?.total ?? '0') - BigInt(committedRows[0]?.total ?? '0');
      if (available < amountBig) {
        insufficient = true;
        return;
      }

      const ins = (await sql`
        INSERT INTO author_payouts
          (author_tg_user_id, amount_credits, asset, dest_address, status)
        VALUES
          (${authorId}::bigint, ${amountBig.toString()}::bigint, 'USDT', ${dest}, 'pending')
        RETURNING id::text
      `) as unknown as Array<{ id: string }>;
      payoutId = ins[0]!.id;

      // Off-chain debit ledger row (audit; prevents double cash-out of same income).
      // Idempotent via uq_ledger_ref(ref_kind, ref_id, kind). Does NOT touch
      // tg_user_balances — income spendability is separate.
      await sql`
        INSERT INTO tg_ledger_entries
          (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
        VALUES
          (${authorId}::bigint, ${(-amountBig).toString()}::bigint, 'author_payout',
           'author_payout', ${payoutId}::uuid, ${(available - amountBig).toString()}::bigint)
        ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
      `;
    });

    if (insufficient) {
      return NextResponse.json({ error: 'insufficient_income' }, { status: 400 });
    }
    if (!payoutId) {
      return NextResponse.json({ error: 'payout_request_failed' }, { status: 500 });
    }

    return NextResponse.json({
      payout_id: payoutId,
      status: 'pending',
      amount_credits: amountBig.toString(),
      // Honest: with the flag off, the request stays pending until cash-out is enabled.
      payouts_enabled: process.env.TON_PAYOUTS_ENABLED === 'true',
    });
  } catch (e) {
    console.error('author-payout request error:', e);
    return NextResponse.json({ error: 'request_failed' }, { status: 500 });
  }
}
