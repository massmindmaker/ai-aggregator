-- Pure exact parsers. JSON money is a canonical string, usage counts are JSON integers.
CREATE OR REPLACE FUNCTION aiag_quota_decimal(_value JSONB, _integer BOOLEAN DEFAULT FALSE)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _s TEXT;
BEGIN
 _s := _value #>> '{}';
 IF jsonb_typeof(_value) IS DISTINCT FROM 'string' OR _s IS NULL
 OR length(_s)>39 OR _s !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
 OR length(replace(_s,'.',''))>38 OR length(split_part(_s,'.',2))>18
 OR (_integer AND _s !~ '^(0|[1-9][0-9]*)$') THEN
  RAISE EXCEPTION 'INVALID_QUOTA_NUMBER' USING ERRCODE='P0001';
 END IF;
 RETURN _s::numeric;
END $$;
CREATE OR REPLACE FUNCTION aiag_quota_money(_n NUMERIC)
RETURNS BIGINT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF _n IS NULL OR _n::text IN('NaN','Infinity','-Infinity') OR _n<0 OR _n>9223372036854775807 OR trunc(_n)<>_n THEN
  RAISE EXCEPTION 'QUOTA_AMOUNT_OUT_OF_RANGE' USING ERRCODE='P0001';
 END IF;
 RETURN _n::bigint;
END $$;
CREATE OR REPLACE FUNCTION aiag_quota_count(_value JSONB, _positive BOOLEAN DEFAULT FALSE)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _s TEXT; _n NUMERIC;
BEGIN
 _s:=_value #>> '{}';
 IF jsonb_typeof(_value) IS DISTINCT FROM 'number' OR _s IS NULL OR length(_s)>16 OR _s !~ '^(0|[1-9][0-9]*)$' THEN
  RAISE EXCEPTION 'INVALID_QUOTA_COUNT' USING ERRCODE='P0001';
 END IF;
 _n:=_s::numeric;
 IF _n>9007199254740991 OR (_positive AND _n=0) THEN RAISE EXCEPTION 'INVALID_QUOTA_COUNT' USING ERRCODE='P0001'; END IF;
 RETURN _n;
