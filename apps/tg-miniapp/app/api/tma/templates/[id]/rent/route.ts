import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Default monthly budget for a cloned agent (US cents). $100/mo — same as the
// free-clone route, so a rented clone gets the same starting budget.
const DEFAULT_BUDGET_CREDITS = 10_000;

// Sanity ceiling on author rent (US cents) = $1000. A price outside (0, MAX] is
// rejected before any money moves.
const MAX_PRICE_CREDITS = 100_000;

// The shareable spec we copy into the rented clone. agent_templates has no secret
// columns, so renting structurally cannot carry a secret — the renter wires their
// own keys/provider afterwards via PATCH …/agents/[id] (BYOK flow).
interface TemplateRow {
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  model_slug: string | null;
  tools: unknown;
  mcp_endpoint_url: string | null;
  price_credits: string | null;
  // Аренда = месячная подписка: месячный лимит трат, входящий в цену (US cents).
  // NULL = берём дефолт клона (DEFAULT_BUDGET_CREDITS).
  rent_monthly_limit_credits: string | null;
  author_tg_user_id: string;
}

/**
 * POST /api/tma/templates/:id/rent — Slice 2 PAID author-rent.
 *
 * The renter pays the EXACT author-set price; the whole sum is credited to the
 * author (AIAG takes 0% of author rent — founder decision #7). AIAG earns on
 * model markup / tools / deploy, NOT here.
 *
 * ATOMICITY: the rental row, the charge, the renter debit, the author credit,
 * BOTH ledger entries, AND the agent clone all run in ONE sql.begin. If anything
 * throws (insufficient funds, a clone failure, a concurrent duplicate) the whole
 * transaction ROLLS BACK — the renter is NEVER charged without receiving the
 * agent, and the author is NEVER credited without the renter being debited. The
 * debit/credit deltas are exactly equal-and-opposite (no platform-fee line). A
 * second concurrent/retried rent is a no-op via the uq_rental_active partial
 * unique index, so an accidental double-tap cannot double-charge.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const renterId = req.headers.get('x-tma-user-id');
  if (!renterId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // 1) Load the template. Must be a PUBLIC, PRICED template (price_credits NOT NULL).
  const rows = (await sql`
    SELECT name, description, system_prompt, model_slug, tools, mcp_endpoint_url,
           price_credits::text AS price_credits,
           rent_monthly_limit_credits::text AS rent_monthly_limit_credits,
           author_tg_user_id::text AS author_tg_user_id
    FROM agent_templates
    WHERE id = ${params.id}::uuid
      AND visibility = 'public'
    LIMIT 1
  `) as unknown as TemplateRow[];

  const tpl = rows[0] ?? null;
  if (!tpl) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Free templates are cloned via …/clone, not rented.
  if (tpl.price_credits === null) {
    return NextResponse.json({ error: 'not_a_paid_template' }, { status: 400 });
  }

  const authorId = tpl.author_tg_user_id;

  // 2) Cheap guards BEFORE opening any transaction (fail-fast, no locks held).

  // SELF-DEAL GUARD: an author renting their own template is a self-credit income
  // farm — forbid it.
  if (renterId === authorId) {
    return NextResponse.json({ error: 'self_deal' }, { status: 403 });
  }

  // AMOUNT GUARD: positive integer within a sane ceiling. The price is the
  // template's STORED price (never client input). A NEGATIVE price would invert
  // the guarded debit (balance − (−x) = balance + x) into an over-credit exploit;
  // ZERO would write two null ledger rows. Reject both before any money moves.
  const price = Number(tpl.price_credits);
  if (!Number.isInteger(price) || price <= 0 || price > MAX_PRICE_CREDITS) {
    return NextResponse.json({ error: 'invalid_price' }, { status: 400 });
  }

  // Месячный лимит трат, входящий в цену подписки. Автор задаёт его на шаблоне;
  // если не задал (NULL) — клон получает дефолтный месячный бюджет.
  const rawLimit = tpl.rent_monthly_limit_credits;
  const monthlyLimit =
    rawLimit !== null && Number.isInteger(Number(rawLimit)) && Number(rawLimit) > 0
      ? Number(rawLimit)
      : DEFAULT_BUDGET_CREDITS;

  // 3) Idempotency / renewal pre-check. Аренда = месячная подписка:
  //    • активная подписка с НЕ истёкшим периодом → no-op (re-tap/refresh не должны
  //      списывать второй раз) — возвращаем существующий клон.
  //    • активная подписка с ИСТЁКШИМ периодом → ПРОДЛЕНИЕ: списываем ещё месяц тем
  //      же атомарным путём и сдвигаем период вперёд (renewal=true ниже).
  //    uq_rental_active — race-safe backstop для конкурентного оформления.
  const existing = (await sql`
    SELECT id::text AS id,
           cloned_agent_id::text AS cloned_agent_id,
           (period_end IS NOT NULL AND period_end > NOW()) AS within_period
    FROM template_rentals
    WHERE template_id = ${params.id}::uuid
      AND renter_tg_user_id = ${renterId}::bigint
      AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{ id: string; cloned_agent_id: string | null; within_period: boolean }>;
  const activeRental = existing[0] ?? null;
  if (activeRental?.cloned_agent_id && activeRental.within_period) {
    return NextResponse.json(
      { agent_id: activeRental.cloned_agent_id, already_rented: true },
      { status: 200 },
    );
  }
  // Активная подписка с истёкшим периодом → продлеваем существующую запись (новый
  // charge + сдвиг периода), НЕ создаём дубль и НЕ клонируем агента заново.
  const renewal = activeRental?.cloned_agent_id ? activeRental : null;

  // 4) THE ENTIRE RENT IN ONE TRANSACTION. Any throw rolls back EVERYTHING.
  const templateKind = `tpl:${params.id}`.slice(0, 40);
  const name = (tpl.name ?? 'Без имени').slice(0, 200);
  const systemPrompt = (tpl.system_prompt ?? '').slice(0, 8000);
  const tools = Array.isArray(tpl.tools) ? tpl.tools : [];

  let newAgentId = '';
  let insufficient = false; // guarded debit found < price
  let duplicate = false; // a concurrent active rental won the uq_rental_active slot
  try {
    await sql.begin(async (sql) => {
      // a) Get/claim the subscription row.
      let rentalId: string;
      if (renewal) {
        // ПРОДЛЕНИЕ: подписка есть, период истёк. Используем ту же запись — НЕ
        // создаём дубль и НЕ клонируем агента (он уже есть). Деньги ниже (b–e)
        // идут тем же атомарным путём, что и первичное оформление.
        rentalId = renewal.id;
        newAgentId = renewal.cloned_agent_id!;
      } else {
        // ПЕРВИЧНОЕ ОФОРМЛЕНИЕ. rent_period='month' + период [now, now+1мес] +
        // замороженный месячный лимит. The uq_rental_active partial unique index
        // (template_id, renter) WHERE status='active' makes a concurrent/retried
        // rent a no-op: ON CONFLICT DO NOTHING → 0 rows → duplicate → rollback
        // (no debit, no second charge).
        const rentalRows = (await sql`
          INSERT INTO template_rentals (
            template_id, renter_tg_user_id, author_tg_user_id,
            price_credits, rent_period, status,
            period_start, period_end, expires_at, monthly_limit_credits
          )
          VALUES (
            ${params.id}::uuid, ${renterId}::bigint, ${authorId}::bigint,
            ${price}::bigint, 'month', 'active',
            NOW(), NOW() + INTERVAL '1 month', NOW() + INTERVAL '1 month',
            ${monthlyLimit}::bigint
          )
          ON CONFLICT (template_id, renter_tg_user_id) WHERE status = 'active'
          DO NOTHING
          RETURNING id::text
        `) as unknown as Array<{ id: string }>;
        if (rentalRows.length === 0) {
          duplicate = true;
          throw new Error('duplicate_rental');
        }
        rentalId = rentalRows[0]!.id;
      }

      // b) Charge row — the ledger ref_id anchor (settled in this same tx).
      const chargeRows = (await sql`
        INSERT INTO rent_charges (
          rental_id, renter_tg_user_id, author_tg_user_id,
          amount_credits, status, settled_at
        )
        VALUES (
          ${rentalId}::uuid, ${renterId}::bigint, ${authorId}::bigint,
          ${price}::bigint, 'settled', NOW()
        )
        RETURNING id::text
      `) as unknown as Array<{ id: string }>;
      const chargeId = chargeRows[0]!.id;

      // c) GUARDED DEBIT of the renter (over-spend safe). 0 rows ⇒ insufficient
      //    funds ⇒ throw ⇒ the whole tx ROLLS BACK (rental + charge included).
      const debit = (await sql`
        UPDATE tg_user_balances
        SET balance_credits = balance_credits - ${price}, updated_at = NOW()
        WHERE tg_user_id = ${renterId}::bigint AND balance_credits >= ${price}
        RETURNING balance_credits::text AS balance_credits
      `) as unknown as Array<{ balance_credits: string }>;
      if (debit.length === 0) {
        insufficient = true;
        throw new Error('insufficient_balance');
      }

      // d) UPSERT-CREDIT of the author (creates the row if the author has none).
      //    100% pass-through: the credited amount equals the debited amount.
      const credit = (await sql`
        INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
        VALUES (${authorId}::bigint, ${price}::bigint, NOW())
        ON CONFLICT (tg_user_id) DO UPDATE
          SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits,
              updated_at = NOW()
        RETURNING balance_credits::text AS balance_credits
      `) as unknown as Array<{ balance_credits: string }>;

      // e) TWO ledger entries: ONE ref_id (the charge), DIFFERENT kind. The deltas
      //    are exactly equal-and-opposite (−price / +price): the pair sums to 0,
      //    AIAG takes 0% of author rent — there is NO platform-fee line.
      await sql`
        INSERT INTO tg_ledger_entries
          (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
        VALUES
          (${renterId}::bigint, ${-price}, 'rent_debit', 'rent_charge',
           ${chargeId}::uuid, ${debit[0]!.balance_credits}::bigint)
        ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
      `;
      await sql`
        INSERT INTO tg_ledger_entries
          (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
        VALUES
          (${authorId}::bigint, ${price}, 'rent_credit', 'rent_charge',
           ${chargeId}::uuid, ${credit[0]!.balance_credits}::bigint)
        ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
      `;

      if (renewal) {
        // f-renew) ПРОДЛЕНИЕ: только сдвигаем период на месяц вперёд. Агент уже
        //   существует (newAgentId выставлен выше), клон не создаём. Лимит обновляем
        //   на актуальный из шаблона (автор мог сменить цену/лимит к продлению).
        await sql`
          UPDATE template_rentals
          SET period_start = NOW(),
              period_end = NOW() + INTERVAL '1 month',
              expires_at = NOW() + INTERVAL '1 month',
              monthly_limit_credits = ${monthlyLimit}::bigint
          WHERE id = ${rentalId}::uuid
        `;
      } else {
        // f) Clone the agent to the renter — IN THE SAME TX (same INSERT shape as the
        //    free-clone route; no secret columns copied; connection_type='aiag'). If
        //    this throws, the debit + credit above ROLL BACK — the renter is never
        //    charged without receiving the agent. budget_credits_monthly = месячный
        //    лимит подписки (worker-гард на агенте), а period-scoped лимит подписки
        //    дополнительно проверяет воркер.
        const ins = (await sql`
          INSERT INTO agents (
            tg_user_id, template_kind, name, description,
            system_prompt, tools, model_slug, budget_credits_monthly,
            connection_type, mcp_endpoint_url
          )
          VALUES (
            ${renterId}::bigint,
            ${templateKind},
            ${name},
            ${tpl.description},
            ${systemPrompt},
            ${sql.json(tools as never)},
            ${tpl.model_slug},
            ${monthlyLimit},
            'aiag',
            ${tpl.mcp_endpoint_url}
          )
          RETURNING id::text
        `) as unknown as Array<{ id: string }>;
        newAgentId = ins[0]!.id;

        // g) Bind the clone to the rental + bump clone_count.
        await sql`
          UPDATE template_rentals SET cloned_agent_id = ${newAgentId}::uuid
          WHERE id = ${rentalId}::uuid
        `;
        await sql`
          UPDATE agent_templates SET clone_count = clone_count + 1
          WHERE id = ${params.id}::uuid
        `;
      }
    });
  } catch (e) {
    if (insufficient) {
      return NextResponse.json({ error: 'insufficient_balance' }, { status: 402 });
    }
    if (duplicate) {
      // A concurrent rent won the active-rental slot — return its agent if the
      // winner has already committed its clone; otherwise 409 (the client retries).
      const dup = (await sql`
        SELECT cloned_agent_id::text AS cloned_agent_id
        FROM template_rentals
        WHERE template_id = ${params.id}::uuid
          AND renter_tg_user_id = ${renterId}::bigint
          AND status = 'active'
        LIMIT 1
      `) as unknown as Array<{ cloned_agent_id: string | null }>;
      if (dup[0]?.cloned_agent_id) {
        return NextResponse.json(
          { agent_id: dup[0].cloned_agent_id, already_rented: true },
          { status: 200 },
        );
      }
      return NextResponse.json({ error: 'duplicate_rental' }, { status: 409 });
    }
    // Unexpected DB error — the money rolled back atomically (nothing committed).
    return NextResponse.json(
      { error: 'rent_failed', detail: e instanceof Error ? e.message : 'rent' },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      agent_id: newAgentId,
      charged_credits: price,
      monthly_limit_credits: monthlyLimit,
      renewed: !!renewal,
    },
    { status: renewal ? 200 : 201 },
  );
}
