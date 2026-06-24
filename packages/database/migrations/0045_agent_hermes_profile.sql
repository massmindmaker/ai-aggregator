-- 0045_agent_hermes_profile.sql — маршрут запуска агента на Hermes.
-- connection_type расширяется: 'aiag'|'external_openai' (старое) + 'hermes_managed'
-- (наш бокс, профиль в hermes_profile, AIAG-биллинг) + 'hermes_own' (свой Hermes URL,
-- ZERO-комиссия как BYOK). hermes_profile = имя профиля (=model в REST). ADDITIVE.
BEGIN;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS hermes_profile TEXT NULL;
COMMIT;
