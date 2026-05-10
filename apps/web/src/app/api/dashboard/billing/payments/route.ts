/**
 * GET /api/dashboard/billing/payments
 *
 * Returns the current user's recent payments for the billing history table.
 * Limit 50, ordered by created_at DESC.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface PaymentRow {
  id: string;
  amount: string;
  currency: string;
  status: string;
  description: string | null;
  payment_method: string | null;
  created_at: string;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const r = await db.execute(sql`
      SELECT id::text AS id, amount::text AS amount, currency, status::text AS status,
             description, payment_method, created_at::text AS created_at
      FROM payments
      WHERE user_id = ${session.user.id}::uuid
      ORDER BY created_at DESC
      LIMIT 50
    `);
    const rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as PaymentRow[]);
    return NextResponse.json({ payments: rows });
  } catch (e) {
    console.error('[billing/payments]', e);
    return NextResponse.json({ payments: [] });
  }
}
