BEGIN;

ALTER TABLE gateway_http_requests
  DROP CONSTRAINT gateway_http_requests_route_kind_check;
ALTER TABLE gateway_http_requests
  ADD CONSTRAINT gateway_http_requests_route_kind_check
  CHECK(route_kind IN('chat','embeddings'));

-- Frozen candidate validation and exact retail/supplier arithmetic.
CREATE OR REPLACE FUNCTION aiag_quota_candidate(_c JSONB,_model TEXT)
RETURNS NUMERIC[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _i NUMERIC; _o NUMERIC; _m NUMERIC; _context NUMERIC; _cap NUMERIC; _inputs NUMERIC; _base NUMERIC; _k TEXT;
BEGIN
 IF (_c->>'modelType')='embedding' THEN
  IF NOT aiag_quota_keys(_c,ARRAY['modelSlug','modelType','upstreamId','upstreamModelId','adapterKey','modelUpstreamId','profileId','profileRevision','adapterContract','endpointPolicy','contextWindowTokens','inputCount','dimensions','encodingFormat','prices','maxCredits'])
  OR (_c->>'modelSlug') IS DISTINCT FROM 'openai/text-embedding-3-small' OR (_c->>'modelSlug') IS DISTINCT FROM _model
  OR (_c->>'upstreamId') IS DISTINCT FROM 'openrouter' OR (_c->>'upstreamModelId') IS DISTINCT FROM 'openai/text-embedding-3-small'
  OR (_c->>'adapterKey') IS DISTINCT FROM 'openrouter' OR (_c->>'profileId') IS DISTINCT FROM 'openrouter-openai-text-embedding-3-small-embeddings-v1'
  OR _c->'profileRevision' IS DISTINCT FROM '1'::jsonb OR (_c->>'adapterContract') IS DISTINCT FROM 'openrouter-pinned-provider-embeddings-v1'
  OR _c->'contextWindowTokens' IS DISTINCT FROM '8192'::jsonb OR _c->'dimensions' IS DISTINCT FROM '1536'::jsonb
  OR (_c->>'encodingFormat') IS DISTINCT FROM 'float' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 ELSE
  IF NOT aiag_quota_keys(_c,ARRAY['modelSlug','modelType','upstreamId','upstreamModelId','adapterKey','modelUpstreamId','profileId','profileRevision','adapterContract','endpointPolicy','contextWindowTokens','maxOutputTokens','prices','maxCredits'])
  OR (_c->>'modelSlug') IS DISTINCT FROM _model OR (_c->>'modelType') IS DISTINCT FROM 'chat'
  OR (_c->>'adapterContract') IS DISTINCT FROM 'openrouter-pinned-provider-chat-v1' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 END IF;
 IF NOT aiag_quota_keys(_c->'endpointPolicy',ARRAY['only','allowFallbacks','requireParameters'])
 OR _c->'endpointPolicy'->'allowFallbacks' IS DISTINCT FROM 'false'::jsonb
 OR _c->'endpointPolicy'->'requireParameters' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(_c->'endpointPolicy'->'only') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 IF jsonb_array_length(_c->'endpointPolicy'->'only')<>1 OR jsonb_typeof(_c->'endpointPolicy'->'only'->0) IS DISTINCT FROM 'string'
 OR (_c->'endpointPolicy'->'only'->>0) !~ '^[A-Za-z0-9._/-]{1,128}$' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 IF (_c->>'modelType')='embedding' AND (_c->'endpointPolicy'->'only'->>0) IS DISTINCT FROM 'openai' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 FOREACH _k IN ARRAY ARRAY['modelSlug','upstreamId','upstreamModelId','adapterKey','modelUpstreamId','profileId'] LOOP
  IF jsonb_typeof(_c->_k) IS DISTINCT FROM 'string' OR (length(_c->>_k)>256 OR (_c->>_k) !~ '^[A-Za-z0-9_./:@+-]+$') THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 END LOOP;
 PERFORM aiag_quota_count(_c->'profileRevision',TRUE);
 _context:=aiag_quota_count(_c->'contextWindowTokens',TRUE);
 IF (_c->>'modelType')='embedding' THEN
  _inputs:=aiag_quota_count(_c->'inputCount',TRUE);
  IF _inputs>16 THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 ELSE
  _cap:=aiag_quota_count(_c->'maxOutputTokens',TRUE);
  IF _cap>_context THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 END IF;
 IF NOT aiag_quota_keys(_c->'prices',ARRAY['inputCentsPer1k','outputCentsPer1k','markup']) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 _i:=aiag_quota_decimal(_c->'prices'->'inputCentsPer1k'); _o:=aiag_quota_decimal(_c->'prices'->'outputCentsPer1k'); _m:=aiag_quota_decimal(_c->'prices'->'markup');
 IF _m<=0 OR _i>=100000000 OR _o>=100000000
 OR length(split_part(_c->'prices'->>'inputCentsPer1k','.',2))>10 OR length(split_part(_c->'prices'->>'outputCentsPer1k','.',2))>10 THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 _base:=CASE WHEN (_c->>'modelType')='embedding' THEN _i*_context*_inputs ELSE _i*_context+greatest(_o-_i,0)*_cap END;
 IF aiag_quota_money(aiag_quota_decimal(_c->'maxCredits',TRUE)) IS DISTINCT FROM aiag_quota_money(ceil(_base*_m)) OR ceil(_base*_m)<=0 THEN RAISE EXCEPTION 'INVALID_CHARGED_MAXIMUM'; END IF;
 RETURN ARRAY[ceil(_base*_m),aiag_quota_money(ceil(10*_base))::numeric];
END $$;

CREATE OR REPLACE FUNCTION aiag_http_validate_identity(_org UUID,_key UUID,_route VARCHAR,_mode VARCHAR,_digest TEXT,_fingerprint TEXT,_version SMALLINT)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF _org IS NULL OR _key IS NULL OR _route NOT IN('chat','embeddings') OR _mode IS DISTINCT FROM 'stored'
 OR _version IS DISTINCT FROM 1 OR _digest IS NULL OR length(_digest)<>64 OR _digest COLLATE "C" !~ '^[0-9a-f]{64}$'
 OR _fingerprint IS NULL OR length(_fingerprint)<>64 OR _fingerprint COLLATE "C" !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
END $$;

CREATE OR REPLACE FUNCTION aiag_http_validate_response(_route TEXT,_body JSONB,_usage JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _choice JSONB; _u JSONB; _p NUMERIC; _c NUMERIC; _t NUMERIC; _cached NUMERIC;
 _item JSONB; _component JSONB; _index INTEGER; _inputs NUMERIC;
BEGIN
 IF octet_length(convert_to(_body::text,'UTF8'))>1048576 THEN
  RAISE EXCEPTION 'HTTP_RESULT_TOO_LARGE' USING ERRCODE='P0001'; END IF;
 IF _route='embeddings' THEN
  IF NOT aiag_quota_keys(_body,ARRAY['object','model','data','usage'])
  OR _body->'object' IS DISTINCT FROM '"list"'::jsonb
  OR jsonb_typeof(_body->'model') IS DISTINCT FROM 'string' OR length(_body->>'model') NOT BETWEEN 1 AND 256
  OR (_body->>'model') COLLATE "C" !~ '^[A-Za-z0-9_./:@+-]+$'
  OR jsonb_typeof(_body->'data') IS DISTINCT FROM 'array'
  OR jsonb_typeof(_usage) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
  _inputs:=aiag_quota_count(_usage->'inputCount',TRUE);
  IF _inputs NOT BETWEEN 1 AND 16 OR jsonb_array_length(_body->'data')<>_inputs THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
  FOR _item,_index IN SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(_body->'data') WITH ORDINALITY LOOP
   IF NOT aiag_quota_keys(_item,ARRAY['object','index','embedding'])
   OR _item->'object' IS DISTINCT FROM '"embedding"'::jsonb
   OR aiag_quota_count(_item->'index')<>_index
   OR jsonb_typeof(_item->'embedding') IS DISTINCT FROM 'array'
   OR jsonb_array_length(_item->'embedding')<>1536 THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
   FOR _component IN SELECT value FROM jsonb_array_elements(_item->'embedding') LOOP
    IF jsonb_typeof(_component) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
   END LOOP;
  END LOOP;
  _u:=_body->'usage';
  IF NOT aiag_quota_keys(_u,ARRAY['prompt_tokens','total_tokens']) THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
  _p:=aiag_quota_count(_u->'prompt_tokens'); _t:=aiag_quota_count(_u->'total_tokens');
  IF _t<>_p OR _p>8192*_inputs THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
  IF _body->'model' IS DISTINCT FROM _usage->'reportedModel'
  OR _u->'prompt_tokens' IS DISTINCT FROM _usage->'usage'->'promptTokens'
  OR _u->'total_tokens' IS DISTINCT FROM _usage->'usage'->'totalTokens'
  OR _usage->'usage'->'completionTokens' IS DISTINCT FROM '0'::jsonb
  OR _usage->'usage'->'cachedInputTokens' IS DISTINCT FROM '0'::jsonb
  OR _usage->'dimensions' IS DISTINCT FROM '1536'::jsonb
  OR _usage->'encodingFormat' IS DISTINCT FROM '"float"'::jsonb THEN RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
  RETURN encode(sha256(convert_to(_body::text,'UTF8')),'hex');
 END IF;
 IF _route IS DISTINCT FROM 'chat' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 IF NOT aiag_quota_keys(_body,ARRAY['id','object','created','model','choices','usage']) THEN
  RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 IF jsonb_typeof(_body->'id') IS DISTINCT FROM 'string' OR length(_body->>'id') NOT BETWEEN 1 AND 256
 OR (_body->>'id') COLLATE "C" !~ '^[A-Za-z0-9_-]+$'
 OR _body->'object' IS DISTINCT FROM '"chat.completion"'::jsonb
 OR jsonb_typeof(_body->'model') IS DISTINCT FROM 'string' OR length(_body->>'model') NOT BETWEEN 1 AND 256
 OR (_body->>'model') COLLATE "C" !~ '^[A-Za-z0-9_./:@+-]+$'
 OR jsonb_typeof(_body->'choices') IS DISTINCT FROM 'array'
 OR jsonb_typeof(_usage) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 IF jsonb_array_length(_body->'choices')<>1 THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 _choice:=_body->'choices'->0;
 IF NOT aiag_quota_keys(_choice,ARRAY['index','message','finish_reason'])
 OR NOT aiag_quota_keys(_choice->'message',ARRAY['role','content'])
 OR _choice->'message'->'role' IS DISTINCT FROM '"assistant"'::jsonb
 OR jsonb_typeof(_choice->'message'->'content') NOT IN('string','null')
 OR jsonb_typeof(_choice->'finish_reason') IS DISTINCT FROM 'string'
 OR (_choice->>'finish_reason') NOT IN('stop','length','content_filter') THEN
  RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 _u:=_body->'usage';
 IF NOT (aiag_quota_keys(_u,ARRAY['prompt_tokens','completion_tokens','total_tokens'])
 OR aiag_quota_keys(_u,ARRAY['prompt_tokens','completion_tokens','total_tokens','cached_input_tokens'])) THEN
  RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 -- Translate only pure count-parser validation failures; financial errors are not caught here.
 BEGIN
  PERFORM aiag_quota_count(_body->'created');
  IF aiag_quota_count(_choice->'index')<>0 THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT'; END IF;
  _p:=aiag_quota_count(_u->'prompt_tokens'); _c:=aiag_quota_count(_u->'completion_tokens'); _t:=aiag_quota_count(_u->'total_tokens');
  IF _u ? 'cached_input_tokens' THEN _cached:=aiag_quota_count(_u->'cached_input_tokens'); END IF;
 EXCEPTION WHEN SQLSTATE 'P0001' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001';
 END;
 IF _t<>_p+_c OR (_cached IS NOT NULL AND _cached>_p) THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
 IF _body->'id' IS DISTINCT FROM _usage->'completionId' OR _body->'model' IS DISTINCT FROM _usage->'reportedModel'
 OR _u->'prompt_tokens' IS DISTINCT FROM _usage->'usage'->'promptTokens'
 OR _u->'completion_tokens' IS DISTINCT FROM _usage->'usage'->'completionTokens'
 OR _u->'total_tokens' IS DISTINCT FROM _usage->'usage'->'totalTokens'
 OR (_u ? 'cached_input_tokens' AND _u->'cached_input_tokens' IS DISTINCT FROM _usage->'usage'->'cachedInputTokens') THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 RETURN encode(sha256(convert_to(_body::text,'UTF8')),'hex');
END $$;

-- Backward-compatible chat validator for established callers.
CREATE OR REPLACE FUNCTION aiag_http_validate_response(_body JSONB,_usage JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
 SELECT aiag_http_validate_response('chat',_body,_usage)
$$;

CREATE OR REPLACE FUNCTION aiag_record_gateway_http_outcome_v1(
 _org_id UUID,_api_key_id UUID,_billing_request_id UUID,_idempotency_key_digest TEXT,_request_fingerprint TEXT,
 _actual_cost_credits BIGINT,_usage_snapshot JSONB,_outcome_kind VARCHAR,_response_body JSONB,_contract_version SMALLINT
) RETURNS SETOF gateway_charge_admission_result LANGUAGE plpgsql VOLATILE AS $$
DECLARE _a gateway_charge_admissions%ROWTYPE; _r gateway_http_requests%ROWTYPE; _result gateway_http_results%ROWTYPE;
 _digest TEXT; _at TIMESTAMPTZ; _transition gateway_charge_admission_result; _has_result BOOLEAN;
BEGIN
 -- Route is loaded from the locked request below; this call validates the route-independent envelope.
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,'chat','stored',_idempotency_key_digest,_request_fingerprint,_contract_version);
 IF _billing_request_id IS NULL THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
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
 PERFORM aiag_http_validate_identity(_org_id,_api_key_id,_r.route_kind,'stored',_idempotency_key_digest,_request_fingerprint,_contract_version);
 IF _r.idempotency_key_digest IS DISTINCT FROM _idempotency_key_digest OR _r.request_fingerprint IS DISTINCT FROM _request_fingerprint
 OR _r.contract_version<>_contract_version OR _r.route_kind NOT IN('chat','embeddings') OR _r.billing_mode<>'stored' THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 IF _a.route_kind IS DISTINCT FROM _r.route_kind OR _a.billing_mode<>'stored' OR NOT EXISTS(SELECT 1 FROM gateway_charge_quota_contexts
 WHERE billing_request_id=_billing_request_id AND org_id=_org_id AND api_key_id=_api_key_id AND quota_version=2) THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 SELECT * INTO _result FROM gateway_http_results WHERE billing_request_id=_billing_request_id FOR UPDATE;
 _has_result:=FOUND;
 IF (_has_result AND _a.state NOT IN('outcome_recorded','settled')) OR (NOT _has_result AND _a.state<>'dispatched') THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 _digest:=aiag_http_validate_response(_r.route_kind,_response_body,_usage_snapshot);
 IF _has_result AND (_result.response_digest IS DISTINCT FROM _digest
 OR (_result.response_body IS NOT NULL AND _result.response_body IS DISTINCT FROM _response_body)) THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 -- All established locks are already held. No second financial algorithm.
 SELECT * INTO STRICT _transition FROM aiag_record_gateway_charge_outcome_v2(_org_id,_billing_request_id,_actual_cost_credits,_usage_snapshot,_outcome_kind);
 IF NOT _has_result THEN
  _at:=clock_timestamp();
  INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at)
  VALUES(_billing_request_id,_org_id,_api_key_id,1,200,'application/json',_response_body,_digest,_at,_at+INTERVAL '168 hours');
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
 _out.contract_version:=1;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005'; END IF;
 SELECT billing_request_id INTO _id FROM gateway_http_requests WHERE org_id=_org_id AND api_key_id=_api_key_id
 AND route_kind=_route_kind AND billing_mode=_billing_mode AND idempotency_key_digest=_idempotency_key_digest;
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
  IF _a.org_id IS DISTINCT FROM _org_id OR _a.api_key_id IS DISTINCT FROM _api_key_id OR _a.route_kind IS DISTINCT FROM _r.route_kind OR _a.billing_mode<>'stored'
  OR _result.org_id IS DISTINCT FROM _org_id OR _result.api_key_id IS DISTINCT FROM _api_key_id
  OR _result.response_digest IS DISTINCT FROM aiag_http_validate_response(_r.route_kind,_result.response_body,_a.usage_snapshot)
  THEN RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
  _out.status:='ready'; _out.http_status:=_result.http_status; _out.content_type:=_result.content_type;
  _out.response_body:=_result.response_body; _out.actual_cost_credits:=_a.actual_cost_credits;
  _out.stored_at:=_result.stored_at; _out.expires_at:=_result.expires_at;
 ELSE _out.status:='unavailable'; END IF;
 RETURN NEXT _out;
END $$;


CREATE OR REPLACE FUNCTION aiag_admit_gateway_charge_impl(
  _org_id UUID,
  _billing_request_id UUID,
  _api_key_id UUID,
  _client_request_id VARCHAR,
  _route_kind VARCHAR,
  _billing_mode VARCHAR,
  _model_slug VARCHAR,
  _authorized_max_credits BIGINT,
  _quote_snapshot JSONB,
  _pre_dispatch_deadline_at TIMESTAMPTZ,
  _quota_version SMALLINT, _declared_session_id VARCHAR, _supplier_quote_snapshot JSONB
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _subscription_credits BIGINT;
  _payg_credits BIGINT;
  _refund_debt BIGINT;
  _subscription_expires_at TIMESTAMPTZ;
  _held_subscription BIGINT := 0;
  _held_payg BIGINT := 0;
  _existing gateway_charge_admissions%ROWTYPE;
  _context gateway_charge_quota_contexts%ROWTYPE;
  _org_policy gateway_quota_org_policies%ROWTYPE;
  _key_policy gateway_quota_key_policies%ROWTYPE;
  _key gateway_api_keys%ROWTYPE;
  _other_key gateway_api_keys%ROWTYPE;
  _admitted_at TIMESTAMPTZ;
  _monthly BIGINT;
  _supplier_max BIGINT;
  _legacy NUMERIC;
BEGIN
  IF _quota_version IS NULL OR _quota_version NOT IN(1,2)
   OR (_quota_version=1 AND (_declared_session_id IS NOT NULL OR _supplier_quote_snapshot IS NOT NULL))
   OR (_quota_version=2 AND (_supplier_quote_snapshot IS NULL OR (_declared_session_id IS NOT NULL AND _declared_session_id COLLATE "C" !~ '^[A-Za-z0-9._:-]{1,128}$')))
  THEN RAISE EXCEPTION 'INVALID_QUOTA_VERSION_OR_CONTEXT'; END IF;
  IF _org_id IS NULL OR _billing_request_id IS NULL OR _api_key_id IS NULL
    OR _route_kind IS NULL OR btrim(_route_kind) = '' OR length(_route_kind) > 32
    OR _billing_mode NOT IN ('stored', 'byok_fee')
    OR _model_slug IS NULL OR btrim(_model_slug) = '' OR length(_model_slug) > 128
    OR (_client_request_id IS NOT NULL AND
        (btrim(_client_request_id) = '' OR length(_client_request_id) > 255))
    OR _authorized_max_credits IS NULL OR _authorized_max_credits <= 0
    OR _quote_snapshot IS NULL OR jsonb_typeof(_quote_snapshot) <> 'object'
    OR _pre_dispatch_deadline_at IS NULL OR NOT isfinite(_pre_dispatch_deadline_at)
  THEN
    RAISE EXCEPTION 'INVALID_ADMISSION' USING ERRCODE = 'P0001';
  END IF;

  SELECT o.subscription_credits, o.payg_credits, o.refund_debt_credits,
         o.subscription_credits_expires_at
    INTO _subscription_credits, _payg_credits, _refund_debt,
         _subscription_expires_at
  FROM organizations o
  WHERE o.id = _org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));

  -- HTTP terminal fence, before the original SELECT/FOUND pair.
  IF EXISTS (SELECT 1 FROM gateway_http_rejections WHERE billing_request_id = _billing_request_id) THEN
    RAISE EXCEPTION 'HTTP_TERMINAL_REJECTION_EXISTS' USING ERRCODE = 'P0005';
  END IF;

  SELECT a.* INTO _existing
  FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF _existing.org_id IS DISTINCT FROM _org_id
      OR _existing.api_key_id IS DISTINCT FROM _api_key_id
      OR _existing.client_request_id IS DISTINCT FROM _client_request_id
      OR _existing.route_kind IS DISTINCT FROM _route_kind
      OR _existing.billing_mode IS DISTINCT FROM _billing_mode
      OR _existing.model_slug IS DISTINCT FROM _model_slug
      OR _existing.authorized_max_credits IS DISTINCT FROM _authorized_max_credits
      OR _existing.quote_snapshot IS DISTINCT FROM _quote_snapshot
      OR _existing.pre_dispatch_deadline_at IS DISTINCT FROM _pre_dispatch_deadline_at
    THEN
      RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
    END IF;
    SELECT * INTO _context FROM gateway_charge_quota_contexts WHERE billing_request_id=_billing_request_id;
    IF (_quota_version=2) IS DISTINCT FROM FOUND
      OR (_quota_version=2 AND (_context.declared_session_id IS DISTINCT FROM _declared_session_id
        OR _context.supplier_quote_snapshot IS DISTINCT FROM _supplier_quote_snapshot
        OR _context.org_id IS DISTINCT FROM _org_id OR _context.api_key_id IS DISTINCT FROM _api_key_id))
    THEN RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;

  SELECT * INTO _org_policy FROM gateway_quota_org_policies WHERE org_id=_org_id FOR UPDATE;
  IF _quota_version=1 AND coalesce(_org_policy.enforcement_version,1)=2 THEN RAISE EXCEPTION 'QUOTA_V2_REQUIRED'; END IF;
  IF _quota_version=2 AND coalesce(_org_policy.enforcement_version,1)<>2 THEN RAISE EXCEPTION 'QUOTA_V2_NOT_ENABLED'; END IF;
  SELECT * INTO _key_policy FROM gateway_quota_key_policies WHERE api_key_id=_api_key_id FOR UPDATE;
  IF _key_policy.org_id IS NOT NULL AND _key_policy.org_id<>_org_id THEN RAISE EXCEPTION 'QUOTA_POLICY_OWNER_CONFLICT'; END IF;
  -- Lock every active org key plus current key in UUID order; policies/writers must take org first.
  FOR _other_key IN SELECT * FROM gateway_api_keys WHERE org_id=_org_id AND (id=_api_key_id OR (disabled_at IS NULL AND revoked_at IS NULL)) ORDER BY id FOR UPDATE LOOP
   IF _other_key.id=_api_key_id THEN _key:=_other_key; END IF;
   IF _quota_version=2 AND _other_key.disabled_at IS NULL AND _other_key.revoked_at IS NULL AND _other_key.daily_usd_cap IS NOT NULL THEN
    IF _other_key.daily_usd_cap::text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN RAISE EXCEPTION 'INVALID_LEGACY_QUOTA_POLICY'; END IF;
    IF _other_key.daily_usd_cap>0 THEN RAISE EXCEPTION 'QUOTA_POLICY_MIGRATION_REQUIRED'; END IF;
   END IF;
  END LOOP;
  IF _key.id IS NULL OR _key.disabled_at IS NOT NULL OR _key.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'API_KEY_ORG_MISMATCH' USING ERRCODE='P0005'; END IF;
  IF _quota_version=2 THEN
   IF _billing_mode='stored' AND _route_kind NOT IN('chat','embeddings') THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
   IF _billing_mode='stored' AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(_quote_snapshot->'tokenQuote'->'candidates') c
    WHERE CASE _route_kind WHEN 'chat' THEN c->>'modelType' IS DISTINCT FROM 'chat'
      WHEN 'embeddings' THEN c->>'modelType' IS DISTINCT FROM 'embedding' ELSE TRUE END
   ) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
   IF _key.cost_limit_monthly_rub IS NOT NULL THEN
    IF _key.cost_limit_monthly_rub::text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN RAISE EXCEPTION 'INVALID_LEGACY_QUOTA_POLICY'; END IF;
    _monthly:=NULLIF(aiag_quota_money(_key.cost_limit_monthly_rub::numeric*1000),0);
   END IF;
   IF jsonb_typeof(_key.policies) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_LEGACY_QUOTA_POLICY'; END IF;
   IF _key.policies ? 'per_session_budget_cap_rub' AND _key.policies->'per_session_budget_cap_rub'<>'null'::jsonb THEN
    IF jsonb_typeof(_key.policies->'per_session_budget_cap_rub') NOT IN('number','string') THEN RAISE EXCEPTION 'INVALID_LEGACY_QUOTA_POLICY'; END IF;
    _legacy:=aiag_quota_decimal(to_jsonb(_key.policies->>'per_session_budget_cap_rub'));
    IF _legacy>0 THEN RAISE EXCEPTION 'QUOTA_POLICY_MIGRATION_REQUIRED'; END IF;
   END IF;
   IF _key_policy.session_microcredits_limit_v2 IS NOT NULL AND _declared_session_id IS NULL THEN RAISE EXCEPTION 'QUOTA_SESSION_REQUIRED'; END IF;
   _supplier_max:=aiag_quota_supplier_max(_billing_mode,_model_slug,_authorized_max_credits,_quote_snapshot,_supplier_quote_snapshot);
  END IF;
  _admitted_at:=clock_timestamp();
  IF _pre_dispatch_deadline_at<=_admitted_at THEN RAISE EXCEPTION 'ADMISSION_DEADLINE_EXPIRED' USING ERRCODE='P0001'; END IF;

  IF _billing_mode = 'stored' THEN
    PERFORM aiag_assert_refund_admission_allowed(_org_id);
  END IF;

  IF _subscription_expires_at IS NULL
    OR _subscription_expires_at > clock_timestamp()
  THEN
    _held_subscription := LEAST(_authorized_max_credits, _subscription_credits);
  END IF;
  _held_payg := _authorized_max_credits - _held_subscription;

  IF _held_payg > _payg_credits THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS' USING ERRCODE = 'P0003';
  END IF;

  UPDATE organizations o
  SET subscription_credits = o.subscription_credits - _held_subscription,
      payg_credits = o.payg_credits - _held_payg,
      updated_at = clock_timestamp()
  WHERE o.id = _org_id
    AND o.subscription_credits >= _held_subscription
    AND o.payg_credits >= _held_payg
  RETURNING o.subscription_credits, o.payg_credits
    INTO _subscription_credits, _payg_credits;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  INSERT INTO gateway_charge_admissions (
    billing_request_id, org_id, api_key_id, client_request_id, route_kind,
    billing_mode, model_slug, authorized_max_credits,
    held_subscription_credits, held_payg_credits,
    captured_subscription_expires_at, quote_snapshot,
    pre_dispatch_deadline_at, created_at
  ) VALUES (
    _billing_request_id, _org_id, _api_key_id, _client_request_id, _route_kind,
    _billing_mode, _model_slug, _authorized_max_credits,
    _held_subscription, _held_payg, _subscription_expires_at, _quote_snapshot,
    _pre_dispatch_deadline_at, _admitted_at
  );

  IF _quota_version=2 THEN
   INSERT INTO gateway_charge_quota_contexts(billing_request_id,org_id,api_key_id,declared_session_id,admitted_at,supplier_formula_version,supplier_quote_snapshot,supplier_authorized_max_usd_micro)
    VALUES(_billing_request_id,_org_id,_api_key_id,_declared_session_id,_admitted_at,_supplier_quote_snapshot->>'formulaVersion',_supplier_quote_snapshot,_supplier_max);
   PERFORM aiag_quota_reserve(_billing_request_id,_monthly,_org_policy.daily_supplier_usd_micro_limit_v2,_key_policy.session_microcredits_limit_v2,_key.cost_limit_monthly_rub::text,_org_policy.revision,_key_policy.revision);
  END IF;

  INSERT INTO gateway_charge_admission_events (
    admission_id, org_id, event_key, event_kind,
    held_subscription_credits, held_payg_credits, metadata
  ) VALUES (
    _billing_request_id, _org_id, 'hold', 'hold',
    _held_subscription, _held_payg,
    jsonb_build_object('billing_mode', _billing_mode, 'model_slug', _model_slug)
  );

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;


