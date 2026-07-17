-- 0056_web_credits_unit.sql
-- T1 (money-path): web org credit buckets migrate ₽ (NUMERIC) → whole
-- MICRO-credit (BIGINT). Founder decision 2026-07-15: 1 credit = 1¢ USD,
-- matching TMA's unit family (tg_user_balances.balance_credits BIGINT) —
-- refined 2026-07-16 (adversarial rework) to a MICRO-credit granularity
-- (1 credit = 1000 micro) so a sub-cent call doesn't have to round up to a
-- full cent (that whole-credit floor was itself an ~1390× overcharge risk on
-- embeddings — Opus review HIGH-1). See
-- docs/specs/2026-07-16-finmodel-build-spec.md and lib/pricing.ts.
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
-- 🔴 P0-2 fix (Opus review, 2026-07-16 rework): the FIRST version of this
-- migration ran the archive-then-DELETE of `gateway_transactions WHERE
-- type='api_usage'` unconditionally, with a header claiming "second run
-- deletes 0 rows because nothing new is inserted as api_usage by the OLD ₽
-- function" — which is FALSE: the NEW credits function
-- (aiag_settle_charge_credits) inserts exactly that `type='api_usage'` shape
-- (settle-charge.sql, both INSERTs). On prod there is no applied-migrations
-- table (packages/database/CLAUDE.md), so a second accidental run of this
-- file after real traffic has landed would have archived nothing new
-- (CREATE TABLE IF NOT EXISTS is a no-op the second time) and then deleted
-- the entire live ledger — destroying both the revenue audit trail AND the
-- idempotency check inside the settle function (which reads
-- gateway_transactions to detect replays), enabling double-charges on any
-- retried request_id.
--
-- Fix: archive + DELETE + type-cast are now inside ONE guarded block, keyed
-- on `gateway_transactions.delta` still being `numeric`. Once this migration
-- has run once (delta is BIGINT), the ENTIRE block — archive, delete, and
-- cast — is skipped on every subsequent run, full stop. There is no window
-- in which DELETE can run against a column that is already BIGINT (i.e.
-- already-migrated, potentially containing real post-migration rows).
--
-- Idempotency (restated under the P0-2 fix):
--  (1) CREATE TABLE IF NOT EXISTS ... AS SELECT (org buckets) — second run
--      does not re-snapshot (table already exists). Non-destructive either way.
--  (2)+(3)+(6, renumbered from old (2)/(3)/(6)) archive+delete+cast of
--      gateway_transactions — now a single data_type-guarded block, see above.
--  (4)/(5) [now the org bucket type/constraint steps] are wrapped in a
--      data_type check so a second run does not re-zero real balances that
--      accrued between runs.
--
-- ⚠️ Deployment-ordering note (finding, not in the original spec): the
-- gateway_transactions.delta cast below still requires this migration and
-- the paired api-gateway code deploy (which stops calling the OLD ₽
-- function) to land together, not this-migration-then-wait — see
-- packages/database/CLAUDE.md deploy runbook / skill aiag-deploy. The P0-2
-- fix above makes a stray SECOND run safe; it does not make "migration
-- applied, old code still serving" safe (that combination still throws a
-- loud Postgres type error on any fractional-₽ INSERT instead of silently
-- mispricing — the originally-intended behaviour, unaffected by this fix).

BEGIN;

-- (1) Archive current (₽-denominated) org bucket values for audit trail.
CREATE TABLE IF NOT EXISTS organizations_rub_archive_20260716 AS
SELECT id, subscription_credits AS sub_rub, payg_credits AS payg_rub,
       subscription_credits_expires_at, NOW() AS archived_at
FROM organizations
WHERE subscription_credits <> 0 OR payg_credits <> 0;

-- (2)+(3)+(6) gateway_transactions: archive the ₽-denominated api_usage rows,
--     clear them (nonsensical once `delta` becomes a credits BIGINT), then
--     cast delta NUMERIC(20,6) → BIGINT — all inside ONE guard keyed on delta
--     still being `numeric`. P0-2 fix: this is what makes a second run,
--     whenever it happens and however much real traffic has landed by then,
--     a true no-op instead of a silent ledger-wipe (see header above).
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'gateway_transactions' AND column_name = 'delta') = 'numeric'
  THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS gateway_transactions_rub_archive_20260716 AS '
            || 'SELECT * FROM gateway_transactions WHERE type = ''api_usage''';
    EXECUTE 'DELETE FROM gateway_transactions WHERE type = ''api_usage''';
    EXECUTE 'ALTER TABLE gateway_transactions ALTER COLUMN delta TYPE BIGINT USING delta::bigint';
  END IF;
END $$;

-- (4) organizations.subscription_credits / payg_credits: NUMERIC(20,6) ₽ →
--     BIGINT MICRO-credits. No real money to convert (see header) → reset to
--     0, not FX-converted. Guarded so a second run is a no-op.
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
