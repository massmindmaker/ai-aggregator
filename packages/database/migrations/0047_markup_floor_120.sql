-- 0047_markup_floor_120.sql
-- Issue #13 (money/A1): raise the markup floor to 1.20 on every upstream + enforce it.
--
-- Gap being closed: model_upstreams.markup defaults to 1.25 (0004_gateway_core.sql:80)
-- but several rows were seeded below break-even: openrouter/openai-via-or 1.07,
-- yandex 1.08, gigachat-tg 1.10, fal/replicate/kie 1.12, together/hf 1.15
-- (0006_seed_models.sql, 0006b_seed_kie_extended.sql, 0024_refresh_models_2026_05.sql).
-- rub_cost = upstream_usd * rate * markup * batchDiscount * cachingFactor
-- (packages/api-gateway/src/lib/pricing.ts:18). RU-контур fixed costs ≈ 10.6% of GMV
-- (эквайринг ~3% + налог 7.6%); at markup 1.07 net ≈ -4.3%, at 1.20 net ≈ +6%. 1.20 is
-- the break-even floor, not a target margin — the 1.25 column default is untouched.
--
-- Scope: ONLY model_upstreams.markup (the live pricing-catalog column). Does NOT touch
-- requests.markup (0004_gateway_core.sql:162) — that is a per-request historical audit
-- log of the markup actually applied at request time, not a pricing input; rewriting it
-- would falsify history. Does NOT touch packages/api-gateway/src/lib/pricing.ts, and does
-- NOT rewrite any already-applied migration (0004/0006/0006b/0024/0030 stay as history —
-- this migration raises their seeded values on top, additively).
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0047_markup_floor_120.sql
--
-- Idempotency:
--   (1) UPDATE ... WHERE markup < 1.20 — a second run touches 0 rows (all already >= 1.20).
--   (2) DROP CONSTRAINT IF EXISTS before ADD — a second run drops-then-recreates the same
--       constraint instead of erroring on duplicate_object.

-- (1) Raise every existing upstream below the floor. Column is NOT NULL (0004), but the
-- guard is written NULL-safe anyway so a future nullable column can't silently bypass it.
UPDATE model_upstreams
SET markup = 1.20
WHERE markup IS NOT NULL AND markup < 1.20;

-- (2) Enforce the floor going forward. Re-runnable: DROP IF EXISTS + ADD, same idiom as
-- 0021/0022_agents_connection_type_fix.sql.
ALTER TABLE model_upstreams DROP CONSTRAINT IF EXISTS chk_markup_floor;

ALTER TABLE model_upstreams
  ADD CONSTRAINT chk_markup_floor
  CHECK (markup IS NULL OR markup >= 1.20);
