-- Additional existing-account TON identity. No Telegram IDs, fabricated emails or monetary writes.
BEGIN;
CREATE TABLE user_ton_wallets (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 network TEXT NOT NULL CHECK(network='-3'),
 address TEXT NOT NULL CHECK(length(address)=66 AND address ~ '^0:[0-9a-f]{64}$'),
 public_key TEXT NOT NULL CHECK(length(public_key)=64 AND public_key ~ '^[0-9a-f]{64}$'),
 wallet_version TEXT NOT NULL CHECK(wallet_version IN('v4r2','v5r1')),
 code_hash TEXT NOT NULL CHECK(length(code_hash)=64 AND code_hash ~ '^[0-9a-f]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revoked_at TIMESTAMPTZ,
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE UNIQUE INDEX user_ton_wallets_active_address ON user_ton_wallets(network,address) WHERE revoked_at IS NULL;
CREATE INDEX user_ton_wallets_owner ON user_ton_wallets(user_id,created_at);
CREATE TABLE user_ton_wallet_challenges (
 id UUID PRIMARY KEY,
 purpose TEXT NOT NULL CHECK(purpose IN('link','login')),
 actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
 browser_hash TEXT NOT NULL CHECK(length(browser_hash)=64 AND browser_hash ~ '^[0-9a-f]{64}$'),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash ~ '^[0-9a-f]{64}$'),
 network TEXT NOT NULL CHECK(network='-3'),
 domain TEXT NOT NULL CHECK(length(domain) BETWEEN 3 AND 300),
 issued_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ, proof_digest TEXT,
 wallet_id UUID REFERENCES user_ton_wallets(id) ON DELETE RESTRICT,
 ticket_hash TEXT,ticket_expires_at TIMESTAMPTZ,ticket_used_at TIMESTAMPTZ,
 CHECK((purpose='link' AND actor_user_id IS NOT NULL) OR (purpose='login' AND actor_user_id IS NULL)),
 CHECK(expires_at=issued_at+INTERVAL '120 seconds'),
 CHECK(proof_digest IS NULL OR (length(proof_digest)=64 AND proof_digest ~ '^[0-9a-f]{64}$')),
 CHECK(ticket_hash IS NULL OR (length(ticket_hash)=64 AND ticket_hash ~ '^[0-9a-f]{64}$')),
 CHECK((consumed_at IS NULL AND wallet_id IS NULL AND proof_digest IS NULL) OR (consumed_at IS NOT NULL AND wallet_id IS NOT NULL AND proof_digest IS NOT NULL)),
 CHECK((ticket_hash IS NULL AND ticket_expires_at IS NULL AND ticket_used_at IS NULL) OR (purpose='login' AND consumed_at IS NOT NULL AND ticket_hash IS NOT NULL AND ticket_expires_at=consumed_at+INTERVAL '60 seconds')),
 CHECK(ticket_used_at IS NULL OR ticket_used_at>=consumed_at)
);
CREATE INDEX user_ton_wallet_challenges_browser ON user_ton_wallet_challenges(browser_hash,issued_at);
CREATE INDEX user_ton_wallet_challenges_actor ON user_ton_wallet_challenges(actor_user_id,issued_at);
CREATE INDEX user_ton_wallet_challenges_expiry ON user_ton_wallet_challenges(expires_at);
CREATE TABLE user_ton_wallet_password_limits (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 window_start TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 8)
);
CREATE FUNCTION aiag_user_ton_wallet_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='user_ton_wallets' THEN
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'TON_WALLET_CREDENTIAL_IMMUTABLE'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['consumed_at','proof_digest','wallet_id','ticket_hash','ticket_expires_at','ticket_used_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['consumed_at','proof_digest','wallet_id','ticket_hash','ticket_expires_at','ticket_used_at'])
   OR (OLD.consumed_at IS NOT NULL AND (to_jsonb(NEW)-'ticket_used_at') IS DISTINCT FROM (to_jsonb(OLD)-'ticket_used_at'))
   OR (OLD.ticket_used_at IS NOT NULL AND NEW.ticket_used_at IS DISTINCT FROM OLD.ticket_used_at)
  THEN RAISE EXCEPTION 'TON_WALLET_CHALLENGE_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER user_ton_wallet_identity_guard BEFORE UPDATE ON user_ton_wallets FOR EACH ROW EXECUTE FUNCTION aiag_user_ton_wallet_immutable();
CREATE TRIGGER user_ton_wallet_challenge_guard BEFORE UPDATE ON user_ton_wallet_challenges FOR EACH ROW EXECUTE FUNCTION aiag_user_ton_wallet_immutable();
REVOKE EXECUTE ON FUNCTION aiag_user_ton_wallet_immutable() FROM PUBLIC;
COMMIT;
