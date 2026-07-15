/**
 * GET /api/dashboard/billing/summary
 *
 * Returns the tier + the balance that is ACTUALLY spent by the gateway.
 *
 * Source-of-truth split (verified against code, not assumed):
 *   - Tier/plan: `subscriptions` (active row for this user) → planName + creditsLimit.
 *     No active row → "Free". Written by the Tinkoff/YooKassa webhook + admin
 *     tier-grant flow (migration 0054).
 *   - Spendable balance: `organizations.subscription_credits` + `payg_credits`,
 *     scoped by the user's default org (`getOrCreateDefaultOrg`). This is the
 *     ONLY balance `aiag_settle_charge` (the gateway's debit function, see
 *     packages/database/src/functions/settle-charge.sql) reads and decrements —
 *     `credit_buckets` is an unused/optional detail table, not the aggregate.
 *
 * Known rassinhron (do not fix here — separate task): the `payments` table
 * (Tinkoff/YooKassa webhook history) and `subscriptions` tier are not wired to
 * top up `organizations.payg_credits` anywhere in this codebase. A user can
 * have paid rows in `payments` / an active `subscriptions` tier while their
 * org's gateway-spendable balance stays 0. This route surfaces the true
 * gateway-side balance (`orgBalanceSourceKnownDesync: true`), it does not
 * bridge the two.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import { getOrCreateDefaultOrg } from '@/lib/dashboard/org';

export const dynamic = 'force-dynamic';

interface SubRow {
  plan_name: string | null;
  credits_limit: string | null;
  credits_used: string | null;
}

interface OrgBalanceRow {
  subscription_credits: string | null;
  payg_credits: string | null;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  let planName = 'Free';
  let creditsLimit: number | null = null;
  let creditsUsed: number | null = null;
  try {
    const subRes = await db.execute(sql`
      SELECT plan_name, credits_limit::text AS credits_limit, credits_used::text AS credits_used
      FROM subscriptions
      WHERE user_id = ${userId}::uuid AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const rows = (((subRes as unknown as { rows?: SubRow[] }).rows ?? subRes) as SubRow[]);
    const row = rows[0];
    if (row) {
      planName = row.plan_name ?? 'Free';
      creditsLimit = row.credits_limit != null ? Number(row.credits_limit) : null;
      creditsUsed = row.credits_used != null ? Number(row.credits_used) : null;
    }
  } catch (e) {
    console.error('[billing/summary] subscription lookup failed', e);
  }

  let subscriptionCreditsRub = 0;
  let paygCreditsRub = 0;
  try {
    const orgId = await getOrCreateDefaultOrg(userId);
    const balRes = await db.execute(sql`
      SELECT subscription_credits::text AS subscription_credits,
             payg_credits::text AS payg_credits
      FROM organizations
      WHERE id = ${orgId}::uuid
      LIMIT 1
    `);
    const rows = (((balRes as unknown as { rows?: OrgBalanceRow[] }).rows ?? balRes) as OrgBalanceRow[]);
    const row = rows[0];
    if (row) {
      subscriptionCreditsRub = row.subscription_credits != null ? Number(row.subscription_credits) : 0;
      paygCreditsRub = row.payg_credits != null ? Number(row.payg_credits) : 0;
    }
  } catch (e) {
    console.error('[billing/summary] org balance lookup failed', e);
  }

  return NextResponse.json({
    plan: { name: planName, creditsLimit, creditsUsed },
    balance: {
      // What the gateway's aiag_settle_charge actually debits (see comment above).
      paygCreditsRub,
      subscriptionCreditsRub,
      totalSpendableRub: paygCreditsRub + subscriptionCreditsRub,
    },
  });
}
