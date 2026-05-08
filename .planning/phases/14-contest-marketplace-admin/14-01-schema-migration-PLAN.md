---
phase: 14-contest-marketplace-admin
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/database/migrations/0014_contest_marketplace.sql
  - packages/database/src/functions/settle-charge.sql
  - packages/database/src/schema/earnings.ts
  - packages/database/src/schema/contests.ts
  - packages/database/src/schema/ai-models.ts
  - packages/database/src/schema/users.ts
  - packages/database/src/schema/index.ts
autonomous: true
requirements:
  - REQ-CONTEST-001
  - REQ-CONTEST-002
  - REQ-PAYOUT-001
  - REQ-PAYOUT-003
  - REQ-KYC-001
tags: [phase14, schema, migration, drizzle, postgres, revshare, kyc]
must_haves:
  truths:
    - "Migration 0014 adds all schema additions per spec §3.1–3.7 and re-running it is a no-op"
    - "Each settled gateway charge inserts an author_earnings row when models.author_user_id IS NOT NULL"
    - "current_tier_pct(user_id) returns 0.70 / 0.75 / 0.80 / 0.85 with sticky lifetime thresholds"
  artifacts:
    - path: packages/database/migrations/0014_contest_marketplace.sql
      provides: "All schema additions + tier function + accrue hook"
      contains: "CREATE TABLE IF NOT EXISTS kyc_documents"
    - path: packages/database/migrations/0014_contest_marketplace.sql
      provides: "prize_awards table"
      contains: "CREATE TABLE IF NOT EXISTS prize_awards"
    - path: packages/database/migrations/0014_contest_marketplace.sql
      provides: "current_tier_pct function"
      contains: "CREATE OR REPLACE FUNCTION current_tier_pct"
    - path: packages/database/migrations/0014_contest_marketplace.sql
      provides: "Updated aiag_settle_charge with accrue_author_earnings hook"
      contains: "INSERT INTO author_earnings"
  key_links:
    - from: packages/api-gateway/src/billing/settle.ts
      to: aiag_settle_charge
      via: "stored function call"
      pattern: "aiag_settle_charge"
    - from: aiag_settle_charge
      to: author_earnings
      via: "conditional INSERT when models.author_user_id IS NOT NULL"
      pattern: "INSERT INTO author_earnings"
---

<objective>
Apply Phase 14 schema additions per spec §3 (contest_submissions extensions, models extensions, users KYC fields, kyc_documents, prize_awards, payouts extensions, consent_records doc_types) plus current_tier_pct() function and an accrue_author_earnings hook inside aiag_settle_charge.

Purpose: Foundation for all admin UI in plans 14-03..14-06 — adds DB columns/tables they read+write, plus the gateway-side accrual that makes earnings real-time per spec §5 Step 5.
Output: Idempotent SQL migration 0014, updated drizzle schema files, regenerated settle-charge.sql with hook.
</objective>

<execution_context>
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/workflows/execute-plan.md
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md
@packages/database/migrations/0011_admin.sql
@packages/database/migrations/0012_admin_indexes.sql
@packages/database/src/functions/settle-charge.sql
@packages/database/src/schema/earnings.ts
@packages/database/src/schema/contests.ts

<interfaces>
Existing tables (live on VPS Postgres):
- `models` — has `id uuid`, `slug`, `enabled`, `type`, `is_active` (status text NOT yet present — add via 0014). Authoritative DB shape: see queries in apps/web/src/app/admin/routing/page.tsx and admin/models/page.tsx.
- `contest_submissions` — has `id, contest_id, user_id, score, public_score, private_score, status, rank` (rank exists; spec §3.1 wants `final_rank` as separate canonical column).
- `users` — has `id, email, role, preferences (jsonb)` — kyc_status currently shadowed in `preferences->>'kyc_status'` (see admin/payouts/page.tsx line 28). Phase 14 promotes it to first-class column.
- `payouts` — schema in packages/database/src/schema/earnings.ts lines 61-91 (already has `tax_withheld_rub`, `net_paid_rub`). Spec §3.5 wants `kyc_snapshot jsonb` + `tax_act_storage_key` added.
- `author_earnings` — schema lines 19-59. Note: existing schema is **monthly snapshot** (period_month, gross_revenue_rub) — spec §5 Step 5 wants per-request accrual. Migration MUST add columns: `gateway_request_id varchar`, `gross_rub numeric`, `tier_pct_decimal numeric`, `net_rub numeric` and relax NOT NULL on `period_month` (or accept NULL for per-request rows).
- `aiag_settle_charge` stored function — defined in `packages/database/src/functions/settle-charge.sql` (also embedded in migration 0004_gateway_core.sql). Returns (sub_portion, payg_portion, new_sub, new_payg, idempotent). Hook MUST be added at the very end of function body, right before `RETURN NEXT`, and skip when `idempotent=TRUE`.

