-- Durable STT infrastructure. Model remains depublished until explicit release activation.
BEGIN;


INSERT INTO upstreams(id,provider,ru_residency,enabled,latency_p50_ms,uptime,base_url,metadata)
VALUES('groq','groq',FALSE,FALSE,250,0.99,'https://api.groq.com/openai/v1',
 jsonb_build_object('docs','https://console.groq.com/docs/speech-to-text','reviewed_contract','groq-whisper-pcm-wav-v1'))
ON CONFLICT(id) DO NOTHING;

UPDATE model_upstreams mu SET enabled=FALSE
FROM models m
WHERE mu.model_id=m.id AND m.slug='whisper-large-v3' AND mu.upstream_id<>'groq';

INSERT INTO model_upstreams(
 model_id,upstream_id,upstream_model_id,price_per_1k_input,price_per_1k_output,
 price_per_audio_sec,markup,enabled)
SELECT m.id,'groq','whisper-large-v3',0,0,0.0030833333,1.8000,FALSE
FROM models m WHERE m.slug='whisper-large-v3'
ON CONFLICT(model_id,upstream_id) DO UPDATE SET
 upstream_model_id=EXCLUDED.upstream_model_id,
 price_per_audio_sec=EXCLUDED.price_per_audio_sec,
 markup=EXCLUDED.markup,
 enabled=FALSE;


