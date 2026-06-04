-- =============================================================================
-- 0038: add gonka/kimi-k2.6 as a routable model via the Gonka upstream.
--
-- GonkaGate serves Kimi K2.6 under the slug `moonshotai/kimi-k2.6` (confirmed live
-- by the 2026-06-04 spike: GET /v1/models). The `gonka` provider + `gonka` upstream
-- rows already exist (migration 0030); this only adds the model + its routing.
--
-- Gateway slug = `gonka/kimi-k2.6`; upstream_model_id = `moonshotai/kimi-k2.6`.
-- Markup omitted → model_upstreams default (1.25). Prices are placeholders pending
-- the real per-token cost from the GonkaGate dashboard (same as 0030).
--
-- Idempotent (ON CONFLICT DO NOTHING). Prod note: DML-only, app role can run it;
-- apply manually in order via `sudo -u postgres psql aiag -f 0038_gonka_kimi.sql`.
-- =============================================================================

-- 1. models — register the slug
INSERT INTO models (slug, type, enabled, display_name, description, metadata) VALUES
  ('gonka/kimi-k2.6', 'chat', true, 'Kimi K2.6',
    'Kimi K2.6 — открытая модель Moonshot AI, доступна через GonkaGate.',
    jsonb_build_object('tags',ARRAY['llm','open','long-context'],'hosted_region','global','provider_family','moonshot'))
ON CONFLICT (slug) DO NOTHING;

-- 2. model_upstreams — route gonka/kimi-k2.6 via the existing `gonka` upstream.
INSERT INTO model_upstreams (model_id, upstream_id, upstream_model_id, price_per_1k_input, price_per_1k_output)
SELECT m.id, s.upstream_id, s.upstream_model_id, s.price_in, s.price_out
FROM (VALUES
  ('gonka/kimi-k2.6', 'gonka', 'moonshotai/kimi-k2.6', 0.20::numeric, 0.60::numeric)
) AS s(model_slug, upstream_id, upstream_model_id, price_in, price_out)
JOIN models m ON m.slug = s.model_slug
ON CONFLICT (model_id, upstream_id) DO NOTHING;
