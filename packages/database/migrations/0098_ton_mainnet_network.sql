-- 0098: TON mainnet network id + server-side asset allowlist (plan AG-TON-L task 1.2).
-- The three CHECK widenings below are the only non-purely-additive DDL of the
-- TON launch plan; they are replayed on the disposable native databases by
-- native-baseline / native-ton-core-test before any production apply.
ALTER TABLE ton_invoices DROP CONSTRAINT ton_invoices_network_check;
ALTER TABLE ton_invoices ADD CONSTRAINT ton_invoices_network_check CHECK (network IN ('tvm:-3','tvm:-1'));
ALTER TABLE ton_chain_events DROP CONSTRAINT ton_chain_events_network_check;
ALTER TABLE ton_chain_events ADD CONSTRAINT ton_chain_events_network_check CHECK (network IN ('tvm:-3','tvm:-1'));
ALTER TABLE ton_reconciliation_cursors DROP CONSTRAINT ton_reconciliation_cursors_network_check;
ALTER TABLE ton_reconciliation_cursors ADD CONSTRAINT ton_reconciliation_cursors_network_check CHECK (network IN ('tvm:-3','tvm:-1'));

-- Server-owned asset admission. The unique identity covers the native NULL
-- master via COALESCE (jetton masters can never be the empty string).
CREATE TABLE ton_asset_allowlist (
  network TEXT NOT NULL CHECK (network IN ('tvm:-3','tvm:-1')),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('native','jetton')),
  master_address VARCHAR(67) CHECK (master_address IS NULL OR master_address ~ '\A(0|-1):[0-9a-f]{64}\Z'),
  asset_decimals SMALLINT NOT NULL CHECK (asset_decimals BETWEEN 0 AND 18),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((asset_kind='native' AND master_address IS NULL AND asset_decimals=9)
    OR (asset_kind='jetton' AND master_address IS NOT NULL))
);
CREATE UNIQUE INDEX ton_asset_allowlist_asset_key ON ton_asset_allowlist (network, COALESCE(master_address,''));

INSERT INTO ton_asset_allowlist (network,asset_kind,master_address,asset_decimals) VALUES
 ('tvm:-3','native',NULL,9),
 ('tvm:-1','native',NULL,9);

-- READ-only admission source for TonServerPolicy consumers.
CREATE FUNCTION aiag_ton_allowlisted_assets_v1(_network TEXT) RETURNS TABLE(network TEXT,asset_kind TEXT,master_address VARCHAR,asset_decimals SMALLINT) LANGUAGE SQL STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT a.network,a.asset_kind,a.master_address,a.asset_decimals FROM ton_asset_allowlist a WHERE a.is_active AND a.network=_network ORDER BY a.asset_kind,a.master_address NULLS FIRST
$$;
REVOKE ALL ON ton_asset_allowlist FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_ton_allowlisted_assets_v1(text) FROM PUBLIC;

-- Network-aware replacements of the 0072 invoice-core functions. The mirror in
-- src/functions/ton-invoice-core.sql carries these exact bodies.
CREATE OR REPLACE FUNCTION aiag_ton_asset_v1(_j JSONB) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF _j->>'kind'='native' THEN
  PERFORM aiag_ton_keys_v1(_j,ARRAY['network','kind','decimals']);
  IF _j->'decimals' IS DISTINCT FROM '9'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_ASSET'; END IF;
 ELSIF _j->>'kind'='jetton' THEN
  PERFORM aiag_ton_keys_v1(_j,ARRAY['network','kind','decimals','masterAddress']);
  PERFORM aiag_ton_text_v1(_j->'masterAddress','\A(0|-1):[0-9a-f]{64}\Z',67);
  IF aiag_ton_time_v1(_j->'decimals')>18 THEN RAISE EXCEPTION 'TON_INVALID_ASSET'; END IF;
 ELSE RAISE EXCEPTION 'TON_INVALID_ASSET'; END IF;
 IF _j->>'network' NOT IN ('tvm:-3','tvm:-1') THEN RAISE EXCEPTION 'TON_INVALID_NETWORK'; END IF;
