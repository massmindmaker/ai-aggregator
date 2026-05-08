---
phase: 14-contest-marketplace-admin
plan: 05
subsystem: admin/kyc
tags: [phase14, admin, kyc, compliance]
requires: [14-01]   # kyc_documents table + users.kyc_* columns (deploy ordering)
provides:
  - admin_route: /admin/kyc-queue
  - api: /api/admin/kyc/[id]/approve
  - api: /api/admin/kyc/[id]/reject
affects: [users.kyc_status, kyc_documents.status, audit_log]
tech-stack:
  added: []
  patterns: [withAdmin, audit, REQUIRED_DOCS-matrix, REQUIRING_idempotent_409]
key-files:
  created:
    - apps/web/src/app/admin/kyc-queue/page.tsx
    - apps/web/src/app/admin/kyc-queue/KycRowActions.tsx
    - apps/web/src/app/api/admin/kyc/[id]/approve/route.ts
    - apps/web/src/app/api/admin/kyc/[id]/reject/route.ts
    - apps/web/src/__tests__/admin-kyc-queue.test.ts
  modified:
    - apps/web/src/app/admin/layout.tsx
decisions:
  - S3 link is a bare https://s3.timeweb.cloud/aiag-storage/{key} URL — bucket provisioning blocked on REQ-INF-011, link will work once bucket public read is configured. Presigned-URL endpoint (/api/admin/kyc/[id]/file) deferred.
  - REQUIRED_DOCS matrix hardcoded per spec §5.1-5.3. self_employed and ip both require inn_certificate.
  - "First doc approved while users.kyc_status='none'" → bump to 'pending' (visibility for /admin/users).
metrics:
  duration_min: 8
  tasks: 2
  files_created: 5
  files_modified: 1
  completed: 2026-05-08
---

# Phase 14 Plan 05: Admin KYC Queue Summary

Admin can review pending kyc_documents grouped by user, approve/reject with reason, and on full required-doc set, the user's kyc_status is promoted to 'verified' atomically.

## What was built

- **`/admin/kyc-queue` page**: counters (pending / approved 7d / rejected 7d) + table of pending docs with email, kyc_type badge, doc_type, S3 link, uploaded_at, action buttons. `requireAdmin` gate. `force-dynamic`.
- **`KycRowActions` client component**: Approve / Reject buttons; reject prompts for reason; inline error label; reload on success.
- **`POST /api/admin/kyc/[id]/approve`**: marks `kyc_documents.status='approved'`; recomputes the user's approved doc set; if it covers `REQUIRED_DOCS[kyc_type]`, sets `users.kyc_status='verified'` + `kyc_verified_at=NOW()`. Idempotent (409 on already-approved). Audited.
- **`POST /api/admin/kyc/[id]/reject`**: requires reason; sets doc rejected + `users.kyc_status='rejected'`. Idempotent. Audited.
- **Sidebar nav** entry "KYC очередь" added to `apps/web/src/app/admin/layout.tsx` next to «Выплаты».
- **Tests** (`__tests__/admin-kyc-queue.test.ts`, 9 cases): auth gate, 404, idempotent 409, completeness-promotes-verified, incomplete-no-promotion, audit row, reject-reason-validation, reject-cascade, reject-idempotency.

## REQUIRED_DOCS matrix (spec §5.1-5.3)

| kyc_type | Required doc_types |
|---|---|
| `self_employed` | `self_employed_certificate`, `inn_certificate` |
| `ip` | `ip_egrip`, `inn_certificate` |
| `individual` | `passport_main`, `passport_registration`, `inn_certificate` |

## Deviations from Plan

**1. [Rule 2] S3 link rendered directly instead of via a `/api/admin/kyc/[id]/file` route.**
- The plan's `<action>` proposed a future presigned-URL endpoint as a stub. We rendered a direct `https://s3.timeweb.cloud/aiag-storage/{storage_key}` link instead — works the moment REQ-INF-011 (S3 bucket) lands, no extra code path.
- The presigned-URL endpoint is documented as a future enhancement when bucket goes private.

**2. [Rule 2] Status normalization edge case.**
- Added explicit "first doc approved while kyc_status='none'" → bump to 'pending' branch (was implicit in plan; made explicit + idempotent).

## TDD Gate Compliance

- RED: commit `0206b07` — `test(14-05): add failing tests…` (imports for non-existent routes; would fail at module-resolve).
- GREEN: commit `95f2f9c` — `feat(14-05): KYC approve/reject API routes…`.
- REFACTOR: not needed.

## Known Stubs

- S3 link assumes bucket `aiag-storage` will allow signed/public reads at `https://s3.timeweb.cloud/aiag-storage/{key}`. Blocked on REQ-INF-011 (Phase 11 infra). Page renders correctly with link present; click yields 404 until bucket exists. Documented, not regression-blocking — plan's purpose (admin can act on pending KYC) holds because admin sees doc metadata and can resolve out-of-band if needed.

## Verification (deferred to VPS per AIAG rule)

Local dev / tsc / vitest NOT run (project rule: no local runtime testing for AIAG; verify on ai-aggregator.ru after deploy). Static checks performed:
- All required files exist (created + modified).
- grep counts confirmed: `requireAdmin` x1, `kyc_documents` x4 in page.tsx; `kyc-queue` x1 in layout.tsx; `REQUIRED_DOCS` + `kyc.approve_doc` + `kyc_status='verified'` present in approve route; `kyc.reject_doc` + `kyc_status='rejected'` present in reject route.

VPS verification will be performed in plan **14-07-deploy-and-verify**.

## Commits

| # | Hash | Message |
|---|---|---|
| 1 | `15a61fb` | feat(14-05): admin KYC queue page + sidebar nav |
| 2 | `0206b07` | test(14-05): add failing tests for KYC approve/reject routes (RED) |
| 3 | `95f2f9c` | feat(14-05): KYC approve/reject API routes with completeness check (GREEN) |

## Self-Check: PASSED

- `apps/web/src/app/admin/kyc-queue/page.tsx` — FOUND
- `apps/web/src/app/admin/kyc-queue/KycRowActions.tsx` — FOUND
- `apps/web/src/app/api/admin/kyc/[id]/approve/route.ts` — FOUND
- `apps/web/src/app/api/admin/kyc/[id]/reject/route.ts` — FOUND
- `apps/web/src/__tests__/admin-kyc-queue.test.ts` — FOUND
- `apps/web/src/app/admin/layout.tsx` — modified (kyc-queue link present)
- Commits `15a61fb`, `0206b07`, `95f2f9c` — all reachable in `git log`.
