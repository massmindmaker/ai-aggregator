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
--
-- recipient_address is load-bearing, not decoration: it is the ton-proof VERIFIED wallet
-- (from ton_wallets) that the reconciler asks the CHAIN about. It is never taken from a
-- request body — a client-chosen address would let a caller point the on-chain grant check
-- at someone else's wallet that already holds a collection item.
--
-- STATUS MACHINE (terminal = anything except 'pending'):
--   pending      — invoice created, chain has not confirmed a mint yet.
--   settled      — chain confirmed the mint; membership granted. Final.
--   failed       — the minter reported an explicit failure (callback error branch). Final.
--   expired      — invoice abandoned WITHOUT any payment evidence. Safe to discard.
--   needs_review — 🔴 PAID (we hold on-chain payment evidence: tx_hash/item_address) but the
--                  chain still has not shown the item after MEMBERSHIP_STUCK_DAYS. This is an
--                  anomaly, not garbage: the user's money is real. It is a TERMINAL status for
--                  the "one live purchase per user" UNIQUE below (so the user is never blocked
--                  from buying again), yet the reconciler KEEPS retrying these rows — if the
--                  indexer was merely down for days, the membership is still granted when it
--                  recovers. A charge carrying payment evidence must NEVER become 'expired'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tg_membership_charges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_user_id       BIGINT NOT NULL,
  tier             TEXT NOT NULL,
  amount_nano_ton  BIGINT NOT NULL CHECK (amount_nano_ton > 0),
  -- 'pending' | 'settled' | 'failed' | 'expired' | 'needs_review' (see status machine above)
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  recipient_address TEXT,                  -- the buyer's ton-proof VERIFIED TON wallet (mint target + chain check)
  tx_hash          TEXT,                   -- payment evidence, when a callback carries a tx hash
  item_address     TEXT,                   -- payment evidence: minted TEP-62 item address (callback's `item.address`)
  failure_reason   TEXT,                   -- why a charge ended in 'failed' / 'needs_review' (never silent)
  startonus_invoice_id TEXT,               -- Startonus invoice id for reconciliation
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at       TIMESTAMPTZ
);

-- Re-runnable ADDs for a 0048 applied from an earlier revision of this file.
--
-- chain_checked_at: the last time tonapi gave a DEFINITIVE answer about this charge's
-- recipient wallet (an answer, empty or not — never a 429/timeout/network failure). The
-- 15-minute TTL sweep in the purchase route may only expire a charge whose absence has
-- actually been confirmed on chain; without this, a lost callback + a rate-limited tonapi
-- would expire a PAID charge and the user would pay twice (issue #29, HIGH-3).
ALTER TABLE tg_membership_charges
  ADD COLUMN IF NOT EXISTS recipient_address TEXT,
  ADD COLUMN IF NOT EXISTS item_address      TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason    TEXT,
  ADD COLUMN IF NOT EXISTS chain_checked_at  TIMESTAMPTZ;

-- Reconciler pool lookups: fresh pendings and the (rare) stuck pool are queried separately
-- so a growing needs_review backlog can never starve new purchases (issue #29, P0-2).
CREATE INDEX IF NOT EXISTS idx_membership_charges_status_created
  ON tg_membership_charges(status, created_at);

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
-- `onchain_key` = the minted item's ON-CHAIN ADDRESS (`item.address`), read from the chain
-- by the reconciler (apps/agent-worker/src/membership-reconciler.ts) via tonapi — NOT from
-- the callback, which is unsigned and never retried and therefore cannot be trusted.
-- (Superseded design note: an earlier revision keyed on COALESCE(txHash, item). That was
-- wrong twice over — the Startonus callback's `item` is an OBJECT {index,address,owner,meta},
-- so it would have stringified to "[object Object]" and collapsed every mint into one claim.)
--
-- The PK is the UNIQUE constraint; `ON CONFLICT (onchain_key) DO NOTHING RETURNING`
-- inside the reconciler's sql.begin is what makes a replayed grant attempt a no-op.
--
-- ⚠️ FALSE-IDEMPOTENCY FIX: an earlier revision of THIS file created the table with PK
-- `tx_hash`. `CREATE TABLE IF NOT EXISTS` would silently keep that stale structure on any
-- DB where the old revision had already been applied, and every `ON CONFLICT (onchain_key)`
-- would then error at runtime. Prod is clean (0048 has never been applied), but "it happens
-- to be fine" is not idempotency — so we repair the structure explicitly instead of trusting
-- IF NOT EXISTS.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tg_membership_tx_claims' AND column_name = 'tx_hash'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tg_membership_tx_claims' AND column_name = 'onchain_key'
  ) THEN
    ALTER TABLE tg_membership_tx_claims RENAME COLUMN tx_hash TO onchain_key;
  END IF;
END $$;
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

-- ---------------------------------------------------------------------------
-- ONE VERIFIED WALLET <-> ONE TELEGRAM ACCOUNT (issue #29, P0-1 second vector).
--
-- 0019 constrains only UNIQUE (tg_user_id, address), so the SAME wallet could be ton-proof
-- verified from TWO tg accounts. Combined with "one pending charge per USER", that let an
-- attacker open a `studio` charge on account A (and never pay), pay 2 TON for `creator` on
-- account B with the same wallet, and have the single minted item satisfy A's studio charge.
-- Paid 2, received 30.
--
-- The chain cannot tell us which charge an item belongs to (one mint template for all tiers),
-- so the wallet->account mapping must be unambiguous. Pretch first, then constrain:
--   (1) if a wallet is currently verified by several accounts, keep the EARLIEST verification
--       and demote the others to is_verified=false (rows are KEPT — no history is deleted;
--       a demoted user can simply re-verify with their own wallet);
--   (2) then enforce it going forward.
UPDATE ton_wallets w
SET is_verified = false
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY address ORDER BY linked_at, id) AS rn
  FROM ton_wallets
  WHERE is_verified = true
) d
WHERE w.id = d.id AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ton_wallets_verified_address
  ON ton_wallets (address) WHERE is_verified = true;

COMMIT;
