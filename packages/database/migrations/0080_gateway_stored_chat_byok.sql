-- Additive durable stored-chat BYOK HTTP identity/result lifecycle.
-- Historical migrations <=0079 remain immutable.

ALTER TABLE gateway_http_requests
  DROP CONSTRAINT gateway_http_requests_billing_mode_check;
ALTER TABLE gateway_http_requests
  ADD CONSTRAINT gateway_http_requests_billing_mode_check
  CHECK(billing_mode IN('stored','byok_fee'));

ALTER TABLE gateway_http_requests
  DROP CONSTRAINT gateway_http_requests_contract_version_check;
ALTER TABLE gateway_http_requests
  ADD CONSTRAINT gateway_http_requests_contract_version_check
  CHECK(
    (billing_mode='stored' AND (contract_version=1 OR (contract_version=2 AND route_kind='chat')))
    OR (billing_mode='byok_fee' AND contract_version=3 AND route_kind='chat')
  );

ALTER TABLE gateway_http_requests
  DROP CONSTRAINT gateway_http_requests_scope_uniq;
ALTER TABLE gateway_http_requests
  ADD CONSTRAINT gateway_http_requests_scope_uniq
  UNIQUE(org_id,api_key_id,route_kind,idempotency_key_digest);

ALTER TABLE gateway_http_results
  DROP CONSTRAINT gateway_http_results_contract_version_check;
ALTER TABLE gateway_http_results
  ADD CONSTRAINT gateway_http_results_contract_version_check
  CHECK(contract_version IN(1,2,3));

ALTER TABLE gateway_http_results
  DROP CONSTRAINT gateway_http_results_content_type_check;
ALTER TABLE gateway_http_results
  ADD CONSTRAINT gateway_http_results_content_type_check
  CHECK(
    (contract_version=2 AND content_type='text/event-stream')
    OR (contract_version IN(1,3) AND content_type='application/json')
  );

CREATE OR REPLACE FUNCTION aiag_http_validate_identity(_org UUID,_key UUID,_route VARCHAR,_mode VARCHAR,_digest TEXT,_fingerprint TEXT,_version SMALLINT)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF _org IS NULL OR _key IS NULL OR _route NOT IN('chat','embeddings','completions')
 OR NOT (
   (_mode='stored' AND (_version=1 OR (_version=2 AND _route='chat')))
   OR (_mode='byok_fee' AND _version=3 AND _route='chat')
 )
 OR _digest IS NULL OR length(_digest)<>64 OR _digest COLLATE "C" !~ '^[0-9a-f]{64}$'
 OR _fingerprint IS NULL OR length(_fingerprint)<>64 OR _fingerprint COLLATE "C" !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
END $$;

