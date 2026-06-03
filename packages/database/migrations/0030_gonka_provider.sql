-- =============================================================================
-- 0030: Seed the Gonka provider + one known-live model.
--
-- Wires GonkaGate (https://api.gonkagate.com/v1, OpenAI-compatible broker) into
-- the gateway as a routable upstream, and registers the single currently-known
-- live slug `gonka/qwen3-235b`. Adapter: packages/api-gateway/src/upstreams/gonka.ts
-- (key from process.env.GONKA_API_KEY; white-label, neutral errors).
--
-- Two catalogs are seeded, mirroring the existing pattern:
--   1. `providers` row (BYOK catalog — same shape as 0026_provider_catalog.sql)
--   2. `upstreams` + `models` + `model_upstreams` rows (gateway routing — same
--      shape as 0024_refresh_models_2026_05.sql). The gateway resolver keys off
--      `model_upstreams.upstream_id = 'gonka'`, so this is what makes the slug
--      routable via the gonka adapter.
--
-- The model list is INTENTIONALLY minimal: only the one known-live slug is
-- seeded here. Additional Gonka models are discovered at runtime, NOT hardcoded.
--
-- Markup: omitted → falls back to the model_upstreams.markup column default (1.25).
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. Safe to re-run.
-- Prod note: app role `aiag` cannot ALTER; this migration is DML-only (no DDL),
-- so it runs as-is. Apply manually in order (no tracking table on prod).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. providers — BYOK catalog entry (OpenAI-compatible wire format, api_key auth)
-- -----------------------------------------------------------------------------
INSERT INTO providers (id, name, api_base, auth_kind, enabled, requires_base_url, sort) VALUES
  ('gonka', 'Gonka', 'https://api.gonkagate.com/v1', 'api_key', true, false, 80)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. upstreams — physical provider row for gateway routing (id = 'gonka')
-- -----------------------------------------------------------------------------
INSERT INTO upstreams (id, provider, ru_residency, enabled, latency_p50_ms, uptime, base_url) VALUES
  ('gonka', 'gonka', false, true, 500, 0.99, 'https://api.gonkagate.com/v1')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. models — register the one known-live slug
-- -----------------------------------------------------------------------------
INSERT INTO models (slug, type, enabled, display_name, description, metadata) VALUES
  ('gonka/qwen3-235b', 'chat', true, 'Qwen3 235B',
    'Qwen3 235B — крупная открытая MoE-модель, доступная через GonkaGate.',
    jsonb_build_object('tags',ARRAY['llm','open','long-context'],'hosted_region','global','provider_family','qwen'))
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. model_upstreams — routing for gonka/qwen3-235b via upstream `gonka`.
--    markup omitted → column default (1.25).
-- -----------------------------------------------------------------------------
INSERT INTO model_upstreams (model_id, upstream_id, upstream_model_id, price_per_1k_input, price_per_1k_output)
SELECT m.id, s.upstream_id, s.upstream_model_id, s.price_in, s.price_out
FROM (VALUES
  ('gonka/qwen3-235b', 'gonka', 'Qwen/Qwen3-235B-A22B', 0.20::numeric, 0.60::numeric)
) AS s(model_slug, upstream_id, upstream_model_id, price_in, price_out)
JOIN models m ON m.slug = s.model_slug
ON CONFLICT (model_id, upstream_id) DO NOTHING;