Drizzle export pattern (from packages/database/src/schema/index.ts): each new table is added to the exported barrel; types are auto-generated via `$inferSelect`/`$inferInsert`.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write 0014_contest_marketplace.sql migration (schema additions + tier function)</name>
  <files>packages/database/migrations/0014_contest_marketplace.sql</files>

  <read_first>
    - Spec lines 128-235 (§3.1–3.7 — full schema additions).
    - Spec lines 238-265 (§4 — revshare tier rules + thresholds 0/50k/200k/1M).
    - `packages/database/migrations/0012_admin_indexes.sql` (idempotency pattern: `CREATE INDEX IF NOT EXISTS`).
    - `packages/database/migrations/0011_admin.sql` (idempotency pattern: `DO $$ BEGIN ... IF NOT EXISTS ... END $$`).
    - `packages/database/src/schema/earnings.ts` lines 19-91 (existing author_earnings + payouts shape).
  </read_first>

  <action>
Create `packages/database/migrations/0014_contest_marketplace.sql`. Every DDL statement MUST be idempotent (use `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, or `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for CHECK / FK additions).

Migration content in this exact order:

1. **contest_submissions extensions (spec §3.1):**
```sql
ALTER TABLE contest_submissions
  ADD COLUMN IF NOT EXISTS published_model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS final_rank int,
  ADD COLUMN IF NOT EXISTS author_consent_id uuid REFERENCES consent_records(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_csubs_pubmodel
  ON contest_submissions(published_model_id) WHERE published_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_csubs_final_rank
  ON contest_submissions(contest_id, final_rank) WHERE final_rank IS NOT NULL;
```

2. **models extensions (spec §3.2):**
```sql
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS derived_from_contest_id uuid REFERENCES contests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS hosting_strategy text NOT NULL DEFAULT 'cloud_api_wrap',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS frozen_reason text,
  ADD COLUMN IF NOT EXISTS depublished_reason text;
DO $$ BEGIN
  ALTER TABLE models ADD CONSTRAINT models_hosting_strategy_chk
    CHECK (hosting_strategy IN ('cloud_api_wrap','hosted_on_aiag','self_hosted_by_author'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE models ADD CONSTRAINT models_status_chk
    CHECK (status IN ('draft','pending_author_consent','live','frozen','depublished'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_models_status_live ON models(status) WHERE status='live';
CREATE INDEX IF NOT EXISTS idx_models_author_user ON models(author_user_id) WHERE author_user_id IS NOT NULL;
```
Default `'live'` (not `'draft'`) preserves existing seeded catalog (~30 models per REQ-MKT-013 already in marketplace).

3. **users extensions (spec §3.3):**
```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS kyc_type text,
  ADD COLUMN IF NOT EXISTS kyc_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS tax_country text DEFAULT 'RU',
  ADD COLUMN IF NOT EXISTS tax_id text,
  ADD COLUMN IF NOT EXISTS bank_details jsonb,
  ADD COLUMN IF NOT EXISTS dob date;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_kyc_status_chk
    CHECK (kyc_status IN ('none','pending','verified','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_kyc_type_chk
    CHECK (kyc_type IS NULL OR kyc_type IN ('self_employed','ip','individual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status) WHERE kyc_status='pending';
```
Note: `bank_details jsonb` will be encrypted application-level (libsodium) by author-side flows in Phase 14b; admin reads only display-anonymized fields (last 4 digits of account/sbp_phone). No pgcrypto dependency.

4. **kyc_documents (spec §3.4):**
```sql
CREATE TABLE IF NOT EXISTS kyc_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('passport_main','passport_registration','inn_certificate','ip_egrip','self_employed_certificate','other')),
  storage_key text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  rejection_reason text
);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_user ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_pending ON kyc_documents(status, uploaded_at DESC) WHERE status='pending';
```

5. **payouts extensions (spec §3.5):**
```sql
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS kyc_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS tax_act_storage_key text;
```
(`tax_withheld_rub` and `net_paid_rub` already exist — see earnings.ts lines 69-72.)

