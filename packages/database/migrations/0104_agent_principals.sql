-- 0104_agent_principals.sql
-- Agent identity rail: headless principals, wallet challenges, service owner user.
-- No monetary writes here. Testnet-only in v1 (network CHECK).
BEGIN;

INSERT INTO users(id, email, name, is_active, is_banned)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'aiag-agents@aiag.local', 'AIAG Agent Service', TRUE, FALSE)
ON CONFLICT (email) DO NOTHING;

CREATE FUNCTION aiag_agent_owner_user_v1() RETURNS UUID LANGUAGE SQL STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT id FROM users WHERE email='aiag-agents@aiag.local' LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION aiag_agent_owner_user_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiag_agent_owner_user_v1() TO PUBLIC;

CREATE TABLE agent_principals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
 network TEXT NOT NULL CHECK(network='-3'),
 address TEXT NOT NULL CHECK(length(address)=48 AND address ~ '^[A-Za-z0-9_-]{48}$'),
 address_raw TEXT NOT NULL CHECK(address_raw ~ '^0:[0-9a-f]{64}$'),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 revoked_at TIMESTAMPTZ,
 CHECK(revoked_at IS NULL OR (status='revoked' AND revoked_at>=created_at))
);
CREATE UNIQUE INDEX agent_principals_active_address ON agent_principals(network,address) WHERE status='active';
CREATE INDEX agent_principals_org ON agent_principals(org_id);

CREATE TABLE agent_wallet_challenges (
 id UUID PRIMARY KEY,
 purpose TEXT NOT NULL CHECK(purpose IN('register','revoke')),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash ~ '^[0-9a-f]{64}$'),
 network TEXT NOT NULL CHECK(network='-3'),
 address TEXT NOT NULL CHECK(length(address)=48),
 domain TEXT NOT NULL CHECK(length(domain) BETWEEN 3 AND 300),
 issued_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 proof_digest TEXT,
 principal_id UUID REFERENCES agent_principals(id) ON DELETE RESTRICT,
 CHECK(expires_at=issued_at+INTERVAL '120 seconds'),
 CHECK(proof_digest IS NULL OR (length(proof_digest)=64 AND proof_digest ~ '^[0-9a-f]{64}$')),
 CHECK((consumed_at IS NULL AND proof_digest IS NULL AND principal_id IS NULL) OR (consumed_at IS NOT NULL AND proof_digest IS NOT NULL))
);
CREATE INDEX agent_wallet_challenges_address ON agent_wallet_challenges(address,issued_at);
CREATE INDEX agent_wallet_challenges_expiry ON agent_wallet_challenges(expires_at);

COMMIT;
