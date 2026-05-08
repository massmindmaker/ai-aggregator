---
phase: 14-contest-marketplace-admin
plan: 06
type: execute
wave: 2
depends_on: [14-01]
files_modified:
  - apps/web/src/app/admin/models/[slug]/edit/page.tsx
  - apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx
  - apps/web/src/app/api/admin/models/[id]/freeze/route.ts
  - apps/web/src/app/api/admin/models/[id]/depublish/route.ts
  - packages/api-gateway/src/middleware/model-status-check.ts
  - apps/web/src/__tests__/admin-models-freeze.test.ts
autonomous: true
requirements:
  - REQ-CONTEST-005
tags: [phase14, admin, models, freeze, gateway]
must_haves:
  truths:
    - "Admin can freeze a model — models.status='frozen' and gateway returns 503 + Retry-After for that model_slug"
    - "Admin can depublish a model — models.status='depublished'; pending earnings remain pending until cron resolves"
    - "Both actions require a reason and are audited"
    - "Gateway middleware checks models.status before settle and short-circuits 'frozen'/'depublished' to 503"
  artifacts:
    - path: apps/web/src/app/api/admin/models/[id]/freeze/route.ts
      provides: "Freeze mutation"
      contains: "status='frozen'"
    - path: apps/web/src/app/api/admin/models/[id]/depublish/route.ts
      provides: "Depublish mutation"
      contains: "status='depublished'"
    - path: packages/api-gateway/src/middleware/model-status-check.ts
      provides: "503 short-circuit for non-live models"
      contains: "Retry-After"
  key_links:
    - from: apps/web/src/app/admin/models/[slug]/edit/page.tsx
      to: ModelStatusActions
      via: "renders freeze/depublish buttons"
      pattern: "ModelStatusActions"
    - from: gateway request handler
      to: model-status-check middleware
      via: "pre-settle status query"
      pattern: "model-status-check"
---

<objective>
Add freeze/depublish admin controls per spec §7.3 (model degradation state machine). Admin can transition `models.status` from `'live'` to `'frozen'` or `'depublished'` with reason; gateway middleware reads status before billing and returns 503 + Retry-After for non-live models.

Purpose: Without freeze, a degraded model keeps charging users while admin has no off-switch. Spec §7.3 requires this to refund users in 30-day window.
Output: Edit page extension + 2 API routes + gateway middleware + tests.
</objective>

<execution_context>
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/workflows/execute-plan.md
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/14-contest-marketplace-admin/14-01-SUMMARY.md
@docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md
@apps/web/src/app/admin/models/[slug]/edit/page.tsx
@apps/web/src/lib/admin/guard.ts
@packages/api-gateway/src/billing/settle.ts
@apps/web/src/__tests__/admin-routing.test.ts

<interfaces>
- models columns post-14-01: status text DEFAULT 'live' CHECK (status IN ('draft','pending_author_consent','live','frozen','depublished')), frozen_reason text, depublished_reason text.
- Gateway: `packages/api-gateway/src/billing/settle.ts` is the wrapper. Need a sibling middleware OR pre-route check that runs BEFORE settle, blocking the request entirely.
- Existing edit page `apps/web/src/app/admin/models/[slug]/edit/page.tsx` — read it to understand current form and where to inject status actions.
- Gateway uses Hono. Look for existing route handlers in `packages/api-gateway/src/routes/` (or similar) — the middleware file path here is illustrative; locate the actual chat-completions handler and apply the check inline if a global middleware doesn't fit.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: ModelStatusActions component + edit page integration</name>
  <files>apps/web/src/app/admin/models/[slug]/edit/page.tsx, apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx</files>

  <read_first>
    - Spec lines 358-380 (§7.3 — full state machine including frozen/depublished consequences).
    - `apps/web/src/app/admin/models/[slug]/edit/page.tsx` (current form structure).
    - `apps/web/src/app/admin/jobs/JobRowActions.tsx` (client actions pattern with confirm + reason prompt).
  </read_first>

  <action>
Create `apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx` as `'use client'`:

