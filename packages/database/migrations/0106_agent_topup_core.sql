-- 0106_agent_topup_core.sql
-- Headless agent topup invoices: Gram (native) + USDT (jetton peg).
-- Authorization is the agent key: a live gateway_api_keys row whose org has an
-- active agent_principals principal (0104). Invoices are owned by the 0104
-- service user (aiag_agent_owner_user_v1()) with purpose='agent_topup' and
-- expected_sender NULL — the paying wallet is unknown at invoice time, and the
-- 0098 settle path already treats a NULL expected_sender as "any sender" while
-- keeping every other review reason (underpayment, mismatch, refund...) intact.
--
-- Idempotency needs NO new index: ton_invoices already carries the table-level
-- UNIQUE(owner_user_id,org_id,idempotency_key) (0072:37). Agent rows always
-- have owner_user_id = the service user and one principal per org
-- (agent_principals.org_id UNIQUE), so that constraint subsumes the requested
-- partial unique (owner,org,idempotency_key) WHERE purpose='agent_topup'
-- without touching any existing row.
BEGIN;

-- 1. Purpose widening. The only table-level constraint on purpose; web rows
-- keep 'gateway_topup' and revalidate unchanged.
ALTER TABLE ton_invoices DROP CONSTRAINT ton_invoices_purpose_check;
ALTER TABLE ton_invoices ADD CONSTRAINT ton_invoices_purpose_check
  CHECK (purpose IN ('gateway_topup','agent_topup'));

