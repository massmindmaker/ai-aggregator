-- Phase 15+ / Bring-Your-Own-Agent — fix connection_type CHECK constraint.
-- Migration 0021 defined CHECK (connection_type IN ('aiag','external')), but the
-- application code (apps/tg-miniapp/app/api/tma/agents/route.ts and
-- apps/agent-worker/src/agent-runner.ts) writes 'external_openai'. That mismatch
-- makes every external-agent INSERT fail the constraint. Drop the old CHECK and
-- re-add one that allows the canonical values the code actually uses.
-- Idempotent: DROP ... IF EXISTS + DO $$ EXCEPTION block.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_connection_type_chk;

DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_connection_type_chk
    CHECK (connection_type IN ('aiag', 'external_openai'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Note: agents_external_requires_url_chk from 0021 stays valid as-is — it only
-- special-cases the 'aiag' default, so any non-aiag value (incl. 'external_openai')
-- still requires external_base_url to be set.
