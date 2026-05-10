# Wave 3 — Supply / Contests Completion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public AI contests work end-to-end: admin creates contest → participants submit → eval-runner scores → leaderboard updates → close → revshare accrues → admin approves payout.

**Architecture:** Worker (`apps/worker`) already has eval-runner with systemd-run sandbox, close-contests-cron, finalize-earnings-cron. The main gap is the admin contest-creation UI and the submission upload flow. Payout approval already exists from Phase 14.

**Tech Stack:** Next.js App Router, Drizzle ORM, BullMQ, systemd-run sandbox, Postgres

**Prerequisite:** Wave 2 complete (specifically Wave 2 Task 1 — `packages/shared/src/s3.ts` must exist). Object Storage (S3) available for submission file uploads.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Read | `apps/worker/src/eval-runner/runner.ts` | Understand sandbox (already built) |
| Read | `apps/worker/src/queues/contest-eval.ts` | Understand eval queue |
| Create | `apps/web/src/app/api/admin/contests/route.ts` | Admin contest CRUD API |
| Create | `apps/web/src/app/api/contests/[slug]/submit/route.ts` | Submission upload endpoint |
| Modify | `apps/web/src/app/admin/contests/` | Admin contest create/edit UI |
| Create | `apps/web/src/app/(marketing)/contests/[slug]/submit/page.tsx` | Public submission page |

---

## Task 1: Audit eval-runner security

**Files:**
- Read: `apps/worker/src/eval-runner/runner.ts`

- [ ] **Step 1: Read eval-runner**

```bash
cat apps/worker/src/eval-runner/runner.ts
```

- [ ] **Step 2: Add LimitFSIZE to systemd-run call**

The runner uses `systemd-run --scope` but is missing `LimitFSIZE`. Add it explicitly to prevent disk exhaustion. In `apps/worker/src/eval-runner/runner.ts`, find the systemd-run args array and add:

```typescript
'-p', 'LimitFSIZE=524288',  // 256MB in 512-byte blocks (524288 * 512 = 268MB)
```

The full systemd-run args should include:
- `MemoryLimit=1G`
- `CPUQuota=80%` (or similar)
- `PrivateNetwork=yes`
- `NoNewPrivileges=yes`
- `ReadWritePaths=<workDir>`
- `LimitFSIZE=524288` ← ADD THIS

Commit after adding:
```bash
git add apps/worker/src/eval-runner/runner.ts
git commit -m "fix(eval-runner): add LimitFSIZE=524288 to systemd-run sandbox"
```

- [ ] **Step 3: Run eval-runner tests**

```bash
cd apps/worker && bun test src/eval-runner/ --timeout 15000
```
Expected: all tests pass.

- [ ] **Step 4: No commit needed if all checks pass. Fix and commit if issues found.**

---

## Task 2: Verify cron idempotency

**Files:**
- Read: `apps/worker/src/queues/finalize-earnings-cron.ts`
- Read: `apps/worker/src/queues/close-contests-cron.ts`

- [ ] **Step 1: Read and verify close-contests-cron**

```bash
cat apps/worker/src/queues/close-contests-cron.ts
```

Verify: `UPDATE contests SET status='closed' WHERE status='active' AND end_at <= NOW()` — idempotent by design (WHERE status='active' prevents double-close).

- [ ] **Step 2: Run cron tests**

```bash
cd apps/worker && bun test src/__tests__/ --timeout 10000
```
Expected: all tests pass including close-contests and finalize-earnings.

- [ ] **Step 3: Commit if any fixes were needed**

```bash
git add apps/worker/
git commit -m "fix(worker): cron idempotency verified + any fixes"
```

---

## Task 3: Admin contest creation UI

**Files:**
- Check existing: `apps/web/src/app/admin/contests/`
- Create if missing: `apps/web/src/app/api/admin/contests/route.ts`

- [ ] **Step 1: Check what exists**

```bash
ls apps/web/src/app/admin/contests/
cat apps/web/src/app/admin/contests/page.tsx 2>/dev/null | head -40
```

- [ ] **Step 2: Create admin contests API if missing**