-- 2. Agent payload validator. Reuses the 0072 primitives (aiag_ton_keys_v1,
-- aiag_ton_text_v1, aiag_ton_time_v1, aiag_ton_atomic_v1, aiag_ton_asset_v1)
-- and the exact quote/FX arithmetic of aiag_ton_payload_v1; differs only where
-- the agent contract differs: no expectedSender key (strict key set rejects
-- it), purpose='agent_topup', min grant 100 credits = 100_000 micro, and the
-- USDT peg. IMMUTABLE and pure like its 0072 sibling (owner arrives as a
-- parameter; the service-user pinning lives in the create function).
CREATE FUNCTION aiag_agent_ton_payload_v1(_p JSONB,_actor UUID,_org UUID) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _q JSONB; _fx JSONB; _grant NUMERIC; _num NUMERIC; _den NUMERIC; _prod NUMERIC; _converted NUMERIC; _rem NUMERIC; _fee NUMERIC; _key TEXT;
BEGIN
 PERFORM aiag_ton_keys_v1(_p,ARRAY['schemaVersion','purpose','ownerId','orgId','idempotencyKey','grantMicrocredits','priceRevision','quote','recipient','finalityPolicyId','verifierVersion']);
 IF octet_length(_p::text)>16384 OR _p->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR _p->'purpose' IS DISTINCT FROM '"agent_topup"'::jsonb OR
    _p->>'ownerId' IS DISTINCT FROM _actor::text OR _p->>'orgId' IS DISTINCT FROM _org::text THEN RAISE EXCEPTION 'TON_INVALID_PAYLOAD'; END IF;
 PERFORM aiag_ton_text_v1(_p->'idempotencyKey','\A[A-Za-z0-9_-]{1,96}\Z',96);
 FOREACH _key IN ARRAY ARRAY['priceRevision','finalityPolicyId','verifierVersion'] LOOP
  PERFORM aiag_ton_text_v1(_p->_key,'\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 END LOOP;
 PERFORM aiag_ton_text_v1(_p->'recipient','\A(0|-1):[0-9a-f]{64}\Z',67);
 _grant:=aiag_ton_atomic_v1(_p->'grantMicrocredits');
 IF _grant<100000 THEN RAISE EXCEPTION 'AGENT_GRANT_TOO_SMALL'; END IF;
 _q:=_p->'quote';
 PERFORM aiag_ton_keys_v1(_q,ARRAY['schemaVersion','quoteId','sourcePrice','asset','fx','additionalFeeAtomic','expiresAtMs','amountAtomic','quotedAtMs']);
 IF octet_length(_q::text)>8192 OR _q->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_QUOTE'; END IF;
 PERFORM aiag_ton_text_v1(_q->'quoteId','\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 PERFORM aiag_ton_keys_v1(_q->'sourcePrice',ARRAY['unit','amountAtomic']);
 PERFORM aiag_ton_asset_v1(_q->'asset');
 _fx:=_q->'fx'; PERFORM aiag_ton_keys_v1(_fx,ARRAY['sourceUnit','targetAsset','numerator','denominator','rounding','source','observedAtMs','expiresAtMs']);
 PERFORM aiag_ton_asset_v1(_fx->'targetAsset');
 IF _q->'asset' IS DISTINCT FROM _fx->'targetAsset' OR _q->'sourcePrice'->'unit' IS DISTINCT FROM '"gateway_microcredits"'::jsonb OR
   _fx->'sourceUnit' IS DISTINCT FROM '"gateway_microcredits"'::jsonb OR _q->'sourcePrice'->'amountAtomic' IS DISTINCT FROM _p->'grantMicrocredits' THEN RAISE EXCEPTION 'TON_INVALID_GRANT_BINDING'; END IF;
 PERFORM aiag_ton_text_v1(_fx->'source','\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 _num:=aiag_ton_atomic_v1(_fx->'numerator'); _den:=aiag_ton_atomic_v1(_fx->'denominator'); _fee:=aiag_ton_atomic_v1(_q->'additionalFeeAtomic',TRUE);
 _prod:=_grant*_num; IF _prod>9223372036854775807 THEN RAISE EXCEPTION 'TON_FX_OVERFLOW'; END IF;
 _converted:=div(_prod,_den); _rem:=mod(_prod,_den);
 IF _fx->>'rounding'='ceil' THEN IF _rem>0 THEN _converted:=_converted+1; END IF;
 ELSIF _fx->>'rounding'='half-up' THEN IF _rem>=_den-_rem THEN _converted:=_converted+1; END IF;
 ELSIF _fx->>'rounding' IS DISTINCT FROM 'floor' THEN RAISE EXCEPTION 'TON_INVALID_ROUNDING'; END IF;
 IF _converted<=0 OR _converted+_fee>9223372036854775807 OR _converted+_fee<>aiag_ton_atomic_v1(_q->'amountAtomic') THEN RAISE EXCEPTION 'TON_QUOTE_MISMATCH'; END IF;
 -- USDT peg, oracle-free: 1 USDT = 100 credits = 100_000 micro and USDT has
 -- 6 decimals, so amount_atomic MUST equal grant_microcredits x 10 exactly
 -- (any additionalFeeAtomic is already forced to 0 by this equality). Master
 -- is the raw form of the TON mainnet USDT jetton master
 -- EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs; the allowlist seed is a
 -- later plan task, admission still runs through ton_asset_allowlist (0098).
 IF _q->'asset'->>'kind'='jetton' THEN
  IF _q->'asset'->>'network' IS DISTINCT FROM 'tvm:-1'
   OR _q->'asset'->>'masterAddress' IS DISTINCT FROM '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
   OR _q->'asset'->>'decimals' IS DISTINCT FROM '6' THEN RAISE EXCEPTION 'AGENT_ASSET_UNSUPPORTED'; END IF;
  IF aiag_ton_atomic_v1(_q->'amountAtomic') IS DISTINCT FROM _grant*10 THEN RAISE EXCEPTION 'AGENT_PEG_VIOLATION'; END IF;
 END IF;
 IF aiag_ton_time_v1(_q->'quotedAtMs')>=aiag_ton_time_v1(_q->'expiresAtMs') OR
  aiag_ton_time_v1(_fx->'observedAtMs')>aiag_ton_time_v1(_q->'quotedAtMs') OR
  aiag_ton_time_v1(_q->'expiresAtMs')>aiag_ton_time_v1(_fx->'expiresAtMs') THEN RAISE EXCEPTION 'TON_INVALID_TIME_ORDER'; END IF;
END $$;

-- 3. Create entrypoint. Authorization: _key_id -> live key (not revoked, not
-- disabled, not past expires_at per 0105) whose org has an active principal.
-- The org lock/refund/balance/quote-expiry/allowlist guards mirror
-- aiag_create_ton_invoice_v1 (0098 replacement) line for line; only owner,
-- purpose and expected_sender differ.
CREATE FUNCTION aiag_create_agent_ton_invoice_v1(_key_id UUID,_payload JSONB,_fingerprint TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _owner UUID; _org UUID; _o organizations; _i ton_invoices; _q JSONB; _grant BIGINT; _now TIMESTAMPTZ; _network TEXT;
BEGIN
 IF _key_id IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 SELECT k.org_id INTO _org FROM gateway_api_keys k JOIN agent_principals p ON p.org_id=k.org_id
  WHERE k.id=_key_id AND k.revoked_at IS NULL AND k.disabled_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND p.status='active';
 IF _org IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 _owner:=aiag_agent_owner_user_v1();
 IF _owner IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 PERFORM aiag_agent_ton_payload_v1(_payload,_owner,_org);
 IF _fingerprint IS NULL OR _fingerprint !~ '\A[0-9a-f]{64}\Z' THEN RAISE EXCEPTION 'TON_INVALID_FINGERPRINT'; END IF;
 SELECT * INTO _o FROM organizations WHERE id=_org AND owner_id=_owner FOR UPDATE;
 IF NOT FOUND OR NOT _o.is_active OR NOT EXISTS(SELECT 1 FROM users WHERE id=_owner AND is_active AND NOT is_banned) THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 SELECT * INTO _i FROM ton_invoices WHERE owner_user_id=_owner AND org_id=_org AND idempotency_key=_payload->>'idempotencyKey' AND purpose='agent_topup';
 IF FOUND THEN
  IF _i.request_fingerprint<>_fingerprint OR _i.request_payload<>_payload THEN RAISE EXCEPTION 'TON_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN aiag_ton_invoice_json_v1(_i);
 END IF;
 _grant:=(_payload->>'grantMicrocredits')::bigint; _q:=_payload->'quote'; _now:=clock_timestamp(); _network:=_q->'asset'->>'network';
 IF NOT EXISTS(SELECT 1 FROM ton_asset_allowlist a WHERE a.is_active AND a.network=_network
   AND a.asset_kind=_q->'asset'->>'kind'
   AND a.master_address IS NOT DISTINCT FROM (_q->'asset'->>'masterAddress')
   AND a.asset_decimals=(_q->'asset'->>'decimals')::smallint) THEN RAISE EXCEPTION 'TON_ASSET_NOT_ALLOWLISTED'; END IF;
 IF _o.refund_debt_credits>0 OR EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL) THEN RAISE EXCEPTION 'TON_REFUND_BLOCKED'; END IF;
 IF _grant>9007199254740991 OR _o.payg_credits<0 OR _o.payg_credits>9007199254740991-_grant THEN RAISE EXCEPTION 'TON_BALANCE_COMPATIBILITY_LIMIT'; END IF;
 IF (_q->>'quotedAtMs')::numeric>extract(epoch FROM _now)*1000 OR (_q->>'expiresAtMs')::numeric<=extract(epoch FROM _now)*1000 THEN RAISE EXCEPTION 'TON_QUOTE_EXPIRED'; END IF;
 INSERT INTO ton_invoices(owner_user_id,org_id,purpose,idempotency_key,request_fingerprint,request_payload,price_revision,grant_microcredits,source_price_unit,source_price_atomic,
 quote_id,quote_snapshot,network,asset_kind,master_address,asset_decimals,amount_atomic,recipient,expected_sender,finality_policy_id,verifier_version,quoted_at,expires_at)
 VALUES(_owner,_org,'agent_topup',_payload->>'idempotencyKey',_fingerprint,_payload,_payload->>'priceRevision',_grant,'gateway_microcredits',_grant,
 _q->>'quoteId',_q,_network,_q->'asset'->>'kind',_q->'asset'->>'masterAddress',(_q->'asset'->>'decimals')::smallint,(_q->>'amountAtomic')::bigint,
 _payload->>'recipient',NULL,_payload->>'finalityPolicyId',_payload->>'verifierVersion',
 to_timestamp((_q->>'quotedAtMs')::numeric/1000),to_timestamp((_q->>'expiresAtMs')::numeric/1000)) RETURNING * INTO _i;
 RETURN aiag_ton_invoice_json_v1(_i);
END $$;

-- 4. Read entrypoint: same key-aliveness predicate as create. Returns no row
-- for a foreign invoice or a key that lost its principal. VOLATILE on purpose:
-- key expiry is evaluated against clock_timestamp().
CREATE FUNCTION aiag_read_agent_ton_invoice_v1(_key_id UUID,_invoice UUID) RETURNS JSONB LANGUAGE SQL SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT aiag_ton_invoice_json_v1(i) FROM ton_invoices i
  JOIN agent_principals p ON p.org_id=i.org_id AND p.status='active' AND i.purpose='agent_topup'
  JOIN gateway_api_keys k ON k.org_id=p.org_id AND k.id=_key_id
   AND k.revoked_at IS NULL AND k.disabled_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
 WHERE i.id=_invoice
$$;

-- 5. Guard dispatch: agent rows validate against the agent contract, web rows
-- keep the exact 0072 behavior. Everything else in the guard is unchanged.
CREATE OR REPLACE FUNCTION aiag_ton_invoice_guard_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'TON_INVALID_TRANSITION'; END IF;
  IF NEW.purpose='agent_topup' THEN
   PERFORM aiag_agent_ton_payload_v1(NEW.request_payload,NEW.owner_user_id,NEW.org_id);
  ELSE
   PERFORM aiag_ton_payload_v1(NEW.request_payload,NEW.owner_user_id,NEW.org_id);
  END IF;
  IF NEW.quote_snapshot IS DISTINCT FROM NEW.request_payload->'quote' OR
   NEW.idempotency_key IS DISTINCT FROM NEW.request_payload->>'idempotencyKey' OR
   NEW.grant_microcredits::text IS DISTINCT FROM NEW.request_payload->>'grantMicrocredits' OR
   NEW.price_revision IS DISTINCT FROM NEW.request_payload->>'priceRevision' OR
   NEW.recipient IS DISTINCT FROM NEW.request_payload->>'recipient' OR
   NEW.expected_sender IS DISTINCT FROM NEW.request_payload->>'expectedSender' OR
   NEW.finality_policy_id IS DISTINCT FROM NEW.request_payload->>'finalityPolicyId' OR
   NEW.verifier_version IS DISTINCT FROM NEW.request_payload->>'verifierVersion' OR
   NEW.quote_id IS DISTINCT FROM NEW.quote_snapshot->>'quoteId' OR
   NEW.network IS DISTINCT FROM NEW.quote_snapshot->'asset'->>'network' OR
   NEW.asset_kind IS DISTINCT FROM NEW.quote_snapshot->'asset'->>'kind' OR
   NEW.master_address IS DISTINCT FROM NEW.quote_snapshot->'asset'->>'masterAddress' OR
   NEW.asset_decimals IS DISTINCT FROM (NEW.quote_snapshot->'asset'->>'decimals')::smallint OR
   NEW.amount_atomic::text IS DISTINCT FROM NEW.quote_snapshot->>'amountAtomic' OR
   NEW.quoted_at IS DISTINCT FROM to_timestamp((NEW.quote_snapshot->>'quotedAtMs')::numeric/1000) OR
   NEW.expires_at IS DISTINCT FROM to_timestamp((NEW.quote_snapshot->>'expiresAtMs')::numeric/1000) THEN
   RAISE EXCEPTION 'TON_SNAPSHOT_MISMATCH';
  END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','review_reason','settled_event_id','receipt_id','updated_at','settled_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','review_reason','settled_event_id','receipt_id','updated_at','settled_at']) THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 IF NEW.status=OLD.status THEN
  IF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 ELSIF NOT ((OLD.status='pending' AND NEW.status IN ('observed','expired','review_required')) OR
   (OLD.status='observed' AND NEW.status IN ('confirmed','review_required')) OR
   (OLD.status='confirmed' AND NEW.status='settled') OR (OLD.status='expired' AND NEW.status='review_required') OR
   (OLD.status='review_required' AND NEW.status IN ('confirmed','settled'))) THEN
  RAISE EXCEPTION 'TON_INVALID_TRANSITION';
 END IF;
 RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION aiag_agent_ton_payload_v1(jsonb,uuid,uuid),aiag_create_agent_ton_invoice_v1(uuid,jsonb,text),aiag_read_agent_ton_invoice_v1(uuid,uuid),aiag_ton_invoice_guard_v1() FROM PUBLIC;

COMMIT;
