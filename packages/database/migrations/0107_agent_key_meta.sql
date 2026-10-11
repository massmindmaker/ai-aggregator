-- 0107_agent_key_meta.sql
-- Agent key lifecycle (plan 2026-10-09 agentic-rail, Task 7):
--  1. gateway_api_keys.meta — per-key bookkeeping JSONB (default '{}'). The
--     rotate endpoint records rotated_from_hash there: an audit-grade link
--     from every rotated key to the credential it replaced, without widening
--     the key columns the auth hot path reads.
--  2. aiag_revoke_agent_principal_v1 — principal self-revoke entrypoint
--     (spec §3 C1, phase-review ruling I-2). Authorization is possession of
--     a LIVE gateway key of the principal's org: every agent key descends
--     from the bootstrap key minted only after a verified TON wallet proof
--     (0104 rail), so a live key is transitively bound to the wallet and no
--     separate challenge/proof round trip is required. One transaction
--     revokes the principal and EVERY live key of the org, which frees the
--     wallet for a fresh registration (agent_principals_active_address is a
--     partial unique WHERE status='active'). Idempotent by design: a
--     principal already revoked reports the stored revoked_at with
--     keysRevoked counting only the keys killed by THIS call (all zero when
--     the API is the only writer — the state is reachable only through
--     out-of-band principal revocation, and the function still sweeps any
--     stray live keys in that case).
BEGIN;

ALTER TABLE gateway_api_keys ADD COLUMN meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE FUNCTION aiag_revoke_agent_principal_v1(_key_id UUID) RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _org UUID; _owner UUID; _p agent_principals; _keys INT; _revoked_at TIMESTAMPTZ; _already BOOLEAN;
BEGIN
 -- Live-key gate (same aliveness predicate as 0106): revoked/disabled/expired
 -- keys authorize nothing. A dead or unknown key id is indistinguishable.
 IF _key_id IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 SELECT k.org_id INTO _org FROM gateway_api_keys k
  WHERE k.id=_key_id AND k.revoked_at IS NULL AND k.disabled_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp());
 IF _org IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 _owner:=aiag_agent_owner_user_v1();
 IF _owner IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 -- One principal per org (agent_principals.org_id UNIQUE, 0104). A live key
 -- whose org has no principal row at all is not an agent key -> refuse.
 SELECT * INTO _p FROM agent_principals WHERE org_id=_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 _already:=_p.status='revoked';
 UPDATE gateway_api_keys SET revoked_at=clock_timestamp(),disabled_at=clock_timestamp()
  WHERE org_id=_org AND revoked_at IS NULL;
 GET DIAGNOSTICS _keys=ROW_COUNT;
 IF _already THEN
  _revoked_at:=_p.revoked_at;
  IF _revoked_at IS NULL THEN RAISE EXCEPTION 'AGENT_PRINCIPAL_STATE_CONFLICT'; END IF;
 ELSE
  UPDATE agent_principals SET status='revoked',revoked_at=clock_timestamp()
   WHERE id=_p.id AND status='active' RETURNING revoked_at INTO _revoked_at;
  IF _revoked_at IS NULL THEN RAISE EXCEPTION 'AGENT_PRINCIPAL_STATE_CONFLICT'; END IF;
 END IF;
 INSERT INTO audit_log(actor_id,actor_type,action,resource_type,resource_id,details)
  VALUES(_owner,'system','agent.revoke','agent_principal',_p.id::text,
   jsonb_build_object('orgId',_org::text,'keysRevoked',_keys,'revokedByKeyId',_key_id::text,'idempotent',_already));
 RETURN jsonb_build_object('principalId',_p.id::text,'revokedAt',_revoked_at,'keysRevoked',_keys);
END $$;

REVOKE EXECUTE ON FUNCTION aiag_revoke_agent_principal_v1(uuid) FROM PUBLIC;

COMMIT;