6. **prize_awards (spec §3.6):**
```sql
CREATE TABLE IF NOT EXISTS prize_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES contests(id),
  submission_id uuid NOT NULL REFERENCES contest_submissions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  rank int NOT NULL,
  amount_rub numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','available','forfeited')),
  forfeited_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prize_awards_uniq ON prize_awards(contest_id, submission_id, rank);
CREATE INDEX IF NOT EXISTS idx_prize_awards_user_status ON prize_awards(user_id, status);
```

**6b. email_jobs (W-5 fix — table not present in earlier migrations; needed by plan 14-03 publish-invite enqueue):**
```sql
CREATE TABLE IF NOT EXISTS email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  to_address text,
  template text NOT NULL,
  payload jsonb,
  subject text,
  body_html text,
  body_text text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS idx_email_jobs_pending ON email_jobs(status, created_at) WHERE status IN ('pending','queued');
```
With this table present, plan 14-03 MUST drop the silent try/catch around the enqueue (let it throw on failure).

**6c. models.tags column (W-6 fix — `tags` is currently inside `models.metadata jsonb`, not a top-level column; plan 14-03 INSERT relies on a real `tags text[]` column):**
```sql
ALTER TABLE models ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[];
CREATE INDEX IF NOT EXISTS idx_models_tags_gin ON models USING GIN (tags);
```

7. **author_earnings extensions (per-request accrual rows):**
The existing schema (earnings.ts) is monthly-snapshot. For per-request accrual we add columns; a NULL `period_month` denotes a per-request row.
```sql
ALTER TABLE author_earnings
  ADD COLUMN IF NOT EXISTS gateway_request_id varchar(64),
  ADD COLUMN IF NOT EXISTS gross_rub numeric(14,4),
  ADD COLUMN IF NOT EXISTS tier_pct_decimal numeric(4,3),
  ADD COLUMN IF NOT EXISTS net_rub numeric(14,4),
  ADD COLUMN IF NOT EXISTS available_at timestamptz;
ALTER TABLE author_earnings ALTER COLUMN period_month DROP NOT NULL;
-- W-2 fix: use plain UNIQUE CONSTRAINT (Postgres allows multiple NULLs in a UNIQUE
-- constraint by default — distinct from a partial unique index, which has trickier
-- ON CONFLICT semantics). All gateway-sourced rows have non-null gateway_request_id;
-- non-gateway sources (currently none) would supply distinct NULLs which Postgres treats
-- as not-equal under default NULLS DISTINCT.
DO $$ BEGIN
  ALTER TABLE author_earnings ADD CONSTRAINT uq_author_earnings_gw_req UNIQUE (gateway_request_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_author_earnings_status_avail
  ON author_earnings(status, available_at) WHERE status='accruing';
```
Status reuses existing `accruing | locked | paid` values; spec text "pending" maps to `accruing` (don't add a new status, keep type-compat with existing earnings.ts schema).

8. **current_tier_pct function (spec §4):**
```sql
CREATE OR REPLACE FUNCTION current_tier_pct(_user_id uuid) RETURNS numeric AS $$
DECLARE _lifetime numeric;
BEGIN
  SELECT COALESCE(SUM(gross_rub), 0) INTO _lifetime
  FROM author_earnings
  WHERE author_id = _user_id
    AND gross_rub IS NOT NULL
    AND status IN ('accruing','locked','paid');
  IF _lifetime >= 1000000 THEN RETURN 0.85;
  ELSIF _lifetime >= 200000 THEN RETURN 0.80;
  ELSIF _lifetime >= 50000  THEN RETURN 0.75;
  ELSE RETURN 0.70;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;
```
Sticky semantics: function reads cumulative `gross_rub`, never decreases.

9. **consent_records doc_types extension (spec §3.7):**
Phase 14 ASSUMES `consent_records` table exists from Phase 1 (spec §3.7). The B-2 fix above adds a hard FK from `contest_submissions.author_consent_id` to it, so a missing table will fail the migration loudly (intended — surfaces a real prod-config bug rather than silently degrading). DO NOT use `RAISE NOTICE skipping` — let it crash so the operator catches it.
Extend doc_type CHECK constraint to add new values `author_publish_consent`, `author_revshare_consent`. Wrap in `DO $$ BEGIN ... EXCEPTION WHEN ... END $$;` only for the constraint-replace step (introspect existing constraint name via pg_catalog, drop, re-add with extended IN list). Reference pattern: 0011_admin.sql lines using `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object`.
PRE-CHECK: at the top of the migration (before any `ALTER TABLE contest_submissions`), emit:
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'consent_records') THEN
    RAISE EXCEPTION 'Phase 14 migration requires consent_records table from Phase 1 — not found. Apply Phase 1 baseline before 0014.';
  END IF;