CREATE OR REPLACE FUNCTION aiag_quota_supplier_max(_mode TEXT,_model TEXT,_max BIGINT,_quote JSONB,_supplier JSONB)
RETURNS BIGINT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _q JSONB; _c JSONB; _v NUMERIC[]; _retail NUMERIC:=0; _s NUMERIC:=0; _discount NUMERIC;
BEGIN
 IF _mode='byok_fee' THEN
  IF _supplier IS DISTINCT FROM '{"version":2,"formulaVersion":"byok-zero-v2"}'::jsonb THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
  RETURN 0;
 END IF;
 IF _mode IS DISTINCT FROM 'stored' OR NOT aiag_quota_keys(_supplier,ARRAY['version','formulaVersion','tokenQuote'])
 OR _supplier->'version' IS DISTINCT FROM '2'::jsonb
 OR (_supplier->>'formulaVersion') IS DISTINCT FROM 'catalog-input-output-cents-per-1k-usd-micro-v2'
 OR NOT aiag_quota_keys(_quote,ARRAY['version','tokenQuote','actualChargePolicy']) OR _quote->'version' IS DISTINCT FROM '1'::jsonb
 OR _supplier->'tokenQuote' IS DISTINCT FROM _quote->'tokenQuote'
 OR NOT aiag_quota_keys(_quote->'actualChargePolicy',ARRAY['formulaVersion','cachingDiscount'])
 OR (_quote->'actualChargePolicy'->>'formulaVersion') IS DISTINCT FROM 'db-input-output-cents-per-1k-legacy-whole-cache-v1' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
 _discount:=aiag_quota_decimal(_quote->'actualChargePolicy'->'cachingDiscount');
 IF _discount>1 THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
 _q:=_quote->'tokenQuote';
 IF NOT aiag_quota_keys(_q,ARRAY['version','formulaVersion','requestedMode','effectiveMode','authorizedMaxCredits','candidates'])
 OR _q->'version' IS DISTINCT FROM '1'::jsonb OR (_q->>'formulaVersion') IS DISTINCT FROM 'db-input-output-cents-per-1k-legacy-whole-cache-v1'
 OR coalesce(_q->>'requestedMode','') NOT IN('auto','fastest','cheapest','balanced','ru-only') OR coalesce(_q->>'effectiveMode','') NOT IN('auto','fastest','cheapest','balanced','ru-only')
 OR jsonb_typeof(_q->'candidates') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
 IF jsonb_array_length(_q->'candidates') NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(_q->'candidates') c WHERE c->>'modelType'='embedding')
 AND (jsonb_array_length(_q->'candidates')<>1 OR _quote->'actualChargePolicy'->'cachingDiscount' IS DISTINCT FROM '"1"'::jsonb) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
 FOR _c IN SELECT value FROM jsonb_array_elements(_q->'candidates') LOOP
  _v:=aiag_quota_candidate(_c,_model); _retail:=greatest(_retail,_v[1]); _s:=greatest(_s,_v[2]);
 END LOOP;
 IF _max IS DISTINCT FROM aiag_quota_money(_retail) OR aiag_quota_decimal(_q->'authorizedMaxCredits',TRUE)<>_retail THEN RAISE EXCEPTION 'INVALID_CHARGED_MAXIMUM'; END IF;
 RETURN aiag_quota_money(_s);
