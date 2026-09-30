-- 0096_settle_idempotency_org_scope.sql
--
-- CRITICAL money fix (2026-09-30): re-scope the `api_usage` idempotency
-- UNIQUE index from GLOBAL to PER-ORG.
--
-- Defect: migration 0004_gateway_core.sql created
--   CREATE UNIQUE INDEX gateway_transactions_api_usage_uniq
--     ON gateway_transactions (request_id, source) WHERE type='api_usage';
-- — no `org_id`. Two consequences, both reachable by an ordinary API key:
--
--  1. CROSS-ORG LEAK. `aiag_settle_charge_credits` decided "already charged"
--     by matching `request_id` ALONE. Org B sending the same `X-Request-Id`
--     as org A (trivially collides: clients number their requests from 1, and
--     UUIDv4 collisions between two unrelated key holders are a birthday
--     problem, not a cryptographic one) hit `idempotent=TRUE`, so B was never
--     charged and got the inference for free.
--  2. The same global index made the DB itself reject org B's INSERT with
--     23505, which `settle.ts`'s error map does not handle → 500 on the
--     money path (and a cheap availability lever).
--
-- Why a NEW migration and not an edit of 0004: prod migrations here are MANUAL
-- and UNTRACKED (packages/database/CLAUDE.md) — 0004 is already applied, so
-- editing it would silently diverge repo from prod. This file only drops and
-- recreates ONE index; no table, no data, no renumbering.
--
-- Fix: the uniqueness identity becomes (org_id, request_id, source). Two orgs
-- may now hold the same request_id, which is exactly the isolation the money
-- path needs. `aiag_settle_charge_credits` is re-deployed with the matching
-- `org_id = _org_id` filter in its idempotency lookup (see
-- 0058_settle_charge_credits_fn.sql — its body is byte-identical to the
-- readable mirror in src/functions/settle-charge.sql), so the index and the
-- query agree on the same identity.
--
-- DEPLOY (manual, `sudo -u postgres psql aiag` — the `aiag` app role cannot
-- run DDL):
--
--   psql aiag -v ON_ERROR_STOP=1 -f packages/database/migrations/0096_settle_idempotency_org_scope.sql
--   psql aiag -c "\di+ gateway_transactions_api_usage*"
--
-- Must land BEFORE the api-gateway deploy that starts sending server-minted
-- `stl_<uuid>` settlement ids; ordering vs. the code deploy does not matter
-- for correctness (the id change alone closes the replay hole) but shipping
-- both in one window keeps the ledger's request_id uniformly server-owned.
--
-- Rollback: the previous index can be recreated from 0004 verbatim. Recreating
-- it may FAIL if two orgs already share a (request_id, source) pair — i.e. once
-- this fix is live, rolling the index back is not always possible. That is the
-- intended, safe direction.

BEGIN;

-- Explicit drop/recreate rather than CREATE ... IF NOT EXISTS: IF NOT EXISTS
-- would silently no-op against the OLD index name and leave prod global.
DROP INDEX IF EXISTS gateway_transactions_api_usage_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS gateway_transactions_api_usage_uniq
  ON gateway_transactions (org_id, request_id, source)
  WHERE type = 'api_usage';

COMMIT;