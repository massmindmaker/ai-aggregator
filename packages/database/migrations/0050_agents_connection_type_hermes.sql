-- 0050_agents_connection_type_hermes.sql — снять блокер схемы для курса «движок = только Hermes».
-- Issue #31: CHECK agents_connection_type_chk (0022) разрешал только 'aiag'|'external_openai'.
-- Код уже имеет ветку 'hermes_managed' (apps/agent-worker/src/agent-runner.ts:140-149) и
-- колонку hermes_profile (0045_agent_hermes_profile.sql), а 'hermes_own' зарезервирован тем же
-- комментарием (свой Hermes URL, ZERO-комиссия как BYOK) — код для hermes_own ещё не написан.
-- Эта миграция ТОЛЬКО расширяет CHECK; сам Hermes-путь — отдельный эпик (#18,
-- docs/specs/2026-07-10-hermes-only-engine-architecture.md).
-- Идемпотентна: DROP CONSTRAINT IF EXISTS -> ADD CONSTRAINT (как в 0022).

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_connection_type_chk;

DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_connection_type_chk
    CHECK (connection_type IN ('aiag', 'external_openai', 'hermes_managed', 'hermes_own'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Note: agents_external_requires_url_chk (0021) stays valid as-is — it only special-cases
-- the 'aiag' default, so 'hermes_managed'/'hermes_own' still require external_base_url to be
-- set (hermes_own = the user's own Hermes URL; hermes_managed's provisioning target is a
-- future concern of the Hermes-only epic, not this migration).
