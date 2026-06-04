-- =============================================================================
-- 0034: agent_schedules — scheduled (self-running) agent runs.
--
-- An agent runs itself on a user-set interval (e.g. every morning). Each fire
-- enqueues a NORMAL agent run through the existing money path — the worker's
-- daily/monthly budget guard + settleRun + BYOK-zero rule all apply unchanged.
-- This table only stores WHAT to run, HOW OFTEN, and WHEN next. No billing here.
--
-- Double-fire safety (multi-instance) lives in the worker's atomic claim:
--   UPDATE agent_schedules SET last_run_at = next_run_at,
--          next_run_at = next_run_at + (interval_minutes * INTERVAL '1 minute')
--   WHERE enabled = true AND next_run_at <= now() RETURNING ...
-- A second tick sees the already-advanced next_run_at and claims nothing.
--
-- interval_minutes floor = 15 (CHECK) to bound how often a schedule can spend.
--
-- Idempotent: CREATE TABLE / INDEX ... IF NOT EXISTS. Safe to re-run.
-- Prod note: this is DDL → run via `sudo -u postgres psql aiag` (app role `aiag`
-- cannot ALTER/CREATE). Apply manually in order (no tracking table on prod).
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tg_user_id       BIGINT NOT NULL,
  prompt           TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 15),
  enabled          BOOLEAN NOT NULL DEFAULT true,
  next_run_at      TIMESTAMPTZ NOT NULL,
  last_run_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- The scheduler tick selects due rows with this exact predicate, so index it.
CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
  ON agent_schedules (enabled, next_run_at);

-- One schedule per agent (the TMA API upserts on this). Keeps the UI 1:1 with
-- the agent and prevents accidental duplicate fires from two stale rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_schedules_agent
  ON agent_schedules (agent_id);
