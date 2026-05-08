---
phase: 14-contest-marketplace-admin
plan: 03
type: execute
wave: 2
depends_on: [14-01]
files_modified:
  - apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx
  - apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx
  - apps/web/src/app/admin/contests/[slug]/page.tsx
  - apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts
  - apps/web/src/__tests__/admin-contests-publish.test.ts
autonomous: true
requirements:
  - REQ-CONTEST-002
  - REQ-CONTEST-003
tags: [phase14, admin, contests, publish, modal]
must_haves:
  truths:
    - "Admin sees a 'Опубликовать как marketplace-модель' button on each contest_submissions row with final_rank ≤ 3"
    - "Submitting the modal creates a models row with status='pending_author_consent' and links it via contest_submissions.published_model_id"
    - "Admin action emits an audit_log row with action='contest.publish_submission'"
  artifacts:
    - path: apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx
      provides: "Client modal with form fields per spec §2 Step 2"
      contains: "hosting_strategy"
    - path: apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts
      provides: "Backend mutation"
      contains: "INSERT INTO models"
  key_links:
    - from: apps/web/src/app/admin/contests/[slug]/page.tsx
      to: PublishSubmissionModal
      via: "renders Modal trigger inside ContestSubmissionsActions row"
      pattern: "PublishSubmissionModal"
    - from: PublishSubmissionModal
      to: /api/admin/contests/[slug]/publish-submission
      via: "fetch POST"
      pattern: "fetch.*publish-submission"
---

<objective>
Add admin publish modal on `/admin/contests/[slug]` per spec §2 Step 2 + wireframe 01. Each submission row with `final_rank ≤ contest.publish_top_k (default 3)` gets a "Опубликовать как marketplace-модель" button. Modal collects: slug, display name, description, hosting_strategy (radio), pricing (cost_rub_override), tags. POST creates `models` row in `pending_author_consent` and links via `contest_submissions.published_model_id`.

Purpose: Admin entry point — without this, contest winners cannot become marketplace models even after schema migration.
Output: Modal component + API route + tests + integration into existing `ContestSubmissionsActions`.
</objective>

<execution_context>
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/workflows/execute-plan.md
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/14-contest-marketplace-admin/14-01-SUMMARY.md
@docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md
@apps/web/src/app/admin/contests/[slug]/page.tsx
@apps/web/src/lib/admin/guard.ts
@apps/web/src/lib/admin/api.ts
@apps/web/src/__tests__/admin-routing.test.ts

