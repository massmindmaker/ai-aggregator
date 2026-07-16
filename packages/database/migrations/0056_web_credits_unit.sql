-- 0056_web_credits_unit.sql
-- T1 (money-path): web org credit buckets migrate ₽ (NUMERIC) → whole US-cent
-- credits (BIGINT). Founder decision 2026-07-15: 1 credit = 1¢ USD, matching
-- TMA (tg_user_balances.balance_credits BIGINT). See
-- docs/specs/2026-07-16-finmodel-build-spec.md.
--
-- Ground truth this migration acts on (read-only SELECT on prod, 2026-07-16):
--   organizations: 47 rows | nonzero sub_credits=1 (737.736872 ₽) |
--     nonzero payg_credits=2 (5999.867422 ₽ total) | all with_expiry=0
--   gateway_transactions: 23 api_usage rows total (20 subscription + 3 payg),
--     all test traffic against the seed grants above
--   payments=0 rows, subscriptions=0 rows, users.balance sum=0 across 60 users
-- → no real revenue exists yet. The nonzero buckets are seed/test grants, not
-- money → they are archived (not FX-converted: converting fictitious ₽ by a
-- live rate would import fiction into the new unit) then reset to 0.
--
-- Deliberately does NOT rewrite migration 0004_gateway_core.sql in place
-- (same convention as 0047_markup_floor_120.sql's header: "does NOT rewrite
-- any already-applied migration ... stays as history"). This migration is
-- forward-only/additive, like 0047.
--
-- Idempotency: every destructive step is guarded so a second run is a no-op —
--  (1)/(2) CREATE TABLE IF NOT EXISTS ... AS SELECT — second run does not
--      re-snapshot (table already exists).
--  (3) DELETE ... WHERE type='api_usage' — second run deletes 0 rows (already
--      gone; nothing new is inserted as type='api_usage' by the OLD ₽
--      function once this migration + the paired code deploy are live).
--  (4)/(5) column-type changes are wrapped in a data_type check so a second
--      run does not re-zero real balances that accrued between runs.
--
-- ⚠️ Deployment-ordering note (finding, not in the original spec): step (6)
-- changes gateway_transactions.delta from NUMERIC (fractional ₽) to BIGINT.
-- If this migration is applied while the OLD gateway code
-- (aiag_settle_charge, ₽) is still serving traffic, any non-BYOK charge with
-- a fractional ₽ amount (the overwhelmingly common case, e.g. 1.15₽) will
-- fail the INSERT with a Postgres type error instead of silently succeeding.
-- That is a LOUDER failure than before (good — no silent misprice), but it
-- means this migration and the api-gateway code deploy of this branch must
-- land together, not this-migration-then-wait.

BEGIN;

-- (1) Archive current (₽-denominated) org bucket values for audit trail.
CREATE TABLE IF NOT EXISTS organizations_rub_archive_20260716 AS
SELECT id, subscription_credits AS sub_rub, payg_credits AS payg_rub,
       subscription_credits_expires_at, NOW() AS archived_at
FROM organizations
WHERE subscription_credits <> 0 OR payg_credits <> 0;

-- (2) Archive historical api_usage ledger rows (₽-denominated, test traffic only).
CREATE TABLE IF NOT EXISTS gateway_transactions_rub_archive_20260716 AS
SELECT * FROM gateway_transactions WHERE type = 'api_usage';

-- (3) Clear the archived rows from the live ledger — they are ₽-denominated
--     and would be nonsensical once `delta` becomes a credits BIGINT.
DELETE FROM gateway_transactions WHERE type = 'api_usage';

-- (4) organizations.subscription_credits / payg_credits: NUMERIC(20,6) ₽ →
--     BIGINT credits. No real money to convert (see header) → reset to 0,
--     not FX-converted. Guarded so a second run is a no-op.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'organizations' AND column_name = 'subscription_credits') = 'numeric'
  THEN
    EXECUTE 'ALTER TABLE organizations ALTER COLUMN subscription_credits DROP DEFAULT';
    EXECUTE 'ALTER TABLE organizations ALTER COLUMN subscription_credits TYPE BIGINT USING 0';
    EXECUTE 'ALTER TABLE organizations ALTER COLUMN subscription_credits SET DEFAULT 0';
  END IF;

  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'organizations' AND column_name = 'payg_credits') = 'numeric'
  THEN
    EXECUTE 'ALTER TABLE organizations ALTER COLUMN payg_credits DROP DEFAULT';
    EXECUTE 'ALTER TABLE organizations ALTER COLUMN payg_credits TYPE BIGINT USING 0';
    EXECUTE 'ALTER TABLE organizations ALTER COLUMN payg_credits SET DEFAULT 0';
  END IF;
END $$;

-- (5) Non-negativity at the type/constraint level (defence in depth on top of
--     the settle function's WHERE-guard). Re-runnable: DROP IF EXISTS + ADD.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_sub_credits_nonneg;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_payg_credits_nonneg;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_sub_credits_nonneg  CHECK (subscription_credits >= 0),
  ADD CONSTRAINT organizations_payg_credits_nonneg CHECK (payg_credits >= 0);

-- (6) gateway_transactions.delta: NUMERIC(20,6) ₽ → BIGINT credits, matching
--     the org buckets. Safe today: step (3) emptied all api_usage rows, and
--     no other type ('topup'/'refill'/'expire'/'refund') has any rows yet
--     (payments=0 on prod) — so this cast has 0 rows to truncate.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'gateway_transactions' AND column_name = 'delta') = 'numeric'
  THEN
    EXECUTE 'ALTER TABLE gateway_transactions ALTER COLUMN delta TYPE BIGINT USING delta::bigint';
  END IF;
END $$;

-- (7) credit_buckets.amount_rub — NOT migrated (table has no aggregate reader;
--     billing/summary/route.ts:14-16 confirms it is never read). Mark the
--     column deprecated via COMMENT ON (safe, additive, does not rewrite the
--     already-applied 0004 migration that created it).
COMMENT ON COLUMN credit_buckets.amount_rub IS
  'DEPRECATED (0056_web_credits_unit.sql): unit-wise this is still ₽ AND the '
  'credit_buckets table itself has no aggregate reader (organizations.* is '
  'the only bucket the gateway settle function and billing reads touch). Do '
  'not treat this column as a source of truth for anything.';

COMMIT;