END $$;
```
This makes the prerequisite explicit and gives a clear operator message instead of an opaque FK error.

End of file: add a comment `-- end of 0014_contest_marketplace.sql`.
  </action>

  <verify>
    <automated>grep -c "CREATE TABLE IF NOT EXISTS kyc_documents" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "CREATE TABLE IF NOT EXISTS prize_awards" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "CREATE OR REPLACE FUNCTION current_tier_pct" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "ADD COLUMN IF NOT EXISTS kyc_status" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "ADD COLUMN IF NOT EXISTS author_user_id" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "ADD COLUMN IF NOT EXISTS published_model_id" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "CREATE TABLE IF NOT EXISTS email_jobs" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "ADD COLUMN IF NOT EXISTS tags text\[\]" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "REFERENCES consent_records" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "Phase 14 migration requires consent_records" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$"</automated>
  </verify>

  <done>
    File `packages/database/migrations/0014_contest_marketplace.sql` exists. Every DDL is idempotent (verified by grep counts above). Re-running the file twice in psql produces zero errors (manual verification deferred to plan 14-07).
  </done>
</task>

<task type="auto">
  <name>Task 2: Add accrue_author_earnings hook to aiag_settle_charge function</name>
  <files>packages/database/migrations/0014_contest_marketplace.sql, packages/database/src/functions/settle-charge.sql</files>

  <read_first>
    - Spec lines 86-105 (§5 Step 5 — accrual semantics, sticky tier_pct, 30-day pending window).
    - `packages/database/src/functions/settle-charge.sql` (full body — must be re-emitted with hook).
    - Note: aiag_settle_charge is the stored function, NOT the wrapper at `packages/api-gateway/src/billing/settle.ts` — that wrapper stays untouched (just calls the function).
  </read_first>

  <action>
Append a `CREATE OR REPLACE FUNCTION aiag_settle_charge(...)` block to `packages/database/migrations/0014_contest_marketplace.sql` that copies the existing function body from `packages/database/src/functions/settle-charge.sql` (lines 20-119) and adds the accrue hook.

Hook insertion point: AFTER the two conditional `INSERT INTO gateway_transactions` blocks (line 110-111 of settle-charge.sql) and BEFORE the final `RETURN NEXT`. Hook body:

```sql
-- AUTHORITATIVE CUTOFF: this WHERE clause (m.status = 'live') is the SINGLE SOURCE OF TRUTH
-- for whether a settled charge accrues to the author. The api-gateway model-status middleware
-- (plan 14-06) is an OPTIMIZATION (short-circuit 503 before upstream call), NOT the gate. Even
-- if middleware races and a frozen-model request slips through, this WHERE filter blocks the
-- accrual at settle time. Do not duplicate this check in middleware as a 'guarantee'.
-- Accrue author earnings if this request used an authored model (Phase 14 §5 Step 5).
-- Skip on idempotent replays (handled by gateway_transactions unique constraint above).
DECLARE _author_id uuid; _model_id uuid; _tier_pct numeric;
BEGIN
  SELECT m.author_user_id, m.id INTO _author_id, _model_id
  FROM requests r
  JOIN models m ON m.slug = r.model_slug
  WHERE r.request_id = _request_id
    AND m.author_user_id IS NOT NULL
    AND m.status = 'live'
  LIMIT 1;

  IF _author_id IS NOT NULL THEN
    _tier_pct := current_tier_pct(_author_id);
    INSERT INTO author_earnings (
      author_id, model_id, period_month,
      gross_rub, tier_pct, tier_pct_decimal, net_rub, author_share_rub,
      gateway_request_id, status, available_at
    ) VALUES (
      _author_id, _model_id, NULL,
      _total_rub, (_tier_pct * 100)::int, _tier_pct, _total_rub * _tier_pct, _total_rub * _tier_pct,
      _request_id, 'accruing', NOW() + INTERVAL '30 days'
    )
    ON CONFLICT (gateway_request_id) WHERE gateway_request_id IS NOT NULL DO NOTHING;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'accrue_author_earnings hook failed for request_id=%: %', _request_id, SQLERRM;