CREATE OR REPLACE FUNCTION aiag_http_validate_byok_response(_body JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
 SELECT aiag_http_validate_response(
  'chat',
  _body,
  jsonb_build_object(
   'completionId',_body->>'id',
   'reportedModel',_body->>'model',
   'usage',jsonb_build_object(
    'promptTokens',_body->'usage'->'prompt_tokens',
    'completionTokens',_body->'usage'->'completion_tokens',
    'totalTokens',_body->'usage'->'total_tokens',
    'cachedInputTokens',coalesce(_body->'usage'->'cached_input_tokens','0'::jsonb)
   )
  )
 )
$$;

CREATE OR REPLACE FUNCTION aiag_claim_gateway_http_request_v1(
 _org_id UUID,_api_key_id UUID,_billing_request_id UUID,_route_kind VARCHAR,_billing_mode VARCHAR,
 _idempotency_key_digest TEXT,_request_fingerprint TEXT,_contract_version SMALLINT
) RETURNS SETOF gateway_http_claim_result_v1 LANGUAGE plpgsql VOLATILE AS $$
DECLARE _id UUID; _r gateway_http_requests%ROWTYPE; _fresh BOOLEAN:=FALSE;
BEGIN
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,_route_kind,_billing_mode,_idempotency_key_digest,_request_fingerprint,_contract_version);
 IF _billing_request_id IS NULL THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 SELECT billing_request_id INTO _id FROM gateway_http_requests WHERE org_id=_org_id AND api_key_id=_api_key_id
 AND route_kind=_route_kind AND idempotency_key_digest=_idempotency_key_digest;
 _id:=coalesce(_id,_billing_request_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(_id::text,0));
 PERFORM 1 FROM gateway_charge_admissions WHERE billing_request_id=_id FOR UPDATE;
 PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);
 SELECT * INTO _r FROM gateway_http_requests WHERE org_id=_org_id AND api_key_id=_api_key_id
 AND route_kind=_route_kind AND idempotency_key_digest=_idempotency_key_digest FOR UPDATE;
 IF FOUND THEN
  IF _r.billing_mode IS DISTINCT FROM _billing_mode
  OR _r.request_fingerprint IS DISTINCT FROM _request_fingerprint OR _r.contract_version<>_contract_version THEN
   RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM gateway_charge_admissions WHERE billing_request_id=_id)
  OR EXISTS(SELECT 1 FROM gateway_http_requests WHERE billing_request_id=_id)
  OR EXISTS(SELECT 1 FROM gateway_transactions WHERE request_id=_id::text) THEN
   RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
  INSERT INTO gateway_http_requests(billing_request_id,org_id,api_key_id,route_kind,billing_mode,contract_version,idempotency_key_digest,request_fingerprint)
  VALUES(_id,_org_id,_api_key_id,_route_kind,_billing_mode,_contract_version,_idempotency_key_digest,_request_fingerprint) RETURNING * INTO _r;
  _fresh:=TRUE;
 END IF;
 RETURN QUERY SELECT _r.contract_version,_r.org_id,_r.api_key_id,_r.billing_request_id,_r.route_kind,_r.billing_mode,
 _r.idempotency_key_digest,_r.request_fingerprint,_r.created_at,_fresh;
END $$;

CREATE OR REPLACE FUNCTION aiag_record_gateway_http_outcome_v1(
 _org_id UUID,_api_key_id UUID,_billing_request_id UUID,_idempotency_key_digest TEXT,_request_fingerprint TEXT,
 _actual_cost_credits BIGINT,_usage_snapshot JSONB,_outcome_kind VARCHAR,_response_body JSONB,_contract_version SMALLINT
) RETURNS SETOF gateway_charge_admission_result LANGUAGE plpgsql VOLATILE AS $$
DECLARE _a gateway_charge_admissions%ROWTYPE; _r gateway_http_requests%ROWTYPE; _result gateway_http_results%ROWTYPE;
 _digest TEXT; _at TIMESTAMPTZ; _transition gateway_charge_admission_result; _has_result BOOLEAN;
