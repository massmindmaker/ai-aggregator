-- =============================================================================
-- 0027: agents.external_api_key_hint — backfill the missing column.
--
-- The create-agent route (apps/tg-miniapp/app/api/tma/agents/route.ts) has
-- ALWAYS inserted `external_api_key_hint` (the last-4 display hint), and the
-- 0026 header comment claims 0021 added it — but 0021 only added
-- connection_type / external_base_url / external_api_key_encrypted /
-- external_model_slug. The column was never in a tracked migration; on prod it
-- may have been added by a manual ALTER, or it may be missing (no external
-- agents exist yet, so the gap is latent).
--
-- This makes the column's existence DEFINITIVE and file-tracked. Provider-picker
-- (catalog BYOK) reuses the same external_openai INSERT, so the column must
-- exist for agent creation with a BYO key to succeed.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS → no-op if prod already has it.
-- Additive only. Touches NO execution path, NO worker, NO money code.
-- =============================================================================

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS external_api_key_hint TEXT;