END;
```

Wrap in nested DECLARE/BEGIN block placed inside the existing function body so locals don't conflict. Note that the existing `aiag_settle_charge` already has a top-level `DECLARE` block — the new locals (`_author_id`, `_model_id`, `_tier_pct`) MUST be added there, not in a nested block (Postgres doesn't allow nested DECLARE inside non-block statements). Restructure: hoist the three new declarations into the top-level `DECLARE` section, keep the hook body as a plain inline block ending with `EXCEPTION WHEN OTHERS THEN RAISE WARNING ...`.

Write the modified function as one contiguous `CREATE OR REPLACE FUNCTION aiag_settle_charge(...) RETURNS TABLE(...) LANGUAGE plpgsql AS $$ ... $$;` at the end of `0014_contest_marketplace.sql`.

Then update `packages/database/src/functions/settle-charge.sql` source-of-truth to mirror the new function body (so future re-creates from baseline include the hook). Keep the existing comment header but add a note: `-- Phase 14: appended accrue_author_earnings hook (spec §5 Step 5).`
  </action>

  <verify>
    <automated>grep -c "INSERT INTO author_earnings" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "current_tier_pct(_author_id)" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "CREATE OR REPLACE FUNCTION aiag_settle_charge" packages/database/migrations/0014_contest_marketplace.sql | grep -q "^1$" &amp;&amp; grep -c "INSERT INTO author_earnings" packages/database/src/functions/settle-charge.sql | grep -q "^1$"</automated>
  </verify>

  <done>
    Migration 0014 contains a complete `CREATE OR REPLACE FUNCTION aiag_settle_charge` body that calls `current_tier_pct` and inserts into `author_earnings` when `models.author_user_id IS NOT NULL`. Source-of-truth file `packages/database/src/functions/settle-charge.sql` mirrors the same body.
  </done>
</task>

<task type="auto">
  <name>Task 3: Update drizzle schema TS files for read-paths</name>
  <files>packages/database/src/schema/earnings.ts, packages/database/src/schema/users.ts, packages/database/src/schema/contests.ts, packages/database/src/schema/ai-models.ts, packages/database/src/schema/index.ts</files>

  <read_first>
    - `packages/database/src/schema/earnings.ts` (existing payouts/author_earnings shape).
    - `packages/database/src/schema/index.ts` (barrel export pattern).
    - Drizzle pattern from any existing schema file: pgTable + columns + indexes + `$inferSelect`/`$inferInsert` types.
  </read_first>

  <action>
Update drizzle TS files so admin pages can use typed reads (some pages still use raw SQL via `db.execute(sql`)`, but typed reads improve safety):

1. `packages/database/src/schema/earnings.ts`:
   - Add to `authorEarnings` columns: `gatewayRequestId: varchar('gateway_request_id', { length: 64 })`, `grossRub: numeric('gross_rub', { precision: 14, scale: 4 })`, `tierPctDecimal: numeric('tier_pct_decimal', { precision: 4, scale: 3 })`, `netRub: numeric('net_rub', { precision: 14, scale: 4 })`, `availableAt: timestamp('available_at', { mode: 'date' })`. Mark `periodMonth` as nullable (drop `.notNull()`).
   - Add to `payouts` columns: `kycSnapshot: jsonb('kyc_snapshot')`, `taxActStorageKey: text('tax_act_storage_key')`. Import `jsonb` from `drizzle-orm/pg-core`.

2. `packages/database/src/schema/users.ts`:
   - Add columns: `kycStatus: text('kyc_status').notNull().default('none')`, `kycType: text('kyc_type')`, `kycVerifiedAt: timestamp('kyc_verified_at', { mode: 'date' })`, `taxCountry: text('tax_country').default('RU')`, `taxId: text('tax_id')`, `bankDetails: jsonb('bank_details')`, `dob: date('dob')`.

3. `packages/database/src/schema/contests.ts`:
   - Add to `contestSubmissions`: `publishedModelId: uuid('published_model_id')`, `publishedAt: timestamp('published_at', { mode: 'date' })`, `finalRank: integer('final_rank')`, `authorConsentId: uuid('author_consent_id')`.

