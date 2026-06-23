-- 0040_hire_sessions_memory_scope.sql
-- Наём (hire) MVP — фундамент изоляции памяти/истории per-(agent_id, hirer_tg_user_id).
-- OWASP LLM06: нанятый агент НЕ должен видеть память владельца или другого нанимателя.
--
-- Spec: docs/superpowers/specs/2026-06-13-rnd-research-synthesis.md §2
--       SECURITY.md «Memory isolation per-hirer».
--
-- Apply on prod MANUALLY (app role `aiag` cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0040_hire_sessions_memory_scope.sql
-- Полностью ADDITIVE + идемпотентно (IF NOT EXISTS / DO-блоки): re-run = no-op.
-- НЕ трогает money-path: settleRun / debit / markup / balance не затрагиваются.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) agent_sessions — контейнер найма (один наниматель ↔ один чужой агент).
--    Типы свёрены с существующей схемой:
--      agents.id          = UUID          (0018_agents.sql)
--      agents.tg_user_id  = BIGINT        (0018_agents.sql)
--    UNIQUE(agent_id, hirer_tg_user_id) → найм идемпотентен (один наниматель = одна сессия).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
  id               BIGSERIAL PRIMARY KEY,
  agent_id         UUID   NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hirer_tg_user_id BIGINT NOT NULL,
  status           TEXT   NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, hirer_tg_user_id)
);

-- Быстрый lookup «активна ли сессия найма у этого юзера по этому агенту»
-- (используется авторизацией запуска нанятого агента).
CREATE INDEX IF NOT EXISTS ix_agent_sessions_hirer
  ON agent_sessions (hirer_tg_user_id, agent_id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 2) agent_memory.scope_tg_user_id — измерение изоляции памяти per-наниматель.
--    NULL = память владельца (старое поведение, не-наёмные прогоны).
--    NOT NULL = приватная память конкретного нанимателя.
--    Тип = BIGINT (как agents.tg_user_id / hirer_tg_user_id).
-- ---------------------------------------------------------------------------
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS scope_tg_user_id BIGINT NULL;

-- ---------------------------------------------------------------------------
-- 3) namespace-индекс памяти по (agent_id, COALESCE(scope,0), key).
--    ВАЖНО: agent_memory имеет PRIMARY KEY (agent_id, key) (0023_agent_memory.sql).
--    Этот PK НЕ различает scope → две строки (owner-scope NULL и hirer-scope)
--    с одинаковым key конфликтовали бы. Поэтому:
--      a) убираем старый PK (agent_id, key) — он становится слишком узким;
--      b) добавляем суррогатный PK по новой колонке id, чтобы у таблицы остался PK;
--      c) уникальность теперь = (agent_id, COALESCE(scope_tg_user_id,0), key)
--         через выражение-индекс (COALESCE даёт стабильный ключ для NULL-scope).
--    ON CONFLICT в memorySet переключается на этот expression-индекс.
--    Все шаги идемпотентны (проверки существования).
-- ---------------------------------------------------------------------------

-- a) суррогатный id (нужен, т.к. снимаем композитный PK)
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS id BIGSERIAL;

-- b) снять старый композитный PK (agent_id, key), если он ещё активен
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'agent_memory'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL AND pk_name <> 'agent_memory_pkey_id' THEN
    EXECUTE format('ALTER TABLE agent_memory DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

-- c) суррогатный PK по id (если ещё нет какого-либо PK)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_memory'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_pkey_id PRIMARY KEY (id);
  END IF;
END $$;

-- d) namespace-уникальность с учётом scope (COALESCE NULL→0). Это целевой
--    конфликтный индекс для memorySet ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS ix_agent_memory_scope
  ON agent_memory (agent_id, COALESCE(scope_tg_user_id, 0), key);

COMMIT;

-- Rollback (если потребуется, прод без tracking — держим в PR-описании, не как live-файл):
--   DROP INDEX IF EXISTS ix_agent_memory_scope;
--   ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_pkey_id;
--   ALTER TABLE agent_memory DROP COLUMN IF EXISTS id;
--   ALTER TABLE agent_memory ADD PRIMARY KEY (agent_id, key);
--   ALTER TABLE agent_memory DROP COLUMN IF EXISTS scope_tg_user_id;
--   DROP INDEX IF EXISTS ix_agent_sessions_hirer;
--   DROP TABLE IF EXISTS agent_sessions;
