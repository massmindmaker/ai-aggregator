import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { requireAdmin, audit, AdminAuthError } from '@/lib/admin/guard';
import { firstRow, rowsOf } from '@/lib/admin/rows';

export const dynamic = 'force-dynamic';

function err(e: unknown) {
  if (e instanceof AdminAuthError) {
    return NextResponse.json({ error: e.code }, { status: e.code === 'UNAUTHORIZED' ? 401 : 403 });
  }
  console.error(e);
  return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const [org, members, txns] = await Promise.all([
      db.execute(sql`SELECT *, COALESCE(status,'active') AS status FROM organizations WHERE id = ${id}`),
      db.execute(sql`
        SELECT om.role, u.email, u.name, om.created_at
        FROM organization_members om JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = ${id} ORDER BY om.created_at LIMIT 200
      `),
      db.execute(sql`
        SELECT id::text, amount::text, status::text, created_at
        FROM payments WHERE metadata->>'organization_id' = ${id}
        ORDER BY created_at DESC LIMIT 50
      `).catch(() => ({ rows: [] })),
    ]);
    return NextResponse.json({
      org: firstRow(org),
      members: rowsOf(members),
      transactions: rowsOf(txns),
    });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user: admin } = await requireAdmin();
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      op: 'topupPayg' | 'suspend' | 'unsuspend' | 'transferOwner';
      amountCredits?: number;
      reason?: string;
      newOwnerEmail?: string;
    };

    switch (body.op) {
      case 'topupPayg': {
        // 🔴 HIGH-3 fix (Opus review): this used to be `amountRub`, written
        // straight into `organizations.payg_credits` — a BIGINT that (as of
        // migration 0056/0058) holds MICRO-credits (1 credit = 1000 micro =
        // 1¢), not ₽ and not whole credits. An admin typing "1000" meaning
        // "1000₽" would have granted 1000 MICRO-credits = $0.01 (~1000×
        // short), and any fractional ₽ input (e.g. "100.50") would have been
        // silently truncated by Postgres' numeric→int8 assignment cast (MED-2
        // — no error, just quiet rounding). This is also currently the ONLY
        // path that tops up organizations.payg_credits at all (T3, the
        // payment→org bridge, is not built yet) — so it doubles as the only
        // way to unblock a founder E2E test after 0056 zeroes the seed
        // buckets. Now takes WHOLE credits explicitly and converts to micro
        // itself (rounded — a fractional-credit admin input is legitimate,
        // e.g. "10.5" credits, but must land on an integer micro-credit).
        // Must be a positive, finite, non-absurd credit amount. A NEGATIVE
        // value here would do `payg_credits + (negative)` and DRAIN/negate the
        // balance; 0 is a no-op; >1_000_000 credits (=$10k) is beyond any sane
        // single admin top-up. All rejected before the micro-credit conversion.
        if (
          typeof body.amountCredits !== 'number' ||
          !Number.isFinite(body.amountCredits) ||
          body.amountCredits <= 0 ||
          body.amountCredits > 1_000_000
        ) {
          return NextResponse.json({ error: 'BAD_AMOUNT' }, { status: 400 });
        }
        const amountMicroCredits = Math.round(body.amountCredits * 1000);
        await db.execute(sql`
          UPDATE organizations SET payg_credits = payg_credits + ${amountMicroCredits} WHERE id = ${id}
        `);
        await audit(admin.email, 'org.topup_payg', 'org', id, {
          deltaCredits: body.amountCredits,
          deltaMicroCredits: amountMicroCredits,
          reason: body.reason,
        });
        break;
      }
      case 'suspend': {
        await db.execute(sql`UPDATE organizations SET status = 'suspended' WHERE id = ${id}`);
        await audit(admin.email, 'org.suspend', 'org', id, { reason: body.reason });
        break;
      }
      case 'unsuspend': {
        await db.execute(sql`UPDATE organizations SET status = 'active' WHERE id = ${id}`);
        await audit(admin.email, 'org.unsuspend', 'org', id, {});
        break;
      }
      case 'transferOwner': {
        if (!body.newOwnerEmail) {
          return NextResponse.json({ error: 'BAD_EMAIL' }, { status: 400 });
        }
        await db.execute(sql`
          UPDATE organizations SET owner_id = (SELECT id FROM users WHERE email = ${body.newOwnerEmail})
          WHERE id = ${id}
        `);
        await audit(admin.email, 'org.transfer_owner', 'org', id, { newOwner: body.newOwnerEmail });
        break;
      }
      default:
        return NextResponse.json({ error: 'UNKNOWN_OP' }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