```tsx
'use client';
import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

interface Props {
  modelId: string;
  modelSlug: string;
  status: string;
  frozenReason: string | null;
  depublishedReason: string | null;
}

export function ModelStatusActions({ modelId, modelSlug, status, frozenReason, depublishedReason }: Props) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const freeze = async () => {
    const reason = window.prompt(`Причина заморозки модели ${modelSlug}? (видна в audit_log)`);
    if (!reason) return;
    setBusy(true); setErr(null);
    const r = await fetch(`/api/admin/models/${modelId}/freeze`, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ reason }),
    });
    if (!r.ok) { setErr((await r.json()).error ?? 'ERR'); setBusy(false); return; }
    window.location.reload();
  };

  const depublish = async () => {
    const reason = window.prompt(`Причина деплабликации модели ${modelSlug}? (необратимо)`);
    if (!reason) return;
    if (!window.confirm(`Подтвердить деплабликацию ${modelSlug}? Pending earnings останутся pending до resolution.`)) return;
    setBusy(true); setErr(null);
    const r = await fetch(`/api/admin/models/${modelId}/depublish`, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ reason }),
    });
    if (!r.ok) { setErr((await r.json()).error ?? 'ERR'); setBusy(false); return; }
    window.location.reload();
  };

  const canFreeze = status === 'live';
  const canDepublish = status === 'live' || status === 'frozen';

  return (
    <div className="space-y-3 border border-border rounded-md p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm">Текущий статус:</span>
        <Badge variant={status === 'live' ? 'default' : status === 'frozen' ? 'outline' : 'destructive'}>
          {status}
        </Badge>
      </div>
      {frozenReason &amp;&amp; <p className="text-xs text-amber-400">Причина заморозки: {frozenReason}</p>}
      {depublishedReason &amp;&amp; <p className="text-xs text-red-400">Причина деплабликации: {depublishedReason}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={freeze} disabled={!canFreeze || busy}>Freeze (503)</Button>
        <Button size="sm" variant="destructive" onClick={depublish} disabled={!canDepublish || busy}>Depublish</Button>
      </div>
      {err &amp;&amp; <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
```

Update `apps/web/src/app/admin/models/[slug]/edit/page.tsx`: extend the SELECT to also fetch `id::text, status, frozen_reason, depublished_reason`. Render `<ModelStatusActions modelId={...} modelSlug={...} status={...} frozenReason={...} depublishedReason={...} />` near the top of the form (above existing fields).
  </action>

  <verify>
    <automated>test -f apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx &amp;&amp; grep -c "ModelStatusActions" apps/web/src/app/admin/models/[slug]/edit/page.tsx | grep -q "[1-9]" &amp;&amp; grep -c "/freeze" apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx | grep -q "^1$" &amp;&amp; grep -c "/depublish" apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx | grep -q "^1$" &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json</automated>
  </verify>

  <done>
    Component renders status badge + freeze/depublish buttons with reason prompts; edit page wires it; tsc clean.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Freeze + depublish API routes + gateway 503 short-circuit</name>
  <files>apps/web/src/app/api/admin/models/[id]/freeze/route.ts, apps/web/src/app/api/admin/models/[id]/depublish/route.ts, packages/api-gateway/src/middleware/model-status-check.ts, apps/web/src/__tests__/admin-models-freeze.test.ts</files>

  <read_first>
    - Spec lines 358-380 (§7.3 — frozen returns 503 + Retry-After; pending earnings stay pending).
    - `packages/api-gateway/src/billing/settle.ts` (wrapper pattern + errors helper).
    - `apps/web/src/__tests__/admin-routing.test.ts` (test harness).
    - Locate gateway routes: search `packages/api-gateway/src/` for `chat/completions` or `app.post` to find where to plug the middleware.
  </read_first>

  <behavior>
    - Test 1: Non-admin → 401/403 on freeze.
    - Test 2: Model not found → 404.
    - Test 3: Model already frozen → 409 IDEMPOTENT_NOOP.
    - Test 4: Reason missing → 400 REASON_REQUIRED.
    - Test 5: Happy path freeze — UPDATE status='frozen', frozen_reason set, audit row 'model.freeze' written.
    - Test 6: Depublish from 'live' OR 'frozen' → status='depublished', depublished_reason set, audit 'model.depublish' written.
    - Test 7: Gateway middleware: when DB returns model_status='frozen', returns 503 with header Retry-After: 3600.
    - Test 8: Gateway middleware: when DB returns model_status='live', passes through.
    - Test 9 (B-3): Two consecutive calls with same modelSlug BOTH hit the DB (no in-process cache). Assert sql tag invoked twice.
  </behavior>

  <action>
