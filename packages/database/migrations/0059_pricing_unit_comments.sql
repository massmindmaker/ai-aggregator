-- 0059_pricing_unit_comments.sql
--
-- Documentation-only (COMMENT ON COLUMN), no data/type change. Pins the true
-- unit of the pricing/ledger columns to the schema itself, atomically and for
-- free, after two independent units got confused twice in this codebase's
-- history:
--   1. model_upstreams.price_per_1k_* / price_per_image / price_per_audio_sec
--      were seeded as US CENTS (= USD × 100) but migration 0006's header
--      literally said "RUB pre-markup (USD * 100)" and 0024's said
--      "price_per_1k_RUB = usd_per_1M × 0.1" — both wrongly naming the unit
--      RUB. That mislabeling is what produced api-gateway's `upstreamUsd`
--      variable (reading a cents column as if it were USD) and the
--      resulting 100× overcharge fixed in this same rework (lib/pricing.ts,
--      finmodel-build-spec.md "поправка v2").
--   2. organizations.subscription_credits/payg_credits and
--      gateway_transactions.delta are MICRO-credits (1 credit = 1000 micro =
--      1¢) as of migration 0056/0058 — not whole credits, not ₽.
--
-- Verified against prod (2026-07-16 SELECT, see 0056's header) and against
-- public pricing: anthropic/claude-sonnet-4-6 0.30/1.50 = $3/$15 per 1M ✓,
-- anthropic/claude-opus-4-8 0.50/2.50 = $5/$25 per 1M ✓,
-- openai/gpt-4o-mini 0.015/0.06 = $0.15/$0.60 per 1M ✓.
--
-- Idempotent: COMMENT ON COLUMN always overwrites, safe to re-run.

COMMENT ON COLUMN model_upstreams.price_per_1k_input IS
  'US CENTS per 1k input tokens (= USD × 100). NOT RUB, despite migration '
  '0006''s original header wording (corrected same day). NOT USD — dividing '
  'by 100 before multiplying by markup is mandatory; see lib/pricing.ts '
  '(calcCostCredits PricingArgs.upstreamCents).';

COMMENT ON COLUMN model_upstreams.price_per_1k_output IS
  'US CENTS per 1k output tokens (= USD × 100). Same convention as '
  'price_per_1k_input — see that column''s comment.';

COMMENT ON COLUMN model_upstreams.price_per_image IS
  'US CENTS per image/clip (= USD × 100). Same convention as '
  'price_per_1k_input. For video models this column holds the per-clip price '
  '(model_upstreams reuses it — see routes/v1/video.ts).';

COMMENT ON COLUMN model_upstreams.price_per_audio_sec IS
  'US CENTS per second of audio (= USD × 100). Same convention as '
  'price_per_1k_input.';

COMMENT ON COLUMN organizations.subscription_credits IS
  'BIGINT MICRO-credits (1 credit = 1000 micro = 1 US cent). Whole-integer '
  'unit as of migration 0056/0058 (2026-07-16) — do not treat as ₽ or as '
  'whole credits. Display value = this / 1000 (see @aiag credits formatter, '
  'finmodel-build-spec.md §1/§9).';

COMMENT ON COLUMN organizations.payg_credits IS
  'BIGINT MICRO-credits (1 credit = 1000 micro = 1 US cent). Same convention '
  'as subscription_credits — see that column''s comment.';

COMMENT ON COLUMN gateway_transactions.delta IS
  'BIGINT MICRO-credits (1 credit = 1000 micro = 1 US cent), signed (negative '
  '= debit). Same convention as organizations.subscription_credits/'
  'payg_credits as of migration 0056/0058.';
