import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import PricingClient from './PricingClient';

export const dynamic = 'force-dynamic';

interface PlanRow {
  plan_name: string | null;
}

async function currentPlanId(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const r = await db.execute(sql`
      SELECT plan_name FROM subscriptions
      WHERE user_id = ${userId}::uuid AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `);
    const rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as PlanRow[]);
    return rows[0]?.plan_name ?? null;
  } catch {
    return null;
  }
}

export default async function PricingPage() {
  const session = await auth();
  const planId = await currentPlanId(session?.user?.id);
  return <PricingClient isLoggedIn={Boolean(session?.user)} currentPlanId={planId} />;
}
