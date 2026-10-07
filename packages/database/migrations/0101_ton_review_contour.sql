-- 0101: durable-but-re-evaluable review decisions + operator contour
-- (plan AG-TON-L task 4.1). Review decisions stay append-only and immutable,
-- but they are NOT terminal: a later settle re-evaluates the causes, so a
-- cleared refund block settles on the next worker sweep. An explicit operator
-- acknowledgement ('acknowledged_no_credit') IS terminal and never credits.
ALTER TABLE ton_invoice_event_decisions DROP CONSTRAINT ton_invoice_event_decisions_invoice_id_event_id_key;
ALTER TABLE ton_invoice_event_decisions ADD CONSTRAINT ton_invoice_event_decisions_invoice_event_decision_key UNIQUE (invoice_id,event_id,decision);
ALTER TABLE ton_invoice_event_decisions DROP CONSTRAINT ton_invoice_event_decisions_decision_check;
ALTER TABLE ton_invoice_event_decisions ADD CONSTRAINT ton_invoice_event_decisions_decision_check CHECK (decision IN ('settled','review_required','acknowledged_no_credit','retry_requested'));
ALTER TABLE ton_invoice_event_decisions DROP CONSTRAINT ton_invoice_event_decisions_check;
ALTER TABLE ton_invoice_event_decisions ADD CONSTRAINT ton_invoice_event_decisions_reason_check CHECK ((decision IN ('review_required','acknowledged_no_credit')) = (reason IS NOT NULL));

-- A re-evaluated review may legitimately settle: allow the guarded exit from
-- review_required into the confirmed→settled chain.
CREATE OR REPLACE FUNCTION aiag_ton_invoice_guard_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'TON_INVALID_TRANSITION'; END IF;
  PERFORM aiag_ton_payload_v1(NEW.request_payload,NEW.owner_user_id,NEW.org_id);
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
REVOKE EXECUTE ON FUNCTION aiag_ton_invoice_guard_v1() FROM PUBLIC;

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
 -- Only the LATEST decision binds: settled is terminal money-wise, an operator
 -- acknowledgement is terminal review-wise; plain review rows re-evaluate so
 -- a cleared temporary cause settles on the next attempt.
 SELECT * INTO _d FROM ton_invoice_event_decisions WHERE invoice_id=_invoice AND event_id=_event.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF FOUND THEN
  IF _d.decision='settled' THEN RETURN jsonb_build_object('kind','already_settled','receipt',aiag_ton_receipt_json_v1(_invoice)); END IF;
  IF _d.decision='acknowledged_no_credit' THEN
   RETURN jsonb_build_object('kind','review_required','invoiceId',_invoice::text,'eventId',_event.id::text,'reason',_d.reason);
  END IF;
 END IF;
 _grant:=_i.grant_microcredits; _amount:=(_credit->>'amountAtomic')::numeric;
 IF _i.status='settled' THEN _reason:='additional_transfer';
 ELSIF EXISTS(SELECT 1 FROM ton_invoice_event_decisions WHERE event_id=_event.id AND decision='settled' AND invoice_id<>_invoice) THEN _reason:='event_already_consumed';
 ELSIF _i.status='review_required' AND EXISTS(SELECT 1 FROM ton_invoice_event_decisions d WHERE d.invoice_id=_invoice AND d.decision='acknowledged_no_credit') THEN _reason:='invoice_in_review';
 ELSIF _i.status='expired' OR _now>=_i.expires_at OR (_credit->>'chainTimeMs')::numeric>=extract(epoch FROM _i.expires_at)*1000 THEN _reason:='late_payment';
 ELSIF _o.owner_id<>_i.owner_user_id THEN _reason:='owner_changed';
 ELSIF _network<>_i.network OR _credit->>'recipient'<>_i.recipient OR _credit->'asset'<>_i.quote_snapshot->'asset' OR _credit->>'reference'<>_i.reference OR
  (_i.expected_sender IS NOT NULL AND _credit->>'sender'<>_i.expected_sender) OR
  (_i.asset_kind='native' AND _credit->>'recipientAccount'<>_i.recipient) OR
  (_i.asset_kind='jetton' AND (_credit->'jettonCredit'->>'masterAddress' IS DISTINCT FROM _i.master_address OR
   _credit->'jettonCredit'->>'merchantJettonWallet' IS DISTINCT FROM _credit->>'recipientAccount')) THEN _reason:='payment_mismatch';
 ELSIF _credit->>'verifierVersion'<>_i.verifier_version OR _credit->>'finalityPolicyId'<>_i.finality_policy_id THEN _reason:='verification_policy_mismatch';
 ELSIF EXISTS(SELECT 1 FROM ton_invoice_event_decisions WHERE invoice_id=_invoice AND event_id<>_event.id AND decision IN ('settled','review_required')) THEN _reason:='multiple_transfers';
 ELSIF _amount<_i.amount_atomic THEN _reason:='underpayment';
 ELSIF _amount>_i.amount_atomic THEN _reason:='overpayment';
 ELSIF _o.refund_debt_credits>0 OR EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL) THEN _reason:='refund_blocked';
 ELSIF _o.payg_credits<0 THEN _reason:='balance_invariant';
 ELSIF _grant>9007199254740991 OR _o.payg_credits>9007199254740991-_grant THEN _reason:='balance_compatibility_limit';
 END IF;
 IF _reason IS NOT NULL THEN
  INSERT INTO ton_invoice_event_decisions(invoice_id,event_id,decision,reason) VALUES(_invoice,_event.id,'review_required',_reason)
   ON CONFLICT (invoice_id,event_id,decision) DO NOTHING;
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
 UPDATE ton_invoices SET status='confirmed',review_reason=NULL,updated_at=_now WHERE id=_invoice AND org_id=_org AND status IN ('observed','review_required') RETURNING id INTO _changed;
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
REVOKE EXECUTE ON FUNCTION aiag_settle_ton_invoice_v1(uuid,jsonb) FROM PUBLIC;
