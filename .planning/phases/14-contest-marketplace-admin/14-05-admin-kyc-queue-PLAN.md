---
phase: 14-contest-marketplace-admin
plan: 05
type: execute
wave: 2
depends_on: [14-01]
files_modified:
  - apps/web/src/app/admin/kyc-queue/page.tsx
  - apps/web/src/app/admin/kyc-queue/KycRowActions.tsx
  - apps/web/src/app/api/admin/kyc/[id]/approve/route.ts
  - apps/web/src/app/api/admin/kyc/[id]/reject/route.ts
  - apps/web/src/app/admin/layout.tsx
  - apps/web/src/__tests__/admin-kyc-queue.test.ts
autonomous: true
requirements:
  - REQ-KYC-001
  - REQ-KYC-002
  - REQ-KYC-003
tags: [phase14, admin, kyc, compliance]
must_haves:
  truths:
    - "Admin sees pending KYC documents grouped by user with all uploaded doc_types"
    - "Admin can approve a document → kyc_documents.status='approved' AND if all required docs for kyc_type approved, users.kyc_status='verified' + kyc_verified_at=now()"
    - "Admin can reject a document with reason → kyc_documents.status='rejected', users.kyc_status='rejected'"
    - "All actions audited with action='kyc.approve_doc' or 'kyc.reject_doc'"
  artifacts:
    - path: apps/web/src/app/admin/kyc-queue/page.tsx
      provides: "Pending KYC review queue"
      contains: "requireAdmin"
    - path: apps/web/src/app/api/admin/kyc/[id]/approve/route.ts
      provides: "Document approve mutation"
      contains: "kyc_documents"
  key_links:
    - from: apps/web/src/app/admin/layout.tsx
      to: /admin/kyc-queue
      via: "sidebar nav link"
      pattern: "kyc-queue"
    - from: KycRowActions
      to: /api/admin/kyc/[id]/approve
      via: "fetch POST"
      pattern: "fetch.*kyc.*approve"
---

<objective>
NEW page `/admin/kyc-queue` per spec §5.4. Lists `kyc_documents` rows with `status='pending'`, grouped by user, with thumbnail preview links (S3 storage_key), approve/reject buttons. On approve of all required docs for the user's `kyc_type`, promote `users.kyc_status` to `'verified'`.

Purpose: Without this page, payout flow blocks indefinitely on KYC verification. This is the bottleneck for unlocking auto-approve on /admin/payouts.
Output: New page + actions component + 2 API routes + sidebar nav entry + tests.
</objective>

<execution_context>
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/workflows/execute-plan.md
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/14-contest-marketplace-admin/14-01-SUMMARY.md
@docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md
@apps/web/src/app/admin/jobs/page.tsx
@apps/web/src/app/admin/jobs/JobRowActions.tsx
@apps/web/src/app/admin/layout.tsx
@apps/web/src/lib/admin/guard.ts
@apps/web/src/__tests__/admin-routing.test.ts

<interfaces>
- kyc_documents table (created in 14-01): id, user_id, doc_type, storage_key, uploaded_at, reviewed_at, reviewed_by, status, rejection_reason.
- doc_type enum: passport_main, passport_registration, inn_certificate, ip_egrip, self_employed_certificate, other.
- Required docs per kyc_type (spec §5.1-5.3):
  - self_employed: ['self_employed_certificate', 'inn_certificate'] (or just self_employed_certificate if INN embedded — for v1 require both)
  - ip: ['ip_egrip', 'inn_certificate']
  - individual: ['passport_main', 'passport_registration', 'inn_certificate']
- Existing /admin/layout.tsx has a sidebar with links — read its structure to insert new link in appropriate position.
- S3 storage_key → public URL: assume existing helper `s3PublicUrl(key)` in `apps/web/src/lib/s3.ts` (verify; if absent, render `<a href={`/api/s3-presigned?key=${storage_key}`}>view</a>` with TODO).
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: KYC queue page + sidebar nav link</name>
  <files>apps/web/src/app/admin/kyc-queue/page.tsx, apps/web/src/app/admin/kyc-queue/KycRowActions.tsx, apps/web/src/app/admin/layout.tsx</files>

  <read_first>
    - Spec lines 273-307 (§5 — three KYC paths + admin review workflow).
    - `apps/web/src/app/admin/jobs/page.tsx` (full file — closest structural template: counters + table + filters + actions component).
    - `apps/web/src/app/admin/jobs/JobRowActions.tsx` (client actions pattern).
    - `apps/web/src/app/admin/layout.tsx` (sidebar nav structure).
  </read_first>

  <action>
