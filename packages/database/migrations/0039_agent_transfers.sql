-- 0039_agent_transfers.sql
-- R1.4 — atomic agent ownership transfer/sale (+ opt-in TON NFT binding).
-- Builds ON TOP of the live D-0/D-1 foundation (tg_user_balances + tg_ledger_entries)
-- and the Wave-1 rent pattern (0032). Changes nothing in them.
--
-- Apply on prod manually (app aiag role cannot ALTER):
--   sudo -u postgres psql aiag -f 0039_agent_transfers.sql
-- Additive + idempotent: CREATE TABLE/INDEX IF NOT EXISTS; ADD COLUMN IF NOT EXISTS.
-- Re-running is a no-op.
--
-- SECURITY / MONEY:
--   * transfer_charges.id is the idempotency anchor: it is the ledger ref_id for BOTH
--     the buyer debit and the seller credit (one ref_id, two `kind`s). The live
--     uq_ledger_ref(ref_kind, ref_id, kind) UNIQUE index (migration 0029) makes each
--     payout row exactly-once — no double-credit on webhook retry.
--   * amount_credits is BIGINT US cents with CHECK >= 0 (0 = gift-only transfer;
--     >0 = sale). DB-level CHECK is defense-in-depth: even if a future caller bypasses
--     the route, a negative charge (which would invert a debit into an over-credit)
--     is rejected at the DB layer.
--   * FKs are WITHOUT ON DELETE CASCADE on purpose: transfer_charges is an immutable
--     money audit trail. Deleting an agent MUST NOT silently erase transfer history.

-- ---------------------------------------------------------------------------
-- Additive columns on agents — mark an agent transferable and bind it to a TON NFT.
-- ---------------------------------------------------------------------------
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS transferable           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS transfer_price_credits BIGINT,   -- NULL = gift-only; >0 = sale price (US cents)
  ADD COLUMN IF NOT EXISTS nft_address            TEXT,     -- TEP-62 item address on TON (NULL until minted)
  ADD COLUMN IF NOT EXISTS nft_owner_wallet       TEXT,     -- current owner's TON wallet
  ADD COLUMN IF NOT EXISTS memory_owner_key       TEXT;     -- key the obezlichennaja memory blob is encrypted to (re-key seam; NULL pre-D-5)

-- ---------------------------------------------------------------------------
-- transfer_charges — the idempotency anchor for one ownership transfer / sale.
-- Its UUID is the ledger ref_id for the debit/credit pair. status flips
-- pending → settled exactly once under the claim-guard.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transfer_charges (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             UUID NOT NULL REFERENCES agents(id),   -- NO cascade: immutable audit trail
  buyer_tg_user_id     BIGINT NOT NULL,
  seller_tg_user_id    BIGINT NOT NULL,
  amount_credits       BIGINT NOT NULL CHECK (amount_credits >= 0), -- 0 = gift, >0 = sale (US cents)
  kind                 VARCHAR(16) NOT NULL,    -- 'sale' | 'gift'
  status               VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending' | 'settled' | 'failed'
  nft_tx_hash          TEXT,                    -- TON mint/transfer tx hash (set on webhook confirm)
  startonus_invoice_id TEXT,                   -- Startonus invoice id for reconciliation
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transfer_charges_agent
  ON transfer_charges(agent_id);
CREATE INDEX IF NOT EXISTS idx_transfer_charges_pending
  ON transfer_charges(status) WHERE status = 'pending';

-- New ledger value documentation (no ALTER needed — tg_ledger_entries.kind /
-- ref_kind are VARCHAR with no DB-level CHECK):
--   kind     ∈ {'transfer_debit','transfer_credit'}  (debit buyer / credit seller, sale only)
--   ref_kind = 'transfer_charge'                      (ref_id = transfer_charges.id)
-- The debit and credit share ONE ref_id and differ only by kind, so both coexist
-- under the live uq_ledger_ref(ref_kind, ref_id, kind) index (migration 0029).