4. `packages/database/src/schema/ai-models.ts`:
   - Add to `aiModels` (or create separate `models.ts` if Phase 4 already created a different `models` table — verify by reading `packages/database/src/schema/ai-models.ts` table name; if it's literally `ai_models` and gateway uses raw `models`, then create NEW file `packages/database/src/schema/models-marketplace.ts` exporting `models` pgTable matching live VPS schema. Confirm via SELECT-from-models references in code).
   - Columns to add: `derivedFromContestId: uuid('derived_from_contest_id')`, `authorUserId: uuid('author_user_id')`, `hostingStrategy: text('hosting_strategy').notNull().default('cloud_api_wrap')`, `status: text('status').notNull().default('live')`, `frozenReason: text('frozen_reason')`, `depublishedReason: text('depublished_reason')`.

5. Create new file `packages/database/src/schema/kyc.ts`:
```ts
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const kycDocuments = pgTable('kyc_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  docType: text('doc_type').notNull(),
  storageKey: text('storage_key').notNull(),
  uploadedAt: timestamp('uploaded_at', { mode: 'date' }).defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at', { mode: 'date' }),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  status: text('status').notNull().default('pending'),
  rejectionReason: text('rejection_reason'),
}, (t) => ({
  userIdx: index('idx_kyc_docs_user').on(t.userId),
  pendingIdx: index('idx_kyc_docs_pending').on(t.status, t.uploadedAt),
}));

export type KycDocument = typeof kycDocuments.$inferSelect;
export type NewKycDocument = typeof kycDocuments.$inferInsert;
```

6. Create new file `packages/database/src/schema/prize-awards.ts`:
```ts
import { pgTable, uuid, text, timestamp, integer, numeric, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { contests, contestSubmissions } from './contests';

export const prizeAwards = pgTable('prize_awards', {
  id: uuid('id').primaryKey().defaultRandom(),
  contestId: uuid('contest_id').notNull().references(() => contests.id),
  submissionId: uuid('submission_id').notNull().references(() => contestSubmissions.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  rank: integer('rank').notNull(),
  amountRub: numeric('amount_rub', { precision: 12, scale: 2 }).notNull(),
  status: text('status').notNull().default('pending'),
  forfeitedReason: text('forfeited_reason'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('idx_prize_awards_uniq').on(t.contestId, t.submissionId, t.rank),
  userStatus: index('idx_prize_awards_user_status').on(t.userId, t.status),
}));

export type PrizeAward = typeof prizeAwards.$inferSelect;
export type NewPrizeAward = typeof prizeAwards.$inferInsert;
```

7. `packages/database/src/schema/index.ts`:
   - Add: `export * from './kyc';` and `export * from './prize-awards';` (if barrel uses re-exports).

Verify TS compiles: `pnpm -C packages/database exec tsc --noEmit -p tsconfig.json` MUST exit 0.
  </action>

  <verify>
    <automated>cd packages/database &amp;&amp; npx tsc --noEmit -p tsconfig.json &amp;&amp; cd ../.. &amp;&amp; grep -c "kycStatus" packages/database/src/schema/users.ts | grep -q "^1$" &amp;&amp; grep -c "authorUserId" packages/database/src/schema/ai-models.ts | grep -q "^1$" || ls packages/database/src/schema/models-marketplace.ts &amp;&amp; test -f packages/database/src/schema/kyc.ts &amp;&amp; test -f packages/database/src/schema/prize-awards.ts</automated>
  </verify>

  <done>
    All five existing schema files updated with new columns, two new files (`kyc.ts`, `prize-awards.ts`) created, barrel re-exports added, `tsc --noEmit` exits 0 in `packages/database/`.
  </done>
</task>

</tasks>

<verification>
- `grep -c "ADD COLUMN IF NOT EXISTS" packages/database/migrations/0014_contest_marketplace.sql` >= 15
- `grep -c "CREATE TABLE IF NOT EXISTS" packages/database/migrations/0014_contest_marketplace.sql` >= 2
- `grep -c "CREATE OR REPLACE FUNCTION" packages/database/migrations/0014_contest_marketplace.sql` >= 2 (current_tier_pct + aiag_settle_charge)
- `npx tsc --noEmit -p packages/database/tsconfig.json` exits 0
- Migration NOT applied here — applied via SSH tunnel in plan 14-07.
</verification>

<success_criteria>
1. Single idempotent SQL file `0014_contest_marketplace.sql` exists with all schema additions, current_tier_pct function, and updated aiag_settle_charge function.
2. Drizzle TS schema reflects new columns/tables; `tsc --noEmit` passes in `packages/database/`.
3. settle-charge.sql source-of-truth mirrors the new function body.
4. No live DB writes happen in this plan — only files on disk.
</success_criteria>

<output>
After completion, create `.planning/phases/14-contest-marketplace-admin/14-01-SUMMARY.md` documenting: column additions, table additions, function additions, hook insertion point inside aiag_settle_charge.
</output>