END $$;

CREATE OR REPLACE FUNCTION aiag_create_ton_invoice_v1(_actor UUID,_org UUID,_payload JSONB,_fingerprint TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _o organizations; _i ton_invoices; _q JSONB; _grant BIGINT; _now TIMESTAMPTZ; _network TEXT;
BEGIN
 PERFORM aiag_ton_payload_v1(_payload,_actor,_org);
 IF _fingerprint IS NULL OR _fingerprint !~ '\A[0-9a-f]{64}\Z' THEN RAISE EXCEPTION 'TON_INVALID_FINGERPRINT'; END IF;
 SELECT * INTO _o FROM organizations WHERE id=_org AND owner_id=_actor FOR UPDATE;
 IF NOT FOUND OR NOT _o.is_active OR NOT EXISTS(SELECT 1 FROM users WHERE id=_actor AND is_active AND NOT is_banned) THEN RAISE EXCEPTION 'TON_NOT_AUTHORIZED'; END IF;
 SELECT * INTO _i FROM ton_invoices WHERE owner_user_id=_actor AND org_id=_org AND idempotency_key=_payload->>'idempotencyKey';
 IF FOUND THEN
  IF _i.request_fingerprint<>_fingerprint OR _i.request_payload<>_payload THEN RAISE EXCEPTION 'TON_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN aiag_ton_invoice_json_v1(_i);
 END IF;
 _grant:=(_payload->>'grantMicrocredits')::bigint; _q:=_payload->'quote'; _now:=clock_timestamp();
 _network:=_q->'asset'->>'network';
 IF NOT EXISTS(SELECT 1 FROM ton_asset_allowlist a WHERE a.is_active AND a.network=_network
   AND a.asset_kind=_q->'asset'->>'kind'
   AND a.master_address IS NOT DISTINCT FROM (_q->'asset'->>'masterAddress')
   AND a.asset_decimals=(_q->'asset'->>'decimals')::smallint) THEN RAISE EXCEPTION 'TON_ASSET_NOT_ALLOWLISTED'; END IF;
 IF _o.refund_debt_credits>0 OR EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL) THEN RAISE EXCEPTION 'TON_REFUND_BLOCKED'; END IF;
 IF _grant>9007199254740991 OR _o.payg_credits<0 OR _o.payg_credits>9007199254740991-_grant THEN RAISE EXCEPTION 'TON_BALANCE_COMPATIBILITY_LIMIT'; END IF;
 IF (_q->>'quotedAtMs')::numeric>extract(epoch FROM _now)*1000 OR (_q->>'expiresAtMs')::numeric<=extract(epoch FROM _now)*1000 THEN RAISE EXCEPTION 'TON_QUOTE_EXPIRED'; END IF;
 INSERT INTO ton_invoices(owner_user_id,org_id,purpose,idempotency_key,request_fingerprint,request_payload,price_revision,grant_microcredits,source_price_unit,source_price_atomic,
 quote_id,quote_snapshot,network,asset_kind,master_address,asset_decimals,amount_atomic,recipient,expected_sender,finality_policy_id,verifier_version,quoted_at,expires_at)
 VALUES(_actor,_org,'gateway_topup',_payload->>'idempotencyKey',_fingerprint,_payload,_payload->>'priceRevision',_grant,'gateway_microcredits',_grant,
 _q->>'quoteId',_q,_network,_q->'asset'->>'kind',_q->'asset'->>'masterAddress',(_q->'asset'->>'decimals')::smallint,(_q->>'amountAtomic')::bigint,
 _payload->>'recipient',_payload->>'expectedSender',_payload->>'finalityPolicyId',_payload->>'verifierVersion',
 to_timestamp((_q->>'quotedAtMs')::numeric/1000),to_timestamp((_q->>'expiresAtMs')::numeric/1000)) RETURNING * INTO _i;
 RETURN aiag_ton_invoice_json_v1(_i);
