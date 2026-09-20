/**
 * GET /api/dashboard/billing/summary
 *
 * Returns the tier + the balance that is ACTUALLY spent by the gateway.
 *
 * Source-of-truth split (verified against code, not assumed):
 *   - Tier/plan: `subscriptions` (active row for this user) → planName + creditsLimit.
 *     No active row → "Free". Written by the Tinkoff/YooKassa webhook + admin
 *     tier-grant flow (migration 0054).
 *   - Spendable balance: `organizations.subscription_credits` + `payg_credits`
 *     (BIGINT MICRO-credits as of migration 0056/0058 — 1 credit = 1000 micro
 *     = 1¢; this route divides by 1000 before returning), scoped by the
 *     user's default org (`getOrCreateDefaultOrg`). This is the ONLY balance
 *     `aiag_settle_charge_credits` (the gateway's debit function, see
 *     packages/database/src/functions/settle-charge.sql /
 *     packages/database/migrations/0058_settle_charge_credits_fn.sql) reads
 *     and decrements — `credit_buckets` is an unused/optional detail table,
 *     not the aggregate.
 *
 * An active top-up refund claim or refund debt blocks all non-BYOK spending.
 * The response preserves the underlying buckets while reporting zero spendable
 * credits so the dashboard matches gateway admission.
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
  refund_debt_credits: string | null;
  refund_pending: boolean;
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
    return NextResponse.json({ error: 'billing_summary_unavailable' }, { status: 503 });
  }

  // 🔴 HIGH-2 fix (Opus review): these were named ...CreditsRub while holding
  // whole CREDITS (an ~8.7% off value if read literally as ₽). organizations.*
  // columns are now BIGINT MICRO-credits (1 credit = 1000 micro = 1¢, as of
  // migration 0056/0058) — divide by 1000 to get the display unit (credits).
  let subscriptionCredits = 0;
  let paygCredits = 0;
  let refundDebtCredits = 0;
  let refundPending = false;
  try {
    const orgId = await getOrCreateDefaultOrg(userId);
    const balRes = await db.execute(sql`
      SELECT subscription_credits::text AS subscription_credits,
             payg_credits::text AS payg_credits,
             refund_debt_credits::text AS refund_debt_credits,
             EXISTS (
               SELECT 1
               FROM payments
               WHERE topup_org_id = organizations.id
                 AND refund_claim_id IS NOT NULL
             ) AS refund_pending
      FROM organizations
      WHERE organizations.id = ${orgId}::uuid
      LIMIT 1
    `);
    const rows = (((balRes as unknown as { rows?: OrgBalanceRow[] }).rows ?? balRes) as OrgBalanceRow[]);
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ error: 'billing_summary_unavailable' }, { status: 503 });
    }
    subscriptionCredits = row.subscription_credits != null ? Number(row.subscription_credits) / 1000 : 0;
    paygCredits = row.payg_credits != null ? Number(row.payg_credits) / 1000 : 0;
    refundDebtCredits = row.refund_debt_credits != null ? Number(row.refund_debt_credits) / 1000 : 0;
    refundPending = row.refund_pending === true;
  } catch (e) {
    console.error('[billing/summary] org balance lookup failed', e);
    return NextResponse.json({ error: 'billing_summary_unavailable' }, { status: 503 });
  }

  return NextResponse.json({
    plan: { name: planName, creditsLimit, creditsUsed },
    balance: {
      // What the gateway's aiag_settle_charge_credits actually debits (see comment above).
      paygCredits,
      subscriptionCredits,
      refundDebtCredits,
      refundPending,
      totalSpendableCredits:
        refundDebtCredits > 0 || refundPending ? 0 : paygCredits + subscriptionCredits,
    },
  });
}