END $$;

CREATE OR REPLACE FUNCTION aiag_quota_supplier_actual(_a gateway_charge_admissions,_actual BIGINT,_usage JSONB)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE _p JSONB; _k TEXT; _prompt NUMERIC; _completion NUMERIC; _total NUMERIC; _cached NUMERIC;
 _i NUMERIC; _o NUMERIC; _m NUMERIC; _d NUMERIC; _base NUMERIC; _charged NUMERIC; _supplier BIGINT; _bounds NUMERIC[];
BEGIN
 PERFORM aiag_quota_validate_dispatch(_a,_a.upstream_id,_a.pricing_snapshot);
 IF _a.billing_mode='byok_fee' THEN
  IF NOT aiag_quota_keys(_usage,ARRAY['version','formulaVersion','billingRequestId','attemptId','upstreamId','verified'])
  OR _usage->'version' IS DISTINCT FROM '2'::jsonb OR (_usage->>'formulaVersion') IS DISTINCT FROM 'byok-fee-microcredits-v2'
  OR _usage->'verified' IS DISTINCT FROM 'true'::jsonb OR (_usage->>'billingRequestId') IS DISTINCT FROM _a.billing_request_id::text
  OR (_usage->>'attemptId') IS DISTINCT FROM _a.attempt_id::text OR (_usage->>'upstreamId') IS DISTINCT FROM _a.upstream_id
  OR _actual<>_a.authorized_max_credits THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
  RETURN 0;
 END IF;
 _p:=_a.pricing_snapshot;
 IF (_p->>'modelType')='embedding' THEN
  IF NOT aiag_quota_keys(_usage,ARRAY['version','usageContract','billingRequestId','attemptId','upstreamId','upstreamModelId','adapterKey','modelSlug','modelUpstreamId','profileId','profileRevision','providerResponseId','reportedModel','inputCount','dimensions','encodingFormat','usage','formulaVersion'])
  OR _usage->'version' IS DISTINCT FROM '1'::jsonb OR (_usage->>'formulaVersion') IS DISTINCT FROM 'db-input-output-cents-per-1k-legacy-whole-cache-v1'
  OR (_usage->>'billingRequestId') IS DISTINCT FROM _a.billing_request_id::text OR (_usage->>'attemptId') IS DISTINCT FROM _a.attempt_id::text
  OR (_usage->>'usageContract') IS DISTINCT FROM (_p->>'adapterContract')
  OR jsonb_typeof(_usage->'providerResponseId') NOT IN('string','null')
  OR (jsonb_typeof(_usage->'providerResponseId')='string' AND length(_usage->>'providerResponseId') NOT BETWEEN 1 AND 256)
  OR _usage->'reportedModel' IS DISTINCT FROM _p->'modelSlug' OR _usage->'inputCount' IS DISTINCT FROM _p->'inputCount'
  OR _usage->'dimensions' IS DISTINCT FROM _p->'dimensions' OR _usage->'encodingFormat' IS DISTINCT FROM _p->'encodingFormat'
  THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 ELSE
 IF NOT aiag_quota_keys(_usage,ARRAY['version','usageContract','billingRequestId','attemptId','upstreamId','upstreamModelId','adapterKey','modelSlug','modelUpstreamId','profileId','profileRevision','completionId','reportedModel','usage','formulaVersion'])
 OR _usage->'version' IS DISTINCT FROM '1'::jsonb OR (_usage->>'formulaVersion') IS DISTINCT FROM 'db-input-output-cents-per-1k-legacy-whole-cache-v1'
 OR (_usage->>'billingRequestId') IS DISTINCT FROM _a.billing_request_id::text OR (_usage->>'attemptId') IS DISTINCT FROM _a.attempt_id::text
 OR (_usage->>'usageContract') IS DISTINCT FROM (_a.pricing_snapshot->>'adapterContract')
 OR jsonb_typeof(_usage->'completionId') IS DISTINCT FROM 'string' OR (length(_usage->>'completionId')>256 OR (_usage->>'completionId') !~ '^[A-Za-z0-9_-]+$')
 OR jsonb_typeof(_usage->'reportedModel') IS DISTINCT FROM 'string' OR (length(_usage->>'reportedModel')>256 OR (_usage->>'reportedModel') !~ '^[A-Za-z0-9_./:@+-]+$') THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 END IF;
 FOREACH _k IN ARRAY ARRAY['upstreamId','upstreamModelId','adapterKey','modelSlug','modelUpstreamId','profileId','profileRevision'] LOOP
  IF _usage->_k IS DISTINCT FROM _p->_k THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 END LOOP;
 IF NOT aiag_quota_keys(_usage->'usage',ARRAY['promptTokens','completionTokens','totalTokens','cachedInputTokens']) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 _prompt:=aiag_quota_count(_usage->'usage'->'promptTokens'); _completion:=aiag_quota_count(_usage->'usage'->'completionTokens');
 _total:=aiag_quota_count(_usage->'usage'->'totalTokens'); _cached:=aiag_quota_count(_usage->'usage'->'cachedInputTokens');
 IF (_p->>'modelType')='embedding' THEN
  IF _completion<>0 OR _cached<>0 OR _total<>_prompt OR _prompt>aiag_quota_count(_p->'contextWindowTokens',TRUE)*aiag_quota_count(_p->'inputCount',TRUE) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 ELSE
  IF _total<>_prompt+_completion OR _cached>_prompt OR _total>aiag_quota_count(_p->'contextWindowTokens',TRUE) OR _completion>aiag_quota_count(_p->'maxOutputTokens',TRUE) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 END IF;
 _i:=aiag_quota_decimal(_p->'prices'->'inputCentsPer1k'); _o:=aiag_quota_decimal(_p->'prices'->'outputCentsPer1k'); _m:=aiag_quota_decimal(_p->'prices'->'markup');
 _d:=aiag_quota_decimal(_p->'actualChargePolicy'->'cachingDiscount'); _base:=_i*_prompt+_o*_completion;
 -- div avoids rounded numeric division immediately next to a half-credit boundary.
 IF _prompt=0 THEN _charged:=div(_base*_m*2+1,2);
 ELSE _charged:=div(_base*_m*((_prompt-_cached)+_cached*_d)*2+_prompt,2*_prompt); END IF;
 _supplier:=aiag_quota_money(ceil(10*_base)); _bounds:=aiag_quota_candidate(_p-'actualChargePolicy',_a.model_slug);
 IF _actual IS DISTINCT FROM aiag_quota_money(_charged) OR _charged>_bounds[1] OR _supplier>_bounds[2] THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 RETURN _supplier;
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
 OR _r.route_kind NOT IN('chat','embeddings') OR _r.billing_mode IS DISTINCT FROM 'stored' OR _r.contract_version IS DISTINCT FROM 1
 OR _a.route_kind IS DISTINCT FROM _r.route_kind OR _a.billing_mode IS DISTINCT FROM 'stored'
 OR _a.state NOT IN('outcome_recorded','settled') OR _a.outcome_kind IS DISTINCT FROM 'success'
 OR _a.attempt_id IS NULL OR _a.upstream_id IS NULL OR _a.pricing_snapshot IS NULL OR _a.usage_snapshot IS NULL
 OR _a.actual_cost_credits IS NULL OR _a.actual_cost_credits<0 OR _a.actual_cost_credits>_a.authorized_max_credits
 OR _result.org_id IS DISTINCT FROM _org_id OR _result.api_key_id IS DISTINCT FROM _api_key_id
 OR _result.contract_version IS DISTINCT FROM 1 OR _result.http_status IS DISTINCT FROM 200 OR _result.content_type IS DISTINCT FROM 'application/json'
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

COMMIT;
