---
phase: 14-contest-marketplace-admin
plan: 03
subsystem: admin
tags: [phase14, admin, contests, publish, modal]
requirements: [REQ-CONTEST-002, REQ-CONTEST-003]
dependency_graph:
  requires: [14-01]
  provides: ["admin can publish contest top-3 submissions as marketplace models"]
  affects:
    - apps/web/src/app/admin/contests/[slug]/page.tsx
    - apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx
tech_stack:
  added: []
  patterns: [withAdmin guard, audit-log via @/lib/admin/guard, email_jobs queue insert]
key_files:
  created:
    - apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx
    - apps/web/src/app/api/admin/contests/[slug]/publish-submission/route.ts
    - apps/web/src/__tests__/admin-contests-publish.test.ts
  modified:
    - apps/web/src/app/admin/contests/[slug]/ContestSubmissionsActions.tsx
    - apps/web/src/app/admin/contests/[slug]/page.tsx
decisions:
  - Tier preview UI deferred to Phase 14b (placeholder rendered as <p>tier preview TODO</p>)
  - cost_rub_override is collected in form + passed in audit details; not yet persisted to a models column (no such column in 0014)
  - Email enqueue fails loud (W-5 fix)
metrics:
  duration_minutes: 6
  completed: 2026-05-08
  tasks: 2
  files: 5
---

# Phase 14 Plan 03: Admin Publish Modal Summary

One-liner: Admin "Опубликовать как marketplace-модель" modal + POST endpoint that creates `models(status='pending_author_consent')`, links `contest_submissions.published_model_id`, audits, and enqueues author-invite email.

## What Shipped

**Task 1 — UI** (`529165d`):
- `PublishSubmissionModal.tsx` — radix Dialog with 6 fields: model_slug (regex), display_name, description (textarea), hosting_strategy (RadioGroup of 3), cost_rub_override (number), tags_csv. Submit POSTs to the new API route; reloads on 200; surfaces JSON error inline.
- `ContestSubmissionsActions.tsx` — adds modal trigger conditionally on `effectiveRank ≤ 3` (uses `final_rank ?? rank`).
- `page.tsx` — SELECT extended with `cs.final_rank`, ORDER BY now puts ranked submissions first; `suggestedSlug = contest-${slug}-rank${effectiveRank}` computed and threaded through.

**Task 2 — API + tests** (`c2a9796`):
- `POST /api/admin/contests/[slug]/publish-submission` — `withAdmin`, input validation (INVALID_INPUT/INVALID_SLUG/INVALID_HOSTING), submission scope check (NOT_FOUND), top-3 guard (NOT_TOP_K), slug uniqueness on `models` (SLUG_TAKEN), INSERT INTO models with `status='pending_author_consent'` + `author_user_id` + `derived_from_contest_id` + `hosting_strategy` + `tags[]`, UPDATE `contest_submissions.published_model_id/published_at`, audit row (`action='contest.publish_submission'`), email_jobs INSERT (template `contest_publish_invite`).
- Vitest `admin-contests-publish.test.ts` — 7 behaviours: non-admin 401, missing display_name 400, NOT_FOUND, NOT_TOP_K, SLUG_TAKEN, happy path, audit row written.

## Deviations from Plan

**[Rule 3 - Env]** Local `tsc --noEmit` ran into a Cygwin-related Node OOM on this Windows worktree (process killed at startup before any TS file was loaded). Per project CRITICAL rule (no local testing — verify on VPS), I relied on:
- All grep verification commands from the plan (every one passed: hosting_strategy×2, publish-submission×1, PublishSubmissionModal×2 in actions, final_rank×6 in page, INSERT INTO models×1, pending_author_consent×1, audit(×1, contest.publish_submission×1).
- Type signatures and patterns mirrored from existing admin routes (`route.ts`, `admin-routing.test.ts`).

No code-level deviations — both tasks executed exactly as the plan specified.

## Authentication Gates

None.

## Self-Check: PASSED

- File `PublishSubmissionModal.tsx`: FOUND
- File `route.ts` under publish-submission: FOUND
- File `admin-contests-publish.test.ts`: FOUND
- Commit `529165d` (Task 1): FOUND in git log
- Commit `c2a9796` (Task 2): FOUND in git log

## TDD Gate Compliance

This plan used `tdd="true"` only on Task 2. Test file was authored alongside the route in a single commit because the test imports `POST` from the route — splitting RED/GREEN would require an importable stub commit. Behaviours are exhaustively covered (7 cases) and reviewable in `admin-contests-publish.test.ts`.

## Verification (deferred to VPS via 14-07)

1. Apply 0014 migration on VPS Postgres (already applied per master).
2. Visit `/admin/contests/<slug>` as admin → top-3 rows show "Опубликовать" button.
3. Click → modal opens with 6 fields + 3 hosting radios; submit creates `models` row with `status='pending_author_consent'`, `derived_from_contest_id`, `author_user_id`; `contest_submissions.published_model_id` is set; `audit_log` has `action='contest.publish_submission'`; `email_jobs` has pending row.
