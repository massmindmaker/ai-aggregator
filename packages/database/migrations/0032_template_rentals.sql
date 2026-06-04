-- 0032_template_rentals.sql
-- Wave 1 / Slice 2 — PAID author-rent + atomic 100%-pass-through author payout.
-- This is the LIVE money path. Builds ON TOP of the live D-0/D-1 foundation
-- (tg_user_balances.balance_credits + tg_ledger_entries) — changes nothing in it.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0032_template_rentals.sql
-- Additive + idempotent: re-running is a no-op (CREATE TABLE/INDEX IF NOT EXISTS).
--
-- DEPENDS ON 0031_agent_templates.sql (agent_templates must already exist on prod).
--
-- SECURITY / MONEY:
--   * rent_charges.id is the idempotency anchor: it is the ledger ref_id for BOTH
--     the renter debit and the author credit (one ref_id, two `kind`s). The live
--     uq_ledger_ref(ref_kind, ref_id, kind) UNIQUE index (migration 0029) makes the
--     payout exactly-once.
--   * amount_credits / price_credits are BIGINT US cents and MUST be > 0. Enforced
--     in the route before any transaction AND by a DB-level CHECK (defense-in-depth —
--     prod migrations are hand-run and a future caller could bypass the route).
--   * FKs are WITHOUT ON DELETE CASCADE on purpose: rentals/charges are an immutable
--     money audit trail. Deleting a template must NOT silently erase rent history.

-- ---------------------------------------------------------------------------
-- template_rentals — the entitlement ("right to use"): who rented what, when,
-- until when, and the clone agent that the rent produced.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS template_rentals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        UUID NOT NULL REFERENCES agent_templates(id),
  renter_tg_user_id  BIGINT NOT NULL,
  author_tg_user_id  BIGINT NOT NULL,                 -- denormalized: author at rent time
  cloned_agent_id    UUID,                            -- the clone agent the renter received
  price_credits      BIGINT NOT NULL CHECK (price_credits > 0), -- frozen price at rent time (US cents)
  rent_period        VARCHAR(16) NOT NULL,            -- 'month' | 'deploy' | 'use'
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ,                     -- for 'month'; NULL for one-shot
  status             VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'cancelled'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rentals_renter
  ON template_rentals(renter_tg_user_id, status);
CREATE INDEX IF NOT EXISTS idx_rentals_template
  ON template_rentals(template_id, created_at DESC);
-- One ACTIVE rental per (template, renter): the race-safe backstop against an
-- accidental double-rent (double-tap / network retry) charging twice. The rent
-- route's `INSERT … ON CONFLICT (template_id, renter_tg_user_id) WHERE status='active'
-- DO NOTHING` keys off this index → a duplicate becomes a no-op, not a second charge.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rental_active
  ON template_rentals(template_id, renter_tg_user_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- rent_charges — the idempotency anchor for one money movement. Its UUID is the
-- ledger ref_id for the debit/credit pair. status flips pending → settled exactly
-- once under the claim-guard, which is what makes the payout single-shot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rent_charges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_id          UUID NOT NULL REFERENCES template_rentals(id),
  renter_tg_user_id  BIGINT NOT NULL,
  author_tg_user_id  BIGINT NOT NULL,
  amount_credits     BIGINT NOT NULL CHECK (amount_credits > 0), -- US cents
  status             VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending' | 'settled'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rent_charges_rental
  ON rent_charges(rental_id);
CREATE INDEX IF NOT EXISTS idx_rent_charges_pending
  ON rent_charges(status) WHERE status = 'pending';

-- New ledger value documentation (no ALTER needed — tg_ledger_entries.kind /
-- ref_kind are VARCHAR(24) with no DB-level CHECK):
--   kind     ∈ {'rent_debit','rent_credit'}   (debit renter / credit author)
--   ref_kind = 'rent_charge'                   (ref_id = rent_charges.id)
-- The debit and credit share ONE ref_id (the charge) and differ only by kind, so
-- both rows coexist under uq_ledger_ref and each is independently idempotent.
