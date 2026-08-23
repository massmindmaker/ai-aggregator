-- 0063_model_upstream_priority.sql
-- T3 of docs/superpowers/plans/2026-08-22-native-egress-integration.md:
-- explicit failover ordering for model × upstream routing rows.
--
-- model_upstreams.priority orders the candidate list the resolver returns
-- (packages/api-gateway/src/routing/resolver.ts):
--   ORDER BY priority ASC, upstream_id ASC
-- Lower value = tried first. The preferred candidate is still chosen by the
-- routing engine (mode/policy — pickUpstream); priority decides the FAILOVER
-- order of the remaining candidates in executeWithFailover
-- (routing/failover.ts). DEFAULT 100 keeps every existing row tied, so the
-- tiebreak falls to upstream_id and current behavior is unchanged until ops
-- deliberately staggers priorities.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS + identical COMMENT are no-ops on
-- re-run (same convention as 0062).

ALTER TABLE model_upstreams ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100;

COMMENT ON COLUMN model_upstreams.priority IS
  'Failover order for candidates of one model: lower = tried first '
  '(resolver ORDER BY priority ASC, upstream_id ASC; T3 native egress '
  'integration, 2026-08-22). Does not affect mode/policy selection '
  '(pickUpstream) — only the order candidates are attempted in when an '
  'earlier one fails.';
