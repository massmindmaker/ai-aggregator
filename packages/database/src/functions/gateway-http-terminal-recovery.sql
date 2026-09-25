-- Fixed versioned rejection DTOs. No caller-supplied error text or financial receipt.
CREATE OR REPLACE FUNCTION aiag_http_rejection_status_v1(_code TEXT)
RETURNS SMALLINT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 CASE _code
 WHEN 'PAYMENT_REQUIRED', 'REFUND_BLOCKED' THEN RETURN 402;
 WHEN 'QUOTA_EXCEEDED' THEN RETURN 429;
 WHEN 'ADMISSION_DEADLINE_EXPIRED', 'REQUEST_NOT_STARTED' THEN RETURN 409;
 WHEN 'SESSION_REQUIRED' THEN RETURN 400;
 ELSE RAISE EXCEPTION 'INVALID_HTTP_REJECTION' USING ERRCODE='P0001';
 END CASE;
END $$;

CREATE OR REPLACE FUNCTION aiag_http_rejection_body_v1(_code TEXT)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _message TEXT; _type TEXT;
BEGIN
 PERFORM aiag_http_rejection_status_v1(_code);
 _message:=CASE _code
 WHEN 'PAYMENT_REQUIRED' THEN 'Payment required'
 WHEN 'QUOTA_EXCEEDED' THEN 'Spending quota exceeded'
 WHEN 'ADMISSION_DEADLINE_EXPIRED' THEN 'Admission deadline expired'
 WHEN 'SESSION_REQUIRED' THEN 'Session identifier required'
 WHEN 'REFUND_BLOCKED' THEN 'Billing admission blocked'
 WHEN 'REQUEST_NOT_STARTED' THEN 'Request not started' END;
 _type:=CASE WHEN _code IN('PAYMENT_REQUIRED','QUOTA_EXCEEDED','REFUND_BLOCKED') THEN 'billing_error' ELSE 'request_error' END;
 RETURN jsonb_build_object('error',jsonb_build_object('code',_code,'message',_message,'type',_type));
END $$;

-- Table and composite types precede the remaining functions in migration0070.
CREATE OR REPLACE FUNCTION aiag_http_rejection_result_v1(_r gateway_http_rejections,_transition BOOLEAN)
RETURNS gateway_http_admit_result_v1 LANGUAGE sql IMMUTABLE AS $$
 SELECT _r.org_id,_r.api_key_id,_r.billing_request_id,'rejected'::text,NULL::gateway_charge_admission_result,
 _r.rejection_code,_r.http_status,_r.response_body,_r.terminal_at,_transition;
$$;

CREATE OR REPLACE FUNCTION aiag_admit_gateway_http_charge_v1(
 _org_id UUID,_billing_request_id UUID,_api_key_id UUID,_client_request_id VARCHAR,_route_kind VARCHAR,_billing_mode VARCHAR,
 _model_slug VARCHAR,_authorized_max_credits BIGINT,_quote_snapshot JSONB,_pre_dispatch_deadline_at TIMESTAMPTZ,
 _declared_session_id VARCHAR,_supplier_quote_snapshot JSONB,_idempotency_key_digest TEXT,_request_fingerprint TEXT,_contract_version SMALLINT
) RETURNS SETOF gateway_http_admit_result_v1 LANGUAGE plpgsql VOLATILE AS $$
DECLARE _r gateway_http_requests%ROWTYPE; _negative gateway_http_rejections%ROWTYPE;
 _admission gateway_charge_admission_result; _out gateway_http_admit_result_v1;
 _state TEXT; _message TEXT; _reason TEXT;
