-- =============================================================================
-- 0035: agent_schedules — NAMED, multi-per-agent, kind-aware schedules.
--
-- Extends the 0034 single-per-agent interval schedule into the SCHEDULES screen
-- (wireframe #25): a user can have MULTIPLE named schedules across their agents
-- («Утренний дайджест 09:00», «Недельный отчёт Пн 10:00» as separate rows).
--
-- NO new billing. A scheduled fire still enqueues a NORMAL agent run through the
-- existing money path — the worker's daily/monthly budget guard + settleRun +
-- BYOK-zero rule all apply unchanged. This migration only adds scheduling shape.
--
-- New columns (all additive, nullable / defaulted so existing 0034 rows stay valid):
--   name           TEXT          — human label shown on the Schedules screen.
--   schedule_kind  VARCHAR(16)   — 'interval' | 'daily' | 'weekly' (DEFAULT 'interval').
--   at_time        TIME          — local Europe/Moscow wall-clock time for daily/weekly.
--   weekday        SMALLINT      — 0=Sun..6=Sat, for weekly only.
-- interval_minutes stays for kind='interval' (>=15 CHECK kept) but is made NULLABLE
-- so daily/weekly rows don't need it.
--
-- DROP the UNIQUE(agent_id) constraint → multiple schedules per agent allowed.
--
-- Idempotent: every statement is guarded (IF NOT EXISTS / IF EXISTS / catalog
-- check). Safe to re-run. Prod note: DDL → run via `sudo -u postgres psql aiag`
-- (app role `aiag` cannot ALTER). Apply manually in order (no tracking on prod).
-- =============================================================================

-- 1) New columns (additive, idempotent).
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS name          TEXT;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS schedule_kind VARCHAR(16) NOT NULL DEFAULT 'interval';
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS at_time       TIME;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS weekday       SMALLINT;

-- 2) interval_minutes: keep the >=15 CHECK semantics but make the column nullable
--    (required only for kind='interval'). The original 0034 column-level CHECK
--    (interval_minutes >= 15) rejects NULL? No — a CHECK passes when the expr is
--    NULL (SQL three-valued logic), so NULL interval_minutes already satisfies it.
--    We only need to drop the NOT NULL so daily/weekly rows can omit it.
ALTER TABLE agent_schedules ALTER COLUMN interval_minutes DROP NOT NULL;

-- 3) A composite kind/shape CHECK so a row is always internally consistent:
--    interval ⇒ interval_minutes >= 15 (NOT NULL);
--    daily    ⇒ at_time NOT NULL;
--    weekly   ⇒ at_time NOT NULL AND weekday in 0..6.
--    Added only if not already present (idempotent via pg_constraint catalog check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_agent_schedules_kind_shape'
  ) THEN
    ALTER TABLE agent_schedules ADD CONSTRAINT chk_agent_schedules_kind_shape CHECK (
      (schedule_kind = 'interval'
         AND interval_minutes IS NOT NULL AND interval_minutes >= 15)
      OR (schedule_kind = 'daily'
         AND at_time IS NOT NULL)
      OR (schedule_kind = 'weekly'
         AND at_time IS NOT NULL AND weekday IS NOT NULL AND weekday BETWEEN 0 AND 6)
    );
  END IF;
END$$;

-- 4) DROP the one-schedule-per-agent unique index → allow multiple named schedules.
DROP INDEX IF EXISTS uq_agent_schedules_agent;

-- 5) The scheduler tick still selects due rows by (enabled, next_run_at); keep that
--    index (0034 already created idx_agent_schedules_due — re-assert idempotently).
CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
  ON agent_schedules (enabled, next_run_at);

-- 6) List-the-user's-schedules query (GET /api/tma/me/schedules) filters by
--    tg_user_id; index it for the Schedules screen.
CREATE INDEX IF NOT EXISTS idx_agent_schedules_user
  ON agent_schedules (tg_user_id);
