-- 0083_gateway_media_claim_state.sql
-- Distinguish durable identity claim from provider-submitted queue ownership.

CREATE OR REPLACE FUNCTION aiag_claim_media_job_v1(
  _org_id UUID, _api_key_id UUID, _billing_request_id UUID, _task_id VARCHAR,
  _route_kind VARCHAR, _idempotency_key_digest TEXT, _request_fingerprint TEXT,
  _model_slug VARCHAR, _upstream_id VARCHAR, _model_upstream_id UUID,
  _provider_family VARCHAR, _quoted_retail BIGINT, _quoted_supplier BIGINT,
  _deadline_at TIMESTAMPTZ, _input JSONB
) RETURNS TABLE(
  id UUID, task_id VARCHAR, billing_request_id UUID, did_claim BOOLEAN
) LANGUAGE plpgsql AS $$
DECLARE _row prediction_jobs%ROWTYPE;
BEGIN
  IF _org_id IS NULL OR _api_key_id IS NULL OR _billing_request_id IS NULL
     OR _task_id IS NULL OR _task_id !~ '^task_[0-9a-f]{32}$'
     OR _route_kind NOT IN ('image','video','audio_speech')
     OR _idempotency_key_digest !~ '^[0-9a-f]{64}$'
     OR _request_fingerprint !~ '^[0-9a-f]{64}$'
     OR _model_slug IS NULL OR btrim(_model_slug)='' OR length(_model_slug)>128
     OR _upstream_id IS NULL OR btrim(_upstream_id)='' OR length(_upstream_id)>64
     OR _model_upstream_id IS NULL
     OR _provider_family NOT IN ('image','video','suno')
     OR _quoted_retail IS NULL OR _quoted_retail <= 0
     OR _quoted_supplier IS NULL OR _quoted_supplier <= 0
     OR _quoted_supplier > _quoted_retail
     OR _deadline_at IS NULL OR _deadline_at <= now()
     OR _input IS NULL OR jsonb_typeof(_input) <> 'object'
  THEN RAISE EXCEPTION 'INVALID_MEDIA_JOB' USING ERRCODE='P0005'; END IF;

  PERFORM aiag_http_require_key(_org_id,_api_key_id,TRUE);

  SELECT * INTO _row FROM prediction_jobs
   WHERE org_id=_org_id AND api_key_id=_api_key_id
     AND route_kind=_route_kind AND idempotency_key_digest=_idempotency_key_digest
     AND contract_version=4
   FOR UPDATE;
  IF FOUND THEN
    IF _row.request_fingerprint IS DISTINCT FROM _request_fingerprint
       OR _row.model_slug IS DISTINCT FROM _model_slug
       OR _row.upstream_id IS DISTINCT FROM _upstream_id
       OR _row.model_upstream_id IS DISTINCT FROM _model_upstream_id
       OR _row.provider_family IS DISTINCT FROM _provider_family
       OR _row.quoted_retail_microcredits IS DISTINCT FROM _quoted_retail
       OR _row.quoted_supplier_microcredits IS DISTINCT FROM _quoted_supplier
    THEN RAISE EXCEPTION 'MEDIA_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
    RETURN QUERY SELECT _row.id,_row.task_id,_row.billing_request_id,FALSE;
    RETURN;
  END IF;

  INSERT INTO prediction_jobs(
    task_id,org_id,api_key_id,model_slug,upstream_id,status,input,
    billing_request_id,route_kind,billing_mode,contract_version,
    idempotency_key_digest,request_fingerprint,model_upstream_id,provider_family,
    quoted_retail_microcredits,quoted_supplier_microcredits,deadline_at
  ) VALUES (
    _task_id,_org_id,_api_key_id,_model_slug,_upstream_id,'claimed',_input,
    _billing_request_id,_route_kind,'stored',4,
    _idempotency_key_digest,_request_fingerprint,_model_upstream_id,_provider_family,
    _quoted_retail,_quoted_supplier,_deadline_at
  ) RETURNING * INTO _row;
  RETURN QUERY SELECT _row.id,_row.task_id,_row.billing_request_id,TRUE;
END $$;

CREATE OR REPLACE FUNCTION aiag_attach_media_provider_task_v1(
  _org_id UUID,_job_id UUID,_billing_request_id UUID,_provider_task_id VARCHAR
) RETURNS TABLE(id UUID, task_id VARCHAR, provider_task_id VARCHAR) LANGUAGE plpgsql AS $$
DECLARE _row prediction_jobs%ROWTYPE;
BEGIN
  IF _provider_task_id IS NULL OR btrim(_provider_task_id)='' OR length(_provider_task_id)>256
  THEN RAISE EXCEPTION 'INVALID_MEDIA_PROVIDER_TASK' USING ERRCODE='P0005'; END IF;
  SELECT p.* INTO _row FROM prediction_jobs p
   WHERE p.id=_job_id AND p.org_id=_org_id AND p.billing_request_id=_billing_request_id
     AND p.contract_version=4 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_JOB_NOT_FOUND' USING ERRCODE='P0005'; END IF;
  IF _row.provider_task_id IS NOT NULL AND _row.provider_task_id IS DISTINCT FROM _provider_task_id
  THEN RAISE EXCEPTION 'MEDIA_PROVIDER_TASK_CONFLICT' USING ERRCODE='P0005'; END IF;
  UPDATE prediction_jobs p SET provider_task_id=COALESCE(p.provider_task_id,_provider_task_id),
    upstream_task_id=COALESCE(p.upstream_task_id,_provider_task_id), status=CASE WHEN p.status='claimed' THEN 'queued' ELSE p.status END
   WHERE p.id=_row.id RETURNING p.* INTO _row;
  RETURN QUERY SELECT _row.id,_row.task_id,_row.provider_task_id;
END $$;