<interfaces>
- shadcn `Dialog` component: `apps/web/src/components/ui/Dialog.tsx` (verify presence; if missing fallback to `<dialog>` HTML element with manual styling — don't add new package).
- Existing `ContestSubmissionsActions.tsx` already exists at `apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx` (referenced in page.tsx line 7). Read it to see its current "set winner" button — extend with a new "Publish" button.
- Admin API guard: `withAdmin(async ({ user }) => {...})` from `@/lib/admin/api`. Returns NextResponse.json on auth fail.
- Audit helper: `audit(actorEmail, action, resourceType, resourceId, details)` from `@/lib/admin/guard`. Action namespace per Phase 11/12 convention: `contest.publish_submission`.
- DB raw SQL pattern: `db.execute(sql\`...\`)` returning `{ rows: [...] }` extracted via `rowsOf<T>(r)`.
- Models table columns post-14-01: `id, slug, name, type, status, hosting_strategy, derived_from_contest_id, author_user_id, enabled, ...`. Default cost stored on per-modality basis — for v1 just write to a custom field or extend `models` later; this plan does NOT modify pricing tables, just records `cost_rub_override` to a new column if absent — see action below.

Email/TG notification stub: `@aiag/email` and `apps/worker/src/queues/email-send.ts` exist (worker queue). For v1 the API route enqueues an email job with body `'Поздравляем! Ваша модель победила в конкурсе...'` — actual delivery handled by existing email-send worker.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create PublishSubmissionModal client component + integrate row action</name>
  <files>apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx, apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx</files>

  <read_first>
    - Spec lines 38-57 (§2 Step 2 — exact field list + behavior).
    - `apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx` (current row actions component).
    - `apps/web/src/components/ui/Dialog.tsx` (if exists) for shadcn Dialog API.
    - `apps/web/src/app/admin/routing/AddRouteForm.tsx` (analog: a client form that POSTs to admin API and reloads).
  </read_first>

  <action>
Create `apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx` as `'use client'` component:

Props: `{ slug: string; submissionId: string; finalRank: number; participantEmail: string | null; suggestedSlug: string }`.

Use shadcn Dialog (or `<dialog ref={ref}>` fallback). Form fields:
1. `name="model_slug"` — text input, default value = `suggestedSlug` (from props), pattern `^[a-z0-9-]{3,80}$`.
2. `name="display_name"` — text input, required, maxLength 100.
3. `name="description"` — textarea, maxLength 500, optional.
4. `name="hosting_strategy"` — radio with three options: `cloud_api_wrap` (default, label "Cloud-API wrap"), `hosted_on_aiag` (label "Hosted on AIAG"), `self_hosted_by_author` (label "Self-hosted by автор").
5. `name="cost_rub_override"` — number input step=0.01, optional.
6. `name="tags_csv"` — text input, default `'🏆 contest-winner,from-contest-${slug}'`, comma-separated.
7. Tier preview block (read-only): display "Автор сейчас на tier: {tierLabel}" — fetched on modal open via GET `/api/admin/users/by-submission/${submissionId}/tier` (or computed client-side as TODO — leave as placeholder text "tier preview TODO" wrapped in `<p className="text-xs text-muted-foreground">` if API not built; the value is not load-bearing for v1).
8. Submit button: "Опубликовать как marketplace-модель" → fetch POST to `/api/admin/contests/${slug}/publish-submission` with JSON body `{submission_id, model_slug, display_name, description, hosting_strategy, cost_rub_override, tags: tags_csv.split(',').map(s => s.trim())}`.

Submit handler: on 200 response → `window.location.reload()`. On non-200 → show error in `<p className="text-red-400 text-sm">{json.error}</p>`.

Use shadcn `Button`, `Input`, `Label`, `RadioGroup` from `@/components/ui/*`. No new dependencies.

Update `apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx`: import `PublishSubmissionModal`. Render the modal trigger button inline conditionally: `{rank !== null &amp;&amp; rank <= 3 ? <PublishSubmissionModal ... /> : null}`. Keep existing setWinner button untouched.

Update `apps/web/src/app/admin/contests/[slug]/page.tsx` SQL select: add `cs.final_rank` to the SELECT and pass it through `submissions` array. Also pass `participant_email` (already there) and a computed `suggestedSlug = `contest-${contest.slug}-rank${rank}``. Pass to ContestSubmissionsActions which passes through to PublishSubmissionModal.
  </action>

  <verify>
    <automated>test -f apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx &amp;&amp; grep -c "hosting_strategy" apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx | grep -q "[2-9]" &amp;&amp; grep -c "publish-submission" apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx | grep -q "[1-9]" &amp;&amp; grep -c "PublishSubmissionModal" apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx | grep -q "[1-9]" &amp;&amp; grep -c "final_rank" apps/web/src/app/admin/contests/[slug]/page.tsx | grep -q "[1-9]" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Modal exists with all 6 form fields + 3 hosting_strategy radios; trigger button rendered conditionally on rank ≤ 3; tsc passes.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: API route POST /api/admin/contests/[slug]/publish-submission + audit + email enqueue</name>
  <files>apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts, apps/web/src/__tests__/admin-contests-publish.test.ts</files>

  <read_first>
    - Spec lines 49-57 (§2 Step 2 — model insert + status='pending_author_consent' + email/TG invite).
    - `apps/web/src/lib/admin/api.ts` (withAdmin wrapper) and `apps/web/src/lib/admin/guard.ts` (audit helper).
    - `apps/web/src/__tests__/admin-routing.test.ts` (test harness pattern with vi.mock auth + db).
    - Existing API route under `apps/web/src/app/api/admin/contests/` (any) for FK pattern.
  </read_first>

  <behavior>
    - Test 1: Non-admin caller → 401/403.
    - Test 2: Missing required field (display_name) → 400 with `{error: 'INVALID_INPUT'}`.
    - Test 3: Submission not found OR not in current contest → 404.
    - Test 4: Submission with final_rank > 3 → 400 with `{error: 'NOT_TOP_K'}`.
    - Test 5: Duplicate model_slug already exists → 409 `{error: 'SLUG_TAKEN'}`.
    - Test 6: Happy path — inserts into models with status='pending_author_consent', sets contest_submissions.published_model_id, calls audit(), returns 200 `{ok: true, model_id, model_slug}`.
    - Test 7: Audit row written with action='contest.publish_submission', resource_type='contest_submission', resource_id=submission_id.
  </behavior>

  <action>
Create `apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return withAdmin(async ({ user }) => {
    const { slug } = await params;
    const body = await req.json().catch(() => ({}));
    const submission_id = String(body.submission_id ?? '');
    const model_slug = String(body.model_slug ?? '').trim();
    const display_name = String(body.display_name ?? '').trim();
    const description = body.description ? String(body.description) : null;
    const hosting_strategy = String(body.hosting_strategy ?? 'cloud_api_wrap');
    const cost_rub_override = body.cost_rub_override !== undefined &amp;&amp; body.cost_rub_override !== '' ? Number(body.cost_rub_override) : null;
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];

    // Validation
    if (!submission_id || !model_slug || !display_name) {
      return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
    }
    if (!/^[a-z0-9-]{3,80}$/.test(model_slug)) {
      return NextResponse.json({ error: 'INVALID_SLUG' }, { status: 400 });
    }
    if (!['cloud_api_wrap', 'hosted_on_aiag', 'self_hosted_by_author'].includes(hosting_strategy)) {
      return NextResponse.json({ error: 'INVALID_HOSTING' }, { status: 400 });
    }

    // Look up submission + contest
    const sub = rowsOf<{ id: string; user_id: string; final_rank: number | null; contest_id: string }>(
      await db.execute(sql`
        SELECT cs.id::text, cs.user_id::text, cs.final_rank, cs.contest_id::text
        FROM contest_submissions cs
        JOIN contests c ON c.id = cs.contest_id
        WHERE cs.id = ${submission_id}::uuid AND c.slug = ${slug}
      `)
    )[0];
    if (!sub) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (sub.final_rank == null || sub.final_rank > 3) {
      return NextResponse.json({ error: 'NOT_TOP_K' }, { status: 400 });
    }

    // Slug uniqueness
    const dup = rowsOf<{ id: string }>(await db.execute(sql`SELECT id::text FROM models WHERE slug = ${model_slug}`))[0];
    if (dup) return NextResponse.json({ error: 'SLUG_TAKEN' }, { status: 409 });

    // Insert model
    const ins = rowsOf<{ id: string }>(await db.execute(sql`
      INSERT INTO models (slug, name, description, status, hosting_strategy,
                          author_user_id, derived_from_contest_id, type, enabled, tags)
      VALUES (${model_slug}, ${display_name}, ${description}, 'pending_author_consent',
              ${hosting_strategy}, ${sub.user_id}::uuid, ${sub.contest_id}::uuid,
              'llm', false, ${tags})
      RETURNING id::text
    `));
    const model_id = ins[0]?.id;
    if (!model_id) return NextResponse.json({ error: 'INSERT_FAILED' }, { status: 500 });

    // Link submission
    await db.execute(sql`
      UPDATE contest_submissions SET published_model_id = ${model_id}::uuid WHERE id = ${submission_id}::uuid
    `);

    // Audit
    await audit(user.email!, 'contest.publish_submission', 'contest_submission', submission_id, {
      model_id, model_slug, hosting_strategy, contest_slug: slug,
    });

    // Enqueue invite email — email_jobs table is created in 14-01 migration; let errors throw.
    // (W-5 fix: previous version swallowed errors via try/catch; per revision, fail loud
    // so a misconfigured email_jobs schema surfaces in CI rather than silently losing invites.)
    await db.execute(sql`
      INSERT INTO email_jobs (to_user_id, template, payload, status, created_at)
      VALUES (${'$'}{sub.user_id}::uuid, 'contest_publish_invite',
              ${'$'}{JSON.stringify({ model_slug, contest_slug: slug, consent_url: `/me/contest-wins/${'$'}{submission_id}/publish` })}::jsonb,
              'pending', NOW())
    `);

    return NextResponse.json({ ok: true, model_id, model_slug });
  });
}
```

The `email_jobs` table is now created in 14-01 migration (W-5 fix); the enqueue MUST throw on failure rather than swallow. The `type: 'llm'` default is a placeholder — Phase 14b will let admin choose modality.

Note: The `models.tags text[]` column is added in 14-01 migration (W-6 fix). The INSERT above relies on it. No fallback needed.

Create `apps/web/src/__tests__/admin-contests-publish.test.ts` mirroring `admin-routing.test.ts`:
- vi.mock `@/auth` + `@/lib/db` + `next/headers`.
- Import `POST` from the new route file.
- Provide mocked `db.execute` returning ordered results: 1st call (submission lookup) returns submission row, 2nd (slug check) returns empty, 3rd (insert) returns `[{id:'m-1'}]`, 4th (UPDATE) returns empty, 5th (audit), 6th (email_jobs).
- Assert HTTP status + JSON body for the 7 behaviors above.
  </action>

  <verify>
    <automated>test -f apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts &amp;&amp; test -f apps/web/src/__tests__/admin-contests-publish.test.ts &amp;&amp; grep -c "INSERT INTO models" apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts | grep -q "^1$" &amp;&amp; grep -c "pending_author_consent" apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts | grep -q "^1$" &amp;&amp; grep -c "audit(" apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts | grep -q "[1-9]" &amp;&amp; grep -c "contest.publish_submission" apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts | grep -q "^1$" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Route handles 7 behaviors; INSERT INTO models with status='pending_author_consent'; audit row written; tsc passes; tests cover all behaviors.
  </done>
</task>

</tasks>

<verification>
- Modal + actions wire up; clicking modal trigger opens dialog with 6 fields.
- API endpoint validates input, inserts model, links submission, audits, returns 200.
- Tests for both client UI logic (smoke via component existence) and API endpoint (vitest).
- tsc clean across apps/web.
</verification>

<success_criteria>
1. Admin can click "Опубликовать" on top-3 submission rows → modal opens.
2. Submitting modal creates `models` row with `status='pending_author_consent'`, `derived_from_contest_id`, `author_user_id`.
3. `contest_submissions.published_model_id` is set on success.
4. audit_log row with action='contest.publish_submission' is written.
5. Endpoint rejects non-top-3 submissions with 400.
</success_criteria>

<output>
After completion, create `.planning/phases/14-contest-marketplace-admin/14-03-SUMMARY.md`.
</output>
