-- 0062_upstream_egress_proxy.sql
-- T2 of docs/superpowers/plans/2026-08-22-native-egress-integration.md:
-- per-upstream egress proxy configuration.
--
-- model_upstreams.egress_proxy holds a proxy URL
-- (socks5://[user:pass@]host:port or http(s)://[user:pass@]host:port) that
-- ALL outbound requests to this routing entry's provider must tunnel through.
-- Resolution precedence (packages/api-gateway/src/upstreams/fetch-upstream.ts):
--   1. this column (per model × upstream routing row)
--   2. env AIAG_EGRESS_PROXY_URL (fleet-wide default)
--   3. unset → direct egress (byte-identical behavior to pre-T2)
--
-- NULL (the default) means "no per-upstream override" — NOT "force direct".
-- Credentials may be embedded in the URL; the value stays server-side (it is
-- never selected into any client-facing API response).
--
-- Idempotency (this repo applies migrations manually, no ledger — see 0061's
-- note): ADD COLUMN IF NOT EXISTS is a no-op on re-run; re-setting an
-- identical COMMENT is a no-op by definition.

ALTER TABLE model_upstreams ADD COLUMN IF NOT EXISTS egress_proxy TEXT;

COMMENT ON COLUMN model_upstreams.egress_proxy IS
  'Optional egress proxy for ALL upstream calls resolved through this row '
  '(socks5://[user:pass@]host:port or http://[user:pass@]host:port). '
  'Precedence: this column > env AIAG_EGRESS_PROXY_URL > direct connection. '
  'NULL = inherit env/direct (never an error). Consumed by api-gateway '
  'upstreams/fetch-upstream.ts via safeFetch({egressProxyUrl}) — native '
  'egress integration T2 (2026-08-22). SSRF guards apply to the destination '
  'identically with or without the proxy.';
