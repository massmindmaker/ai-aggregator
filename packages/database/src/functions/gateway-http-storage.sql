-- Server-only persistence composition. No execution permission is granted by replay.
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

CREATE OR REPLACE FUNCTION aiag_http_require_key(_org UUID,_key UUID,_active BOOLEAN)
RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
DECLARE _k gateway_api_keys%ROWTYPE;
BEGIN
 SELECT * INTO _k FROM gateway_api_keys WHERE org_id=_org AND id=_key FOR SHARE;
 IF NOT FOUND OR (_active AND (_k.revoked_at IS NOT NULL OR _k.disabled_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'HTTP_ACCESS_DENIED' USING ERRCODE='P0005';
 END IF;
END $$;

-- Exact public DTO, never a sanitizer for an arbitrary provider blob.
CREATE OR REPLACE FUNCTION aiag_http_validate_response(_route TEXT,_body JSONB,_usage JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _choice JSONB; _u JSONB; _p NUMERIC; _c NUMERIC; _t NUMERIC; _cached NUMERIC;
 _item JSONB; _component JSONB; _index INTEGER; _inputs NUMERIC; _original JSONB := _body;
 _event JSONB; _event_no INTEGER:=0; _stream_id TEXT; _stream_model TEXT; _stream_created NUMERIC; _current_created NUMERIC;
 _stream_content TEXT:=''; _stream_finish TEXT; _seen_usage BOOLEAN:=FALSE; _delta JSONB;
BEGIN
 IF octet_length(convert_to(_body::text,'UTF8'))>1048576 THEN
  RAISE EXCEPTION 'HTTP_RESULT_TOO_LARGE' USING ERRCODE='P0001'; END IF;
 IF _route='chat' AND _body->'object' IS NOT DISTINCT FROM '"aiag.chat.stream.v1"'::jsonb THEN
  IF NOT aiag_quota_keys(_body,ARRAY['object','events','final']) OR jsonb_typeof(_body->'events') IS DISTINCT FROM 'array'
  OR jsonb_array_length(_body->'events') NOT BETWEEN 2 AND 4096 OR jsonb_typeof(_body->'final') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
  FOR _event IN SELECT value FROM jsonb_array_elements(_body->'events') LOOP
   _event_no:=_event_no+1;
   IF octet_length(convert_to(_event::text,'UTF8'))>65536 OR NOT (aiag_quota_keys(_event,ARRAY['id','object','created','model','choices']) OR aiag_quota_keys(_event,ARRAY['id','object','created','model','choices','usage']))
   OR _event->'object' IS DISTINCT FROM '"chat.completion.chunk"'::jsonb OR jsonb_typeof(_event->'id') IS DISTINCT FROM 'string' OR length(_event->>'id') NOT BETWEEN 1 AND 256 OR (_event->>'id') COLLATE "C" !~ '^[A-Za-z0-9_-]+$'
   OR jsonb_typeof(_event->'model') IS DISTINCT FROM 'string' OR length(_event->>'model') NOT BETWEEN 1 AND 256 OR (_event->>'model') COLLATE "C" !~ '^[A-Za-z0-9_./:@+-]+$' OR jsonb_typeof(_event->'choices') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
   BEGIN _current_created:=aiag_quota_count(_event->'created'); EXCEPTION WHEN SQLSTATE 'P0001' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END;
   IF _stream_id IS NULL THEN _stream_id:=_event->>'id'; _stream_model:=_event->>'model'; _stream_created:=_current_created; ELSIF _event->>'id' IS DISTINCT FROM _stream_id OR _event->>'model' IS DISTINCT FROM _stream_model OR _current_created IS DISTINCT FROM _stream_created THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
   IF _event ? 'usage' THEN
    IF _seen_usage OR _stream_finish IS NULL OR _event_no<>jsonb_array_length(_body->'events') OR jsonb_array_length(_event->'choices')<>0 OR NOT (aiag_quota_keys(_event->'usage',ARRAY['prompt_tokens','completion_tokens','total_tokens']) OR aiag_quota_keys(_event->'usage',ARRAY['prompt_tokens','completion_tokens','total_tokens','cached_input_tokens'])) THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
    _u:=_event->'usage'; BEGIN _p:=aiag_quota_count(_u->'prompt_tokens'); _c:=aiag_quota_count(_u->'completion_tokens'); _t:=aiag_quota_count(_u->'total_tokens'); IF _u ? 'cached_input_tokens' THEN _cached:=aiag_quota_count(_u->'cached_input_tokens'); END IF; EXCEPTION WHEN SQLSTATE 'P0001' THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END;
    IF _t<>_p+_c OR (_cached IS NOT NULL AND _cached>_p) OR _u->'prompt_tokens' IS DISTINCT FROM _usage->'usage'->'promptTokens' OR _u->'completion_tokens' IS DISTINCT FROM _usage->'usage'->'completionTokens' OR _u->'total_tokens' IS DISTINCT FROM _usage->'usage'->'totalTokens' OR (_u ? 'cached_input_tokens' AND _u->'cached_input_tokens' IS DISTINCT FROM _usage->'usage'->'cachedInputTokens') THEN RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF; _seen_usage:=TRUE;
   ELSE
    IF _seen_usage OR _stream_finish IS NOT NULL OR jsonb_array_length(_event->'choices')<>1 THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF; _choice:=_event->'choices'->0; _delta:=_choice->'delta';
    IF NOT aiag_quota_keys(_choice,ARRAY['index','delta','finish_reason']) OR aiag_quota_count(_choice->'index')<>0 OR jsonb_typeof(_delta) IS DISTINCT FROM 'object' OR NOT (aiag_quota_keys(_delta,ARRAY[]::TEXT[]) OR aiag_quota_keys(_delta,ARRAY['role']) OR aiag_quota_keys(_delta,ARRAY['content'])) OR (_delta ? 'role' AND _delta->'role' IS DISTINCT FROM '"assistant"'::jsonb) OR (_delta ? 'content' AND (jsonb_typeof(_delta->'content') IS DISTINCT FROM 'string' OR _delta->>'content'='')) OR (_choice->'finish_reason' IS NOT DISTINCT FROM 'null'::jsonb AND aiag_quota_keys(_delta,ARRAY[]::TEXT[])) OR (_choice->'finish_reason' IS DISTINCT FROM 'null'::jsonb AND (_choice->>'finish_reason' NOT IN('stop','length','content_filter') OR NOT aiag_quota_keys(_delta,ARRAY[]::TEXT[]))) THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
    IF _delta ? 'role' AND _event_no<>1 THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF; IF _delta ? 'content' THEN _stream_content:=_stream_content||(_delta->>'content'); IF octet_length(convert_to(_stream_content,'UTF8'))>524288 THEN RAISE EXCEPTION 'HTTP_RESULT_TOO_LARGE' USING ERRCODE='P0001'; END IF; END IF; IF _choice->'finish_reason' IS DISTINCT FROM 'null'::jsonb THEN IF _stream_finish IS NOT NULL THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF; _stream_finish:=_choice->>'finish_reason'; END IF;
   END IF;
  END LOOP;
  IF NOT _seen_usage OR _stream_finish IS NULL THEN RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF; PERFORM aiag_http_validate_response('chat',_body->'final',_usage);
  IF _body->'final'->'id' IS DISTINCT FROM to_jsonb(_stream_id) OR _body->'final'->'model' IS DISTINCT FROM to_jsonb(_stream_model) OR _body->'final'->'created' IS DISTINCT FROM to_jsonb(_stream_created) OR _body->'final'->'choices'->0->'message'->'content' IS DISTINCT FROM to_jsonb(_stream_content) OR _body->'final'->'choices'->0->'finish_reason' IS DISTINCT FROM to_jsonb(_stream_finish) OR _body->'final'->'usage' IS DISTINCT FROM _u THEN RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
  RETURN encode(sha256(convert_to(_original::text,'UTF8')),'hex');
 END IF;
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
 IF _route='completions' THEN
  IF NOT aiag_quota_keys(_body,ARRAY['id','object','created','model','choices','usage'])
  OR _body->'object' IS DISTINCT FROM '"text_completion"'::jsonb
  OR jsonb_typeof(_body->'choices') IS DISTINCT FROM 'array'
  OR jsonb_array_length(_body->'choices')<>1 THEN
   RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
  _choice:=_body->'choices'->0;
  IF NOT aiag_quota_keys(_choice,ARRAY['text','index','logprobs','finish_reason'])
  OR jsonb_typeof(_choice->'text') IS DISTINCT FROM 'string'
  OR _choice->'logprobs' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'INVALID_HTTP_RESULT' USING ERRCODE='P0001'; END IF;
  _body:=jsonb_build_object(
   'id',_body->'id','object','chat.completion','created',_body->'created','model',_body->'model',
   'choices',jsonb_build_array(jsonb_build_object(
    'index',_choice->'index','message',jsonb_build_object('role','assistant','content',_choice->'text'),
    'finish_reason',_choice->'finish_reason')),
   'usage',_body->'usage');
  _route:='chat';
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
 RETURN encode(sha256(convert_to(_original::text,'UTF8')),'hex');
END $$;

-- Backward-compatible chat validator for established callers.
CREATE OR REPLACE FUNCTION aiag_http_validate_response(_body JSONB,_usage JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
 SELECT aiag_http_validate_response('chat',_body,_usage)
$$;

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

CREATE OR REPLACE FUNCTION aiag_http_immutable_request()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION aiag_http_immutable_result()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF (to_jsonb(NEW)-ARRAY['response_body','payload_expired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['response_body','payload_expired_at'])
 OR OLD.response_body IS NULL OR OLD.payload_expired_at IS NOT NULL OR NEW.response_body IS NOT NULL
 OR NEW.payload_expired_at IS NULL OR NEW.payload_expired_at<OLD.expires_at OR OLD.expires_at>clock_timestamp()
 OR NEW.payload_expired_at>clock_timestamp() THEN
  RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gateway_http_request_immutable ON gateway_http_requests;
CREATE TRIGGER gateway_http_request_immutable BEFORE UPDATE ON gateway_http_requests FOR EACH ROW EXECUTE FUNCTION aiag_http_immutable_request();
DROP TRIGGER IF EXISTS gateway_http_result_immutable ON gateway_http_results;
CREATE TRIGGER gateway_http_result_immutable BEFORE UPDATE ON gateway_http_results FOR EACH ROW EXECUTE FUNCTION aiag_http_immutable_result();

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

CREATE OR REPLACE FUNCTION aiag_expire_gateway_http_result_v1(_org_id UUID,_billing_request_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE _changed UUID;
BEGIN
 IF _org_id IS NULL OR _billing_request_id IS NULL THEN RAISE EXCEPTION 'INVALID_HTTP_REQUEST' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text,0));
 PERFORM 1 FROM gateway_charge_admissions WHERE billing_request_id=_billing_request_id FOR UPDATE;
 PERFORM 1 FROM gateway_http_requests WHERE billing_request_id=_billing_request_id AND org_id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 UPDATE gateway_http_results SET response_body=NULL,payload_expired_at=clock_timestamp()
 WHERE billing_request_id=_billing_request_id AND org_id=_org_id AND response_body IS NOT NULL
 AND payload_expired_at IS NULL AND expires_at<=clock_timestamp() RETURNING billing_request_id INTO _changed;
 RETURN _changed IS NOT NULL;
END $$;
