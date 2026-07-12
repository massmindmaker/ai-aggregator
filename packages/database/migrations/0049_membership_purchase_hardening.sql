-- 0049_membership_purchase_hardening.sql
-- Issue #29 round 6 rework — three closes on top of 0048:
--
-- (1) P0-1 (tier from chain, not DB): NO schema change needed. The reconciler
--     (apps/agent-worker/src/membership-reconciler.ts) now reads the tier from the minted
--     item's own on-chain metadata (a `Tier` attribute baked in by ONE-TEMPLATE-PER-TIER
--     Startonus mint templates), never from `tg_membership_charges.tier`. That charge
--     column stays as the buyer's REQUESTED tier — now cross-checked against the chain,
--     not trusted blind.
--
-- (2) Decision B (idempotent purchase, never a second live invoice): a repeat "buy" call
--     while a charge is still 'pending' must return the SAME Startonus invoice, not mint a
--     second one — two live signable TON Connect transactions for one grant risk a genuine
--     double payment. The route can only replay the invoice if it was PERSISTED at creation
--     time — hence these columns.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER):
--   sudo -u postgres psql aiag -f 0049_membership_purchase_hardening.sql
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS. Re-running is a no-op.

BEGIN;

ALTER TABLE tg_membership_charges
  ADD COLUMN IF NOT EXISTS invoice_to          TEXT,       -- Startonus InvoiceResponse.to
  ADD COLUMN IF NOT EXISTS invoice_amount      TEXT,       -- Startonus InvoiceResponse.value (nano TON, string)
  ADD COLUMN IF NOT EXISTS invoice_payload     TEXT,       -- Startonus InvoiceResponse.payload (base64 TON Connect payload)
  ADD COLUMN IF NOT EXISTS invoice_valid_until BIGINT;     -- Startonus InvoiceResponse.validUntil (unix seconds)

COMMIT;