```typescript
// apps/web/src/app/api/admin/contests/route.ts
import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard';
import { db } from '@/lib/db';
import { contests } from '@aiag/database/schema';
import { z } from 'zod';

const createSchema = z.object({
  title: z.string().min(3).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000),
  taskType: z.enum(['classification', 'regression', 'generation', 'ranking']),
  prizeRub: z.number().positive(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  evaluatorScript: z.string(), // Python evaluator source
  inputJson: z.string(),       // ground truth / test set (JSON)
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;

  const body = createSchema.safeParse(await req.json());
  if (!body.success) return Response.json({ error: body.error.flatten() }, { status: 422 });

  const { title, slug, description, taskType, prizeRub, startAt, endAt, evaluatorScript, inputJson } = body.data;

  const [contest] = await db.insert(contests).values({
    title,
    slug,
    description,
    taskType,
    prizeRub: String(prizeRub),
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    evaluatorScript,
    inputJson,
    status: 'draft',
  }).returning();

  return Response.json({ contest }, { status: 201 });
}
```

- [ ] **Step 3: If admin contests page is a stub, add create form**

In `apps/web/src/app/admin/contests/new/page.tsx` (create if missing), add a form with fields: title, slug, description, taskType, prizeRub, startAt, endAt, evaluatorScript (textarea), inputJson (textarea).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/admin/contests/ apps/web/src/app/admin/contests/
git commit -m "feat(admin): contest creation API + UI"
```

---

## Task 4: Submission upload endpoint

**Files:**
- Create: `apps/web/src/app/api/contests/[slug]/submit/route.ts`

> **Note:** `uploadToS3` is imported from `@aiag/shared/s3` — this requires Wave 2 Task 1 complete.
> The BullMQ payload must match `ContestEvalJobData` from `apps/worker/src/queues/contest-eval.ts`.
> Check that type before writing this code — the evaluator script source and submission file content must be included.

- [ ] **Step 1: Read ContestEvalJobData type**

```bash
cat apps/worker/src/queues/contest-eval.ts | head -40
```

This tells you the exact fields required in the queue payload.

- [ ] **Step 2: Write submission endpoint**

```typescript
// apps/web/src/app/api/contests/[slug]/submit/route.ts
import { NextRequest } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-user';
import { db } from '@/lib/db';
import { contests, contestSubmissions, evaluatorScripts } from '@aiag/database/schema';
import { eq, and } from 'drizzle-orm';
import { uploadToS3 } from '@aiag/shared/s3';

export const runtime = 'nodejs';

const MAX_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const authUser = await getAuthenticatedUser();
  if (!authUser) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const { slug } = await params;

  const [contest] = await db.select().from(contests)
    .where(and(eq(contests.slug, slug), eq(contests.status, 'active')));
  if (!contest) return Response.json({ error: 'contest_not_found_or_not_active' }, { status: 404 });

  const now = new Date();
  if (now < contest.startAt || now > contest.endAt) {
    return Response.json({ error: 'contest_not_open' }, { status: 400 });
  }

  // Fetch evaluator script — needed for BullMQ payload
  const [evalScript] = await db.select().from(evaluatorScripts)
    .where(eq(evaluatorScripts.contestId, contest.id));
  if (!evalScript) {
    return Response.json({ error: 'evaluator_not_configured' }, { status: 503 });
  }

  const formData = await req.formData();
  const file = formData.get('submission') as File | null;
  const description = (formData.get('description') as string ?? '').slice(0, 500);

  if (!file) return Response.json({ error: 'submission_required' }, { status: 400 });
  if (file.size > MAX_SIZE) return Response.json({ error: 'too_large', maxMb: 50 }, { status: 400 });

  const userId = authUser.user.id;
  const s3Key = `submissions/${contest.id}/${userId}/${Date.now()}-${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const fileUrl = await uploadToS3(s3Key, buffer, file.type);

  const [submission] = await db.insert(contestSubmissions).values({
    contestId: contest.id,
    userId,
    fileUrl,
    description,
    status: 'pending',
    publicScore: null,
    privateScore: null,
  }).returning();

  // Enqueue eval with full ContestEvalJobData (matches worker type)
  try {
    const { Queue } = await import('bullmq');
    const { createRedis } = await import('@/lib/redis');
    const queue = new Queue('contest-eval', { connection: createRedis() });
    await queue.add('eval', {
      submissionId: submission.id,
      contestId: contest.id,
      evaluatorScriptId: evalScript.id,
      scriptSource: evalScript.source,
      submissionFiles: [{ key: s3Key, url: fileUrl, name: file.name }],
      inputJson: contest.inputJson,
    });
  } catch (err) {
    console.error('Failed to enqueue eval job:', err);
    // submission saved — admin can retrigger from /admin/contests/[slug]
  }

  return Response.json({ submissionId: submission.id, status: 'pending' }, { status: 201 });
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -i "submit" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/contests/
git commit -m "feat(contests): submission upload endpoint + enqueue eval job"
```