BEGIN
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,_route_kind,_billing_mode,_idempotency_key_digest,_request_fingerprint,_contract_version);
 IF _billing_request_id IS NULL THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text,0));
 PERFORM 1 FROM gateway_charge_admissions WHERE billing_request_id=_billing_request_id FOR UPDATE;
 -- No request row lock before admission's policy/key locks. Org serializes all supported writers.
 SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_billing_request_id;
 IF _r.org_id IS DISTINCT FROM _org_id OR _r.api_key_id IS DISTINCT FROM _api_key_id
 OR _r.route_kind IS DISTINCT FROM _route_kind OR _r.billing_mode IS DISTINCT FROM _billing_mode
 OR _r.contract_version IS DISTINCT FROM _contract_version OR _r.idempotency_key_digest IS DISTINCT FROM _idempotency_key_digest
 OR _r.request_fingerprint IS DISTINCT FROM _request_fingerprint THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 SELECT * INTO _negative FROM gateway_http_rejections WHERE billing_request_id=_billing_request_id;
 IF FOUND THEN
  IF _negative.org_id IS DISTINCT FROM _org_id OR _negative.api_key_id IS DISTINCT FROM _api_key_id
  OR EXISTS(SELECT 1 FROM gateway_charge_admissions WHERE billing_request_id=_billing_request_id)
  OR EXISTS(SELECT 1 FROM gateway_http_results WHERE billing_request_id=_billing_request_id) THEN
   RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
  PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);
  PERFORM 1 FROM gateway_http_requests WHERE billing_request_id=_billing_request_id FOR UPDATE;
  PERFORM 1 FROM gateway_http_rejections WHERE billing_request_id=_billing_request_id FOR UPDATE;
  RETURN NEXT aiag_http_rejection_result_v1(_negative,FALSE); RETURN;
 END IF;
 BEGIN
  SELECT * INTO STRICT _admission FROM aiag_admit_gateway_charge_v2(
   _org_id,_billing_request_id,_api_key_id,_client_request_id,_route_kind,_billing_mode,_model_slug,
   _authorized_max_credits,_quote_snapshot,_pre_dispatch_deadline_at,_declared_session_id,_supplier_quote_snapshot);
 EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE 'P0003' OR SQLSTATE 'P0005' THEN
  GET STACKED DIAGNOSTICS _state=RETURNED_SQLSTATE,_message=MESSAGE_TEXT;
  _reason:=CASE
   WHEN _state='P0003' AND _message='INSUFFICIENT_FUNDS' THEN 'PAYMENT_REQUIRED'
   WHEN _state='P0003' AND _message='QUOTA_EXCEEDED' THEN 'QUOTA_EXCEEDED'
   WHEN _state='P0001' AND _message='ADMISSION_DEADLINE_EXPIRED' THEN 'ADMISSION_DEADLINE_EXPIRED'
   WHEN _state='P0001' AND _message='QUOTA_SESSION_REQUIRED' THEN 'SESSION_REQUIRED'
   WHEN _state='P0005' AND _message='REFUND_BLOCKED' THEN 'REFUND_BLOCKED' END;
  IF _reason IS NULL THEN RAISE; END IF;
 END;
 -- This check is outside the catch. Active key is mandatory even on existing-admission replay.
 PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);
 PERFORM 1 FROM gateway_http_requests WHERE billing_request_id=_billing_request_id FOR UPDATE;
 IF _reason IS NULL THEN
  _out.org_id:=_r.org_id; _out.api_key_id:=_r.api_key_id; _out.billing_request_id:=_r.billing_request_id;
  _out.status:='admitted'; _out.admission:=_admission; _out.did_transition:=_admission.did_transition;
  RETURN NEXT _out; RETURN;
 END IF;
 -- The nested block rolled back every hold/quota mutation; outer org/billing locks survive it.
 PERFORM 1 FROM gateway_http_rejections WHERE billing_request_id=_billing_request_id FOR UPDATE;
 IF FOUND OR EXISTS(SELECT 1 FROM gateway_charge_admissions WHERE billing_request_id=_billing_request_id)
 OR EXISTS(SELECT 1 FROM gateway_http_results WHERE billing_request_id=_billing_request_id) THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 INSERT INTO gateway_http_rejections(billing_request_id,org_id,api_key_id,result_version,rejection_code,http_status,content_type,response_body,terminal_at)
 VALUES(_billing_request_id,_org_id,_api_key_id,1,_reason,aiag_http_rejection_status_v1(_reason),'application/json',aiag_http_rejection_body_v1(_reason),clock_timestamp())
 RETURNING * INTO _negative;
 RETURN NEXT aiag_http_rejection_result_v1(_negative,TRUE);
END $$;

