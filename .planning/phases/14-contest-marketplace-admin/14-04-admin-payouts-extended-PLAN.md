---
phase: 14-contest-marketplace-admin
plan: 04
type: execute
wave: 2
depends_on: [14-01]
files_modified:
  - apps/web/src/app/admin/payouts/page.tsx
  - apps/web/src/app/admin/payouts/PayoutRowActions.tsx
  - apps/web/src/app/api/admin/payouts/[id]/approve/route.ts
  - apps/web/src/app/api/admin/payouts/[id]/reject/route.ts
  - apps/web/src/lib/payouts/tax.ts
  - apps/web/src/__tests__/admin-payouts-approve.test.ts
  - apps/web/src/__tests__/payouts-tax.test.ts
autonomous: true
requirements:
  - REQ-PAYOUT-001
  - REQ-PAYOUT-002
  - REQ-PAYOUT-003
  - REQ-PAYOUT-004
tags: [phase14, admin, payouts, tax, kyc]
must_haves:
  truths:
    - "Admin sees payouts queue filterable by status (pending|available|paid)"
    - "Admin can approve a payout — it transitions to 'paid' with tax_withheld_rub and net_rub computed per kyc_type"
    - "Auto-approve fast-path: amount ≤ 20000 ₽ AND user.kyc_status='verified' → admin click is one-step (no manual review prompt)"
    - "Approve action writes audit_log row with action='payout.approve' including tax breakdown"
  artifacts:
    - path: apps/web/src/app/admin/payouts/page.tsx
      provides: "Extended queue with filter + per-row actions"
      contains: "status_filter"
    - path: apps/web/src/lib/payouts/tax.ts
      provides: "Pure tax calculator"
      contains: "calculateTax"
    - path: apps/web/src/app/api/admin/payouts/[id]/approve/route.ts
      provides: "Approve mutation"
      contains: "tax_withheld_rub"
  key_links:
    - from: PayoutRowActions
      to: /api/admin/payouts/[id]/approve
      via: "fetch POST"
      pattern: "fetch.*payouts.*approve"
    - from: approve route
      to: payouts row UPDATE + audit
      via: "transactional update"
      pattern: "UPDATE payouts SET status"
---

<objective>
Extend `/admin/payouts` (Phase 11 base) per spec §6 admin half. Add status filter, per-row actions (approve/reject), tax calculation per `kyc_type` (НПД/ИП → 0%, физлицо → 13%), auto-approve cap (≤20000₽ + verified KYC), and audit logging. Out of scope: real bank transfer integration — mark `tx_ref` and `tax_act_storage_key` as TODO stubs.

Purpose: Without admin approval flow, accrued earnings cannot be paid out. This is the operator's daily queue.
Output: Extended page + 2 API routes + pure tax calculator + tests.
</objective>

<execution_context>
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/workflows/execute-plan.md
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/14-contest-marketplace-admin/14-01-SUMMARY.md
@docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md
@apps/web/src/app/admin/payouts/page.tsx
@apps/web/src/app/admin/jobs/page.tsx
@apps/web/src/app/admin/jobs/JobRowActions.tsx
@apps/web/src/lib/admin/guard.ts
@apps/web/src/__tests__/admin-routing.test.ts

<interfaces>
- payouts table post-14-01: id, author_id, amount_rub, tax_withheld_rub, net_paid_rub, method, status (requested|processing|paid|failed|reversed), kyc_snapshot jsonb, tax_act_storage_key, request_at, processed_at, paid_at.
- users table post-14-01: kyc_status, kyc_type ('self_employed'|'ip'|'individual'), kyc_verified_at, tax_id, bank_details jsonb.
- author_earnings status values: 'accruing'|'locked'|'paid'. Locked rows are payable.
- Existing /admin/payouts page: simple queue with bulk-actions stub, no per-row approve. Replace fetch query, add filters, add row actions.
- Tax calculator must be a pure function for unit-testability.
- Auto-approve cap: 20000 ₽ per user decision in scope_constraints (not 50k spec default).
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Pure tax calculator + unit tests</name>
  <files>apps/web/src/lib/payouts/tax.ts, apps/web/src/__tests__/payouts-tax.test.ts</files>

  <read_first>
    - Spec lines 113-119 (§6 — three tax models: НПД 0%, ИП 0%, физлицо 13%).
    - `apps/web/src/__tests__/admin-routing.test.ts` (vitest harness pattern).
  </read_first>

  <behavior>
    - Test 1: kyc_type='self_employed', amount=10000 → {tax_withheld_rub: 0, net_rub: 10000, withholding_pct: 0}.
    - Test 2: kyc_type='ip', amount=10000 → {tax_withheld_rub: 0, net_rub: 10000, withholding_pct: 0}.
    - Test 3: kyc_type='individual', amount=10000 → {tax_withheld_rub: 1300, net_rub: 8700, withholding_pct: 13}.
    - Test 4: kyc_type=null → throws Error('KYC_TYPE_REQUIRED').
    - Test 5: amount<=0 → throws Error('INVALID_AMOUNT').
    - Test 6: Rounding — kyc_type='individual', amount=12345.67 → tax=1604.94 (13% rounded to 2dp), net=10740.73.
  </behavior>

  <action>
