---
phase: 14-contest-marketplace-admin
plan: 07
status: PARTIAL — migration applied, code on master, deploy pipeline blocked by pre-existing CI debt
date: 2026-05-08
---

# Plan 14-07 — Deploy and Verify (PARTIAL)

## Migration applied ✓

Applied `0014_contest_marketplace.sql` on production VPS (Timeweb Postgres 16.13, db `aiag`) via `ssh aiag-vps 'sudo -u postgres psql -d aiag'`. SSH tunnel was unnecessary (root SSH on VPS, peer auth to postgres role).

**Two real bugs surfaced and fixed during apply, both committed:**

1. **`fix(14-01): make consent_records refs conditional in 0014`** (`c96ab74`).
   The 14-01 executor wrote a `RAISE EXCEPTION 'Phase 14 migration requires consent_records table from Phase 1 — not found'` precheck, but Phase 1 never actually shipped that table — no migration in `packages/database/migrations/` creates it, and prod DB has 55 public tables, none named `consent_records`. The precheck blocked the migration on first apply. Phase 14 admin half does not actually need `consent_records`; it's a forward-looking spec §3.7 dependency for the author-consent flow scheduled for Phase 14b/15. Fix: dropped the precheck, wrapped the `contest_submissions.author_consent_id` FK column add and the `consent_records.doc_type` CHECK extension in `IF EXISTS consent_records` conditional DO blocks. Both reapply cleanly when the table is added later (migration is fully idempotent).

2. **`fix(14-01): catch duplicate_table on author_earnings UNIQUE constraint`** (`cce18b7`).
   Re-running the migration for idempotency check raised `ERROR: relation "uq_author_earnings_gw_req" already exists`. The `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` block caught only `42710`, but Postgres raises `duplicate_table` (`42P07`) for the implicit unique index name collision. Added `WHEN duplicate_table THEN NULL`.

After fixes: clean apply, second run is a no-op (verified).

**Probe queries (post-apply):**

```
users.kyc_*    rows=5   (kyc_status, kyc_type, bank_details, dob, tax_id ✓)
models.new     rows=4   (author_user_id, status, hosting_strategy, derived_from_contest_id ✓)
to_regclass    kyc_documents=kyc_documents, prize_awards=prize_awards ✓
current_tier_pct(NULL) = 0.70 ✓
aiag_settle_charge function present ✓
```

`consent_records` skip notice fired as designed:
> NOTICE: consent_records table not present — skipping doc_type CHECK extension (will apply on re-run after Phase 14b/15 baseline).

**Ownership note:** `models`, `audit_log`, `author_earnings` are owned by `postgres`; `users`, `contests`, `contest_submissions`, `payouts` are owned by `aiag`. Migration must be run as superuser (`sudo -u postgres psql`), not as the app user. Worth a future plan to normalise ownership to `aiag`.

## Deploy ✗ — BLOCKED on pre-existing CI pipeline debt

Triggered `Deploy to Production (bare-metal VPS)` workflow four times. The pipeline was already broken on master before Phase 14 work — the most recent successful deploy is `20260427T024519Z-1e346f7` from 2026-04-27 (per `STATE.md`). My attempt surfaced and partially fixed five layers of breakage. Three are committed; two remain:

| # | Layer | Fix | Commit |
|---|-------|-----|--------|
| 1 | `bun install --frozen-lockfile` failed because repo only had `package-lock.json` and bun auto-migrates → frozen flag rejects | Generated `bun.lock` on VPS (bun 1.3.13) and committed | `6c16e20` |
| 2 | `apps/web/package.json` did not declare `@aiag/shared`, `@aiag/yookassa` deps despite imports | Added both deps | `487c0ca`, `f9d0f2c` |
| 3 | `packages/{shared,database,email,telegram-alerts,tinkoff,yookassa}` expose `dist/` via `exports` field but `dist/` is `.gitignored`; CI never built them before `next build` → `Module not found` | Added `prebuild` script in `apps/web/package.json` that builds all six workspace packages | `487c0ca`, `f9d0f2c` |
| 4 | After fixes 1–3 land, `next build` reaches "Collecting page data" and fails because `/api/admin/audit/route.ts` and `/api/admin/cohorts/recompute/route.ts` eagerly initialise the DB at module-load time and CI has no `DATABASE_URL` | **NOT FIXED** — needs `export const dynamic = 'force-dynamic'` on those routes (and likely others after each is unblocked) | — |
| 5 | `gh` token in use has only `repo` scope (not `workflow`); my first attempt to add a prebuild step inside `.github/workflows/deploy-production.yml` was rejected by the remote. Worked around by moving prebuild into `apps/web/package.json` `scripts.prebuild` (npm convention auto-runs before `build`). | Workaround in place; if future fixes need workflow-file edits, run `gh auth refresh -s workflow` first | — |

**Last failed run:** https://github.com/massmindmaker/aiag-marketplace/actions/runs/25560639318

VPS production currently runs the `20260427T024519Z-1e346f7` release (Phase 13 + earlier). Phase 14 admin code is on master but **not live in apps**.

## Smoke tests ✗ — DEFERRED

Smoke for the four new admin pages and the gateway 503 path cannot run until layer 4 is fixed and a clean deploy lands. Carrying forward to a follow-up plan (proposal: `14b-fix-deploy-pipeline` or fold into 14b at start).

## Open TODOs (carry-forward to Phase 14b)

**Author-side flows (original Phase 14b scope):**
- `/me/contest-wins/[id]/publish` — accept publish invitation (consent + revshare).
- `/me/kyc` — upload kyc documents to S3.
- `/me/earnings/payout` — request payout.
- `/dashboard/earnings` extended — show pending vs locked vs paid.

**New, surfaced by 14-07:**
- Fix CI deploy pipeline layer-4 (eager DB init in `/api/admin/audit`, `/api/admin/cohorts/recompute`, likely others). Pattern: add `export const dynamic = 'force-dynamic'` or refactor to lazy-init.
- Normalise table ownership from `postgres` → `aiag` (`models`, `audit_log`, `author_earnings`) so app user can own future migrations.
- Build artifacts strategy: either commit `dist/` for workspace packages, or formalise prebuild via Turborepo / nx for caching.
- Real bank transfer via СБП API (`payouts.tx_ref`).
- Tax act PDF generator (`payouts.tax_act_storage_key`).
- ФНС «Мой налог» integration (chek auto-generation for НПД).
- Presigned URL endpoint for `/api/admin/kyc/[id]/file` (REQ-INF-011 — S3 bucket `aiag-storage` not yet provisioned).
- libsodium application-level encryption for `users.bank_details`.
- Gateway `model-status-check` middleware: consider opt-in caching with explicit invalidation if DB load matters at scale (currently fresh per-request lookup, B-3).

## REQ-IDs covered (code-complete on master, not live)

| REQ | Where |
|-----|-------|
| REQ-CONTEST-001 | `apps/worker/src/queues/close-contests-cron.ts` (final_rank computation) |
| REQ-CONTEST-002 | Same — prize_awards INSERT |
| REQ-CONTEST-003 | `apps/web/src/app/admin/contests/[slug]/PublishSubmissionModal.tsx` + `publish-submission/route.ts` |
| REQ-CONTEST-005 | `models.status` machine + `apps/web/src/app/admin/models/[slug]/edit/ModelStatusActions.tsx` + gateway `model-status-check.ts` |
| REQ-PAYOUT-001..004 | `apps/web/src/lib/payouts/tax.ts` + `/admin/payouts` page rewrite + approve/reject route handlers |
| REQ-KYC-001..003 | `apps/web/src/app/admin/kyc-queue/**` + approve/reject route handlers |

## Phase status

Phase 14 admin half: **code-complete on master, deploy blocked**. Recommend opening Phase 14b with first plan dedicated to fixing the deploy pipeline (layer 4), then proceeding with author-side flows.