-- Only for a synchronously known abort before the first admit invocation; never recovery/timeout.
CREATE OR REPLACE FUNCTION aiag_reject_unstarted_gateway_http_request_v1(
 _org_id UUID,_api_key_id UUID,_billing_request_id UUID,_route_kind VARCHAR,_billing_mode VARCHAR,
 _idempotency_key_digest TEXT,_request_fingerprint TEXT,_contract_version SMALLINT
) RETURNS SETOF gateway_http_admit_result_v1 LANGUAGE plpgsql VOLATILE AS $$
DECLARE _r gateway_http_requests%ROWTYPE; _negative gateway_http_rejections%ROWTYPE;
BEGIN
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,_route_kind,_billing_mode,_idempotency_key_digest,_request_fingerprint,_contract_version);
 IF _billing_request_id IS NULL THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text,0));
 PERFORM 1 FROM gateway_charge_admissions WHERE billing_request_id=_billing_request_id FOR UPDATE;
 IF FOUND THEN RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);
 SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_billing_request_id FOR UPDATE;
 IF _r.org_id IS DISTINCT FROM _org_id OR _r.api_key_id IS DISTINCT FROM _api_key_id
 OR _r.route_kind IS DISTINCT FROM _route_kind OR _r.billing_mode IS DISTINCT FROM _billing_mode
 OR _r.contract_version IS DISTINCT FROM _contract_version OR _r.idempotency_key_digest IS DISTINCT FROM _idempotency_key_digest
 OR _r.request_fingerprint IS DISTINCT FROM _request_fingerprint THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 IF EXISTS(SELECT 1 FROM gateway_http_results WHERE billing_request_id=_billing_request_id) THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 SELECT * INTO _negative FROM gateway_http_rejections WHERE billing_request_id=_billing_request_id FOR UPDATE;
 IF FOUND THEN
  IF _negative.org_id IS DISTINCT FROM _org_id OR _negative.api_key_id IS DISTINCT FROM _api_key_id THEN
   RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
  RETURN NEXT aiag_http_rejection_result_v1(_negative,FALSE); RETURN;
 END IF;
 INSERT INTO gateway_http_rejections(billing_request_id,org_id,api_key_id,result_version,rejection_code,http_status,content_type,response_body,terminal_at)
 VALUES(_billing_request_id,_org_id,_api_key_id,1,'REQUEST_NOT_STARTED',409,'application/json',aiag_http_rejection_body_v1('REQUEST_NOT_STARTED'),clock_timestamp())
 RETURNING * INTO _negative;
 RETURN NEXT aiag_http_rejection_result_v1(_negative,TRUE);
END $$;

CREATE OR REPLACE FUNCTION aiag_read_gateway_http_result_v2(
 _org_id UUID,_api_key_id UUID,_route_kind VARCHAR,_billing_mode VARCHAR,
 _idempotency_key_digest TEXT,_request_fingerprint TEXT,_contract_version SMALLINT
) RETURNS SETOF gateway_http_read_result_v2 LANGUAGE plpgsql VOLATILE AS $$
DECLARE _id UUID; _r gateway_http_requests%ROWTYPE; _negative gateway_http_rejections%ROWTYPE;
 _out gateway_http_read_result_v2;
BEGIN
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,_route_kind,_billing_mode,_idempotency_key_digest,_request_fingerprint,_contract_version);
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 SELECT billing_request_id INTO _id FROM gateway_http_requests WHERE org_id=_org_id AND api_key_id=_api_key_id
 AND route_kind=_route_kind AND billing_mode=_billing_mode AND idempotency_key_digest=_idempotency_key_digest;
 IF _id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(_id::text,0));
  PERFORM 1 FROM gateway_charge_admissions WHERE billing_request_id=_id FOR UPDATE;
 END IF;
 PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);
 IF _id IS NOT NULL THEN
  SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_id FOR UPDATE;
  IF _r.org_id IS DISTINCT FROM _org_id OR _r.api_key_id IS DISTINCT FROM _api_key_id
  OR _r.request_fingerprint IS DISTINCT FROM _request_fingerprint OR _r.contract_version IS DISTINCT FROM _contract_version THEN
   RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
  SELECT * INTO _negative FROM gateway_http_rejections WHERE billing_request_id=_id FOR UPDATE;
  IF FOUND THEN
   IF _negative.org_id IS DISTINCT FROM _org_id OR _negative.api_key_id IS DISTINCT FROM _api_key_id
   OR EXISTS(SELECT 1 FROM gateway_charge_admissions WHERE billing_request_id=_id)
   OR EXISTS(SELECT 1 FROM gateway_http_results WHERE billing_request_id=_id) THEN
    RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
   _out.contract_version:=_contract_version; _out.status:='rejected'; _out.billing_request_id:=_id;
   _out.http_status:=_negative.http_status; _out.content_type:=_negative.content_type; _out.response_body:=_negative.response_body;
   _out.stored_at:=_negative.terminal_at; _out.rejection_code:=_negative.rejection_code;
   RETURN NEXT _out; RETURN;
  END IF;
 END IF;
 RETURN QUERY SELECT v.*,NULL::text FROM aiag_read_gateway_http_result_v1(
  _org_id,_api_key_id,_route_kind,_billing_mode,_idempotency_key_digest,_request_fingerprint,_contract_version) v;