Create `apps/web/src/lib/payouts/tax.ts`:

```ts
export type KycType = 'self_employed' | 'ip' | 'individual';

export interface TaxResult {
  tax_withheld_rub: number;
  net_rub: number;
  withholding_pct: number;
}

export function calculateTax(amount_rub: number, kyc_type: KycType | null): TaxResult {
  if (kyc_type == null) throw new Error('KYC_TYPE_REQUIRED');
  if (!Number.isFinite(amount_rub) || amount_rub <= 0) throw new Error('INVALID_AMOUNT');
  let pct = 0;
  if (kyc_type === 'individual') pct = 13;
  // 'self_employed' (НПД) and 'ip' (УСН 6%) — author pays own taxes; AIAG withholds nothing.
  const tax = Math.round((amount_rub * pct) ) / 100;
  // amount * pct / 100 rounded to kopecks
  const taxRub = Math.round((amount_rub * (pct / 100)) * 100) / 100;
  const netRub = Math.round((amount_rub - taxRub) * 100) / 100;
  return { tax_withheld_rub: taxRub, net_rub: netRub, withholding_pct: pct };
}
```

Create `apps/web/src/__tests__/payouts-tax.test.ts` with the 6 tests above. Use `expect(calculateTax(...)).toEqual({...})` for happy paths and `expect(() => ...).toThrow('KYC_TYPE_REQUIRED')` for errors.
  </action>

  <verify>
    <automated>test -f apps/web/src/lib/payouts/tax.ts &amp;&amp; test -f apps/web/src/__tests__/payouts-tax.test.ts &amp;&amp; grep -c "kyc_type === 'individual'" apps/web/src/lib/payouts/tax.ts | grep -q "^1$" &amp;&amp; grep -c "calculateTax" apps/web/src/__tests__/payouts-tax.test.ts | grep -q "[5-9]" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Pure function exported; six unit tests cover all branches; tsc clean.
  </done>
</task>

<task type="auto">
  <name>Task 2: Extended /admin/payouts page with status filter + row actions</name>
  <files>apps/web/src/app/admin/payouts/page.tsx, apps/web/src/app/admin/payouts/PayoutRowActions.tsx</files>

  <read_first>
    - Spec lines 108-125 (§6 — admin queue + auto-approve + tax preview).
    - Current `apps/web/src/app/admin/payouts/page.tsx` (full file — being replaced, not appended).
    - `apps/web/src/app/admin/jobs/page.tsx` lines 33-90 (filter + counters pattern via `searchParams: Promise<...>`).
    - `apps/web/src/app/admin/jobs/JobRowActions.tsx` (row actions client component pattern with fetch POST).
  </read_first>

  <action>
Rewrite `apps/web/src/app/admin/payouts/page.tsx` to:

1. Read `searchParams.status` (one of `requested|processing|paid|failed`, default `requested`).
2. Call `requireAdmin()` before fetching.
3. Run two queries in parallel:
   a. **Counters** by status:
      ```sql
      SELECT
        COUNT(*) FILTER (WHERE status='requested')::int AS pending,
        COUNT(*) FILTER (WHERE status='processing')::int AS processing,
        COUNT(*) FILTER (WHERE status='paid' AND paid_at::date = CURRENT_DATE)::int AS paid_today,
        COUNT(*) FILTER (WHERE status='failed' AND requested_at > NOW() - INTERVAL '7 days')::int AS failed_7d
      FROM payouts
      ```
   b. **Rows** filtered by status:
      ```sql
      SELECT p.id::text, p.author_id::text, u.email AS author_email,
             u.kyc_status, u.kyc_type,
             p.amount_rub::text, p.tax_withheld_rub::text, p.net_paid_rub::text,
             p.method, p.status, p.requested_at::text, p.paid_at::text
      FROM payouts p
      JOIN users u ON u.id = p.author_id
      WHERE p.status = ${status}
      ORDER BY p.requested_at DESC
      LIMIT 200
      ```

