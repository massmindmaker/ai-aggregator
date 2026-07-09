-- Issue #4 (CRIT/money): global dedup for TON/USDT top-up on-chain tx_hash.
--
-- Gap being closed: topup/check route + agent-worker topup-reconciler match a
-- deposit purely on `comment.includes('topup:<tag>')` + `value >= expected`,
-- guarded only per-row (`status='pending'`). One on-chain payment whose comment
-- contains several `topup:<tag>` substrings (or satisfies several pending rows)
-- could confirm and credit EVERY matching row — balance minted from one payment.
--
-- Fix contract (issue #4): crediting becomes idempotent BY tx_hash via
-- `INSERT ... ON CONFLICT (tx_hash) DO NOTHING RETURNING` into a claims table;
-- credit happens only if that insert returned a row. Plus a belt-and-suspenders
-- UNIQUE on tg_topups.tx_hash itself.
--
-- Order matters: (1) claims table, (2) pretch existing prod duplicates,
-- (3) backfill claims from history so old txs can never be re-claimed,
-- (4) the unique index (would fail if built before the pretch).

-- (1) Claim ledger: one on-chain tx <-> at most one credited topup, ever.
CREATE TABLE IF NOT EXISTS tg_topup_tx_claims (
  tx_hash    TEXT PRIMARY KEY,
  topup_id   UUID NOT NULL REFERENCES tg_topups(id),
  claimed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_topup_tx_claims_topup
  ON tg_topup_tx_claims(topup_id);

-- (2) Pretch existing duplicates so the unique index below cannot fail.
-- Keep the earliest row (by created_at, then id) untouched; suffix the rest
-- with ':dup:<id>' — history is preserved, never deleted. '' hashes are left
-- alone: they are excluded from both the index and the backfill (a hash-less
-- credit has no verifiable on-chain identity; see (4) note).
UPDATE tg_topups t
SET tx_hash = t.tx_hash || ':dup:' || t.id
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY tx_hash ORDER BY created_at, id) AS rn
  FROM tg_topups
  WHERE tx_hash IS NOT NULL AND tx_hash <> ''
) d
WHERE t.id = d.id AND d.rn > 1;

-- (3) Backfill: claim every historical confirmed tx_hash so an old on-chain
-- payment can never be re-used to credit a new pending topup. After (2) each
-- non-empty tx_hash maps to exactly one row, so no DISTINCT juggling needed.
INSERT INTO tg_topup_tx_claims (tx_hash, topup_id, claimed_at)
SELECT tx_hash, id, COALESCE(confirmed_at, NOW())
FROM tg_topups
WHERE status = 'confirmed' AND tx_hash IS NOT NULL AND tx_hash <> ''
ON CONFLICT (tx_hash) DO NOTHING;

-- (4) Global UNIQUE on tg_topups.tx_hash. Partial: NULL (pending rows) and ''
-- (legacy hash-less confirmations) are excluded so existing data can't break
-- it; new code never writes '' (hash-less deposit = no-match, not credited).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_topups_tx_hash
  ON tg_topups (tx_hash)
  WHERE tx_hash IS NOT NULL AND tx_hash <> '';