END $$;

CREATE OR REPLACE FUNCTION aiag_ton_credit_v1(_c JSONB) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _key TEXT;
BEGIN
 PERFORM aiag_ton_keys_v1(_c,ARRAY['network','asset','recipient','recipientAccount','sender','amountAtomic','reference','txHash','txLt','messageHash','messageIndex','chainTimeMs','observedAtMs','verifiedAtMs','blockAnchor','masterchainAnchor','executionPathDigest','verifierVersion','finalityPolicyId','jettonCredit']);
 IF _c->>'network' NOT IN ('tvm:-3','tvm:-1') THEN RAISE EXCEPTION 'TON_INVALID_NETWORK'; END IF;
 PERFORM aiag_ton_asset_v1(_c->'asset');
 FOREACH _key IN ARRAY ARRAY['recipient','recipientAccount','sender'] LOOP
  PERFORM aiag_ton_text_v1(_c->_key,'\A(0|-1):[0-9a-f]{64}\Z',67);
 END LOOP;
 FOREACH _key IN ARRAY ARRAY['txHash','messageHash','executionPathDigest'] LOOP
  PERFORM aiag_ton_text_v1(_c->_key,'\A[0-9a-f]{64}\Z',64);
 END LOOP;
 FOREACH _key IN ARRAY ARRAY['reference','blockAnchor','masterchainAnchor','verifierVersion','finalityPolicyId'] LOOP
  PERFORM aiag_ton_text_v1(_c->_key,'\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 END LOOP;
 PERFORM aiag_ton_atomic_v1(_c->'amountAtomic',FALSE,TRUE); PERFORM aiag_ton_atomic_v1(_c->'txLt',TRUE,TRUE);
 IF aiag_ton_time_v1(_c->'messageIndex')>2147483647 THEN RAISE EXCEPTION 'TON_INVALID_INDEX'; END IF;
 IF aiag_ton_time_v1(_c->'chainTimeMs')>aiag_ton_time_v1(_c->'observedAtMs') OR
    aiag_ton_time_v1(_c->'observedAtMs')>aiag_ton_time_v1(_c->'verifiedAtMs') THEN RAISE EXCEPTION 'TON_INVALID_TIME_ORDER'; END IF;
 IF _c->'asset'->>'kind'='native' THEN
  IF _c->'jettonCredit'<>'null'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_JETTON'; END IF;
 ELSE
  PERFORM aiag_ton_keys_v1(_c->'jettonCredit',ARRAY['masterAddress','merchantJettonWallet']);
  PERFORM aiag_ton_text_v1(_c->'jettonCredit'->'masterAddress','\A(0|-1):[0-9a-f]{64}\Z',67);
  PERFORM aiag_ton_text_v1(_c->'jettonCredit'->'merchantJettonWallet','\A(0|-1):[0-9a-f]{64}\Z',67);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION aiag_settle_ton_invoice_v1(_invoice UUID,_credit JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _org UUID; _o organizations; _i ton_invoices; _event ton_chain_events; _d ton_invoice_event_decisions;
 _facts JSONB; _evidence JSONB; _reason TEXT; _now TIMESTAMPTZ; _grant BIGINT; _receipt UUID; _changed UUID; _payg TEXT; _debt TEXT; _amount NUMERIC; _network TEXT;
BEGIN
 PERFORM aiag_ton_credit_v1(_credit);
 IF (_credit->>'verifiedAtMs')::numeric>extract(epoch FROM clock_timestamp())*1000 THEN RAISE EXCEPTION 'TON_INVALID_TIME_ORDER'; END IF;
 SELECT org_id INTO _org FROM ton_invoices WHERE id=_invoice;
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','not_found'); END IF;
 SELECT * INTO _o FROM organizations WHERE id=_org FOR UPDATE;
 SELECT * INTO _i FROM ton_invoices WHERE id=_invoice AND org_id=_org FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','not_found'); END IF;
 _now:=clock_timestamp(); _network:=_credit->>'network';
 _facts:=_credit-ARRAY['observedAtMs','verifiedAtMs','blockAnchor','masterchainAnchor','executionPathDigest','verifierVersion','finalityPolicyId'];
 _evidence:=_credit-ARRAY['amountAtomic','reference','sender','txHash','txLt','messageHash','messageIndex','chainTimeMs','observedAtMs','verifiedAtMs'];
 INSERT INTO ton_chain_events(network,recipient_account,tx_hash,message_hash,tx_lt,message_index,fact_snapshot,evidence_snapshot,observed_at,verified_at)
 VALUES(_network,_credit->>'recipientAccount',_credit->>'txHash',_credit->>'messageHash',_credit->>'txLt',(_credit->>'messageIndex')::integer,
 _facts,_evidence,to_timestamp((_credit->>'observedAtMs')::numeric/1000),to_timestamp((_credit->>'verifiedAtMs')::numeric/1000))
 ON CONFLICT(network,recipient_account,tx_hash,message_hash) DO NOTHING;
 SELECT * INTO _event FROM ton_chain_events WHERE network=_network AND recipient_account=_credit->>'recipientAccount' AND tx_hash=_credit->>'txHash' AND message_hash=_credit->>'messageHash' FOR UPDATE;
 IF _event.id IS NULL THEN RAISE EXCEPTION 'TON_EVENT_CAS'; END IF;
 IF _event.fact_snapshot<>_facts THEN RETURN jsonb_build_object('kind','evidence_conflict','eventId',_event.id::text); END IF;
 SELECT * INTO _d FROM ton_invoice_event_decisions WHERE invoice_id=_invoice AND event_id=_event.id;
 IF FOUND THEN
  IF _d.decision='settled' THEN RETURN jsonb_build_object('kind','already_settled','receipt',aiag_ton_receipt_json_v1(_invoice)); END IF;
  RETURN jsonb_build_object('kind','review_required','invoiceId',_invoice::text,'eventId',_event.id::text,'reason',_d.reason);
 END IF;
 _grant:=_i.grant_microcredits; _amount:=(_credit->>'amountAtomic')::numeric;
 IF _i.status='settled' THEN _reason:='additional_transfer';
 ELSIF EXISTS(SELECT 1 FROM ton_invoice_event_decisions WHERE event_id=_event.id AND decision='settled' AND invoice_id<>_invoice) THEN _reason:='event_already_consumed';
 ELSIF _i.status='review_required' THEN _reason:='invoice_in_review';
 ELSIF _i.status='expired' OR _now>=_i.expires_at OR (_credit->>'chainTimeMs')::numeric>=extract(epoch FROM _i.expires_at)*1000 THEN _reason:='late_payment';
 ELSIF _o.owner_id<>_i.owner_user_id THEN _reason:='owner_changed';
 ELSIF _network<>_i.network OR _credit->>'recipient'<>_i.recipient OR _credit->'asset'<>_i.quote_snapshot->'asset' OR _credit->>'reference'<>_i.reference OR
  (_i.expected_sender IS NOT NULL AND _credit->>'sender'<>_i.expected_sender) OR
  (_i.asset_kind='native' AND _credit->>'recipientAccount'<>_i.recipient) OR
  (_i.asset_kind='jetton' AND (_credit->'jettonCredit'->>'masterAddress' IS DISTINCT FROM _i.master_address OR
   _credit->'jettonCredit'->>'merchantJettonWallet' IS DISTINCT FROM _credit->>'recipientAccount')) THEN _reason:='payment_mismatch';
 ELSIF _credit->>'verifierVersion'<>_i.verifier_version OR _credit->>'finalityPolicyId'<>_i.finality_policy_id THEN _reason:='verification_policy_mismatch';
 ELSIF EXISTS(SELECT 1 FROM ton_invoice_event_decisions WHERE invoice_id=_invoice AND event_id<>_event.id) THEN _reason:='multiple_transfers';
 ELSIF _amount<_i.amount_atomic THEN _reason:='underpayment';
 ELSIF _amount>_i.amount_atomic THEN _reason:='overpayment';
 ELSIF _o.refund_debt_credits>0 OR EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL) THEN _reason:='refund_blocked';
 ELSIF _o.payg_credits<0 THEN _reason:='balance_invariant';
 ELSIF _grant>9007199254740991 OR _o.payg_credits>9007199254740991-_grant THEN _reason:='balance_compatibility_limit';
 END IF;
 IF _reason IS NOT NULL THEN
  INSERT INTO ton_invoice_event_decisions(invoice_id,event_id,decision,reason) VALUES(_invoice,_event.id,'review_required',_reason);
  IF _i.status NOT IN ('settled','review_required') THEN
   UPDATE ton_invoices SET status='review_required',review_reason=_reason,updated_at=_now WHERE id=_invoice AND org_id=_org AND status IN ('pending','observed','expired') RETURNING id INTO _changed;
   IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
  END IF;
  RETURN jsonb_build_object('kind','review_required','invoiceId',_invoice::text,'eventId',_event.id::text,'reason',_reason);
 END IF;
 IF _i.status='pending' THEN
  UPDATE ton_invoices SET status='observed',updated_at=_now WHERE id=_invoice AND org_id=_org AND status='pending' RETURNING id INTO _changed;
  IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
 END IF;
 UPDATE ton_invoices SET status='confirmed',updated_at=_now WHERE id=_invoice AND org_id=_org AND status='observed' RETURNING id INTO _changed;
 IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
 UPDATE organizations SET payg_credits=payg_credits+_grant,updated_at=_now
 WHERE id=_org AND owner_id=_i.owner_user_id AND payg_credits>=0 AND refund_debt_credits=0
  AND _grant BETWEEN 1 AND 9007199254740991::bigint AND payg_credits<=9007199254740991::bigint-_grant
  AND NOT EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL)
 RETURNING payg_credits::text,refund_debt_credits::text INTO _payg,_debt;
 IF NOT FOUND THEN RAISE EXCEPTION 'TON_BALANCE_CAS'; END IF;
 INSERT INTO gateway_transactions(org_id,request_id,type,source,delta,metadata)
 VALUES(_org,'ton:invoice:'||_invoice::text,'topup','ton',_grant,jsonb_build_object('schema_version',1,'invoice_id',_invoice::text,
 'order_id',_i.order_id::text,'event_id',_event.id::text,'owner_user_id',_i.owner_user_id::text,'grant_microcredits',_grant::text,
 'amount_atomic',_i.amount_atomic::text,'asset',_i.quote_snapshot->'asset','network',_i.network,'price_revision',_i.price_revision,
 'quote_id',_i.quote_id,'payg_after_microcredits',_payg,'refund_debt_after_microcredits',_debt,'settled_at',_now)) RETURNING id INTO _receipt;
 IF _receipt IS NULL THEN RAISE EXCEPTION 'TON_RECEIPT_CAS'; END IF;
 INSERT INTO ton_invoice_event_decisions(invoice_id,event_id,decision) VALUES(_invoice,_event.id,'settled');
 UPDATE ton_invoices SET status='settled',settled_event_id=_event.id,receipt_id=_receipt,settled_at=_now,updated_at=_now
 WHERE id=_invoice AND org_id=_org AND owner_user_id=_i.owner_user_id AND status='confirmed' AND settled_event_id IS NULL AND receipt_id IS NULL RETURNING id INTO _changed;
 IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
 RETURN jsonb_build_object('kind','settled','receipt',aiag_ton_receipt_json_v1(_invoice));
END $$;
REVOKE EXECUTE ON FUNCTION aiag_ton_asset_v1(jsonb),aiag_create_ton_invoice_v1(uuid,uuid,jsonb,text),aiag_ton_credit_v1(jsonb),aiag_settle_ton_invoice_v1(uuid,jsonb) FROM PUBLIC;
