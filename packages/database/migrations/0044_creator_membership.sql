-- 0044_creator_membership.sql
--
-- CREATOR MEMBERSHIP GATE (founder decision 2026-06-24).
-- A user who holds a membership NFT (= "creator") may CREATE agents from scratch
-- (POST /api/tma/agents + /api/tma/agents/ai-builder). Users WITHOUT membership can
-- still HIRE and CLONE existing agents (those routes are NOT gated). Membership is a
-- simple flag, backed by NFT ownership when MEMBERSHIP_NFT_COLLECTION_ADDRESS is set.
--
-- ADDITIVE + idempotent: creates one new table, touches NO existing table and NO
-- money-path column. Applied MANUALLY on prod (the app DB role cannot ALTER); this
-- file is untracked like the rest of packages/database/migrations.

BEGIN;
CREATE TABLE IF NOT EXISTS tg_memberships (
  tg_user_id   BIGINT      PRIMARY KEY,
  nft_address  TEXT        NULL,          -- the membership NFT item address, when known
  source       TEXT        NOT NULL DEFAULT 'nft',   -- 'nft' | 'founder' | 'grant'
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Seed the founder so creation is never fully locked out.
INSERT INTO tg_memberships (tg_user_id, source) VALUES (217133707, 'founder')
  ON CONFLICT (tg_user_id) DO NOTHING;
COMMIT;
