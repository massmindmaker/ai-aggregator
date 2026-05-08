-- =============================================================================
-- Phase 14: Contest → Marketplace pipeline + Admin foundation (spec §3, §4, §5)
--
-- Adds:
--   - contest_submissions extensions (publish linkage, final_rank, consent FK)
--   - models extensions (author_user_id, status lifecycle, hosting strategy, tags)
--   - users KYC + tax + bank fields
--   - kyc_documents table (per-user identity uploads)
--   - prize_awards table (post-contest forfeit-aware prize ledger)
--   - payouts extensions (kyc_snapshot, tax_act_storage_key)
--   - author_earnings extensions (per-request accrual columns + 30d available_at)
--   - email_jobs table (publish-invite worker queue, used by plan 14-03)
--   - current_tier_pct(_user_id) — sticky lifetime revshare tier function
--   - aiag_settle_charge — appended accrue_author_earnings hook (spec §5 Step 5)
--
-- Idempotent: every DDL uses IF NOT EXISTS or DO $$ EXCEPTION blocks.
-- Apply: VPS Postgres (Timeweb), via plan 14-07 SSH-tunnel checkpoint.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK: consent_records prerequisite (Phase 1 baseline).
-- Surfaces a clear operator message instead of opaque FK error if missing.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'consent_records') THEN
    RAISE EXCEPTION 'Phase 14 migration requires consent_records table from Phase 1 — not found. Apply Phase 1 baseline before 0014.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. contest_submissions extensions (spec §3.1)
-- ---------------------------------------------------------------------------
ALTER TABLE contest_submissions
  ADD COLUMN IF NOT EXISTS published_model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS final_rank int,
  ADD COLUMN IF NOT EXISTS author_consent_id uuid REFERENCES consent_records(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_csubs_pubmodel
  ON contest_submissions(published_model_id) WHERE published_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_csubs_final_rank
  ON contest_submissions(contest_id, final_rank) WHERE final_rank IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. models extensions (spec §3.2)
-- Default status='live' preserves existing seeded catalog (~30 models).
-- ---------------------------------------------------------------------------
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

-- 6c. models.tags top-level column (W-6 fix — currently nested in metadata jsonb)
ALTER TABLE models ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[];
CREATE INDEX IF NOT EXISTS idx_models_tags_gin ON models USING GIN (tags);

-- ---------------------------------------------------------------------------
-- 3. users extensions (spec §3.3)
-- bank_details encrypted application-side (libsodium) by Phase 14b author flows.
-- Admin reads display only last-4 digits; no pgcrypto dependency here.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. kyc_documents (spec §3.4)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. payouts extensions (spec §3.5)
-- tax_withheld_rub + net_paid_rub already exist from earlier migrations.
-- ---------------------------------------------------------------------------
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS kyc_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS tax_act_storage_key text;

-- ---------------------------------------------------------------------------
-- 6. prize_awards (spec §3.6)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6b. email_jobs (W-5 fix — needed by plan 14-03 publish-invite enqueue)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 7. author_earnings extensions (per-request accrual rows; period_month NULL for these)
-- W-2: plain UNIQUE constraint (Postgres NULLS DISTINCT default — multiple non-gateway
--      rows with NULL gateway_request_id are allowed; gateway rows are unique).
-- ---------------------------------------------------------------------------
ALTER TABLE author_earnings
  ADD COLUMN IF NOT EXISTS gateway_request_id varchar(64),
  ADD COLUMN IF NOT EXISTS gross_rub numeric(14,4),
  ADD COLUMN IF NOT EXISTS tier_pct_decimal numeric(4,3),
  ADD COLUMN IF NOT EXISTS net_rub numeric(14,4),
  ADD COLUMN IF NOT EXISTS available_at timestamptz;

ALTER TABLE author_earnings ALTER COLUMN period_month DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE author_earnings ADD CONSTRAINT uq_author_earnings_gw_req UNIQUE (gateway_request_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_author_earnings_status_avail
  ON author_earnings(status, available_at) WHERE status='accruing';

-- ---------------------------------------------------------------------------
-- 8. current_tier_pct function (spec §4 — sticky lifetime tiers)
-- Thresholds: 0 / 50k / 200k / 1M lifetime gross_rub → 0.70/0.75/0.80/0.85.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 9. consent_records doc_type extension (spec §3.7)
-- Add 'author_publish_consent' and 'author_revshare_consent' to existing CHECK.
-- Introspect actual constraint name from pg_catalog before dropping.
-- ---------------------------------------------------------------------------
DO $$
DECLARE _conname text;
BEGIN
  SELECT con.conname INTO _conname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'consent_records'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%doc_type%'
  LIMIT 1;

  IF _conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE consent_records DROP CONSTRAINT %I', _conname);
  END IF;

  -- Re-add with extended IN list. Keep prior values; new values appended.
  -- Prior assumed values from Phase 1: 'tos','privacy','marketing','transborder'.
  -- If Phase 1 used different prior values, this constraint will reject existing rows
  -- and the migration will fail loudly — operator must reconcile.
  ALTER TABLE consent_records
    ADD CONSTRAINT consent_records_doc_type_chk
    CHECK (doc_type IN (
      'tos','privacy','marketing','transborder',
      'author_publish_consent','author_revshare_consent'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- end of 0014_contest_marketplace.sql (Task 1 portion)
-- aiag_settle_charge function with accrue_author_earnings hook is appended in Task 2.
