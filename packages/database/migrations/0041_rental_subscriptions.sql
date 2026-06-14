-- 0041_rental_subscriptions.sql
-- Аренда = ЧЕСТНАЯ МЕСЯЧНАЯ ПОДПИСКА с лимитом (founder model 2026-06-14):
--   «автор ставит цену в месяц, в цену входит лимит (сколько кредитов можно
--    тратить на агента в месяц). Заплатил → месяц пользуешься в рамках лимита →
--    продлеваешь.» Наём = подписка = одна механика.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0041_rental_subscriptions.sql
-- Additive + idempotent: re-running is a no-op (ADD COLUMN IF NOT EXISTS).
--
-- DEPENDS ON 0031_agent_templates.sql + 0032_template_rentals.sql.
--
-- MONEY: this migration adds NO new money path. The atomic 100%-pass-through
-- author payout in 0032 (rent_charges → tg_ledger_entries debit/credit pair under
-- uq_ledger_ref) is REUSED unchanged for both the first month and each renewal —
-- a renewal is just another rent_charges row settled the exact same way. AIAG keeps
-- 0% of author rent. settleRun (run debit) is NOT touched.

-- ---------------------------------------------------------------------------
-- agent_templates: the author sets the MONTHLY rent price (price_credits, already
-- exists) AND the MONTHLY spend limit included in that price. NULL limit = fall
-- back to the clone's default monthly budget (route DEFAULT_BUDGET_CREDITS).
-- ---------------------------------------------------------------------------
ALTER TABLE agent_templates
  ADD COLUMN IF NOT EXISTS rent_monthly_limit_credits BIGINT
    CHECK (rent_monthly_limit_credits IS NULL OR rent_monthly_limit_credits > 0);
COMMENT ON COLUMN agent_templates.rent_monthly_limit_credits IS
  'Месячный лимит трат (US cents), входящий в цену подписки. NULL = дефолт клона.';

-- ---------------------------------------------------------------------------
-- template_rentals: turn the entitlement row into a MONTHLY SUBSCRIPTION period.
--   * period_start / period_end define the CURRENT paid month. period_end =
--     period_start + 1 month at purchase/renewal.
--   * monthly_limit_credits is the FROZEN limit for this subscription (copied from
--     the template at purchase time, like price_credits already is).
-- started_at / expires_at (0032) are kept untouched; period_* is the explicit,
-- renewal-driven period the founder model asks for.
-- ---------------------------------------------------------------------------
ALTER TABLE template_rentals
  ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ;
ALTER TABLE template_rentals
  ADD COLUMN IF NOT EXISTS period_end TIMESTAMPTZ;
ALTER TABLE template_rentals
  ADD COLUMN IF NOT EXISTS monthly_limit_credits BIGINT
    CHECK (monthly_limit_credits IS NULL OR monthly_limit_credits > 0);

-- Fast lookup of the active subscription for a cloned agent (worker limit gate).
CREATE INDEX IF NOT EXISTS idx_rentals_cloned_agent_active
  ON template_rentals(cloned_agent_id, status)
  WHERE cloned_agent_id IS NOT NULL AND status = 'active';

-- New rent_period value documentation (no ALTER — rent_period is VARCHAR(16) with
-- no DB-level CHECK): rent_period = 'month' for a monthly subscription. Legacy rows
-- stay 'use' (one-shot, no period) and remain valid.
