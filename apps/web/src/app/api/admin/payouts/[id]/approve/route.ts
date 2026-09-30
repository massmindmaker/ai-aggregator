/**
 * Phase 14-04 Task 3 — POST /api/admin/payouts/[id]/approve
 *
 * Approves a payout: computes tax via calculateTax(), updates the payouts
 * row (status='paid', processed_at, kyc_snapshot, tax breakdown recorded in
 * metadata jsonb), marks the corresponding locked author_earnings rows as
 * 'paid' via FIFO (sum of net_rub up to and including last row whose running
 * total ≤ payout's net_rub — boundary EXCLUSIVE, no row splitting), and
 * writes an audit_log entry.
 *
 * All three mutations are wrapped in a single db.transaction (atomicity invariant).
 *
 * Out of scope (TODO Phase 14b):
 *   - Real bank transfer (СБП API) → transaction_id stays NULL.
 *   - Tax act PDF generation → tax_act_storage_key stays NULL.
 *
 * PROD-SCHEMA NOTE: the real `payouts` table has NO author_id / amount_rub /
 * tax_withheld_rub / net_paid_rub / admin_note / paid_at columns — the
 * migration files describing them are stale/drifted from prod. Real columns
 * used below: user_id, amount, metadata jsonb. Tax breakdown + approver
 * identity are recorded in `metadata` instead of dedicated columns.
 * `author_earnings` is a different table and genuinely has author_id/net_rub
 * — those refs are untouched.
 */
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { rowsOf } from '@/lib/admin/rows';
import { calculateTax, type KycType } from '@/lib/payouts/tax';

const AUTO_APPROVE_CAP_RUB = 20000;

interface PayoutWithUser {
  id: string;
  user_id: string;
  amount: string;
  status: string;
  kyc_status: string | null;
  kyc_type: string | null;
  tax_id: string | null;
  bank_details: unknown;
  kyc_verified_at: string | null;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;

    const lookup = await db.execute(sql`
      SELECT p.id::text, p.user_id::text, p.amount::text, p.status,
             u.kyc_status, u.kyc_type, u.tax_id, u.bank_details,
             u.kyc_verified_at::text AS kyc_verified_at
      FROM payouts p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = ${id}::uuid
      LIMIT 1
    `);
    const row = rowsOf<PayoutWithUser>(lookup)[0];
    if (!row) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (row.status === 'paid') {
      return NextResponse.json(
        { error: 'IDEMPOTENT_NOOP' },
        { status: 409 }
      );
    }
    // F-1 (security review): the gate must be on the VERIFICATION STATUS, not
    // on the mere presence of kyc_type. `kyc/[id]/reject` flips kyc_status to
    // 'rejected' while leaving kyc_type populated, so the old presence check
    // let a rejected author through: tax was computed and the payout marked
    // 'paid'. Verified status is the only state that author_earnings may be
    // settled from.
    if (row.kyc_status !== 'verified' || !row.kyc_type) {
      return NextResponse.json(
        {
          error: 'KYC_REQUIRED',
          kyc_status: row.kyc_status,
        },
        { status: 422 }
      );
    }

    const amount = Number(row.amount);
    const tax = calculateTax(amount, row.kyc_type as KycType);

    // KYC snapshot for audit trail. bank_details stays as encrypted blob ref;
    // anonymisation (last-4 only) is a Phase 14b TODO once libsodium integration lands.
    const kycSnapshot = {
      kyc_type: row.kyc_type,
      kyc_status: row.kyc_status,
      tax_id: row.tax_id,
      kyc_verified_at: row.kyc_verified_at,
      snapshot_at: new Date().toISOString(),
    };

    const autoPath =
      amount <= AUTO_APPROVE_CAP_RUB && row.kyc_status === 'verified';

    // B-5: ALL three mutations (payouts UPDATE, author_earnings FIFO UPDATE,
    // audit INSERT) wrapped in a single drizzle transaction. Partial commits
    // would corrupt the locked→paid ledger if a later step failed.
    // B-6: FIFO sums net_rub (author's share), boundary EXCLUSIVE — payout
    // pays slightly less than `amount` when running sum doesn't land exactly;
    // remainder rolls to the next payout. Split-row mode is out of scope.
    await (db as unknown as {
      transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
    }).transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE payouts SET
          status = 'paid',
          processed_at = NOW(),
          kyc_snapshot = ${JSON.stringify(kycSnapshot)}::jsonb,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'tax_withheld_rub', ${tax.tax_withheld_rub}::numeric,
            'net_paid_rub', ${tax.net_rub}::numeric,
            'approved_by', ${user.email}::text,
            'approved_at', ${new Date().toISOString()}::text
          )
        WHERE id = ${id}::uuid AND status NOT IN ('paid','failed')
      `);

      // Mark FIFO-net_rub-summed locked author_earnings as 'paid' up to (and
      // INCLUDING) the last row whose running cumulative net_rub does not
      // exceed tax.net_rub. The boundary row stays 'locked' for next payout.
      // Ledger invariant:
      //   sum(author_earnings.net_rub WHERE status='paid')
      //     == sum(payouts.metadata->>'net_paid_rub') for that author.
      // (row.user_id IS the author's id — payouts has no separate author_id column.)
      await tx.execute(sql`
        WITH eligible AS (
          SELECT id, net_rub,
                 SUM(net_rub) OVER (ORDER BY computed_at, id) AS running
          FROM author_earnings
          WHERE author_id = ${row.user_id}::uuid
            AND status = 'locked'
            AND net_rub IS NOT NULL
        )
        UPDATE author_earnings ae SET status = 'paid'
        FROM eligible e
        WHERE ae.id = e.id AND e.running <= ${tax.net_rub}
      `);

      await tx.execute(sql`
        INSERT INTO audit_log (actor_email, action, resource_type, resource_id, details, created_at)
        VALUES (
          ${user.email},
          'payout.approve',
          'payout',
          ${id},
          ${JSON.stringify({
            amount,
            kyc_type: row.kyc_type,
            kyc_status: row.kyc_status,
            tax_withheld_rub: tax.tax_withheld_rub,
            net_rub: tax.net_rub,
            withholding_pct: tax.withholding_pct,
            auto_path: autoPath,
          })}::jsonb,
          NOW()
        )
      `);
    });

    // TODO (Phase 14b): enqueue real bank transfer via СБП API; populate
    // payouts.transaction_id and tax_act_storage_key with PDF.
    return NextResponse.json({
      ok: true,
      id,
      tax_withheld_rub: tax.tax_withheld_rub,
      net_rub: tax.net_rub,
      withholding_pct: tax.withholding_pct,
      auto_path: autoPath,
    });
  });
}