BEGIN
 -- Route/mode are loaded from the locked durable request below.
 IF _org_id IS NULL OR _api_key_id IS NULL OR _billing_request_id IS NULL
 OR _contract_version NOT IN(1,2,3)
 OR _idempotency_key_digest IS NULL OR length(_idempotency_key_digest)<>64 OR _idempotency_key_digest COLLATE "C" !~ '^[0-9a-f]{64}$'
 OR _request_fingerprint IS NULL OR length(_request_fingerprint)<>64 OR _request_fingerprint COLLATE "C" !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
 IF _outcome_kind IS DISTINCT FROM 'success' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text,0));
 SELECT * INTO _a FROM gateway_charge_admissions WHERE billing_request_id=_billing_request_id FOR UPDATE;
 PERFORM aiag_http_require_key(_org_id,_api_key_id,FALSE);
 IF _a.org_id IS DISTINCT FROM _org_id OR _a.api_key_id IS DISTINCT FROM _api_key_id THEN
  RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_billing_request_id AND org_id=_org_id AND api_key_id=_api_key_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,_r.route_kind,_r.billing_mode,_idempotency_key_digest,_request_fingerprint,_contract_version);
 IF _r.idempotency_key_digest IS DISTINCT FROM _idempotency_key_digest OR _r.request_fingerprint IS DISTINCT FROM _request_fingerprint
 OR _r.contract_version<>_contract_version OR _r.route_kind NOT IN('chat','embeddings','completions') THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 IF _a.route_kind IS DISTINCT FROM _r.route_kind OR _a.billing_mode IS DISTINCT FROM _r.billing_mode OR NOT EXISTS(SELECT 1 FROM gateway_charge_quota_contexts
 WHERE billing_request_id=_billing_request_id AND org_id=_org_id AND api_key_id=_api_key_id AND quota_version=2) THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 SELECT * INTO _result FROM gateway_http_results WHERE billing_request_id=_billing_request_id FOR UPDATE;
 _has_result:=FOUND;
 IF (_has_result AND _a.state NOT IN('outcome_recorded','settled')) OR (NOT _has_result AND _a.state<>'dispatched') THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 IF (_contract_version=2) IS DISTINCT FROM (_response_body->>'object'='aiag.chat.stream.v1') THEN
  RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 _digest:=CASE WHEN _r.billing_mode='byok_fee'
  THEN aiag_http_validate_byok_response(_response_body)
  ELSE aiag_http_validate_response(_r.route_kind,_response_body,_usage_snapshot) END;
 IF _has_result AND (_result.response_digest IS DISTINCT FROM _digest
 OR (_result.response_body IS NOT NULL AND _result.response_body IS DISTINCT FROM _response_body)) THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 -- All established locks are already held. No second financial algorithm.
 SELECT * INTO STRICT _transition FROM aiag_record_gateway_charge_outcome_v2(_org_id,_billing_request_id,_actual_cost_credits,_usage_snapshot,_outcome_kind);
 IF NOT _has_result THEN
  _at:=clock_timestamp();
  INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at)
  VALUES(_billing_request_id,_org_id,_api_key_id,_contract_version,200,
   (CASE WHEN _contract_version=2 THEN 'text/event-stream' ELSE 'application/json' END),
   _response_body,_digest,_at,_at+INTERVAL '168 hours');
 END IF;
 RETURN NEXT _transition;
END $$;

CREATE OR REPLACE FUNCTION aiag_read_gateway_http_result_v1(
 _org_id UUID,_api_key_id UUID,_route_kind VARCHAR,_billing_mode VARCHAR,
 _idempotency_key_digest TEXT,_request_fingerprint TEXT,_contract_version SMALLINT
) RETURNS SETOF gateway_http_read_result_v1 LANGUAGE plpgsql VOLATILE AS $$
DECLARE _id UUID; _r gateway_http_requests%ROWTYPE; _a gateway_charge_admissions%ROWTYPE; _result gateway_http_results%ROWTYPE;
 _out gateway_http_read_result_v1; _has_result BOOLEAN;
