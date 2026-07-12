-- 0052_membership_null_tier_hardening.sql
-- Issue #29 round 7, HIGH-D: NULL tier in tg_memberships is currently interpreted by the
-- creation-quota gate as UNLIMITED (issue #32, apps/tg-miniapp/src/lib/membership.ts
-- assertAgentQuota). That was fine as long as the ONLY NULL-tier row was the founder seed
-- (0044). It stopped being fine once the pre-round-6 on-chain sync route
-- (POST /api/tma/membership, commit 14c4fed — LIVE on `feat/r2-readiness` before the
-- round-6 fix in 1af2751) could write source='nft', tier=NULL rows for ANY wallet merely
-- HOLDING a collection item (no payment, no tier read — see the removed grantMembership()
-- in apps/tg-miniapp/src/lib/nft-ownership.ts / membership.ts). Any such row already on prod
-- currently reads as free-forever-unlimited — strictly better than paying for `studio`.
--
-- Two independent closes, so a future bug that writes NULL again fails CLOSED, not OPEN:
--
-- (1) BACKFILL: neutralize existing legacy rows. NOT deleted (audit trail) — flagged with
--     revoked_at/revoked_reason. The founder seed (0044: tg_user_id 217133707,
--     source='founder') is explicitly excluded by the WHERE clause and is never touched.
--
-- (2) CONTRACT CHANGE: NULL/unrecognized tier now means ZERO privileges, UNLESS
--     source='founder' (0044's existing seed already IS that explicit flag — no new column
--     needed). This is documented on the column via COMMENT so any reader (this app's
--     hasCreatorMembership/currentMembershipTier, ALREADY updated in this same round — see
--     apps/tg-miniapp/src/lib/membership.ts — and issue #32's assertAgentQuota, in a
--     DIFFERENT worktree, NOT touched here) has one place to learn the rule.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER):
--   sudo -u postgres psql aiag -f 0052_membership_null_tier_hardening.sql
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, backfill guarded by revoked_at IS NULL
-- (re-running touches 0 rows the second time). Re-running is a no-op.

BEGIN;

ALTER TABLE tg_memberships
  ADD COLUMN IF NOT EXISTS revoked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

-- BACKFILL: legacy free grants from the pre-round-6 ownership-only sync route. Founder seed
-- (source='founder') is excluded by name, not just by tier — belt-and-suspenders in case a
-- future founder-adjacent row also happens to have tier IS NULL for a legitimate reason.
UPDATE tg_memberships
SET revoked_at = NOW(),
    revoked_reason = 'legacy_null_tier_ownership_grant: pre-round-6 sync route ' ||
      '(POST /api/tma/membership, commit 14c4fed) granted on bare NFT ownership with no ' ||
      'payment and no tier — issue #29 HIGH-D. Neutralized, not deleted.'
WHERE tier IS NULL
  AND source <> 'founder'
  AND revoked_at IS NULL;

-- CONTRACT (fail-closed, issue #29 HIGH-D): documented on the columns so it travels with
-- the schema, not just this migration file.
COMMENT ON COLUMN tg_memberships.tier IS
  'Purchased tier (creator/builder/studio) or NULL. CONTRACT for every reader (issue #29 '
  'HIGH-D, migration 0052): NULL or an unrecognized value means ZERO privileges/quota '
  '(fail-closed) UNLESS source = ''founder''. NEVER treat NULL as unlimited access — that '
  'was the exact free-membership bug this migration closes. Any quota/gate reader '
  '(including issue #32''s assertAgentQuota) MUST implement this rule.';

COMMENT ON COLUMN tg_memberships.revoked_at IS
  'Set when this row must no longer confer ANY privilege (e.g. the legacy free-grant '
  'backfill, issue #29 HIGH-D, migration 0052). NULL = active. Every reader MUST treat '
  'revoked_at IS NOT NULL as zero privileges regardless of tier/source.';

COMMENT ON COLUMN tg_memberships.source IS
  '''nft'' (paid, granted by apps/agent-worker/src/membership-reconciler.ts against a '
  'chain-confirmed item) | ''founder'' (migration 0044 seed — the ONLY source that may '
  'carry tier IS NULL and still have full privileges) | ''grant'' (reserved, unused). '
  'See tg_memberships.tier comment for the fail-closed NULL-tier contract.';

COMMIT;