Create `apps/web/src/app/api/admin/models/[id]/freeze/route.ts`:

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
    const m = rowsOf<{ id: string; slug: string; status: string }>(
      await db.execute(sql`SELECT id::text, slug, status FROM models WHERE id=${id}::uuid`)
    )[0];
    if (!m) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (m.status === 'frozen') return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });

    await db.execute(sql`
      UPDATE models SET status='frozen', frozen_reason=${reason} WHERE id=${id}::uuid
    `);
    await audit(user.email!, 'model.freeze', 'model', id, { slug: m.slug, reason, prev_status: m.status });
    return NextResponse.json({ ok: true });
  });
}
```

Create `apps/web/src/app/api/admin/models/[id]/depublish/route.ts` — same pattern with `status='depublished'`, `depublished_reason=reason`, audit action `model.depublish`. Allowed transitions: `live`→`depublished` or `frozen`→`depublished`. Reject if already 'depublished' (409) or 'draft'/'pending_author_consent' (400 INVALID_TRANSITION).

Create `packages/api-gateway/src/middleware/model-status-check.ts`:

**B-3 fix:** No in-process cache. The middleware does a fresh per-request DB lookup against `models.status`. Rationale: settle-charge.sql in plan 14-01 is the AUTHORITATIVE CUTOFF (it filters `m.status = 'live'` at accrue time). Middleware is a 503-short-circuit OPTIMIZATION, not the gate. Adding a 30s cache risks (a) drifted accrual decisions vs. middleware decisions, and (b) operator confusion when a freeze action takes "up to 30s" to take effect. A per-request `SELECT status FROM models WHERE slug=\$1` against an indexed column (idx_models_status_live in 14-01) is sub-millisecond and shares Postgres's row cache anyway.

```ts
import type { Context, Next } from 'hono';
import { sql as defaultSql } from '../lib/db';

/**
 * Per-request DB lookup — no in-process cache. The DB index `idx_models_status_live`
 * (created in migration 0014) makes this fast. NEVER add caching here without first
 * adding a synchronous flush endpoint called from the freeze/depublish admin routes.
 */
export async function checkModelStatus(
  modelSlug: string,
  sql = defaultSql
): Promise<'live' | 'frozen' | 'depublished' | 'draft' | 'pending_author_consent' | 'unknown'> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM models WHERE slug = ${modelSlug} LIMIT 1`;
  return (rows[0]?.status ?? 'unknown') as ReturnType<typeof checkModelStatus> extends Promise<infer T> ? T : never;
}

export function modelStatusMiddleware() {
  return async (c: Context, next: Next) => {
    // Hono: don't consume body twice — peek model slug from JSON without losing it.
    // Use c.req.raw.clone() so downstream handlers can re-read the body.
    let modelSlug: string | undefined;
    try {
      const cloned = c.req.raw.clone();
      const body = (await cloned.json()) as { model?: string };
      modelSlug = body?.model;
    } catch {
      return next(); // non-JSON body — let the route handle it
    }
    if (!modelSlug) return next();
    // Fresh DB lookup — NO CACHE (B-3).
    const status = await checkModelStatus(modelSlug);
    if (status === 'frozen' || status === 'depublished') {
      c.header('Retry-After', '3600');
      return c.json({ error: 'MODEL_UNAVAILABLE', status, model: modelSlug }, 503);
    }
    return next();
  };
}
```

**W-9 wiring (verified against `packages/api-gateway/src/server.ts`):**

The gateway server (server.ts) registers `/v1/*` middleware in this order:
- Line 70: `app.use('/v1/*', requireApiKey);`
- Line 71: `app.use('/v1/*', rateLimit);`
- Line 72: `app.use('/v1/*', piiFilter);`
- Lines 74–81: route mounts (`app.route('/v1/chat', chat);` etc.)

