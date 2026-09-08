BEGIN;
-- Append-only correction: normalize frozen-evidence conflicts, never settlement failures.
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
 -- Only frozen-evidence validation is translated. Settlement/transport errors remain untouched.
 BEGIN
  IF _q.supplier_actual_usd_micro IS DISTINCT FROM aiag_quota_supplier_actual(_a,_a.actual_cost_credits,_a.usage_snapshot) THEN
   RAISE EXCEPTION 'HTTP_RESULT_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;
  IF _result.response_body IS NOT NULL THEN
   IF _result.payload_expired_at IS NOT NULL OR _result.response_digest IS DISTINCT FROM aiag_http_validate_response(_result.response_body,_a.usage_snapshot) THEN
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