Create `apps/web/src/app/admin/kyc-queue/page.tsx`:

```tsx
import * as React from 'react';
import { db, sql } from '@/lib/db';
import { rowsOf } from '@/lib/admin/rows';
import { requireAdmin } from '@/lib/admin/guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { KycRowActions } from './KycRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'KYC очередь — AIAG Admin' };

type Row = {
  doc_id: string;
  user_id: string;
  email: string;
  kyc_type: string | null;
  kyc_status: string;
  doc_type: string;
  storage_key: string;
  uploaded_at: string;
};

async function fetchPending(): Promise<Row[]> {
  try {
    const r = await db.execute(sql`
      SELECT d.id::text AS doc_id,
             u.id::text AS user_id, u.email,
             u.kyc_type, u.kyc_status,
             d.doc_type, d.storage_key, d.uploaded_at::text
      FROM kyc_documents d
      JOIN users u ON u.id = d.user_id
      WHERE d.status = 'pending'
      ORDER BY d.uploaded_at ASC
      LIMIT 200
    `);
    return rowsOf<Row>(r);
  } catch (e) {
    console.error('[admin/kyc-queue] fetch failed', e);
    return [];
  }
}

async function fetchCounters(): Promise<{ pending: number; approved_7d: number; rejected_7d: number }> {
  try {
    const r = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE status='approved' AND reviewed_at > NOW() - INTERVAL '7 days')::int AS approved_7d,
        COUNT(*) FILTER (WHERE status='rejected' AND reviewed_at > NOW() - INTERVAL '7 days')::int AS rejected_7d
      FROM kyc_documents
    `);
    return rowsOf<{ pending: number; approved_7d: number; rejected_7d: number }>(r)[0]
      ?? { pending: 0, approved_7d: 0, rejected_7d: 0 };
  } catch {
    return { pending: 0, approved_7d: 0, rejected_7d: 0 };
  }
}

