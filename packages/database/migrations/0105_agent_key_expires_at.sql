-- 0105_agent_key_expires_at.sql
-- Optional gateway API-key TTL. NULL = key never expires (existing keys
-- unaffected); a set value must strictly follow key creation.
BEGIN;

ALTER TABLE gateway_api_keys ADD COLUMN expires_at TIMESTAMPTZ
  CHECK(expires_at IS NULL OR expires_at>created_at);

COMMIT;