Add modelStatusMiddleware AFTER piiFilter (so we authenticate + rate-limit first, then short-circuit non-live models before any upstream call). Concretely:

1. Add import near the other middleware imports (around line 11–14):
   ```ts
   import { modelStatusMiddleware } from './middleware/model-status-check';
   ```
2. Add a new line immediately after line 72 (`app.use('/v1/*', piiFilter);`):
   ```ts
   app.use('/v1/*', modelStatusMiddleware());
   ```
   This applies to ALL /v1/* routes (chat, completions, images, video, audio, embeddings) — every billable endpoint. The middleware is a no-op (next()) when the request body has no `model` field, so non-model routes (`/v1/balance`, `/v1/models`) pass through.

This is a HARD REQUIREMENT, not a TODO fallback. Since no in-process cache (B-3 fix), no cache-invalidation endpoint is needed — freeze/depublish writes to `models.status` and the very next gateway request sees the new value.

Create `apps/web/src/__tests__/admin-models-freeze.test.ts` covering 8 behaviors:
- Tests 1-6 mirror admin-routing.test.ts harness (vi.mock auth + db).
- Tests 7-9 import `checkModelStatus` from gateway middleware and pass a fake sql tag returning specific rows; assert returned status string. Test 9 verifies the fake sql tag was called twice for two consecutive lookups (no cache).
  </action>

  <verify>
    <automated>test -f apps/web/src/app/api/admin/models/[id]/freeze/route.ts &amp;&amp; test -f apps/web/src/app/api/admin/models/[id]/depublish/route.ts &amp;&amp; test -f packages/api-gateway/src/middleware/model-status-check.ts &amp;&amp; test -f apps/web/src/__tests__/admin-models-freeze.test.ts &amp;&amp; grep -c "status='frozen'" apps/web/src/app/api/admin/models/[id]/freeze/route.ts | grep -q "^1$" &amp;&amp; grep -c "status='depublished'" apps/web/src/app/api/admin/models/[id]/depublish/route.ts | grep -q "^1$" &amp;&amp; grep -c "Retry-After" packages/api-gateway/src/middleware/model-status-check.ts | grep -q "^1$" &amp;&amp; grep -c "model.freeze" apps/web/src/app/api/admin/models/[id]/freeze/route.ts | grep -q "^1$" &amp;&amp; (! grep -E "STATUS_CACHE|CACHE_TTL_MS" packages/api-gateway/src/middleware/model-status-check.ts) &amp;&amp; grep -c "modelStatusMiddleware" packages/api-gateway/src/server.ts | grep -q "[2-9]" &amp;&amp; grep -E "app.use\(['\"]/v1/\*['\"], modelStatusMiddleware" packages/api-gateway/src/server.ts &amp;&amp; npx tsc --noEmit -p apps/web/tsconfig.json &amp;&amp; npx tsc --noEmit -p packages/api-gateway/tsconfig.json</automated>
  </verify>

  <done>
    Both routes exist with audit + reason validation; gateway middleware does fresh per-request DB lookup (NO cache, B-3) + returns 503 with Retry-After; middleware wired into server.ts at line 73 (after piiFilter, before route mounts) per W-9; tests cover 9 behaviors; tsc clean both projects.
  </done>
</task>

</tasks>

<verification>
- Edit page renders status actions with current status visible.
- Freeze/depublish APIs validate reason, update status, audit.
- Gateway middleware short-circuits non-live models with 503 + Retry-After.
- All grep checks pass; tsc clean both apps/web and packages/api-gateway.
</verification>

<success_criteria>
1. Admin sees freeze/depublish buttons on /admin/models/[slug]/edit.
2. Click freeze with reason → models.status='frozen' + audit.
3. Subsequent gateway call to that model_slug returns 503 + Retry-After.
4. Depublish allowed from live OR frozen.
5. Reason required for both; idempotent 409 on no-op.
</success_criteria>

<output>
After completion, create `.planning/phases/14-contest-marketplace-admin/14-06-SUMMARY.md`. Note where exactly the gateway middleware was wired (file + line) so plan 14-07 smoke can curl-verify the 503.
</output>