export default async function AdminKycQueuePage() {
  await requireAdmin();
  const [rows, counters] = await Promise.all([fetchPending(), fetchCounters()]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">KYC очередь</h1>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">Pending</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold text-amber-400">{counters.pending}</div></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">Approved 7d</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{counters.approved_7d}</div></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">Rejected 7d</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold text-red-400">{counters.rejected_7d}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Документы на проверке</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-left px-3 py-2">KYC type</th>
                <th className="text-left px-3 py-2">Doc</th>
                <th className="text-left px-3 py-2">Файл</th>
                <th className="text-left px-3 py-2">Загружен</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.doc_id} className="border-t">
                  <td className="px-3 py-2 text-xs font-mono">{r.email}</td>
                  <td className="px-3 py-2"><Badge variant="outline">{r.kyc_type ?? '—'}</Badge></td>
                  <td className="px-3 py-2 text-xs">{r.doc_type}</td>
                  <td className="px-3 py-2 text-xs"><a href={`/api/admin/kyc/${r.doc_id}/file`} target="_blank" rel="noreferrer" className="text-amber-400 underline">открыть</a></td>
                  <td className="px-3 py-2 text-xs">{new Date(r.uploaded_at).toLocaleString('ru-RU')}</td>
                  <td className="px-3 py-2 text-right">
                    <KycRowActions docId={r.doc_id} userId={r.user_id} kycType={r.kyc_type} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 &amp;&amp; (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">Очередь пуста</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
```

Note on file viewing: `/api/admin/kyc/${doc_id}/file` is a future presigned-URL redirect endpoint (TODO — leave as href for now; v1 admin can manually fetch from S3 console using `storage_key`). This is acceptable for MVP since KYC volume is low (<10/day).

Create `apps/web/src/app/admin/kyc-queue/KycRowActions.tsx` as `'use client'` mirroring `JobRowActions.tsx`:

```tsx
'use client';
import * as React from 'react';
import { Button } from '@/components/ui/Button';

interface Props { docId: string; userId: string; kycType: string | null }

export function KycRowActions({ docId }: Props) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const approve = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/admin/kyc/${docId}/approve`, { method: 'POST' });
    if (!r.ok) { setErr((await r.json()).error ?? 'ERR'); setBusy(false); return; }
    window.location.reload();
  };
  const reject = async () => {
    const reason = window.prompt('Причина отказа?');
    if (!reason) return;
    setBusy(true);
    const r = await fetch(`/api/admin/kyc/${docId}/reject`, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ reason }),
    });
    if (!r.ok) { setErr((await r.json()).error ?? 'ERR'); setBusy(false); return; }
    window.location.reload();
  };

  return (
    <div className="flex gap-2 items-center justify-end">
      <Button size="sm" onClick={approve} disabled={busy}>Approve</Button>
      <Button size="sm" variant="destructive" onClick={reject} disabled={busy}>Reject</Button>
      {err &amp;&amp; <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
```

Update `apps/web/src/app/admin/layout.tsx`: locate the sidebar nav entries (likely an array or JSX list of `<Link href="/admin/...">`). Insert a new entry: `<Link href="/admin/kyc-queue">KYC очередь</Link>` positioned next to /admin/payouts (related concern). Match existing styling exactly (className, icon if other entries have icons).
  </action>

  <verify>
    <automated>test -f apps/web/src/app/admin/kyc-queue/page.tsx &amp;&amp; test -f apps/web/src/app/admin/kyc-queue/KycRowActions.tsx &amp;&amp; grep -c "requireAdmin" apps/web/src/app/admin/kyc-queue/page.tsx | grep -q "^1$" &amp;&amp; grep -c "kyc_documents" apps/web/src/app/admin/kyc-queue/page.tsx | grep -q "[1-9]" &amp;&amp; grep -c "kyc-queue" apps/web/src/app/admin/layout.tsx | grep -q "[1-9]" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Page exists, calls requireAdmin, fetches pending docs + counters; row actions client component wired; sidebar nav link added; tsc clean.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Approve + reject KYC API routes with kyc_type completeness check</name>
  <files>apps/web/src/app/api/admin/kyc/[id]/approve/route.ts, apps/web/src/app/api/admin/kyc/[id]/reject/route.ts, apps/web/src/__tests__/admin-kyc-queue.test.ts</files>

  <read_first>
    - Spec lines 277-301 (§5.1-5.3 — required documents per kyc_type).
    - `apps/web/src/__tests__/admin-routing.test.ts` (test harness).
  </read_first>

  <behavior>
    - Test 1: Non-admin → 401/403.
    - Test 2: Doc not found → 404.
    - Test 3: Doc already approved → 409 IDEMPOTENT_NOOP.
    - Test 4: Approve self_employed_certificate when user.kyc_type='self_employed' AND inn_certificate also approved → users.kyc_status='verified'.
    - Test 5: Approve self_employed_certificate when inn_certificate still pending → users.kyc_status stays 'pending'.
    - Test 6: Reject — doc.status='rejected' + rejection_reason set + users.kyc_status='rejected'.
    - Test 7: Audit row written with action='kyc.approve_doc' or 'kyc.reject_doc'.
  </behavior>

  <action>
Create `apps/web/src/app/api/admin/kyc/[id]/approve/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

const REQUIRED_DOCS: Record<string, string[]> = {
  self_employed: ['self_employed_certificate', 'inn_certificate'],
  ip: ['ip_egrip', 'inn_certificate'],
  individual: ['passport_main', 'passport_registration', 'inn_certificate'],
};

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;

    const doc = rowsOf<{ id: string; user_id: string; status: string; doc_type: string; kyc_type: string | null }>(
      await db.execute(sql`
        SELECT d.id::text, d.user_id::text, d.status, d.doc_type, u.kyc_type
        FROM kyc_documents d JOIN users u ON u.id = d.user_id
        WHERE d.id = ${id}::uuid
      `)
    )[0];
    if (!doc) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (doc.status === 'approved') return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });

    // Approve this doc
    await db.execute(sql`
      UPDATE kyc_documents
      SET status='approved', reviewed_at=NOW(), reviewed_by=(SELECT id FROM users WHERE email=${user.email}), rejection_reason=NULL
      WHERE id=${id}::uuid
    `);

    // Check completeness for user's kyc_type
    let promoted = false;
    if (doc.kyc_type &amp;&amp; REQUIRED_DOCS[doc.kyc_type]) {
      const required = REQUIRED_DOCS[doc.kyc_type];
      const approved = rowsOf<{ doc_type: string }>(await db.execute(sql`
        SELECT DISTINCT doc_type FROM kyc_documents
        WHERE user_id = ${doc.user_id}::uuid AND status = 'approved'
      `)).map((r) => r.doc_type);
      const allOk = required.every((t) => approved.includes(t));
      if (allOk) {
        await db.execute(sql`
          UPDATE users SET kyc_status='verified', kyc_verified_at=NOW() WHERE id=${doc.user_id}::uuid
        `);
        promoted = true;
      } else if (rowsOf(await db.execute(sql`SELECT 1 FROM users WHERE id=${doc.user_id}::uuid AND kyc_status='none'`)).length > 0) {
        // First doc approved while still 'none' → bump to 'pending'
        await db.execute(sql`UPDATE users SET kyc_status='pending' WHERE id=${doc.user_id}::uuid AND kyc_status='none'`);
      }
    }

    await audit(user.email!, 'kyc.approve_doc', 'kyc_document', id, {
      doc_type: doc.doc_type, user_id: doc.user_id, promoted_to_verified: promoted,
    });
    return NextResponse.json({ ok: true, promoted });
  });
}
```

Create `apps/web/src/app/api/admin/kyc/[id]/reject/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;
    const { reason } = await req.json().catch(() => ({}));
    if (!reason || typeof reason !== 'string') {
      return NextResponse.json({ error: 'REASON_REQUIRED' }, { status: 400 });
    }

    const doc = rowsOf<{ id: string; user_id: string; status: string }>(
      await db.execute(sql`SELECT id::text, user_id::text, status FROM kyc_documents WHERE id=${id}::uuid`)
    )[0];
    if (!doc) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (doc.status === 'rejected') return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });

    await db.execute(sql`
      UPDATE kyc_documents SET status='rejected', reviewed_at=NOW(),
        reviewed_by=(SELECT id FROM users WHERE email=${user.email}), rejection_reason=${reason}
      WHERE id=${id}::uuid
    `);
    await db.execute(sql`UPDATE users SET kyc_status='rejected' WHERE id=${doc.user_id}::uuid`);

    await audit(user.email!, 'kyc.reject_doc', 'kyc_document', id, { reason, user_id: doc.user_id });
    return NextResponse.json({ ok: true });
  });
}
```

Create `apps/web/src/__tests__/admin-kyc-queue.test.ts` covering the 7 behaviors. Mock `db.execute` to return staged results for each case.
  </action>

  <verify>
    <automated>test -f apps/web/src/app/api/admin/kyc/[id]/approve/route.ts &amp;&amp; test -f apps/web/src/app/api/admin/kyc/[id]/reject/route.ts &amp;&amp; test -f apps/web/src/__tests__/admin-kyc-queue.test.ts &amp;&amp; grep -c "REQUIRED_DOCS" apps/web/src/app/api/admin/kyc/[id]/approve/route.ts | grep -q "[1-9]" &amp;&amp; grep -c "kyc.approve_doc" apps/web/src/app/api/admin/kyc/[id]/approve/route.ts | grep -q "^1$" &amp;&amp; grep -c "kyc.reject_doc" apps/web/src/app/api/admin/kyc/[id]/reject/route.ts | grep -q "^1$" &amp;&amp; grep -c "kyc_status='verified'" apps/web/src/app/api/admin/kyc/[id]/approve/route.ts | grep -q "^1$" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Both routes exist; approve checks REQUIRED_DOCS completeness and promotes user.kyc_status='verified' atomically; reject sets users.kyc_status='rejected'; both audited; tests cover 7 behaviors; tsc clean.
  </done>
</task>

</tasks>

<verification>
- /admin/kyc-queue renders pending docs with counters.
- Sidebar nav link present.
- Approve API completeness check works (only verifies user when ALL required docs are approved).
- Reject sets user-level rejection.
- All grep checks pass; tsc clean.
</verification>

<success_criteria>
1. Admin sees pending KYC documents with email + doc_type + storage_key link.
2. Approving last required doc for user's kyc_type promotes users.kyc_status to 'verified'.
3. Reject requires reason, marks document rejected and user kyc_status='rejected'.
4. Both actions audited.
5. Sidebar entry visible in admin layout.
</success_criteria>

<output>
After completion, create `.planning/phases/14-contest-marketplace-admin/14-05-SUMMARY.md`. Note TODO: presigned URL endpoint for `/api/admin/kyc/[id]/file` deferred to v1 (admin uses S3 console).
</output>