END $$;

-- Internal accounting operation: revoked keys still own their previously dispatched obligations.
CREATE OR REPLACE FUNCTION aiag_recover_gateway_http_settlement_v1(_org_id UUID,_api_key_id UUID,_billing_request_id UUID)
RETURNS SETOF gateway_charge_admission_result LANGUAGE plpgsql VOLATILE AS $$
DECLARE _a gateway_charge_admissions%ROWTYPE; _r gateway_http_requests%ROWTYPE;
 _result gateway_http_results%ROWTYPE; _q gateway_charge_quota_contexts%ROWTYPE;
BEGIN
 IF _org_id IS NULL OR _api_key_id IS NULL OR _billing_request_id IS NULL THEN
  RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text,0));
 SELECT * INTO _a FROM gateway_charge_admissions WHERE billing_request_id=_billing_request_id FOR UPDATE;
 PERFORM aiag_http_require_key(_org_id,_api_key_id,FALSE);
 IF _a.org_id IS DISTINCT FROM _org_id OR _a.api_key_id IS DISTINCT FROM _api_key_id THEN
  RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_billing_request_id FOR UPDATE;
 SELECT * INTO _result FROM gateway_http_results WHERE billing_request_id=_billing_request_id FOR UPDATE;
 PERFORM 1 FROM gateway_http_rejections WHERE billing_request_id=_billing_request_id FOR UPDATE;
 IF FOUND OR _r.org_id IS DISTINCT FROM _org_id OR _r.api_key_id IS DISTINCT FROM _api_key_id
 OR _r.route_kind NOT IN('chat','embeddings','completions') OR _r.billing_mode IS DISTINCT FROM 'stored'
 OR _r.contract_version NOT IN(1,2) OR (_r.contract_version=2 AND _r.route_kind IS DISTINCT FROM 'chat')
 OR _a.route_kind IS DISTINCT FROM _r.route_kind OR _a.billing_mode IS DISTINCT FROM 'stored'
 OR _a.state NOT IN('outcome_recorded','settled') OR _a.outcome_kind IS DISTINCT FROM 'success'
 OR _a.attempt_id IS NULL OR _a.upstream_id IS NULL OR _a.pricing_snapshot IS NULL OR _a.usage_snapshot IS NULL
 OR _a.actual_cost_credits IS NULL OR _a.actual_cost_credits<0 OR _a.actual_cost_credits>_a.authorized_max_credits
 OR _result.org_id IS DISTINCT FROM _org_id OR _result.api_key_id IS DISTINCT FROM _api_key_id
 OR _result.contract_version IS DISTINCT FROM _r.contract_version OR _result.http_status IS DISTINCT FROM 200
 OR _result.content_type IS DISTINCT FROM (CASE WHEN _r.contract_version=2 THEN 'text/event-stream' ELSE 'application/json' END)
 THEN RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 SELECT * INTO _q FROM gateway_charge_quota_contexts WHERE billing_request_id=_billing_request_id;
 IF _q.org_id IS DISTINCT FROM _org_id OR _q.api_key_id IS DISTINCT FROM _api_key_id OR _q.quota_version IS DISTINCT FROM 2
 OR _q.supplier_actual_usd_micro IS NULL OR _q.supplier_usage_snapshot IS DISTINCT FROM _a.usage_snapshot
 OR _q.supplier_actual_usd_micro>_q.supplier_authorized_max_usd_micro THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 -- Only frozen-evidence validation is translated. Settlement/transport errors remain untouched.
 BEGIN
  IF _q.supplier_actual_usd_micro IS DISTINCT FROM aiag_quota_supplier_actual(_a,_a.actual_cost_credits,_a.usage_snapshot) THEN
   RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
  IF _result.response_body IS NOT NULL THEN
   IF _result.payload_expired_at IS NOT NULL OR _result.response_digest IS DISTINCT FROM aiag_http_validate_response(_r.route_kind,_result.response_body,_a.usage_snapshot) THEN
    RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
  ELSIF _result.payload_expired_at IS NULL OR _result.expires_at>clock_timestamp()
  OR _result.payload_expired_at<_result.expires_at OR _result.payload_expired_at>clock_timestamp() THEN
   RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005';
  END IF;
 EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE 'P0005' THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005';
 END;
 -- No provider/outcome/hold/cancel; the existing financial algorithm is the only writer.
 RETURN QUERY SELECT * FROM aiag_settle_admitted_gateway_charge(_org_id,_billing_request_id);
END $$;