END $$;
CREATE OR REPLACE FUNCTION aiag_quota_keys(_value JSONB, _keys TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(_value)='object' THEN
   (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(_value) k) IS NOT DISTINCT FROM
   (SELECT array_agg(k ORDER BY k) FROM unnest(_keys) k) ELSE FALSE END
$$;
-- The sole clock helper takes explicit time for pure boundary tests; public admit never accepts a clock.
CREATE OR REPLACE FUNCTION aiag_quota_period(_at TIMESTAMPTZ, _unit TEXT)
RETURNS TABLE(period_start TIMESTAMPTZ,period_end TIMESTAMPTZ) LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF _at IS NULL OR NOT isfinite(_at) OR _unit NOT IN('day','month') OR _unit IS NULL THEN RAISE EXCEPTION 'INVALID_QUOTA_PERIOD'; END IF;
 RETURN QUERY SELECT date_trunc(_unit,_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
 (date_trunc(_unit,_at AT TIME ZONE 'UTC')+CASE WHEN _unit='day' THEN INTERVAL '1 day' ELSE INTERVAL '1 month' END) AT TIME ZONE 'UTC';
END $$;
-- Returns [charged maximum, supplier maximum]. Frozen metadata is evidence, never a live catalog lookup.
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
CREATE OR REPLACE FUNCTION aiag_quota_validate_dispatch(_a gateway_charge_admissions,_upstream TEXT,_pricing JSONB)
RETURNS VOID LANGUAGE plpgsql STABLE AS $$
DECLARE _ctx gateway_charge_quota_contexts%ROWTYPE;
BEGIN
 SELECT * INTO _ctx FROM gateway_charge_quota_contexts WHERE billing_request_id=_a.billing_request_id;
 IF NOT FOUND THEN RETURN; END IF;
 IF _ctx.org_id<>_a.org_id OR _ctx.api_key_id<>_a.api_key_id THEN RAISE EXCEPTION 'QUOTA_CONTEXT_CONFLICT'; END IF;
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
-- Caller is the single admission core, already holding org -> billing -> admission -> policies/keys.
CREATE OR REPLACE FUNCTION aiag_quota_reserve(_id UUID,_month BIGINT,_day BIGINT,_session BIGINT,_monthly_value TEXT,_org_revision BIGINT,_key_revision BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE _a gateway_charge_admissions%ROWTYPE; _q gateway_charge_quota_contexts%ROWTYPE; _kind TEXT;
 _start TIMESTAMPTZ; _end TIMESTAMPTZ; _key UUID; _sid TEXT; _max BIGINT; _limit BIGINT; _bucket UUID; _policy JSONB;
BEGIN
 SELECT * INTO STRICT _a FROM gateway_charge_admissions WHERE billing_request_id=_id;
 SELECT * INTO STRICT _q FROM gateway_charge_quota_contexts WHERE billing_request_id=_id;
 IF _a.state<>'held' OR _q.org_id<>_a.org_id OR _q.api_key_id<>_a.api_key_id THEN RAISE EXCEPTION 'QUOTA_CONTEXT_CONFLICT'; END IF;
 FOR _kind IN SELECT unnest(ARRAY['key_month_charged_v2','key_session_charged_v2','org_day_supplier_v2']) ORDER BY 1 LOOP
  _start:=NULL; _end:=NULL; _key:=NULL; _sid:=NULL;
  IF _kind='key_month_charged_v2' THEN
   SELECT p.period_start,p.period_end INTO _start,_end FROM aiag_quota_period(_q.admitted_at,'month') p;
   _key:=_a.api_key_id; _max:=_a.authorized_max_credits; _limit:=_month;
   _policy:=jsonb_build_object('version',2,'source','cost_limit_monthly_rub','sourceValue',_monthly_value);
  ELSIF _kind='org_day_supplier_v2' THEN
   SELECT p.period_start,p.period_end INTO _start,_end FROM aiag_quota_period(_q.admitted_at,'day') p;
   _max:=_q.supplier_authorized_max_usd_micro; _limit:=_day;
   _policy:=jsonb_build_object('version',2,'source','daily_supplier_usd_micro_limit_v2','revision',_org_revision::text);
  ELSE
   IF _q.declared_session_id IS NULL THEN CONTINUE; END IF;
   _key:=_a.api_key_id; _sid:=_q.declared_session_id; _max:=_a.authorized_max_credits; _limit:=_session;
   _policy:=jsonb_build_object('version',2,'source','session_microcredits_limit_v2','revision',_key_revision::text);
  END IF;
  INSERT INTO gateway_quota_buckets(org_id,kind,api_key_id,declared_session_id,period_start,period_end)
   VALUES(_a.org_id,_kind,_key,_sid,_start,_end) ON CONFLICT DO NOTHING;
  SELECT id INTO STRICT _bucket FROM gateway_quota_buckets b WHERE b.org_id=_a.org_id AND b.kind=_kind
   AND b.api_key_id IS NOT DISTINCT FROM _key AND b.declared_session_id IS NOT DISTINCT FROM _sid
   AND b.period_start IS NOT DISTINCT FROM _start AND b.period_end IS NOT DISTINCT FROM _end FOR UPDATE;
  UPDATE gateway_quota_buckets b SET reserved_amount=(b.reserved_amount::numeric+_max)::bigint
   WHERE b.id=_bucket AND b.reserved_amount::numeric+b.settled_amount::numeric+_max<=9223372036854775807
   AND (_limit IS NULL OR b.reserved_amount::numeric+b.settled_amount::numeric+_max<=_limit)
   RETURNING b.id INTO _bucket;
  IF NOT FOUND THEN RAISE EXCEPTION 'QUOTA_EXCEEDED' USING ERRCODE='P0003'; END IF;
  _policy:=_policy||jsonb_build_object('orgId',_a.org_id,'apiKeyId',_key,'declaredSessionId',_sid,'limit',_limit::text,'periodStart',_start,'periodEnd',_end);
  INSERT INTO gateway_charge_quota_reservations(billing_request_id,bucket_id,kind,limit_snapshot,policy_snapshot,reserved_max)
   VALUES(_id,_bucket,_kind,_limit,_policy,_max);
  INSERT INTO gateway_charge_quota_events(billing_request_id,kind,event_kind,bucket_id,reserved_delta,settled_delta,released_amount)
   VALUES(_id,_kind,'reserved',_bucket,_max,0,0);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION aiag_quota_terminal(_id UUID,_settle BOOLEAN)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE _a gateway_charge_admissions%ROWTYPE; _q gateway_charge_quota_contexts%ROWTYPE; _r gateway_charge_quota_reservations%ROWTYPE;
 _amount BIGINT; _bucket UUID; _n INTEGER:=0; _at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 SELECT * INTO _q FROM gateway_charge_quota_contexts WHERE billing_request_id=_id;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO STRICT _a FROM gateway_charge_admissions WHERE billing_request_id=_id;
 IF _q.org_id<>_a.org_id OR _q.api_key_id<>_a.api_key_id OR _settle IS NULL
 OR (_settle AND (_a.state<>'outcome_recorded' OR _q.supplier_actual_usd_micro IS NULL))
 OR (NOT _settle AND _a.state<>'held') THEN RAISE EXCEPTION 'QUOTA_CONTEXT_CONFLICT'; END IF;
 -- Lock buckets before reservations; identical deterministic order to reserve.
 PERFORM b.id FROM gateway_quota_buckets b JOIN gateway_charge_quota_reservations r ON r.bucket_id=b.id
  WHERE r.billing_request_id=_id ORDER BY b.kind,b.api_key_id,b.period_start,b.declared_session_id FOR UPDATE OF b;
 FOR _r IN SELECT * FROM gateway_charge_quota_reservations WHERE billing_request_id=_id ORDER BY kind FOR UPDATE LOOP
  _n:=_n+1;
  IF _r.state<>'reserved' OR NOT EXISTS(SELECT 1 FROM gateway_quota_buckets b WHERE b.id=_r.bucket_id AND b.org_id=_a.org_id AND b.kind=_r.kind
    AND (b.kind='org_day_supplier_v2' OR b.api_key_id=_a.api_key_id)
    AND (b.kind<>'key_session_charged_v2' OR b.declared_session_id=_q.declared_session_id)) THEN RAISE EXCEPTION 'QUOTA_RESERVATION_CONFLICT'; END IF;
  _amount:=CASE WHEN NOT _settle THEN 0 WHEN _r.kind='org_day_supplier_v2' THEN _q.supplier_actual_usd_micro ELSE _a.actual_cost_credits END;
  IF _amount IS NULL OR _amount<0 OR _amount>_r.reserved_max THEN RAISE EXCEPTION 'QUOTA_ACTUAL_CONFLICT'; END IF;
  UPDATE gateway_quota_buckets b SET reserved_amount=b.reserved_amount-_r.reserved_max,settled_amount=(b.settled_amount::numeric+_amount)::bigint
   WHERE b.id=_r.bucket_id AND b.reserved_amount>=_r.reserved_max AND b.settled_amount::numeric+_amount<=9223372036854775807 RETURNING b.id INTO _bucket;
  IF NOT FOUND THEN RAISE EXCEPTION 'QUOTA_COUNTER_CONFLICT'; END IF;
  UPDATE gateway_charge_quota_reservations SET state=CASE WHEN _settle THEN 'settled' ELSE 'released' END,actual_amount=_amount,terminal_at=_at
   WHERE billing_request_id=_id AND bucket_id=_r.bucket_id AND state='reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'QUOTA_RESERVATION_CONFLICT'; END IF;
  INSERT INTO gateway_charge_quota_events(billing_request_id,kind,event_kind,bucket_id,reserved_delta,settled_delta,released_amount,created_at)
   VALUES(_id,_r.kind,CASE WHEN _settle THEN 'settled' ELSE 'released' END,_r.bucket_id,-_r.reserved_max,_amount,_r.reserved_max-_amount,_at);
 END LOOP;
 IF _n<>(CASE WHEN _q.declared_session_id IS NULL THEN 2 ELSE 3 END) THEN RAISE EXCEPTION 'QUOTA_RESERVATION_CONFLICT'; END IF;
END $$;
