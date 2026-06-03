-- 0029_usd_ledger.sql
-- D-1: TMA ₽ → USD-pegged credit unit (1 credit = 1 US cent, BIGINT).
-- SAFE: prod has 0 agents and 0 balances at apply time — no value conversion,
-- no freeze window. If any row exists, STOP and use a USING-cast + maintenance window.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0029_usd_ledger.sql
-- Idempotent: re-running is a no-op (renames guarded by existence checks, ledger
-- objects use IF NOT EXISTS).

BEGIN;

-- ---------------------------------------------------------------------------
-- Guard: refuse the 0-row fast path if real money exists. The whole reason this
-- migration is a cheap rename (not a financial conversion) is that prod is empty.
-- The moment tg_user_balances / agent_runs is non-empty this STOPS and forces a
-- USING-cast + chosen ₽→USD rate in a maintenance window.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tg_user_balances) > 0
     OR (SELECT COUNT(*) FROM agent_runs) > 0 THEN
    RAISE EXCEPTION 'tg_user_balances / agent_runs not empty — do NOT run the 0-row fast path; convert with a USING cast in a maintenance window';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) spendable balance ₽ → credits (cents, integer). Idempotent rename.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'tg_user_balances' AND column_name = 'balance_rub') THEN
    ALTER TABLE tg_user_balances RENAME COLUMN balance_rub TO balance_credits;
  END IF;
END $$;
ALTER TABLE tg_user_balances
  ALTER COLUMN balance_credits TYPE BIGINT USING (round(balance_credits))::bigint,
  ALTER COLUMN balance_credits SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2) run cost ₽ → credits
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'agent_runs' AND column_name = 'cost_rub') THEN
    ALTER TABLE agent_runs RENAME COLUMN cost_rub TO cost_credits;
  END IF;
END $$;
ALTER TABLE agent_runs
  ALTER COLUMN cost_credits TYPE BIGINT USING (round(cost_credits))::bigint,
  ALTER COLUMN cost_credits SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3) agent budgets ₽ → credits ($1000 monthly / $100 daily defaults in cents)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'agents' AND column_name = 'budget_rub_monthly') THEN
    ALTER TABLE agents RENAME COLUMN budget_rub_monthly TO budget_credits_monthly;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'agents' AND column_name = 'daily_budget_rub') THEN
    ALTER TABLE agents RENAME COLUMN daily_budget_rub TO daily_budget_credits;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'agents' AND column_name = 'spent_today_rub') THEN
    ALTER TABLE agents RENAME COLUMN spent_today_rub TO spent_today_credits;
  END IF;
END $$;
ALTER TABLE agents
  ALTER COLUMN budget_credits_monthly TYPE BIGINT USING (round(budget_credits_monthly))::bigint,
  ALTER COLUMN budget_credits_monthly SET DEFAULT 100000,   -- $1000
  ALTER COLUMN daily_budget_credits   TYPE BIGINT USING (round(daily_budget_credits))::bigint,
  ALTER COLUMN daily_budget_credits   SET DEFAULT 10000,     -- $100
  ALTER COLUMN spent_today_credits    TYPE BIGINT USING (round(spent_today_credits))::bigint,
  ALTER COLUMN spent_today_credits    SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4) topups: credited amount (cents) + audited conversion rate
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'tg_topups' AND column_name = 'amount_rub') THEN
    ALTER TABLE tg_topups RENAME COLUMN amount_rub TO amount_credits;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'tg_topups' AND column_name = 'rate_rub_per_ton') THEN
    ALTER TABLE tg_topups RENAME COLUMN rate_rub_per_ton TO rate_usd_cents_per_ton;
  END IF;
END $$;
ALTER TABLE tg_topups
  ALTER COLUMN amount_credits         TYPE BIGINT USING (round(amount_credits))::bigint,
  ALTER COLUMN rate_usd_cents_per_ton TYPE BIGINT USING (round(rate_usd_cents_per_ton))::bigint;

-- ---------------------------------------------------------------------------
-- 5) append-only immutable ledger (audit truth; cached balance is a projection)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tg_ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  tg_user_id    BIGINT NOT NULL,
  delta_credits BIGINT NOT NULL,          -- +credit (topup) or −debit (run settle), cents
  kind          VARCHAR(24) NOT NULL,     -- 'topup' | 'run_debit' | 'adjustment' | 'refund'
  ref_kind      VARCHAR(24),              -- 'tg_topup' | 'agent_run'
  ref_id        UUID,                     -- topups.id / agent_runs.id (idempotency key)
  balance_after BIGINT NOT NULL,          -- materialized balance immediately after this entry
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON tg_ledger_entries(tg_user_id, created_at DESC);
-- idempotency: a topup/run can post at most one entry of a given kind
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_ref
  ON tg_ledger_entries(ref_kind, ref_id, kind)
  WHERE ref_id IS NOT NULL;

COMMIT;

-- Rollback (0 rows): symmetric rename back to *_rub + TYPE NUMERIC, DROP TABLE
-- tg_ledger_entries. Kept in the PR description, not as a live file (prod has no
-- migration tracking — packages/database/CLAUDE.md).
