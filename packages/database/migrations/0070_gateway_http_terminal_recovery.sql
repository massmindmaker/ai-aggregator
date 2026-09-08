BEGIN;
CREATE TABLE IF NOT EXISTS gateway_http_rejections (
 billing_request_id UUID PRIMARY KEY,
 org_id UUID NOT NULL,
 api_key_id UUID NOT NULL,
 result_version SMALLINT NOT NULL CHECK(result_version=1),
 rejection_code TEXT NOT NULL,
 http_status SMALLINT NOT NULL,
 content_type TEXT NOT NULL CHECK(content_type='application/json'),
 response_body JSONB NOT NULL CHECK(jsonb_typeof(response_body)='object' AND octet_length(convert_to(response_body::text,'UTF8'))<=2048),
 terminal_at TIMESTAMPTZ NOT NULL CHECK(isfinite(terminal_at)),
 CONSTRAINT gateway_http_rejections_request_owner_fk FOREIGN KEY(org_id,api_key_id,billing_request_id) REFERENCES gateway_http_requests(org_id,api_key_id,billing_request_id) ON DELETE RESTRICT,
 CONSTRAINT gateway_http_rejections_key_owner_fk FOREIGN KEY(org_id,api_key_id) REFERENCES gateway_api_keys(org_id,id) ON DELETE RESTRICT
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_type WHERE typname='gateway_http_admit_result_v1' AND typnamespace='public'::regnamespace) THEN
  CREATE TYPE gateway_http_admit_result_v1 AS (org_id UUID,api_key_id UUID,billing_request_id UUID,status TEXT,admission gateway_charge_admission_result,rejection_code TEXT,http_status SMALLINT,response_body JSONB,terminal_at TIMESTAMPTZ,did_transition BOOLEAN);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_type WHERE typname='gateway_http_read_result_v2' AND typnamespace='public'::regnamespace) THEN
  CREATE TYPE gateway_http_read_result_v2 AS (contract_version SMALLINT,status TEXT,billing_request_id UUID,http_status SMALLINT,content_type TEXT,response_body JSONB,actual_cost_credits BIGINT,stored_at TIMESTAMPTZ,expires_at TIMESTAMPTZ,rejection_code TEXT);
 END IF;
END $$;
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
   _out.contract_version:=1; _out.status:='rejected'; _out.billing_request_id:=_id;
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
 OR _r.route_kind IS DISTINCT FROM 'chat' OR _r.billing_mode IS DISTINCT FROM 'stored' OR _r.contract_version IS DISTINCT FROM 1
 OR _a.route_kind IS DISTINCT FROM 'chat' OR _a.billing_mode IS DISTINCT FROM 'stored'
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
 IF _q.supplier_actual_usd_micro IS DISTINCT FROM aiag_quota_supplier_actual(_a,_a.actual_cost_credits,_a.usage_snapshot) THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 IF _result.response_body IS NOT NULL THEN
  IF _result.payload_expired_at IS NOT NULL OR _result.response_digest IS DISTINCT FROM aiag_http_validate_response(_result.response_body,_a.usage_snapshot) THEN
   RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
 ELSIF _result.payload_expired_at IS NULL OR _result.expires_at>clock_timestamp()
 OR _result.payload_expired_at<_result.expires_at OR _result.payload_expired_at>clock_timestamp() THEN
  RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005';
 END IF;
 -- No provider/outcome/hold/cancel; the existing financial algorithm is the only writer.
 RETURN QUERY SELECT * FROM aiag_settle_admitted_gateway_charge(_org_id,_billing_request_id);
END $$;

ALTER TABLE gateway_http_rejections ADD CONSTRAINT gateway_http_rejections_fixed_result_check
 CHECK(http_status=aiag_http_rejection_status_v1(rejection_code) AND response_body=aiag_http_rejection_body_v1(rejection_code));
-- UPDATE immutability only. Existing FK DELETE semantics and guarded fixture cleanup are retained.
CREATE TRIGGER gateway_http_rejection_immutable BEFORE UPDATE ON gateway_http_rejections FOR EACH ROW EXECUTE FUNCTION aiag_http_immutable_request();
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
   IF _billing_mode='stored' AND _route_kind IS DISTINCT FROM 'chat' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
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

COMMIT;