CREATE OR REPLACE FUNCTION aiag_valid_transcription_job_input(_input JSONB,_model TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _bytes NUMERIC; _rate NUMERIC; _channels NUMERIC; _bits NUMERIC;
 _frames NUMERIC; _duration NUMERIC; _billable NUMERIC; _expected_duration NUMERIC;
BEGIN
 IF _model<>'whisper-large-v3' OR _input IS NULL OR jsonb_typeof(_input)<>'object'
 OR NOT aiag_quota_keys(_input,ARRAY[
   'model','language','format','parserContract','fileSha256','byteLength','sampleRate','channels',
   'bitsPerSample','frames','durationMs','billableMs'])
 OR (_input->>'model') IS DISTINCT FROM _model
 OR (_input->>'format') IS DISTINCT FROM 'pcm_wav'
 OR (_input->>'parserContract') IS DISTINCT FROM 'pcm-wav-riff-v1'
 OR coalesce(_input->>'fileSha256','') !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(_input->'language') NOT IN('string','null')
 OR (jsonb_typeof(_input->'language')='string' AND (_input->>'language') !~ '^[a-z]{2}$')
 THEN RETURN FALSE; END IF;
 BEGIN
  _bytes:=aiag_quota_count(_input->'byteLength',TRUE);
  _rate:=aiag_quota_count(_input->'sampleRate',TRUE);
  _channels:=aiag_quota_count(_input->'channels',TRUE);
  _bits:=aiag_quota_count(_input->'bitsPerSample',TRUE);
  _frames:=aiag_quota_count(_input->'frames',TRUE);
  _duration:=aiag_quota_count(_input->'durationMs',TRUE);
  _billable:=aiag_quota_count(_input->'billableMs',TRUE);
 EXCEPTION WHEN OTHERS THEN RETURN FALSE;
 END;
 IF _bytes<44 OR _bytes>25000000 OR _rate<8000 OR _rate>192000
 OR _channels NOT IN(1,2) OR _bits NOT IN(8,16,24,32) OR _frames<=0
 OR _bytes < 44 + (_frames*_channels*_bits/8)
 THEN RETURN FALSE; END IF;
 _expected_duration:=ceil(_frames*1000/_rate);
 IF _duration<>_expected_duration OR _duration<1 OR _duration>7200000
 OR _billable<>greatest(10000,_duration)
 THEN RETURN FALSE; END IF;
 RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION aiag_guard_transcription_prediction_job_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _old_stt BOOLEAN:=FALSE; _new_stt BOOLEAN:=FALSE; _digest TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN
  _old_stt:=OLD.contract_version=4 AND OLD.route_kind='audio_transcription';
 END IF;
 IF TG_OP<>'DELETE' THEN
  _new_stt:=NEW.contract_version=4 AND NEW.route_kind='audio_transcription';
 END IF;
 IF TG_OP='DELETE' THEN
  IF _old_stt AND NOT (
    OLD.status='claimed'
    AND NOT EXISTS(
      SELECT 1 FROM gateway_charge_admissions a
       WHERE a.billing_request_id=OLD.billing_request_id
    )
  ) THEN RAISE EXCEPTION 'STT_JOB_IMMUTABLE' USING ERRCODE='P0005'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND _old_stt AND (
   NOT _new_stt
   OR (to_jsonb(NEW)-ARRAY['status','output','completed_at','result_digest','settled_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','output','completed_at','result_digest','settled_at'])
 ) THEN RAISE EXCEPTION 'STT_JOB_IMMUTABLE' USING ERRCODE='P0005'; END IF;
 IF _new_stt AND (
   NEW.billing_mode<>'stored' OR NEW.provider_family<>'groq_stt'
   OR NEW.upstream_id<>'groq' OR NEW.provider_task_id IS NOT NULL
   OR NEW.model_upstream_id IS NULL
   OR NEW.quoted_retail_microcredits IS NULL OR NEW.quoted_retail_microcredits<=0
   OR NEW.quoted_supplier_microcredits IS NULL OR NEW.quoted_supplier_microcredits<=0
   OR NEW.quoted_supplier_microcredits>NEW.quoted_retail_microcredits
   OR NEW.deadline_at IS NULL OR NOT isfinite(NEW.deadline_at)
   OR NOT aiag_valid_transcription_job_input(NEW.input,NEW.model_slug)
 ) THEN RAISE EXCEPTION 'INVALID_STT_JOB' USING ERRCODE='P0005'; END IF;
 IF TG_OP='INSERT' THEN
  IF _new_stt AND (
    NEW.status<>'claimed' OR NEW.output IS NOT NULL OR NEW.error_message IS NOT NULL
    OR NEW.completed_at IS NOT NULL OR NEW.result_digest IS NOT NULL OR NEW.settled_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'INVALID_STT_JOB_STATE' USING ERRCODE='P0005'; END IF;
  RETURN NEW;
 END IF;
 IF _old_stt THEN
  IF OLD.status='claimed' THEN
   IF NEW.status NOT IN('claimed','completed') THEN RAISE EXCEPTION 'STT_JOB_INVALID_TRANSITION' USING ERRCODE='P0005'; END IF;
  ELSIF OLD.status='completed' THEN
   IF NEW.status<>'completed' THEN RAISE EXCEPTION 'STT_JOB_INVALID_TRANSITION' USING ERRCODE='P0005'; END IF;
  ELSE
   RAISE EXCEPTION 'STT_JOB_INVALID_TRANSITION' USING ERRCODE='P0005';
  END IF;
  IF OLD.output IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output
  OR OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at
  OR OLD.result_digest IS NOT NULL AND NEW.result_digest IS DISTINCT FROM OLD.result_digest
  OR OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at
  THEN RAISE EXCEPTION 'STT_JOB_IMMUTABLE' USING ERRCODE='P0005'; END IF;
  IF OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM gateway_charge_admissions a
     WHERE a.billing_request_id=NEW.billing_request_id
       AND a.org_id=NEW.org_id AND a.api_key_id=NEW.api_key_id
       AND a.route_kind='audio_transcription' AND a.billing_mode='stored'
       AND a.state='settled'
  ) THEN RAISE EXCEPTION 'STT_JOB_INVALID_SETTLEMENT' USING ERRCODE='P0005'; END IF;
  IF NEW.status='claimed' AND (
    NEW.output IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.result_digest IS NOT NULL OR NEW.settled_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'STT_JOB_INVALID_TRANSITION' USING ERRCODE='P0005'; END IF;
  IF NEW.status='completed' THEN
   IF NEW.output IS NULL OR jsonb_typeof(NEW.output)<>'object'
   OR NOT aiag_quota_keys(NEW.output,ARRAY['text'])
   OR jsonb_typeof(NEW.output->'text')<>'string'
   OR octet_length(convert_to(NEW.output->>'text','UTF8'))>1000000
   OR NEW.completed_at IS NULL OR NEW.result_digest IS NULL
   THEN RAISE EXCEPTION 'INVALID_TRANSCRIPTION_RESULT' USING ERRCODE='P0005'; END IF;
   _digest:=encode(sha256(convert_to(NEW.output::text,'UTF8')),'hex');
   IF NEW.result_digest IS DISTINCT FROM _digest THEN RAISE EXCEPTION 'TRANSCRIPTION_RESULT_CONFLICT' USING ERRCODE='P0005'; END IF;
   IF OLD.status='claimed' AND NOT EXISTS(
    SELECT 1 FROM gateway_charge_admissions a
     WHERE a.billing_request_id=NEW.billing_request_id
       AND a.org_id=NEW.org_id AND a.api_key_id=NEW.api_key_id
       AND a.route_kind='audio_transcription' AND a.billing_mode='stored'
       AND a.state IN('dispatched','outcome_recorded','settled')
       AND a.attempt_id IS NOT NULL AND a.pricing_snapshot IS NOT NULL
   ) THEN RAISE EXCEPTION 'STT_JOB_INVALID_TRANSITION' USING ERRCODE='P0005'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER transcription_prediction_job_guard_v1
BEFORE INSERT OR UPDATE OR DELETE ON prediction_jobs
FOR EACH ROW EXECUTE FUNCTION aiag_guard_transcription_prediction_job_v1();
REVOKE EXECUTE ON FUNCTION aiag_valid_transcription_job_input(JSONB,TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION aiag_guard_transcription_prediction_job_v1() FROM PUBLIC;

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
     OR _route_kind NOT IN ('image','video','audio_speech','audio_transcription')
     OR _idempotency_key_digest !~ '^[0-9a-f]{64}$'
     OR _request_fingerprint !~ '^[0-9a-f]{64}$'
     OR _model_slug IS NULL OR btrim(_model_slug)='' OR length(_model_slug)>128
     OR _upstream_id IS NULL OR btrim(_upstream_id)='' OR length(_upstream_id)>64
     OR _model_upstream_id IS NULL
     OR _provider_family NOT IN ('image','video','suno','groq_stt')
     OR _quoted_retail IS NULL OR _quoted_retail <= 0
     OR _quoted_supplier IS NULL OR _quoted_supplier <= 0
     OR _quoted_supplier > _quoted_retail
     OR _deadline_at IS NULL OR _deadline_at <= now()
     OR _input IS NULL OR jsonb_typeof(_input) <> 'object'
  THEN RAISE EXCEPTION 'INVALID_MEDIA_JOB' USING ERRCODE='P0005'; END IF;

  IF _route_kind='audio_transcription' AND (
    _provider_family<>'groq_stt'
    OR NOT aiag_valid_transcription_job_input(_input,_model_slug)
    OR NOT EXISTS(
      SELECT 1 FROM model_upstreams mu
      JOIN models m ON m.id=mu.model_id
      JOIN upstreams u ON u.id=mu.upstream_id
       WHERE mu.id=_model_upstream_id
         AND m.slug=_model_slug
         AND mu.upstream_id=_upstream_id
         AND mu.upstream_model_id=_model_slug
         AND mu.enabled=TRUE AND u.enabled=TRUE
         AND u.provider='groq'
    )
  ) THEN RAISE EXCEPTION 'MEDIA_CAPABILITY_UNAVAILABLE' USING ERRCODE='P0005'; END IF;

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
       OR (_route_kind='audio_transcription' AND _row.input IS DISTINCT FROM _input)
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


CREATE OR REPLACE FUNCTION aiag_transcription_quote_values(_q JSONB,_model TEXT)
RETURNS NUMERIC[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _ms NUMERIC; _rate NUMERIC; _markup NUMERIC; _supplier_usd NUMERIC;
 _supplier_credits NUMERIC; _retail NUMERIC;
BEGIN
 IF NOT aiag_quota_keys(_q,ARRAY[
   'version','formulaVersion','routeKind','modelSlug','modelUpstreamId',
   'upstreamId','upstreamModelId','providerFamily','billableMs',
   'rateUsdMicroPerHour','markup','supplierMaxMicrocredits',
   'supplierMaxUsdMicro','authorizedMaxCredits'])
 OR _q->'version' IS DISTINCT FROM '1'::jsonb
 OR (_q->>'formulaVersion') IS DISTINCT FROM 'groq-whisper-duration-v1'
 OR (_q->>'routeKind') IS DISTINCT FROM 'audio_transcription'
 OR (_q->>'modelSlug') IS DISTINCT FROM _model
 OR (_q->>'upstreamId') IS DISTINCT FROM 'groq'
 OR (_q->>'upstreamModelId') IS DISTINCT FROM _model
 OR (_q->>'providerFamily') IS DISTINCT FROM 'groq_stt'
 OR coalesce(_q->>'modelUpstreamId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'INVALID_TRANSCRIPTION_QUOTE'; END IF;
 _ms:=aiag_quota_count(_q->'billableMs',TRUE);
 _rate:=aiag_quota_count(_q->'rateUsdMicroPerHour',TRUE);
 _markup:=aiag_quota_decimal(_q->'markup');
 IF _ms<10000 OR _ms>7200000 OR _markup<1.20
 OR _model<>'whisper-large-v3' OR _rate<>111000
 THEN RAISE EXCEPTION 'INVALID_TRANSCRIPTION_QUOTE'; END IF;
 _supplier_usd:=ceil(_rate*_ms/3600000);
 _supplier_credits:=ceil(_supplier_usd/10);
 _retail:=ceil((_supplier_usd/10)*_markup);
 IF aiag_quota_money(aiag_quota_decimal(_q->'supplierMaxMicrocredits',TRUE))<>_supplier_credits
 OR aiag_quota_money(aiag_quota_decimal(_q->'supplierMaxUsdMicro',TRUE))<>_supplier_usd
 OR aiag_quota_money(aiag_quota_decimal(_q->'authorizedMaxCredits',TRUE))<>_retail
 THEN RAISE EXCEPTION 'INVALID_TRANSCRIPTION_QUOTE'; END IF;
 RETURN ARRAY[_retail,_supplier_credits,_supplier_usd];
END $$;

CREATE OR REPLACE FUNCTION aiag_quota_supplier_max(_mode TEXT,_model TEXT,_max BIGINT,_quote JSONB,_supplier JSONB)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE _q JSONB; _c JSONB; _v NUMERIC[]; _retail NUMERIC:=0; _s NUMERIC:=0; _discount NUMERIC; _base NUMERIC; _m NUMERIC;
BEGIN
 IF _mode='stored' AND (_supplier->>'formulaVersion')='author-share-usd-micro-v1' THEN
  IF NOT aiag_quota_keys(_supplier,ARRAY['version','formulaVersion','authorQuote']) OR _supplier->'version' IS DISTINCT FROM '2'::jsonb
   OR NOT aiag_quota_keys(_quote,ARRAY['version','authorQuote']) OR _quote->'version' IS DISTINCT FROM '1'::jsonb
   OR _quote->'authorQuote' IS DISTINCT FROM _supplier->'authorQuote' THEN RAISE EXCEPTION 'AUTHOR_QUOTE_INVALID'; END IF;
  _v:=aiag_author_quote_values(_quote->'authorQuote',_model);
  IF _max IS DISTINCT FROM _v[1] THEN RAISE EXCEPTION 'INVALID_CHARGED_MAXIMUM'; END IF;
  RETURN _v[2]::bigint;
 END IF;
 IF _mode='stored' AND (_supplier->>'formulaVersion')='groq-whisper-duration-usd-micro-v1' THEN
  IF NOT aiag_quota_keys(_supplier,ARRAY['version','formulaVersion','transcriptionQuote'])
   OR _supplier->'version' IS DISTINCT FROM '2'::jsonb
   OR NOT aiag_quota_keys(_quote,ARRAY['version','transcriptionQuote'])
   OR _quote->'version' IS DISTINCT FROM '1'::jsonb
   OR _supplier->'transcriptionQuote' IS DISTINCT FROM _quote->'transcriptionQuote'
  THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
  _q:=_quote->'transcriptionQuote';
  _v:=aiag_transcription_quote_values(_q,_model);
  IF _max IS DISTINCT FROM _v[1]::bigint THEN RAISE EXCEPTION 'INVALID_CHARGED_MAXIMUM'; END IF;
  IF NOT EXISTS(
    SELECT 1
      FROM model_upstreams mu
      JOIN models m ON m.id=mu.model_id
      JOIN upstreams u ON u.id=mu.upstream_id
     WHERE mu.id=(_q->>'modelUpstreamId')::uuid
       AND m.slug=_model
       AND mu.upstream_id='groq'
       AND mu.upstream_model_id=_model
       AND u.provider='groq'
       AND u.enabled=TRUE
       AND mu.enabled=TRUE
       AND mu.price_per_audio_sec=0.0030833333::numeric
       AND mu.markup=aiag_quota_decimal(_q->'markup')
  ) THEN RAISE EXCEPTION 'INVALID_TRANSCRIPTION_MAPPING'; END IF;
  RETURN _v[3]::bigint;
 END IF;
 IF _mode='byok_fee' THEN
  IF _supplier IS DISTINCT FROM '{"version":2,"formulaVersion":"byok-zero-v2"}'::jsonb THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
  RETURN 0;
 END IF;
 IF _mode='stored' AND (_supplier->>'formulaVersion')='media-supplier-unit-microcredits-v1' THEN
  IF NOT aiag_quota_keys(_supplier,ARRAY['version','formulaVersion','mediaQuote'])
   OR _supplier->'version' IS DISTINCT FROM '2'::jsonb
   OR NOT aiag_quota_keys(_quote,ARRAY['version','mediaQuote']) OR _quote->'version' IS DISTINCT FROM '1'::jsonb
   OR _supplier->'mediaQuote' IS DISTINCT FROM _quote->'mediaQuote' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
  _q:=_quote->'mediaQuote';
  IF NOT aiag_quota_keys(_q,ARRAY['version','formulaVersion','routeKind','modelSlug','modelUpstreamId','upstreamId','upstreamModelId','providerFamily','units','priceCentsPerUnit','markup','authorizedMaxCredits'])
   OR _q->'version' IS DISTINCT FROM '1'::jsonb OR (_q->>'formulaVersion') IS DISTINCT FROM 'media-unit-microcredits-v1'
   OR coalesce(_q->>'routeKind','') NOT IN('image','video','audio_speech','audio_transcription')
   OR (_q->>'modelSlug') IS DISTINCT FROM _model THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
  _base:=aiag_quota_decimal(_q->'priceCentsPerUnit')*aiag_quota_count(_q->'units',TRUE)*1000;
  _m:=aiag_quota_decimal(_q->'markup');
  IF _base<=0 OR _m<=0 THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
  _s:=ceil(_base)*10; _retail:=ceil(_base*_m);
  IF _max IS DISTINCT FROM aiag_quota_money(_retail) OR aiag_quota_decimal(_q->'authorizedMaxCredits',TRUE)<>_retail THEN RAISE EXCEPTION 'INVALID_CHARGED_MAXIMUM'; END IF;
  RETURN aiag_quota_money(_s);
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
   IF _billing_mode='stored' AND _route_kind NOT IN('chat','embeddings','completions','image','video','audio_speech','audio_transcription') THEN RAISE EXCEPTION 'INVALID_SUPPLIER_QUOTE'; END IF;
   IF _billing_mode='stored' AND _route_kind IN('chat','embeddings','completions') AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(_quote_snapshot->'tokenQuote'->'candidates') c
    WHERE CASE _route_kind WHEN 'chat' THEN c->>'modelType' IS DISTINCT FROM 'chat'
      WHEN 'completions' THEN c->>'modelType' IS DISTINCT FROM 'chat'
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


CREATE OR REPLACE FUNCTION aiag_quota_validate_dispatch(_a gateway_charge_admissions,_upstream TEXT,_pricing JSONB)
RETURNS VOID LANGUAGE plpgsql STABLE AS $$
DECLARE _ctx gateway_charge_quota_contexts%ROWTYPE; _tv NUMERIC[];
BEGIN
 SELECT * INTO _ctx FROM gateway_charge_quota_contexts WHERE billing_request_id=_a.billing_request_id;
 IF NOT FOUND THEN RETURN; END IF;
 IF _ctx.org_id<>_a.org_id OR _ctx.api_key_id<>_a.api_key_id THEN RAISE EXCEPTION 'QUOTA_CONTEXT_CONFLICT'; END IF;
 IF _a.billing_mode='stored' AND (_pricing->>'formulaVersion')='author-fixed-microcredits-v1' THEN
  PERFORM aiag_author_quote_values(_pricing,_a.model_slug);
  IF _pricing IS DISTINCT FROM _a.quote_snapshot->'authorQuote' OR _upstream IS DISTINCT FROM 'author:'||(_pricing->>'versionId')
   OR NOT EXISTS(SELECT 1 FROM author_request_bindings b WHERE b.billing_request_id=_a.billing_request_id AND b.author_quote=_pricing AND b.org_id=_a.org_id AND b.api_key_id=_a.api_key_id)
  THEN RAISE EXCEPTION 'SUPPLIER_DISPATCH_CONFLICT'; END IF;
  RETURN;
 END IF;
 IF _a.billing_mode='stored' AND (_pricing->>'formulaVersion')='groq-whisper-duration-v1' THEN
  _tv:=aiag_transcription_quote_values(_pricing,_a.model_slug);
  IF _pricing IS DISTINCT FROM _a.quote_snapshot->'transcriptionQuote'
   OR _upstream IS DISTINCT FROM 'groq'
   OR _tv[3]::bigint<>_ctx.supplier_authorized_max_usd_micro
  THEN RAISE EXCEPTION 'SUPPLIER_DISPATCH_CONFLICT'; END IF;
  RETURN;
 END IF;
 IF _a.billing_mode='stored' AND (_pricing->>'formulaVersion')='media-unit-microcredits-v1' THEN
  IF NOT aiag_quota_keys(_pricing,ARRAY['version','formulaVersion','routeKind','modelSlug','modelUpstreamId','upstreamId','upstreamModelId','providerFamily','units','priceCentsPerUnit','markup','authorizedMaxCredits','supplierMaxMicrocredits','supplierMaxUsdMicro'])
   OR _pricing->'version' IS DISTINCT FROM '1'::jsonb
   OR (_pricing-'supplierMaxMicrocredits'-'supplierMaxUsdMicro') IS DISTINCT FROM (_a.quote_snapshot->'mediaQuote')
   OR (_pricing->>'upstreamId') IS DISTINCT FROM _upstream
   OR aiag_quota_money(aiag_quota_decimal(_pricing->'supplierMaxUsdMicro',TRUE))<>_ctx.supplier_authorized_max_usd_micro
  THEN RAISE EXCEPTION 'SUPPLIER_DISPATCH_CONFLICT'; END IF;
  RETURN;
 END IF;
 IF _a.billing_mode='stored' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(_ctx.supplier_quote_snapshot->'tokenQuote'->'candidates') c
    WHERE _pricing=c.value||jsonb_build_object('actualChargePolicy',_a.quote_snapshot->'actualChargePolicy') AND c.value->>'upstreamId'=_upstream) THEN RAISE EXCEPTION 'SUPPLIER_DISPATCH_CONFLICT'; END IF;
 ELSE
  -- BYOK evidence is an explicit fixed-fee contract, not a BYOK executor.
  IF NOT aiag_quota_keys(_pricing,ARRAY['version','formulaVersion','upstreamId','feeMicrocredits']) OR _pricing->'version' IS DISTINCT FROM '2'::jsonb
  OR (_pricing->>'formulaVersion') IS DISTINCT FROM 'byok-fee-microcredits-v2' OR (_pricing->>'upstreamId') IS DISTINCT FROM _upstream
  OR aiag_quota_money(aiag_quota_decimal(_pricing->'feeMicrocredits',TRUE))<>_a.authorized_max_credits THEN RAISE EXCEPTION 'SUPPLIER_DISPATCH_CONFLICT'; END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION aiag_quota_supplier_actual(_a gateway_charge_admissions,_actual BIGINT,_usage JSONB)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE _p JSONB; _k TEXT; _prompt NUMERIC; _completion NUMERIC; _total NUMERIC; _cached NUMERIC;
 _i NUMERIC; _o NUMERIC; _m NUMERIC; _d NUMERIC; _base NUMERIC; _charged NUMERIC; _supplier BIGINT; _bounds NUMERIC[]; _tv NUMERIC[];
BEGIN
 PERFORM aiag_quota_validate_dispatch(_a,_a.upstream_id,_a.pricing_snapshot);
 IF _a.billing_mode='stored' AND (_a.pricing_snapshot->>'formulaVersion')='author-fixed-microcredits-v1'
  AND _usage->>'formulaVersion'='author-verified-no-charge-v1' THEN
  IF _actual IS DISTINCT FROM 0 OR NOT aiag_quota_keys(_usage,ARRAY['version','formulaVersion','billingRequestId','attemptId','upstreamId','resolutionId'])
   OR _usage->'version' IS DISTINCT FROM '1'::jsonb OR _usage->>'billingRequestId' IS DISTINCT FROM _a.billing_request_id::text
   OR _usage->>'attemptId' IS DISTINCT FROM _a.attempt_id::text OR _usage->>'upstreamId' IS DISTINCT FROM _a.upstream_id
   OR NOT EXISTS(SELECT 1 FROM author_operator_resolutions r WHERE r.billing_request_id=_a.billing_request_id AND r.attempt_id=_a.attempt_id AND r.id::text=_usage->>'resolutionId' AND r.kind='verified_no_charge')
  THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
  RETURN 0;
 END IF;
 IF _a.billing_mode='stored' AND (_a.pricing_snapshot->>'formulaVersion')='author-fixed-microcredits-v1' THEN
  IF NOT aiag_quota_keys(_usage,ARRAY['version','formulaVersion','billingRequestId','attemptId','upstreamId','verified','responseDigest','completionId','reportedModel','usage'])
   OR _usage->'version' IS DISTINCT FROM '1'::jsonb OR _usage->>'formulaVersion' IS DISTINCT FROM 'author-fixed-microcredits-v1'
   OR _usage->'verified' IS DISTINCT FROM 'true'::jsonb OR _usage->>'billingRequestId' IS DISTINCT FROM _a.billing_request_id::text
   OR _usage->>'attemptId' IS DISTINCT FROM _a.attempt_id::text OR _usage->>'upstreamId' IS DISTINCT FROM _a.upstream_id
   OR coalesce(_usage->>'responseDigest','') !~ '^sha256:[0-9a-f]{64}$' OR _actual IS DISTINCT FROM _a.authorized_max_credits
  THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
  IF _usage->>'reportedModel' IS DISTINCT FROM _a.model_slug OR (coalesce(_usage->>'completionId','') !~ '^[A-Za-z0-9_-]+$' OR length(_usage->>'completionId') NOT BETWEEN 1 AND 256)
   OR NOT aiag_quota_keys(_usage->'usage',ARRAY['promptTokens','completionTokens','totalTokens','cachedInputTokens'])
   OR aiag_quota_count(_usage->'usage'->'totalTokens')<>aiag_quota_count(_usage->'usage'->'promptTokens')+aiag_quota_count(_usage->'usage'->'completionTokens')
   OR _usage->'usage'->'cachedInputTokens' IS DISTINCT FROM '0'::jsonb
  THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
  _bounds:=aiag_author_quote_values(_a.pricing_snapshot,_a.model_slug);
  RETURN _bounds[2]::bigint;
 END IF;
 IF _a.billing_mode='byok_fee' THEN
  IF NOT aiag_quota_keys(_usage,ARRAY['version','formulaVersion','billingRequestId','attemptId','upstreamId','verified'])
  OR _usage->'version' IS DISTINCT FROM '2'::jsonb OR (_usage->>'formulaVersion') IS DISTINCT FROM 'byok-fee-microcredits-v2'
  OR _usage->'verified' IS DISTINCT FROM 'true'::jsonb OR (_usage->>'billingRequestId') IS DISTINCT FROM _a.billing_request_id::text
  OR (_usage->>'attemptId') IS DISTINCT FROM _a.attempt_id::text OR (_usage->>'upstreamId') IS DISTINCT FROM _a.upstream_id
  OR _actual<>_a.authorized_max_credits THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
  RETURN 0;
 END IF;
 IF _a.billing_mode='stored' AND (_a.pricing_snapshot->>'formulaVersion')='groq-whisper-duration-v1' THEN
  IF NOT aiag_quota_keys(_usage,ARRAY['version','formulaVersion','billingRequestId','attemptId','upstreamId','terminalStatus','verified'])
   OR _usage->'version' IS DISTINCT FROM '1'::jsonb
   OR (_usage->>'formulaVersion') IS DISTINCT FROM 'groq-whisper-duration-v1'
   OR (_usage->>'billingRequestId') IS DISTINCT FROM _a.billing_request_id::text
   OR (_usage->>'attemptId') IS DISTINCT FROM _a.attempt_id::text
   OR (_usage->>'upstreamId') IS DISTINCT FROM _a.upstream_id
   OR _usage->'verified' IS DISTINCT FROM 'true'::jsonb
   OR (_usage->>'terminalStatus') IS DISTINCT FROM 'completed'
   OR _actual IS DISTINCT FROM _a.authorized_max_credits
  THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
  _tv:=aiag_transcription_quote_values(_a.pricing_snapshot,_a.model_slug);
  RETURN _tv[3]::bigint;
 END IF;
 IF _a.billing_mode='stored' AND (_a.pricing_snapshot->>'formulaVersion')='media-unit-microcredits-v1' THEN
  IF NOT aiag_quota_keys(_usage,ARRAY['version','formulaVersion','billingRequestId','attemptId','upstreamId','terminalStatus','verified'])
   OR _usage->'version' IS DISTINCT FROM '1'::jsonb OR (_usage->>'formulaVersion') IS DISTINCT FROM 'media-unit-microcredits-v1'
   OR (_usage->>'billingRequestId') IS DISTINCT FROM _a.billing_request_id::text
   OR (_usage->>'attemptId') IS DISTINCT FROM _a.attempt_id::text OR (_usage->>'upstreamId') IS DISTINCT FROM _a.upstream_id
   OR _usage->'verified' IS DISTINCT FROM 'true'::jsonb
   OR coalesce(_usage->>'terminalStatus','') NOT IN('completed','failed')
  THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
  _supplier:=aiag_quota_money(aiag_quota_decimal(_a.pricing_snapshot->'supplierMaxUsdMicro',TRUE));
  IF (_usage->>'terminalStatus')='completed' THEN
   IF _actual<>_a.authorized_max_credits THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
   RETURN _supplier;
  END IF;
  IF _actual<>0 THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
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

CREATE OR REPLACE FUNCTION aiag_record_sync_transcription_result_v1(
  _org_id UUID,_job_id UUID,_billing_request_id UUID,_output JSONB
) RETURNS TABLE(state TEXT,did_record BOOLEAN) LANGUAGE plpgsql VOLATILE AS $$
DECLARE _job prediction_jobs%ROWTYPE; _a gateway_charge_admissions%ROWTYPE;
 _digest TEXT; _recorded BOOLEAN:=FALSE; _tv NUMERIC[];
BEGIN
 IF _org_id IS NULL OR _job_id IS NULL OR _billing_request_id IS NULL
 OR _output IS NULL OR jsonb_typeof(_output)<>'object'
 OR NOT aiag_quota_keys(_output,ARRAY['text'])
 OR jsonb_typeof(_output->'text')<>'string'
 OR octet_length(convert_to(_output->>'text','UTF8'))>1000000
 THEN RAISE EXCEPTION 'INVALID_TRANSCRIPTION_RESULT' USING ERRCODE='P0001'; END IF;

 PERFORM 1 FROM organizations WHERE id=_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_JOB_NOT_FOUND' USING ERRCODE='P0005'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text,0));
 SELECT * INTO _a FROM gateway_charge_admissions
  WHERE billing_request_id=_billing_request_id FOR UPDATE;
 SELECT * INTO _job FROM prediction_jobs
  WHERE id=_job_id AND org_id=_org_id AND billing_request_id=_billing_request_id
    AND contract_version=4 FOR UPDATE;
 IF NOT FOUND OR _job.route_kind<>'audio_transcription'
 OR _job.provider_family<>'groq_stt' OR _job.provider_task_id IS NOT NULL
 OR _a.org_id IS DISTINCT FROM _org_id
 OR _a.api_key_id IS DISTINCT FROM _job.api_key_id
 OR _a.route_kind<>'audio_transcription' OR _a.billing_mode<>'stored'
 OR _a.model_slug IS DISTINCT FROM _job.model_slug
 OR _a.upstream_id IS DISTINCT FROM _job.upstream_id
 OR _a.attempt_id IS NULL OR _a.pricing_snapshot IS NULL
 OR _a.state NOT IN('dispatched','outcome_recorded','settled')
 THEN RAISE EXCEPTION 'TRANSCRIPTION_STATE_CONFLICT' USING ERRCODE='P0005'; END IF;

 _tv:=aiag_transcription_quote_values(_a.quote_snapshot->'transcriptionQuote',_a.model_slug);
 IF NOT aiag_valid_transcription_job_input(_job.input,_job.model_slug)
 OR (_job.input->'billableMs') IS DISTINCT FROM (_a.quote_snapshot->'transcriptionQuote'->'billableMs')
 OR (_a.quote_snapshot->'transcriptionQuote'->>'modelUpstreamId') IS DISTINCT FROM _job.model_upstream_id::text
 OR (_a.quote_snapshot->'transcriptionQuote'->>'upstreamId') IS DISTINCT FROM _job.upstream_id
 OR (_a.quote_snapshot->'transcriptionQuote'->>'providerFamily') IS DISTINCT FROM _job.provider_family
 OR _tv[1]::bigint IS DISTINCT FROM _job.quoted_retail_microcredits
 OR _tv[2]::bigint IS DISTINCT FROM _job.quoted_supplier_microcredits
 THEN RAISE EXCEPTION 'TRANSCRIPTION_QUOTE_INPUT_CONFLICT' USING ERRCODE='P0005'; END IF;

 _digest:=encode(sha256(convert_to(_output::text,'UTF8')),'hex');
 IF _job.status='completed' THEN
  IF _job.output IS DISTINCT FROM _output OR _job.result_digest IS DISTINCT FROM _digest
  THEN RAISE EXCEPTION 'TRANSCRIPTION_RESULT_CONFLICT' USING ERRCODE='P0005'; END IF;
 ELSIF _job.status='claimed' AND _a.state='dispatched' THEN
  UPDATE prediction_jobs SET status='completed',output=_output,error_message=NULL,
    completed_at=coalesce(completed_at,clock_timestamp()),result_digest=_digest
   WHERE id=_job.id;
  _recorded:=TRUE;
 ELSE
  RAISE EXCEPTION 'TRANSCRIPTION_STATE_CONFLICT' USING ERRCODE='P0005';
 END IF;

 IF _a.state='settled' THEN
  UPDATE prediction_jobs SET settled_at=coalesce(settled_at,clock_timestamp())
   WHERE id=_job.id;
 END IF;
 RETURN QUERY SELECT _a.state::text,_recorded;
END $$;

COMMIT;
