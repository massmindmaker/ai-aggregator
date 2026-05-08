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
-- NOTE on consent_records: forward-looking dependency from Phase 1 spec.
-- The table is not yet present in the deployed schema (Phase 1 shipped
-- without it). Sections referencing consent_records (FK on
-- contest_submissions.author_consent_id, doc_type CHECK extension) are
-- conditional and become no-ops when the table is missing. They are
-- safely re-applicable by re-running this migration after Phase 14b/15
-- introduces consent_records.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. contest_submissions extensions (spec §3.1)
-- ---------------------------------------------------------------------------
ALTER TABLE contest_submissions
  ADD COLUMN IF NOT EXISTS published_model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS final_rank int;

-- contest_submissions.author_consent_id — conditional on consent_records existence.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'consent_records') THEN
    EXECUTE 'ALTER TABLE contest_submissions
             ADD COLUMN IF NOT EXISTS author_consent_id uuid
             REFERENCES consent_records(id) ON DELETE SET NULL';
  END IF;
END $$;

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
-- Conditional: no-op if consent_records table does not exist yet.
-- ---------------------------------------------------------------------------
DO $$
DECLARE _conname text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'consent_records') THEN
    RAISE NOTICE 'consent_records table not present — skipping doc_type CHECK extension (will apply on re-run after Phase 14b/15 baseline).';
    RETURN;
  END IF;

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

  ALTER TABLE consent_records
    ADD CONSTRAINT consent_records_doc_type_chk
    CHECK (doc_type IN (
      'tos','privacy','marketing','transborder',
      'author_publish_consent','author_revshare_consent'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 10. aiag_settle_charge — appended accrue_author_earnings hook (spec §5 Step 5)
--
-- AUTHORITATIVE CUTOFF: the WHERE clause `m.status = 'live'` in this function is the
-- SINGLE SOURCE OF TRUTH for whether a settled charge accrues to the author. The
-- api-gateway model-status middleware (plan 14-06) is an OPTIMIZATION (short-circuit
-- 503 before upstream call), NOT the gate. Even if middleware races and a frozen-model
-- request slips through, this WHERE filter blocks the accrual at settle time.
-- Do not duplicate this check in middleware as a 'guarantee'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aiag_settle_charge(
  _org_id       UUID,
  _request_id   VARCHAR,
  _total_rub    NUMERIC
) RETURNS TABLE(
  sub_portion  NUMERIC,
  payg_portion NUMERIC,
  new_sub      NUMERIC,
  new_payg     NUMERIC,
  idempotent   BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
  _sub_avail     NUMERIC;
  _payg_avail    NUMERIC;
  _sub_expires   TIMESTAMPTZ;
  _sub_portion   NUMERIC := 0;
  _payg_portion  NUMERIC := 0;
  _existing_sub  NUMERIC;
  _existing_payg NUMERIC;
  -- Phase 14: hook locals (declared at top level — Postgres disallows nested DECLARE)
  _author_id     UUID;
  _model_id      UUID;
  _tier_pct      NUMERIC;
BEGIN
  IF _total_rub <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  -- Lock org row (serializes per-org concurrency)
  SELECT subscription_credits, payg_credits, subscription_credits_expires_at
    INTO _sub_avail, _payg_avail, _sub_expires
  FROM organizations
  WHERE id = _org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency check INSIDE lock (FIX C2). Reuses gateway_transactions table
  -- (api_usage rows). If rows exist — return existing values, no UPDATE.
  SELECT
    COALESCE(SUM(CASE WHEN source = 'subscription' THEN ABS(delta) END), 0),
    COALESCE(SUM(CASE WHEN source = 'payg'         THEN ABS(delta) END), 0)
    INTO _existing_sub, _existing_payg
  FROM gateway_transactions
  WHERE request_id = _request_id
    AND type = 'api_usage'
    AND source IN ('subscription', 'payg');

  IF _existing_sub > 0 OR _existing_payg > 0 THEN
    sub_portion  := _existing_sub;
    payg_portion := _existing_payg;
    new_sub      := _sub_avail;
    new_payg     := _payg_avail;
    idempotent   := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Expired sub credits treated as zero (R2)
  IF _sub_expires IS NOT NULL AND _sub_expires < NOW() THEN
    _sub_avail := 0;
  END IF;

  _sub_portion  := LEAST(_total_rub, _sub_avail);
  _payg_portion := _total_rub - _sub_portion;

  IF _payg_portion > _payg_avail THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: need % payg, have %', _payg_portion, _payg_avail
      USING ERRCODE = 'P0003';
  END IF;

  UPDATE organizations
     SET subscription_credits = subscription_credits - _sub_portion,
         payg_credits         = payg_credits - _payg_portion,
         updated_at           = NOW()
   WHERE id = _org_id
     AND subscription_credits >= _sub_portion
     AND payg_credits         >= _payg_portion
  RETURNING subscription_credits, payg_credits INTO new_sub, new_payg;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  -- Two conditional INSERTs per spec §4.3 (FIX C1)
  IF _sub_portion > 0 THEN
    INSERT INTO gateway_transactions (org_id, request_id, type, source, delta, metadata, created_at)
    VALUES (_org_id, _request_id, 'api_usage', 'subscription', -_sub_portion, '{}'::jsonb, NOW());
  END IF;

  IF _payg_portion > 0 THEN
    INSERT INTO gateway_transactions (org_id, request_id, type, source, delta, metadata, created_at)
    VALUES (_org_id, _request_id, 'api_usage', 'payg', -_payg_portion, '{}'::jsonb, NOW());
  END IF;

  -- -----------------------------------------------------------------------
  -- Phase 14 §5 Step 5 — accrue_author_earnings hook.
  -- Skipped on idempotent replays (early-return above). Filter `m.status='live'`
  -- is the authoritative cutoff; failures isolated by inner BEGIN/EXCEPTION.
  -- -----------------------------------------------------------------------
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
      ON CONFLICT (gateway_request_id) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'accrue_author_earnings hook failed for request_id=%: %', _request_id, SQLERRM;
  END;

  sub_portion  := _sub_portion;
  payg_portion := _payg_portion;
  idempotent   := FALSE;
  RETURN NEXT;
END;
$$;

-- end of 0014_contest_marketplace.sql