4. Render top: 4 KPI cards (pending / processing / paid_today / failed_7d) using same Card pattern as `admin/jobs/page.tsx` lines 113-146.
5. Render filter as `<form><select name="status">...</select></form>` with 4 options + submit. Or use `<a href="?status=paid">` Link group.
6. Render table with columns: Email | KYC | Сумма ₽ | Удержано ₽ | Net ₽ | Method | Статус | Когда | Действия.
7. KYC column: `<Badge variant={r.kyc_status === 'verified' ? 'default' : 'outline'}>{r.kyc_status}/{r.kyc_type ?? '—'}</Badge>`.
8. Действия column renders `<PayoutRowActions id={r.id} amountRub={Number(r.amount_rub)} kycStatus={r.kyc_status} kycType={r.kyc_type} status={r.status} />`.
9. Empty state: «Нет выплат в этом статусе».

Create `apps/web/src/app/admin/payouts/PayoutRowActions.tsx` as `'use client'`:

```tsx
'use client';
import * as React from 'react';
import { Button } from '@/components/ui/Button';

interface Props {
  id: string;
  amountRub: number;
  kycStatus: string;
  kycType: string | null;
  status: string;
}

const AUTO_APPROVE_CAP_RUB = 20000;

export function PayoutRowActions({ id, amountRub, kycStatus, kycType, status }: Props) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  if (status !== 'requested') return <span className="text-xs text-muted-foreground">—</span>;

  const fastPath = amountRub <= AUTO_APPROVE_CAP_RUB &amp;&amp; kycStatus === 'verified';

  const approve = async () => {
    if (!fastPath) {
      const ok = window.confirm(`Сумма ${amountRub} ₽ превышает auto-cap или KYC ≠ verified. Approve вручную?`);
      if (!ok) return;
    }
    setBusy(true); setErr(null);
    const r = await fetch(`/api/admin/payouts/${id}/approve`, { method: 'POST' });
    if (!r.ok) { setErr((await r.json()).error ?? 'ERR'); setBusy(false); return; }
    window.location.reload();
  };

  const reject = async () => {
    const reason = window.prompt('Причина отказа?');
    if (!reason) return;
    setBusy(true);
    const r = await fetch(`/api/admin/payouts/${id}/reject`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    if (!r.ok) { setErr((await r.json()).error ?? 'ERR'); setBusy(false); return; }
    window.location.reload();
  };

  return (
    <div className="flex gap-2 items-center">
      <Button size="sm" onClick={approve} disabled={busy} variant={fastPath ? 'default' : 'outline'}>
        {fastPath ? 'Auto-approve' : 'Approve'}
      </Button>
      <Button size="sm" onClick={reject} disabled={busy} variant="destructive">Reject</Button>
      {err &amp;&amp; <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
```

Keep the existing `PayoutsBulkActions` import only if useful; otherwise remove (one-row-at-a-time approve is sufficient for v1).
  </action>

  <verify>
    <automated>grep -c "status_filter\|searchParams" apps/web/src/app/admin/payouts/page.tsx | grep -q "[1-9]" &amp;&amp; grep -c "requireAdmin" apps/web/src/app/admin/payouts/page.tsx | grep -q "[1-9]" &amp;&amp; test -f apps/web/src/app/admin/payouts/PayoutRowActions.tsx &amp;&amp; grep -c "AUTO_APPROVE_CAP_RUB" apps/web/src/app/admin/payouts/PayoutRowActions.tsx | grep -q "[1-9]" &amp;&amp; grep -c "20000" apps/web/src/app/admin/payouts/PayoutRowActions.tsx | grep -q "^1$" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Page reads status filter, calls requireAdmin, shows 4 counters + filtered rows + per-row actions; PayoutRowActions has auto-approve cap = 20000 constant; tsc passes.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Approve + reject API routes with tax calc + audit</name>
  <files>apps/web/src/app/api/admin/payouts/[id]/approve/route.ts, apps/web/src/app/api/admin/payouts/[id]/reject/route.ts, apps/web/src/__tests__/admin-payouts-approve.test.ts</files>

  <read_first>
    - `apps/web/src/lib/payouts/tax.ts` (just created, Task 1).
    - `apps/web/src/__tests__/admin-routing.test.ts` (test harness).
    - Spec lines 113-125 (§6 — tax breakdown saved on payouts row + audit).
  </read_first>

  <behavior>
    - Test 1: Non-admin → 401/403.
    - Test 2: Payout not found → 404.
    - Test 3: Payout already paid → 409 IDEMPOTENT_NOOP.
    - Test 4: User has no kyc_type → 422 KYC_REQUIRED.
    - Test 5: Happy path физлицо amount=10000 → UPDATE payouts SET tax_withheld_rub=1300, net_paid_rub=8700, status='paid', kyc_snapshot=jsonb, paid_at=NOW(); audit row written; locked author_earnings rows for this user up to amount become 'paid'.
    - Test 6: Reject — POST with `{reason}` → status='failed', admin_note=reason, audit action='payout.reject'.
  </behavior>

  <action>
