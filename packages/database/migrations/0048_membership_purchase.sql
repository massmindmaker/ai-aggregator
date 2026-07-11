-- 0048_membership_purchase.sql
-- Issue #29 (money/p1): membership-NFT purchase — 3 tiers (creator/builder/studio)
-- minted through Startonus, paid on-chain in TON (NOT a crypto-credit debit).
--
-- Builds on 0044_creator_membership.sql (tg_memberships already exists, seeded with
-- the founder). This migration ADDS a `tier` column to it, plus the purchase-charge +
-- tx-hash-claim tables that mirror the proven patterns already on prod:
--   - transfer_charges          (0039_agent_transfers.sql)   — pending→settled charge row
--   - tg_topup_tx_claims        (0046_topup_tx_hash_dedup.sql) — UNIQUE-by-tx_hash claim ledger
--
-- IDEMPOTENCY CONTRACT (issue #29, lesson of closed issue #4): a membership is granted
-- ONLY after `INSERT INTO tg_membership_tx_claims ... ON CONFLICT (onchain_key) DO NOTHING
-- RETURNING` returns a row, inside the SAME sql.begin transaction as the grant + the
-- charge settle. A replayed webhook for the same on-chain mint hits the PK conflict, the
-- INSERT returns 0 rows, and the caller skips the grant — no second membership, no
-- double-settle. See apps/tg-miniapp/app/api/tma/membership/webhook/route.ts.
--
-- NOTE: the purchase webhook is not the only writer of tg_memberships — the on-chain sync
-- route (POST /api/tma/membership) also grants to a wallet that HOLDS a collection item,
-- and the founder is seeded by 0044. That sync path is deliberately left as-is pending a
-- founder decision on the "transfer the NFT ⇒ transfer the membership (with its agents)"
-- model, where on-chain ownership becomes the source of truth. It will be rewritten by
-- that decision's own task; nothing here depends on it.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER):
--   sudo -u postgres psql aiag -f 0048_membership_purchase.sql
-- Additive + idempotent: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT (0047 idiom). Re-running is a no-op.

BEGIN;

-- ---------------------------------------------------------------------------
-- tg_memberships: add the purchased tier. NULL stays valid for the pre-existing
-- founder-seed row (0044) and any future 'grant' source that doesn't carry a tier.
-- ---------------------------------------------------------------------------
ALTER TABLE tg_memberships
  ADD COLUMN IF NOT EXISTS tier TEXT;

ALTER TABLE tg_memberships DROP CONSTRAINT IF EXISTS chk_tg_memberships_tier;
ALTER TABLE tg_memberships
  ADD CONSTRAINT chk_tg_memberships_tier
  CHECK (tier IS NULL OR tier IN ('creator', 'builder', 'studio'));

-- ---------------------------------------------------------------------------
-- tg_membership_charges — the idempotency anchor for one membership purchase.
-- pending → settled exactly once, guarded by the on-chain claim insert below.
--
-- recipient_address is load-bearing, not decoration: the webhook re-verifies ON CHAIN
-- that THIS wallet actually holds an item in the membership collection before granting,
-- so a forged callback cannot mint a membership out of thin air (issue #29 review,
-- MEDIUM-1 — Startonus does not sign its callbacks).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tg_membership_charges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_user_id       BIGINT NOT NULL,
  tier             TEXT NOT NULL,
  amount_nano_ton  BIGINT NOT NULL CHECK (amount_nano_ton > 0),
  -- 'pending' | 'settled' | 'failed' | 'expired' (TTL-swept, see idx below)
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  recipient_address TEXT,                  -- the buyer's TON wallet (mint target + on-chain re-check)
  tx_hash          TEXT,                   -- TON mint tx hash, when the callback carries one
  item_address     TEXT,                   -- minted TEP-62 item address (the callback's `item`)
  startonus_invoice_id TEXT,               -- Startonus invoice id for reconciliation
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at       TIMESTAMPTZ
);

-- Re-runnable ADDs for a 0048 applied from an earlier revision of this file.
ALTER TABLE tg_membership_charges
  ADD COLUMN IF NOT EXISTS recipient_address TEXT,
  ADD COLUMN IF NOT EXISTS item_address      TEXT;

ALTER TABLE tg_membership_charges DROP CONSTRAINT IF EXISTS chk_tg_membership_charges_tier;
ALTER TABLE tg_membership_charges
  ADD CONSTRAINT chk_tg_membership_charges_tier
  CHECK (tier IN ('creator', 'builder', 'studio'));

CREATE INDEX IF NOT EXISTS idx_membership_charges_user
  ON tg_membership_charges(tg_user_id);
CREATE INDEX IF NOT EXISTS idx_membership_charges_pending
  ON tg_membership_charges(status) WHERE status = 'pending';

-- MEDIUM-2 (TOCTOU): "at most one pending purchase per user" must be a DB invariant, not
-- a SELECT-then-INSERT race in the route. Two concurrent purchase calls now collide on
-- this partial UNIQUE and the loser gets a clean 409 instead of a second live invoice.
-- Partial ⇒ settled/failed/expired rows are unconstrained (a user may buy again).
CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_charges_one_pending
  ON tg_membership_charges (tg_user_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- tg_membership_tx_claims — GLOBAL dedup by ON-CHAIN IDENTITY (issue #4 pattern).
-- One on-chain mint <-> at most one membership grant, ever.
--
-- `onchain_key` = COALESCE(callback.txHash, callback.item). The documented live Startonus
-- callback (packages/shared/src/startonus.ts:72-81) carries `item` (the minted NFT item
-- address — unique on chain) and does NOT promise a txHash, so keying dedup on tx_hash
-- alone would leave the real callback unguarded. We accept whichever the acquirer sends
-- and key on it; both are on-chain-unique identifiers of the SAME mint.
--
-- The PK is the UNIQUE constraint; `ON CONFLICT (onchain_key) DO NOTHING RETURNING`
-- inside the webhook's sql.begin is what makes a replayed callback a no-op.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tg_membership_tx_claims (
  onchain_key TEXT PRIMARY KEY,
  charge_id   UUID NOT NULL REFERENCES tg_membership_charges(id),
  tg_user_id  BIGINT NOT NULL,
  tier        TEXT NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_tx_claims_charge
  ON tg_membership_tx_claims(charge_id);

COMMIT;
