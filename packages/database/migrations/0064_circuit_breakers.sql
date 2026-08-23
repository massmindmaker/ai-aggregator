-- 0064_circuit_breakers.sql
-- T3 of docs/superpowers/plans/2026-08-22-native-egress-integration.md:
-- persisted circuit-breaker state per upstream.
--
-- The gateway keeps breaker state in memory
-- (packages/api-gateway/src/failover/breaker.ts) and mirrors every transition
-- here so an OPEN circuit survives a process restart / deploy (otherwise the
-- first requests after boot hammer a provider that just failed 5 times).
--
-- state machine (breaker.ts):
--   closed     — normal traffic
--   open       — short-circuited until opened_until elapses
--                (transient ×5 → 30s; any rate_limit/quota → kind-specific
--                 cooldown; repeated opens double the cooldown, cap ×16)
--   half_open  — ONE probe allowed; success → closed, failure → open again
--
-- Rows are written lazily (only after the first incident), so healthy
-- upstreams generate zero writes.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + COMMENT are no-ops on re-run
-- (same convention as 0062).

CREATE TABLE IF NOT EXISTS circuit_breakers (
  upstream_id     VARCHAR(64) PRIMARY KEY REFERENCES upstreams(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'closed'
                  CHECK (state IN ('closed', 'open', 'half_open')),
  failures        INT NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  opened_until    TIMESTAMPTZ
);

COMMENT ON TABLE circuit_breakers IS
  'Persisted circuit-breaker state per upstream (api-gateway failover, T3 '
  '2026-08-22). Written lazily by src/failover/breaker.ts on every transition; '
  'loaded back on the first touch of an upstream after process start. '
  'opened_until is meaningful only while state = ''open''.';

COMMENT ON COLUMN circuit_breakers.state IS
  '''closed'' = normal, ''open'' = short-circuited until opened_until, '
  '''half_open'' = exactly one probe request allowed.';

COMMENT ON COLUMN circuit_breakers.failures IS
  'Consecutive transient-failure count toward the open threshold (5). '
  'Reset to 0 when the breaker closes.';

COMMENT ON COLUMN circuit_breakers.last_failure_at IS
  'Timestamp of the most recent recorded failure (any kind).';

COMMENT ON COLUMN circuit_breakers.opened_until IS
  'Deadline while state = ''open'': requests are skipped until it elapses, '
  'then the breaker moves to half_open for a single probe.';