---

## Task 5: Private score leak prevention

**Files:**
- Check: `apps/web/src/app/api/contests/[slug]/leaderboard/route.ts` (or similar)
- Check: any query that returns `privateScore` to non-admin users

Private scores must not be visible to authors until the contest is closed. This is enforced at the DB query level, not just the UI.

- [ ] **Step 1: Find leaderboard query**

```bash
grep -r "privateScore\|private_score" apps/web/src/ --include="*.ts" -l
```

- [ ] **Step 2: Ensure private score is hidden until contest close**

In any API route that returns submission scores to non-admin users, apply this guard:

```typescript
// Only return privateScore if contest is closed OR requesting user is admin
const isAdmin = authUser?.user.role === 'admin';
const isClosed = contest.status === 'closed';

// When building the response, null out privateScore unless allowed:
const safeSubmission = {
  ...submission,
  privateScore: (isClosed || isAdmin) ? submission.privateScore : null,
};
```

This must be applied at the DB query or serialization level — never rely on the UI to hide it.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/contests/
git commit -m "fix(contests): enforce private score hidden until contest close"
```

---

## Task 6: Public submission page

**Files:**
- Create: `apps/web/src/app/(marketing)/contests/[slug]/submit/page.tsx`

- [ ] **Step 1: Write submission UI**

```tsx
// apps/web/src/app/(marketing)/contests/[slug]/submit/page.tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import MainLayout from '@/components/layout/MainLayout';

// Note: Next.js 15 — params is a Promise in client components too when using searchParams
// but for simple slug-only pages, the prop arrives synchronously in client components.
export default function SubmitPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('uploading');
    const fd = new FormData(e.currentTarget);
    const res = await fetch(`/api/contests/${params.slug}/submit`, { method: 'POST', body: fd });
    if (res.ok) {
      setStatus('done');
      setMsg('Решение принято! Результат появится в лидерборде после проверки (~5 мин).');
    } else {
      const err = await res.json().catch(() => ({}));
      setStatus('error');
      setMsg(err.error ?? 'Ошибка загрузки');
    }
  }

  return (
    <MainLayout>
      <section className="container mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-bold mb-6">Отправить решение</h1>
        {status === 'done' ? (
          <div className="p-4 border rounded-sm" style={{ borderColor: 'var(--success)', color: 'var(--success)' }}>
            {msg}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Файл решения (CSV, JSON, ZIP — до 50 МБ)</label>
              <input type="file" name="submission" required className="block w-full text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Описание подхода (опционально)</label>
              <textarea name="description" rows={3} maxLength={500}
                className="block w-full text-sm p-2 rounded-sm border bg-transparent"
                style={{ borderColor: 'var(--line)' }} />
            </div>
            {status === 'error' && (
              <div className="text-sm" style={{ color: 'var(--danger)' }}>{msg}</div>
            )}
            <button type="submit" disabled={status === 'uploading'}
              className="px-5 py-2.5 font-semibold rounded-sm text-black"
              style={{ background: 'var(--accent)' }}>
              {status === 'uploading' ? 'Загружаем...' : 'Отправить решение'}
            </button>
          </form>
        )}
      </section>
    </MainLayout>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/\(marketing\)/contests/
git commit -m "feat(contests): public submission page"
```

---

## Task 7: End-to-end test and deploy

- [ ] **Step 1: Build worker**

```bash
cd apps/worker && bun run build 2>&1 | tail -5
```

- [ ] **Step 2: Run all worker tests**

```bash
cd apps/worker && bun test --timeout 30000
```
Expected: all tests pass.

- [ ] **Step 3: Push and deploy**

```bash
git push origin master
ops/scripts/deploy.sh
```

- [ ] **Step 4: Smoke test contest flow**

1. Admin: go to `/admin/contests`, create a test contest with simple evaluator script
2. Set status to 'active' in admin
3. Visit `/contests/[slug]` as a regular user
4. Submit a test file
5. Check `/admin/contests/[slug]` — submission appears in list
6. After worker processes eval job — check leaderboard for score

- [ ] **Step 5: Verify payout flow (Phase 14)**

Go to `/admin/payouts` — verify payout queue UI works (built in Phase 14).
Go to `/admin/kyc-queue` — verify KYC queue works.