BEGIN
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,_route_kind,_billing_mode,_idempotency_key_digest,_request_fingerprint,_contract_version);
 _out.contract_version:=_contract_version;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 SELECT billing_request_id INTO _id FROM gateway_http_requests WHERE org_id=_org_id AND api_key_id=_api_key_id
 AND route_kind=_route_kind AND idempotency_key_digest=_idempotency_key_digest;
 IF _id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(_id::text,0));
  SELECT * INTO _a FROM gateway_charge_admissions WHERE billing_request_id=_id FOR UPDATE;
 END IF;
 PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);
 IF _id IS NULL THEN _out.status:='not_found'; RETURN NEXT _out; RETURN; END IF;
 SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_id FOR UPDATE;
 IF _r.org_id IS DISTINCT FROM _org_id OR _r.api_key_id IS DISTINCT FROM _api_key_id
 OR _r.route_kind IS DISTINCT FROM _route_kind OR _r.billing_mode IS DISTINCT FROM _billing_mode
 OR _r.request_fingerprint IS DISTINCT FROM _request_fingerprint OR _r.contract_version<>_contract_version THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 _out.billing_request_id:=_id;
 SELECT * INTO _result FROM gateway_http_results WHERE billing_request_id=_id FOR UPDATE;
 _has_result:=FOUND;
 IF _has_result AND (_result.expires_at<=clock_timestamp() OR _result.payload_expired_at IS NOT NULL) THEN
  _out.status:='expired'; _out.stored_at:=_result.stored_at; _out.expires_at:=_result.expires_at;
 ELSIF _a.state IS NULL OR _a.state IN('held','dispatched','outcome_recorded') THEN _out.status:='pending';
 ELSIF _a.state='cancelled' OR NOT _has_result THEN _out.status:='unavailable';
 ELSIF _a.state='settled' THEN
  IF _a.org_id IS DISTINCT FROM _org_id OR _a.api_key_id IS DISTINCT FROM _api_key_id OR _a.route_kind IS DISTINCT FROM _r.route_kind OR _a.billing_mode IS DISTINCT FROM _r.billing_mode
  OR _result.org_id IS DISTINCT FROM _org_id OR _result.api_key_id IS DISTINCT FROM _api_key_id
  OR _result.contract_version IS DISTINCT FROM _contract_version OR _result.http_status IS DISTINCT FROM 200
  OR _result.content_type IS DISTINCT FROM (CASE WHEN _contract_version=2 THEN 'text/event-stream' ELSE 'application/json' END)
  OR _result.response_digest IS DISTINCT FROM (CASE WHEN _r.billing_mode='byok_fee'
       THEN aiag_http_validate_byok_response(_result.response_body)
       ELSE aiag_http_validate_response(_r.route_kind,_result.response_body,_a.usage_snapshot) END)
  THEN RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
  _out.status:='ready'; _out.http_status:=_result.http_status; _out.content_type:=_result.content_type;
  _out.response_body:=_result.response_body; _out.actual_cost_credits:=_a.actual_cost_credits;
  _out.stored_at:=_result.stored_at; _out.expires_at:=_result.expires_at;
 ELSE _out.status:='unavailable'; END IF;
 RETURN NEXT _out;
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
 AND route_kind=_route_kind AND idempotency_key_digest=_idempotency_key_digest;
 IF _id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(_id::text,0));
  PERFORM 1 FROM gateway_charge_admissions WHERE billing_request_id=_id FOR UPDATE;
 END IF;
 PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);
 IF _id IS NOT NULL THEN
  SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_id FOR UPDATE;
  IF _r.org_id IS DISTINCT FROM _org_id OR _r.api_key_id IS DISTINCT FROM _api_key_id
  OR _r.route_kind IS DISTINCT FROM _route_kind OR _r.billing_mode IS DISTINCT FROM _billing_mode
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
 OR _r.route_kind NOT IN('chat','embeddings','completions')
 OR NOT (
   (_r.billing_mode='stored' AND (_r.contract_version=1 OR (_r.contract_version=2 AND _r.route_kind='chat')))
   OR (_r.billing_mode='byok_fee' AND _r.contract_version=3 AND _r.route_kind='chat')
 )
 OR _a.route_kind IS DISTINCT FROM _r.route_kind OR _a.billing_mode IS DISTINCT FROM _r.billing_mode
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
   IF _result.payload_expired_at IS NOT NULL OR _result.response_digest IS DISTINCT FROM
    (CASE WHEN _r.billing_mode='byok_fee' THEN aiag_http_validate_byok_response(_result.response_body)
      ELSE aiag_http_validate_response(_r.route_kind,_result.response_body,_a.usage_snapshot) END) THEN
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
