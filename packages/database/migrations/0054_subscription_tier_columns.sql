-- fix/rub-payments-tinkoff: make a paid TIER actually activatable.
--
-- Problem: /api/subscriptions/create sells a TIER (Basic/Starter/Pro from
-- lib/payments/providers.ts TIERS), but the CONFIRMED webhook had no row to
-- flip to 'active' and no place to record the tier's monthly credit
-- allowance — so the buyer's rubles were dumped into users.balance instead of
-- their tier being turned on.
--
-- The dashboard already READS these columns (apps/web/src/lib/dashboard/
-- overview.ts joins subscriptions on user_id / status='active' and selects
-- plan_name, credits_limit, credits_used inside a try/catch that falls back to
-- 'Free' precisely because they don't exist yet). This migration makes the
-- table match what the app already queries — it does not invent new surface.

-- (1) A tier subscription is NOT scoped to a single AI model (unlike the legacy
-- Plan-01 per-model subscription this table originally modelled). Allow model_id
-- to be NULL so a tier row can exist without a model. Safe: subscriptions is
-- empty in prod.
ALTER TABLE subscriptions
  ALTER COLUMN model_id DROP NOT NULL;

-- (2) Tier state the dashboard reads. plan_name = TIERS[tier].name;
-- credits_limit = TIERS[tier].credits (the monthly credit allowance, a COUNT of
-- credits — NOT a ruble amount); credits_used = consumption this period (0 on
-- activation; the gateway metering that decrements it is a separate, unbuilt
-- integration — see route TODO).
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS plan_name    TEXT,
  ADD COLUMN IF NOT EXISTS credits_limit INTEGER,
  ADD COLUMN IF NOT EXISTS credits_used  INTEGER NOT NULL DEFAULT 0;

-- (3) 'pending' state: a subscription row created at payment initiation that is
-- not yet paid. Kept distinct from 'active' so the dashboard (status='active')
-- never shows an unpaid tier. The CONFIRMED webhook flips pending -> active.
-- ADD VALUE IF NOT EXISTS is idempotent and must run outside a txn block (it is,
-- migrations are hand-run statement-by-statement via psql).
ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'pending';