Create `apps/web/src/app/api/admin/payouts/[id]/approve/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';
import { calculateTax, type KycType } from '@/lib/payouts/tax';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;

    const row = rowsOf<{
      id: string; author_id: string; amount_rub: string; status: string;
      kyc_status: string; kyc_type: string | null; tax_id: string | null;
      bank_details: unknown; kyc_verified_at: string | null;
    }>(await db.execute(sql`
      SELECT p.id::text, p.author_id::text, p.amount_rub::text, p.status,
             u.kyc_status, u.kyc_type, u.tax_id, u.bank_details, u.kyc_verified_at::text
      FROM payouts p JOIN users u ON u.id = p.author_id
      WHERE p.id = ${id}::uuid
    `))[0];
    if (!row) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (row.status === 'paid') return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });
    if (!row.kyc_type) return NextResponse.json({ error: 'KYC_REQUIRED' }, { status: 422 });

    const amount = Number(row.amount_rub);
    const tax = calculateTax(amount, row.kyc_type as KycType);

    // Snapshot KYC for audit trail
    const kycSnapshot = {
      kyc_type: row.kyc_type, tax_id: row.tax_id,
      kyc_verified_at: row.kyc_verified_at,
      // bank_details anonymized — keep last 4 of account / phone only
      // for v1 store full encrypted blob reference (TODO: anonymize after libsodium integration)
    };

    // B-5 fix: ALL three mutations (payouts UPDATE, author_earnings FIFO UPDATE, audit INSERT)
    // wrapped in a single drizzle transaction. Partial commits would corrupt the locked→paid
    // ledger if the audit insert later failed.
    // B-6 fix:
    //   - FIFO sums net_rub (author's share), NOT gross_rub. Payout consumes from author's share.
    //   - Boundary policy: EXCLUDE the boundary row (e.running <= tax.net_rub, never split a row).
    //     Effect: payout pays SLIGHTLY LESS than `amount` when the running sum doesn't land
    //     exactly on the requested amount; the remainder rolls to the next payout.
    //     Future: split-row mode for exact amounts — out of scope for Phase 14.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE payouts SET
          tax_withheld_rub = ${tax.tax_withheld_rub},
          net_paid_rub = ${tax.net_rub},
          kyc_snapshot = ${JSON.stringify(kycSnapshot)}::jsonb,
          status = 'paid',
          processed_at = NOW(),
          paid_at = NOW(),
          admin_note = COALESCE(admin_note, '') || ' approved by ' || ${user.email}
        WHERE id = ${id}::uuid AND status = 'requested'
      `);

      // Mark FIFO net_rub-summed locked author_earnings as 'paid' up to (and INCLUDING) the
      // last row whose running cumulative net_rub does not exceed tax.net_rub. The boundary row
      // (the one that would push running over) stays 'locked' for next payout.
      await tx.execute(sql`
        WITH eligible AS (
          SELECT id, net_rub, SUM(net_rub) OVER (ORDER BY computed_at, id) AS running
          FROM author_earnings
          WHERE author_id = ${row.author_id}::uuid AND status = 'locked' AND net_rub IS NOT NULL
        )
        UPDATE author_earnings ae SET status = 'paid'
        FROM eligible e
        WHERE ae.id = e.id AND e.running <= ${tax.net_rub}
      `);
      // Ledger invariant: sum(author_earnings.net_rub WHERE status='paid')
      //                == sum(payouts.net_paid_rub).

      await tx.execute(sql`
        INSERT INTO audit_log (actor_email, action, resource_type, resource_id, details, created_at)
        VALUES (${user.email}, 'payout.approve', 'payout', ${id},
                ${JSON.stringify({
                  amount_rub: amount, kyc_type: row.kyc_type,
                  tax_withheld_rub: tax.tax_withheld_rub, net_rub: tax.net_rub,
                  auto_path: amount <= 20000 && row.kyc_status === 'verified',
                })}::jsonb, NOW())
      `);
    });

    // TODO: enqueue real bank transfer (СБП API). For v1 just mark paid.
    // TODO: generate tax_act_storage_key PDF and store on payouts row.

    return NextResponse.json({ ok: true, id, ...tax });
  });
}
```

Create `apps/web/src/app/api/admin/payouts/[id]/reject/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;
    const { reason } = await req.json().catch(() => ({}));
    if (!reason || typeof reason !== 'string') {
      return NextResponse.json({ error: 'REASON_REQUIRED' }, { status: 400 });
    }
    // B-5 fix: wrap UPDATE + audit in a single transaction so a missing-payout case
    // doesn't leave a half-state.
    const updated = await db.transaction(async (tx) => {
      const r = await tx.execute(sql`
        UPDATE payouts SET status='failed', admin_note=${reason}, processed_at=NOW()
        WHERE id=${id}::uuid AND status IN ('requested','processing')
        RETURNING id::text
      `);
      if (!(r as { rowCount?: number }).rowCount) return false;
      await tx.execute(sql`
        INSERT INTO audit_log (actor_email, action, resource_type, resource_id, details, created_at)
        VALUES (${user.email}, 'payout.reject', 'payout', ${id},
                ${JSON.stringify({ reason })}::jsonb, NOW())
      `);
      return true;
    });
    if (!updated) {
      return NextResponse.json({ error: 'NOT_FOUND_OR_FINAL' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
```

Create `apps/web/src/__tests__/admin-payouts-approve.test.ts` mirroring `admin-routing.test.ts`:
- vi.mock auth + db + headers.
- Import POST from approve route + reject route.
- Test the 6 behaviors above; assert SQL strings contain the right table+column updates and that audit() was invoked.
  </action>

  <verify>
    <automated>test -f apps/web/src/app/api/admin/payouts/[id]/approve/route.ts &amp;&amp; test -f apps/web/src/app/api/admin/payouts/[id]/reject/route.ts &amp;&amp; test -f apps/web/src/__tests__/admin-payouts-approve.test.ts &amp;&amp; grep -c "calculateTax" apps/web/src/app/api/admin/payouts/[id]/approve/route.ts | grep -q "[1-9]" &amp;&amp; grep -c "payout.approve" apps/web/src/app/api/admin/payouts/[id]/approve/route.ts | grep -q "^1$" &amp;&amp; grep -c "payout.reject" apps/web/src/app/api/admin/payouts/[id]/reject/route.ts | grep -q "^1$" &amp;&amp; (grep -c "db.transaction" apps/web/src/app/api/admin/payouts/[id]/approve/route.ts | grep -q "[1-9]") &amp;&amp; (grep -c "tx.execute" apps/web/src/app/api/admin/payouts/[id]/approve/route.ts | awk '$1 >= 3 {exit 0} {exit 1}') &amp;&amp; grep "SUM(net_rub)" apps/web/src/app/api/admin/payouts/[id]/approve/route.ts &amp;&amp; grep "running <= " apps/web/src/app/api/admin/payouts/[id]/approve/route.ts &amp;&amp; grep -c "db.transaction" apps/web/src/app/api/admin/payouts/[id]/reject/route.ts | grep -q "[1-9]" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Both routes exist; approve calls calculateTax + writes kyc_snapshot + marks earnings paid + audits — ALL three mutations in a single db.transaction (B-5); FIFO uses net_rub with boundary EXCLUSIVE (B-6); reject also transactional; tests cover 6 behaviors; tsc clean.
  </done>
</task>

</tasks>

<verification>
- /admin/payouts page renders with status filter + KPI counters + per-row actions.
- Approve API: validation → tax calc → atomic UPDATE → audit → optional earnings mark-paid.
- Reject API: requires reason → UPDATE → audit.
- All grep checks pass; tsc clean.
</verification>

<success_criteria>
1. Admin can filter payouts by status.
2. Click Approve on requested row → tax computed, payout marked paid, audit written.
3. Auto-approve fast path triggers for amount ≤ 20000 ₽ AND kyc_status='verified'.
4. Reject with reason marks failed and audits.
5. Locked author_earnings up to payout amount transition to 'paid'.
</success_criteria>

<output>
After completion, create `.planning/phases/14-contest-marketplace-admin/14-04-SUMMARY.md`. Note TODO: real bank transfer (СБП API) + tax act PDF generator stubbed for Phase 14b.
</output>
