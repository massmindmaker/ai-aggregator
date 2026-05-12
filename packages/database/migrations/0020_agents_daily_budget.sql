-- Phase 15 / Wave 04 hardening — daily budget for agents
-- P0-4: separate daily-budget gate so a runaway agent can't burn a whole month in a day.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS daily_budget_rub NUMERIC(12,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS spent_today_rub  NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spent_today_date DATE          NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/Moscow')::date;

-- Index used by the daily-reset cron and the in-worker bucket check.
CREATE INDEX IF NOT EXISTS idx_agents_spent_today_date ON agents(spent_today_date);
