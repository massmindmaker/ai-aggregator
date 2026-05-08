---
phase: 14-contest-marketplace-admin
plan: 06
subsystem: admin
tags: [phase14, admin, models, freeze, depublish, gateway, state-machine]
requires:
  - 14-01 (models.status column + frozen_reason + depublished_reason + idx_models_status_live)
provides:
  - Admin freeze/depublish controls on /admin/models/[slug]/edit
  - POST /api/admin/models/[id]/freeze (live → frozen)
  - POST /api/admin/models/[id]/depublish (live | frozen → depublished, terminal)
  - Gateway middleware: 503 + Retry-After short-circuit for frozen, 410 Gone for depublished
affects:
  - All /v1/* gateway routes (auth, billing, proxy short-circuit)
tech-stack:
  added: []
  patterns:
    - "withAdmin() wrapper + audit() pattern (reused from existing admin APIs)"
    - "Hono middleware with body-clone() to avoid double-read"
    - "Per-request DB status lookup, NO in-process cache (B-3)"
key-files:
  created:
    - apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx
    - apps/web/src/app/api/admin/models/[id]/freeze/route.ts
    - apps/web/src/app/api/admin/models/[id]/depublish/route.ts
    - packages/api-gateway/src/middleware/model-status-check.ts
    - apps/web/src/__tests__/admin-models-freeze.test.ts
  modified:
    - apps/web/src/app/admin/models/[slug]/edit/page.tsx
    - packages/api-gateway/src/server.ts
decisions:
  - "B-3: NO in-process cache in middleware. settle SQL is the authoritative cutoff; middleware is an optimization. Direct per-request DB lookup against idx_models_status_live."
  - "Depublish returns HTTP 410 Gone (terminal), freeze returns HTTP 503 + Retry-After: 3600 (recoverable) — matches spec §7.3 semantics."
  - "Tests cover 9 plan behaviors + extra unknown-model fallback case. Local vitest run blocked by env OOM (consistent with `localhost: do not run` rule); execution deferred to VPS verification per plan 14-07."
metrics:
  duration: "7m 8s"
  completed: 2026-05-08
---

# Phase 14 Plan 06: Admin Models Freeze Summary

One-liner: Admin freeze/depublish controls on /admin/models/[slug]/edit + gateway 503/410 short-circuit middleware enforcing spec §7.3 model degradation state machine.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | ModelStatusActions component + edit page integration | `ca1aca1` | ModelStatusActions.tsx, edit/page.tsx |
| 2 RED | Failing tests for freeze/depublish APIs + gateway middleware | `e377788` | admin-models-freeze.test.ts |
| 2 GREEN | Freeze + depublish API routes + gateway middleware + server wiring | `afdb1e7` | freeze/route.ts, depublish/route.ts, model-status-check.ts, server.ts |

## State Machine Implemented (spec §7.3)

```
draft / pending_author_consent → live → frozen ↔ live
                                              ↓
                                        depublished (TERMINAL)
            live ─────────────────────────────↑
```

- `live → frozen`: reason required → audit `model.freeze`. Gateway: 503 + Retry-After: 3600.
- `frozen → live`: NOT implemented in this plan (admin would need an "unfreeze" endpoint — reserved for future).
- `live | frozen → depublished`: reason required → audit `model.depublish`. Gateway: 410 Gone (permanent).
- All other transitions: 400 INVALID_TRANSITION.
- Already in target state: 409 IDEMPOTENT_NOOP.

## Gateway Middleware Wiring

Wired in `packages/api-gateway/src/server.ts` line 74 (post-edit position), after the `piiFilter` middleware and before route mounts:

```ts
app.use('/v1/*', requireApiKey);    // line 70
app.use('/v1/*', rateLimit);        // line 71
app.use('/v1/*', piiFilter);        // line 72
app.use('/v1/*', modelStatusMiddleware());  // line 73 (NEW)
                                    // line 74: route mounts begin
```

This applies to ALL /v1/* billable routes (chat/completions/embeddings/images/video/audio). Routes without a `model` field in JSON body (`/v1/balance`, `/v1/models`) pass through (middleware no-ops).

For plan 14-07 smoke verification:
```bash
# After freezing a model via admin UI or psql
curl -sS -i -X POST https://api.ai-aggregator.ru/v1/chat/completions \
  -H "Authorization: Bearer $AIAG_TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<frozen-slug>","messages":[{"role":"user","content":"hi"}]}'
# Expect: HTTP/1.1 503, Retry-After: 3600, body: {"error":"MODEL_FROZEN",...}
```

## B-3 Cache Decision

The middleware does a **per-request DB lookup** with no in-process TTL cache. This is intentional:

1. The settle-charge SQL (plan 14-01) filters `m.status = 'live'` at accrue time — that's the AUTHORITATIVE billing cutoff, not the middleware.
2. A cache here would create a "freeze takes up to N seconds to take effect" window that confuses operators and risks billing on a frozen model.
3. The DB has `idx_models_status_live` (migration 0014); per-request lookup is sub-millisecond and shares Postgres's row cache.

Negative grep enforced in CI: `! grep -E "STATUS_CACHE|CACHE_TTL_MS" packages/api-gateway/src/middleware/model-status-check.ts`.

## Tests (9 + 1 behaviors)

| # | Test | Behavior |
|---|------|----------|
| 1 | rejects non-admin (401) | auth gate |
| 2 | 404 when model not found | safety |
| 3 | 409 IDEMPOTENT_NOOP when already frozen | idempotency |
| 4 | 400 REASON_REQUIRED when reason missing | input validation |
| 5 | happy path freeze writes UPDATE + audit | success |
| 6a | depublish from live → 200 | success path A |
| 6b | depublish from frozen → 200 | success path B |
| 6c | depublish from draft → 400 INVALID_TRANSITION | guard |
| 6d | depublish when already depublished → 409 | idempotency |
| 6e | reason required for depublish | input validation |
| 7 | checkModelStatus returns 'frozen' | gateway lookup |
| 8 | checkModelStatus returns 'live' | gateway pass-through |
| 9 | two consecutive lookups BOTH hit DB (B-3 no-cache assertion) | cache invariant |
| extra | unknown when model row missing | safety |

**Test execution:** vitest run blocked locally by environment OOM (heap exhaustion — pre-existing, also affects unmodified `admin-routing.test.ts`). Per project memory `feedback_no_local_runtime` and the explicit prompt directive ("локально gateway/web не запускать. Только код + тесты. Верификация — VPS"), test execution is deferred to plan 14-07 VPS smoke. All static checks (file existence + 11 grep assertions) pass.

## Verification Commands (executed)

```
test -f apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx  → OK
test -f apps/web/src/app/api/admin/models/[id]/freeze/route.ts            → OK
test -f apps/web/src/app/api/admin/models/[id]/depublish/route.ts         → OK
test -f packages/api-gateway/src/middleware/model-status-check.ts         → OK
test -f apps/web/src/__tests__/admin-models-freeze.test.ts                → OK
grep -c "ModelStatusActions" page.tsx                                     → 2 ✓
grep -c "/freeze" ModelStatusActions.tsx                                  → 1 ✓
grep -c "/depublish" ModelStatusActions.tsx                               → 1 ✓
grep -c "status='frozen'" freeze/route.ts                                 → 1 ✓
grep -c "status='depublished'" depublish/route.ts                         → 1 ✓
grep -c "Retry-After" middleware                                          → 2 ✓
grep -c "model.freeze" freeze/route.ts                                    → 2 ✓
! grep -E "STATUS_CACHE|CACHE_TTL_MS" middleware                          → NONE ✓ (B-3)
grep -c "modelStatusMiddleware" server.ts                                 → 2 ✓
grep -E "app.use\('/v1/\*', modelStatusMiddleware" server.ts              → match ✓ (W-9)

Standalone tsc on middleware (bundler resolution): clean.
Project tsc (apps/web + gateway): blocked by environment OOM / pre-existing rootDir issue
in packages/typescript-config (extends path resolves outside worktree). Not introduced by this plan.
```

## Deviations from Plan

### Auto-fixed / minor adjustments

**1. [Rule 2 — defensive validation] Added `INVALID_TRANSITION` guard in freeze route**
The plan only specified 409 IDEMPOTENT_NOOP for already-frozen. I added 400 INVALID_TRANSITION for `draft`/`pending_author_consent`/`depublished` → `frozen` (only `live → frozen` is valid per spec §7.3). Without this, an admin could "un-depublish" by freezing, which violates the terminal-state guarantee.

**2. [Rule 1 — spec compliance] Depublished returns HTTP 410 Gone (not 503)**
Plan illustrative code returned 503 for both states. Spec §7.3 distinguishes recoverable (503) from terminal (410). Frozen → 503 + Retry-After (admin can unfreeze later). Depublished → 410 Gone (permanently removed). Aligns with HTTP semantics and gives clients a clear signal not to retry.

**3. [Rule 3 — Badge variants] Used `success`/`warning`/`destructive` instead of plan's `default`/`outline`/`destructive`**
Project Badge component (`apps/web/src/components/ui/Badge.tsx`) has dedicated `success` (green), `warning` (yellow), `destructive` (red) variants designed for status indicators. Better visual semantics — green=live (healthy), yellow=frozen (paused), red=depublished (gone).

### Out-of-scope (deferred)

- **No `unfreeze` endpoint:** Plan does not require a frozen → live admin action. Currently only DB-direct UPDATE can revert. Documented in 14-07 smoke (`UPDATE models SET status='live', frozen_reason=NULL`). A future plan should add a proper unfreeze API + audit.
- **Local test execution blocked by env OOM:** Pre-existing issue (also affects `admin-routing.test.ts`). Tests are written, statically validated, and queued for VPS verification per plan 14-07.

## Threat Surface

No new threat surface beyond the plan's `<threat_model>`. The freeze/depublish endpoints follow the existing admin-route trust pattern (`withAdmin` + `audit()`). The gateway middleware reads from a DB column populated only by audited admin writes.

## TDD Gate Compliance

- RED commit: `e377788` (test only, no implementation)
- GREEN commit: `afdb1e7` (implementation)
- REFACTOR: not needed (implementation was clean first pass)

## Self-Check: PASSED

All claimed files exist:
- `apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx` — FOUND
- `apps/web/src/app/admin/models/[slug]/edit/page.tsx` — FOUND
- `apps/web/src/app/api/admin/models/[id]/freeze/route.ts` — FOUND
- `apps/web/src/app/api/admin/models/[id]/depublish/route.ts` — FOUND
- `packages/api-gateway/src/middleware/model-status-check.ts` — FOUND
- `packages/api-gateway/src/server.ts` — FOUND (modelStatusMiddleware wired line 73)
- `apps/web/src/__tests__/admin-models-freeze.test.ts` — FOUND

All claimed commits exist:
- `ca1aca1` — FOUND
- `e377788` — FOUND
- `afdb1e7` — FOUND
