-- Atomic additive quota prerequisite; no enrollment or public route activation.
BEGIN;

-- Task6: explicit enrollment only. No legacy policy or opening-balance backfill.
CREATE TABLE gateway_quota_org_policies (
 org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
 enforcement_version SMALLINT NOT NULL DEFAULT 1 CHECK(enforcement_version IN(1,2)),
 daily_supplier_usd_micro_limit_v2 BIGINT CHECK(daily_supplier_usd_micro_limit_v2>=0),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE gateway_quota_key_policies (
 api_key_id UUID PRIMARY KEY REFERENCES gateway_api_keys(id) ON DELETE RESTRICT,
 org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 session_microcredits_limit_v2 BIGINT CHECK(session_microcredits_limit_v2>=0),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE gateway_quota_buckets (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 kind VARCHAR(32) NOT NULL CHECK(kind IN('key_month_charged_v2','org_day_supplier_v2','key_session_charged_v2')),
 api_key_id UUID REFERENCES gateway_api_keys(id) ON DELETE RESTRICT,
 declared_session_id VARCHAR(128) COLLATE "C", period_start TIMESTAMPTZ, period_end TIMESTAMPTZ,
 reserved_amount BIGINT NOT NULL DEFAULT 0 CHECK(reserved_amount>=0), settled_amount BIGINT NOT NULL DEFAULT 0 CHECK(settled_amount>=0),
 CHECK(reserved_amount::numeric+settled_amount::numeric<=9223372036854775807),
 CHECK((kind='key_month_charged_v2' AND api_key_id IS NOT NULL AND declared_session_id IS NULL AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_start<period_end)
 OR(kind='org_day_supplier_v2' AND api_key_id IS NULL AND declared_session_id IS NULL AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_start<period_end)
 OR(kind='key_session_charged_v2' AND api_key_id IS NOT NULL AND declared_session_id IS NOT NULL AND declared_session_id COLLATE "C" ~ '^[A-Za-z0-9._:-]{1,128}$' AND period_start IS NULL AND period_end IS NULL))
);
CREATE UNIQUE INDEX gateway_quota_month_uniq ON gateway_quota_buckets(org_id,api_key_id,period_start) WHERE kind='key_month_charged_v2';
CREATE UNIQUE INDEX gateway_quota_day_uniq ON gateway_quota_buckets(org_id,period_start) WHERE kind='org_day_supplier_v2';
CREATE UNIQUE INDEX gateway_quota_session_uniq ON gateway_quota_buckets(org_id,api_key_id,declared_session_id) WHERE kind='key_session_charged_v2';
CREATE TABLE gateway_charge_quota_contexts (
 billing_request_id UUID PRIMARY KEY REFERENCES gateway_charge_admissions(billing_request_id) ON DELETE RESTRICT,
 quota_version SMALLINT NOT NULL DEFAULT 2 CHECK(quota_version=2),
 org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, api_key_id UUID NOT NULL REFERENCES gateway_api_keys(id) ON DELETE RESTRICT,
 declared_session_id VARCHAR(128) COLLATE "C" CHECK(declared_session_id COLLATE "C" ~ '^[A-Za-z0-9._:-]{1,128}$'),
 admitted_at TIMESTAMPTZ NOT NULL, supplier_formula_version VARCHAR(80) NOT NULL,
 supplier_quote_snapshot JSONB NOT NULL CHECK(jsonb_typeof(supplier_quote_snapshot)='object'),
 supplier_authorized_max_usd_micro BIGINT NOT NULL CHECK(supplier_authorized_max_usd_micro>=0),
 supplier_actual_usd_micro BIGINT CHECK(supplier_actual_usd_micro>=0 AND supplier_actual_usd_micro<=supplier_authorized_max_usd_micro),
 supplier_usage_snapshot JSONB,
 CHECK((supplier_actual_usd_micro IS NULL)=(supplier_usage_snapshot IS NULL))
);
CREATE TABLE gateway_charge_quota_reservations (
 billing_request_id UUID NOT NULL REFERENCES gateway_charge_quota_contexts(billing_request_id) ON DELETE RESTRICT,
 bucket_id UUID NOT NULL REFERENCES gateway_quota_buckets(id) ON DELETE RESTRICT,
 kind VARCHAR(32) NOT NULL, limit_snapshot BIGINT CHECK(limit_snapshot>=0), policy_snapshot JSONB NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
 reserved_max BIGINT NOT NULL CHECK(reserved_max>=0), actual_amount BIGINT,
 state VARCHAR(12) NOT NULL DEFAULT 'reserved', terminal_at TIMESTAMPTZ,
 PRIMARY KEY(billing_request_id,bucket_id), UNIQUE(billing_request_id,kind),
 CHECK(kind IN('key_month_charged_v2','org_day_supplier_v2','key_session_charged_v2')),
 CHECK((state='reserved' AND actual_amount IS NULL AND terminal_at IS NULL)
 OR(state='settled' AND actual_amount IS NOT NULL AND actual_amount>=0 AND actual_amount<=reserved_max AND terminal_at IS NOT NULL)
 OR(state='released' AND actual_amount IS NOT NULL AND actual_amount=0 AND terminal_at IS NOT NULL))
);
CREATE TABLE gateway_charge_quota_events (
 billing_request_id UUID NOT NULL REFERENCES gateway_charge_quota_contexts(billing_request_id) ON DELETE RESTRICT,
 kind VARCHAR(32) NOT NULL, event_kind VARCHAR(12) NOT NULL CHECK(event_kind IN('reserved','settled','released')),
 bucket_id UUID NOT NULL REFERENCES gateway_quota_buckets(id) ON DELETE RESTRICT,
 reserved_delta BIGINT NOT NULL, settled_delta BIGINT NOT NULL CHECK(settled_delta>=0), released_amount BIGINT NOT NULL CHECK(released_amount>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(billing_request_id,kind,event_kind),
 FOREIGN KEY(billing_request_id,bucket_id) REFERENCES gateway_charge_quota_reservations(billing_request_id,bucket_id) ON DELETE RESTRICT,
 CHECK((event_kind='reserved' AND reserved_delta>=0 AND settled_delta=0 AND released_amount=0)
 OR(event_kind='settled' AND reserved_delta<=0 AND settled_delta+released_amount::numeric=-reserved_delta::numeric)
 OR(event_kind='released' AND reserved_delta<=0 AND settled_delta=0 AND released_amount::numeric=-reserved_delta::numeric))
);

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
DECLARE _i NUMERIC; _o NUMERIC; _m NUMERIC; _context NUMERIC; _cap NUMERIC; _base NUMERIC; _k TEXT;
BEGIN
 IF NOT aiag_quota_keys(_c,ARRAY['modelSlug','modelType','upstreamId','upstreamModelId','adapterKey','modelUpstreamId','profileId','profileRevision','adapterContract','endpointPolicy','contextWindowTokens','maxOutputTokens','prices','maxCredits'])
 OR (_c->>'modelSlug') IS DISTINCT FROM _model OR (_c->>'modelType') IS DISTINCT FROM 'chat'
 OR (_c->>'adapterContract') IS DISTINCT FROM 'openrouter-pinned-provider-chat-v1'
 OR NOT aiag_quota_keys(_c->'endpointPolicy',ARRAY['only','allowFallbacks','requireParameters'])
 OR _c->'endpointPolicy'->'allowFallbacks' IS DISTINCT FROM 'false'::jsonb
 OR _c->'endpointPolicy'->'requireParameters' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(_c->'endpointPolicy'->'only') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 IF jsonb_array_length(_c->'endpointPolicy'->'only')<>1 OR jsonb_typeof(_c->'endpointPolicy'->'only'->0) IS DISTINCT FROM 'string'
 OR (_c->'endpointPolicy'->'only'->>0) !~ '^[A-Za-z0-9._/-]{1,128}$' THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 FOREACH _k IN ARRAY ARRAY['modelSlug','upstreamId','upstreamModelId','adapterKey','modelUpstreamId','profileId'] LOOP
  IF jsonb_typeof(_c->_k) IS DISTINCT FROM 'string' OR (length(_c->>_k)>256 OR (_c->>_k) !~ '^[A-Za-z0-9_./:@+-]+$') THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 END LOOP;
 PERFORM aiag_quota_count(_c->'profileRevision',TRUE);
 _context:=aiag_quota_count(_c->'contextWindowTokens',TRUE); _cap:=aiag_quota_count(_c->'maxOutputTokens',TRUE);
 IF _cap>_context OR NOT aiag_quota_keys(_c->'prices',ARRAY['inputCentsPer1k','outputCentsPer1k','markup']) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 _i:=aiag_quota_decimal(_c->'prices'->'inputCentsPer1k'); _o:=aiag_quota_decimal(_c->'prices'->'outputCentsPer1k'); _m:=aiag_quota_decimal(_c->'prices'->'markup');
 IF _m<=0 OR _i>=100000000 OR _o>=100000000
 OR length(split_part(_c->'prices'->>'inputCentsPer1k','.',2))>10 OR length(split_part(_c->'prices'->>'outputCentsPer1k','.',2))>10 THEN RAISE EXCEPTION 'INVALID_SUPPLIER_CANDIDATE'; END IF;
 _base:=_i*_context+greatest(_o-_i,0)*_cap;
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
 IF NOT aiag_quota_keys(_usage,ARRAY['version','usageContract','billingRequestId','attemptId','upstreamId','upstreamModelId','adapterKey','modelSlug','modelUpstreamId','profileId','profileRevision','completionId','reportedModel','usage','formulaVersion'])
 OR _usage->'version' IS DISTINCT FROM '1'::jsonb OR (_usage->>'formulaVersion') IS DISTINCT FROM 'db-input-output-cents-per-1k-legacy-whole-cache-v1'
 OR (_usage->>'billingRequestId') IS DISTINCT FROM _a.billing_request_id::text OR (_usage->>'attemptId') IS DISTINCT FROM _a.attempt_id::text
 OR (_usage->>'usageContract') IS DISTINCT FROM (_a.pricing_snapshot->>'adapterContract')
 OR jsonb_typeof(_usage->'completionId') IS DISTINCT FROM 'string' OR (length(_usage->>'completionId')>256 OR (_usage->>'completionId') !~ '^[A-Za-z0-9_-]+$')
 OR jsonb_typeof(_usage->'reportedModel') IS DISTINCT FROM 'string' OR (length(_usage->>'reportedModel')>256 OR (_usage->>'reportedModel') !~ '^[A-Za-z0-9_./:@+-]+$') THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 _p:=_a.pricing_snapshot;
 FOREACH _k IN ARRAY ARRAY['upstreamId','upstreamModelId','adapterKey','modelSlug','modelUpstreamId','profileId','profileRevision'] LOOP
  IF _usage->_k IS DISTINCT FROM _p->_k THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 END LOOP;
 IF NOT aiag_quota_keys(_usage->'usage',ARRAY['promptTokens','completionTokens','totalTokens','cachedInputTokens']) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
 _prompt:=aiag_quota_count(_usage->'usage'->'promptTokens'); _completion:=aiag_quota_count(_usage->'usage'->'completionTokens');
 _total:=aiag_quota_count(_usage->'usage'->'totalTokens'); _cached:=aiag_quota_count(_usage->'usage'->'cachedInputTokens');
 IF _total<>_prompt+_completion OR _cached>_prompt OR _total>aiag_quota_count(_p->'contextWindowTokens',TRUE) OR _completion>aiag_quota_count(_p->'maxOutputTokens',TRUE) THEN RAISE EXCEPTION 'INVALID_SUPPLIER_USAGE'; END IF;
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

CREATE OR REPLACE FUNCTION aiag_gateway_charge_admission_result(
  _billing_request_id UUID,
  _did_transition BOOLEAN
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE sql STABLE AS $$
  SELECT
    a.billing_request_id, a.org_id, a.api_key_id, a.client_request_id,
    a.route_kind, a.billing_mode, a.model_slug, a.authorized_max_credits,
    a.held_subscription_credits, a.held_payg_credits,
    a.captured_subscription_expires_at, a.quote_snapshot, a.attempt_id,
    a.upstream_id, a.pricing_snapshot, a.actual_cost_credits,
    a.usage_snapshot, a.outcome_kind, a.state, a.pre_dispatch_deadline_at,
    a.created_at, a.dispatched_at, a.outcome_recorded_at, a.settled_at,
    a.cancelled_at, a.reconcile_after, a.released_subscription_credits,
    a.released_payg_credits, a.debt_repaid_credits,
    a.expired_subscription_credits, _did_transition
  FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id;
$$;

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

CREATE OR REPLACE FUNCTION aiag_mark_gateway_charge_dispatched(
  _org_id UUID,
  _billing_request_id UUID,
  _attempt_id UUID,
  _upstream_id VARCHAR,
  _pricing_snapshot JSONB
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
  _dispatch_at TIMESTAMPTZ;
  _updated_billing_request_id UUID;
BEGIN
  IF _org_id IS NULL OR _billing_request_id IS NULL OR _attempt_id IS NULL
    OR _upstream_id IS NULL OR btrim(_upstream_id) = '' OR length(_upstream_id) > 64
    OR _pricing_snapshot IS NULL OR jsonb_typeof(_pricing_snapshot) <> 'object'
  THEN
    RAISE EXCEPTION 'INVALID_DISPATCH' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  IF _existing.attempt_id IS NOT NULL THEN
    IF _existing.attempt_id IS DISTINCT FROM _attempt_id
      OR _existing.upstream_id IS DISTINCT FROM _upstream_id
      OR _existing.pricing_snapshot IS DISTINCT FROM _pricing_snapshot
    THEN
      RAISE EXCEPTION 'DISPATCH_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
    END IF;
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;

  IF _existing.state <> 'held' THEN
    RAISE EXCEPTION 'DISPATCH_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  _dispatch_at := clock_timestamp();
  IF _existing.pre_dispatch_deadline_at <= _dispatch_at THEN
    RAISE EXCEPTION 'ADMISSION_DEADLINE_EXPIRED' USING ERRCODE = 'P0005';
  END IF;

  PERFORM aiag_quota_validate_dispatch(_existing,_upstream_id,_pricing_snapshot);

  UPDATE gateway_charge_admissions a
  SET state = 'dispatched', attempt_id = _attempt_id,
      upstream_id = _upstream_id, pricing_snapshot = _pricing_snapshot,
      dispatched_at = _dispatch_at,
      reconcile_after = _dispatch_at + INTERVAL '15 minutes'
  WHERE a.billing_request_id = _billing_request_id
    AND a.state = 'held'
    AND a.pre_dispatch_deadline_at > _dispatch_at
  RETURNING a.billing_request_id INTO _updated_billing_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPATCH_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_record_gateway_charge_outcome_impl(
  _org_id UUID,
  _billing_request_id UUID,
  _actual_cost_credits BIGINT,
  _usage_snapshot JSONB,
  _outcome_kind VARCHAR,
  _quota_version SMALLINT
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
  _context gateway_charge_quota_contexts%ROWTYPE;
  _supplier_actual BIGINT;
BEGIN
  IF _quota_version IS NULL OR _quota_version NOT IN(1,2) THEN RAISE EXCEPTION 'INVALID_QUOTA_VERSION_OR_CONTEXT'; END IF;
  IF _org_id IS NULL OR _billing_request_id IS NULL
    OR _actual_cost_credits IS NULL OR _actual_cost_credits < 0
    OR _usage_snapshot IS NULL OR jsonb_typeof(_usage_snapshot) <> 'object'
    OR _outcome_kind IS NULL OR btrim(_outcome_kind) = ''
    OR length(_outcome_kind) > 32
    OR (_actual_cost_credits = 0
        AND _outcome_kind NOT IN ('success', 'verified_no_charge'))
  THEN
    RAISE EXCEPTION 'INVALID_OUTCOME' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  SELECT * INTO _context FROM gateway_charge_quota_contexts WHERE billing_request_id=_billing_request_id;
  IF (_quota_version=2) IS DISTINCT FROM FOUND THEN RAISE EXCEPTION 'QUOTA_OUTCOME_VERSION_CONFLICT'; END IF;
  IF _quota_version=2 THEN
   IF _existing.attempt_id IS NULL THEN RAISE EXCEPTION 'OUTCOME_STATE_CONFLICT'; END IF;
   _supplier_actual:=aiag_quota_supplier_actual(_existing,_actual_cost_credits,_usage_snapshot);
   IF _supplier_actual>_context.supplier_authorized_max_usd_micro THEN RAISE EXCEPTION 'SUPPLIER_ACTUAL_EXCEEDS_MAX'; END IF;
   IF _context.supplier_actual_usd_micro IS NOT NULL AND (_context.supplier_actual_usd_micro IS DISTINCT FROM _supplier_actual OR _context.supplier_usage_snapshot IS DISTINCT FROM _usage_snapshot) THEN RAISE EXCEPTION 'OUTCOME_IDENTITY_CONFLICT'; END IF;
  END IF;
  IF _actual_cost_credits > _existing.authorized_max_credits THEN
    RAISE EXCEPTION 'ACTUAL_EXCEEDS_AUTHORIZED_MAX' USING ERRCODE = 'P0001';
  END IF;

  IF _existing.actual_cost_credits IS NOT NULL THEN
    IF _existing.actual_cost_credits IS DISTINCT FROM _actual_cost_credits
      OR _existing.usage_snapshot IS DISTINCT FROM _usage_snapshot
      OR _existing.outcome_kind IS DISTINCT FROM _outcome_kind
    THEN
      RAISE EXCEPTION 'OUTCOME_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
    END IF;
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;

  IF _existing.state <> 'dispatched' THEN
    RAISE EXCEPTION 'OUTCOME_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  IF _quota_version=2 THEN
   UPDATE gateway_charge_quota_contexts SET supplier_actual_usd_micro=_supplier_actual,supplier_usage_snapshot=_usage_snapshot WHERE billing_request_id=_billing_request_id AND supplier_actual_usd_micro IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'OUTCOME_IDENTITY_CONFLICT'; END IF;
  END IF;
  UPDATE gateway_charge_admissions a
  SET state = 'outcome_recorded', actual_cost_credits = _actual_cost_credits,
      usage_snapshot = _usage_snapshot, outcome_kind = _outcome_kind,
      outcome_recorded_at = clock_timestamp(), reconcile_after = clock_timestamp()
  WHERE a.billing_request_id = _billing_request_id AND a.state = 'dispatched';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_settle_admitted_gateway_charge(
  _org_id UUID,
  _billing_request_id UUID
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
  _current_expiry TIMESTAMPTZ;
  _refund_debt BIGINT;
  _used_subscription BIGINT;
  _used_payg BIGINT;
  _unused_subscription BIGINT;
  _unused_payg BIGINT;
  _released_subscription BIGINT := 0;
  _released_payg BIGINT;
  _debt_repaid BIGINT;
  _expired_subscription BIGINT := 0;
  _receipt_id VARCHAR;
  _post_subscription BIGINT;
  _post_payg BIGINT;
  _post_refund_debt BIGINT;
BEGIN
  SELECT o.subscription_credits_expires_at, o.refund_debt_credits
    INTO _current_expiry, _refund_debt
  FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  IF _existing.state = 'settled' THEN
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;
  IF _existing.state <> 'outcome_recorded' THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  _used_subscription := LEAST(
    _existing.actual_cost_credits, _existing.held_subscription_credits
  );
  _used_payg := _existing.actual_cost_credits - _used_subscription;
  _unused_subscription := _existing.held_subscription_credits - _used_subscription;
  _unused_payg := _existing.held_payg_credits - _used_payg;
  _debt_repaid := LEAST(_unused_payg, _refund_debt);
  _released_payg := _unused_payg - _debt_repaid;

  IF _existing.captured_subscription_expires_at IS NOT DISTINCT FROM _current_expiry
    AND (_existing.captured_subscription_expires_at IS NULL
         OR _existing.captured_subscription_expires_at > clock_timestamp())
  THEN
    _released_subscription := _unused_subscription;
  ELSE
    _expired_subscription := _unused_subscription;
  END IF;

  UPDATE organizations o
  SET subscription_credits = o.subscription_credits + _released_subscription,
      payg_credits = o.payg_credits + _released_payg,
      refund_debt_credits = o.refund_debt_credits - _debt_repaid,
      updated_at = clock_timestamp()
  WHERE o.id = _org_id AND o.refund_debt_credits >= _debt_repaid
  RETURNING o.subscription_credits, o.payg_credits, o.refund_debt_credits
    INTO _post_subscription, _post_payg, _post_refund_debt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  _receipt_id := 'gw:' || _billing_request_id::text;
  IF _used_subscription > 0 THEN
    INSERT INTO gateway_transactions (
      org_id, request_id, type, source, delta, metadata, created_at
    ) VALUES (
      _org_id, _receipt_id, 'api_usage', 'subscription', -_used_subscription,
      jsonb_build_object(
        'billing_request_id', _billing_request_id,
        'model_slug', _existing.model_slug,
        'outcome_kind', _existing.outcome_kind,
        'usage', _existing.usage_snapshot
      ), clock_timestamp()
    );
  END IF;
  IF _used_payg > 0 THEN
    INSERT INTO gateway_transactions (
      org_id, request_id, type, source, delta, metadata, created_at
    ) VALUES (
      _org_id, _receipt_id, 'api_usage', 'payg', -_used_payg,
      jsonb_build_object(
        'billing_request_id', _billing_request_id,
        'model_slug', _existing.model_slug,
        'outcome_kind', _existing.outcome_kind,
        'usage', _existing.usage_snapshot
      ), clock_timestamp()
    );
  END IF;

  INSERT INTO gateway_charge_admission_events (
    admission_id, org_id, event_key, event_kind,
    used_subscription_credits, used_payg_credits,
    released_subscription_credits, released_payg_credits,
    debt_repaid_credits, expired_subscription_credits, metadata
  ) VALUES (
    _billing_request_id, _org_id, 'settlement', 'settlement',
    _used_subscription, _used_payg, _released_subscription, _released_payg,
    _debt_repaid, _expired_subscription,
    jsonb_build_object('actual_cost_credits', _existing.actual_cost_credits)
  );

  PERFORM aiag_quota_terminal(_billing_request_id,TRUE);

  UPDATE gateway_charge_admissions a
  SET state = 'settled', settled_at = clock_timestamp(), reconcile_after = NULL,
      released_subscription_credits = _released_subscription,
      released_payg_credits = _released_payg,
      debt_repaid_credits = _debt_repaid,
      expired_subscription_credits = _expired_subscription
  WHERE a.billing_request_id = _billing_request_id
    AND a.state = 'outcome_recorded';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_cancel_undispatched_gateway_charge(
  _org_id UUID,
  _billing_request_id UUID
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
  _current_expiry TIMESTAMPTZ;
  _refund_debt BIGINT;
  _released_subscription BIGINT := 0;
  _released_payg BIGINT;
  _debt_repaid BIGINT;
  _expired_subscription BIGINT := 0;
  _post_subscription BIGINT;
  _post_payg BIGINT;
  _post_refund_debt BIGINT;
BEGIN
  SELECT o.subscription_credits_expires_at, o.refund_debt_credits
    INTO _current_expiry, _refund_debt
  FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  IF _existing.state = 'cancelled' THEN
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;
  IF _existing.state <> 'held' THEN
    RAISE EXCEPTION 'CANCELLATION_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  _debt_repaid := LEAST(_existing.held_payg_credits, _refund_debt);
  _released_payg := _existing.held_payg_credits - _debt_repaid;
  IF _existing.captured_subscription_expires_at IS NOT DISTINCT FROM _current_expiry
    AND (_existing.captured_subscription_expires_at IS NULL
         OR _existing.captured_subscription_expires_at > clock_timestamp())
  THEN
    _released_subscription := _existing.held_subscription_credits;
  ELSE
    _expired_subscription := _existing.held_subscription_credits;
  END IF;

  UPDATE organizations o
  SET subscription_credits = o.subscription_credits + _released_subscription,
      payg_credits = o.payg_credits + _released_payg,
      refund_debt_credits = o.refund_debt_credits - _debt_repaid,
      updated_at = clock_timestamp()
  WHERE o.id = _org_id AND o.refund_debt_credits >= _debt_repaid
  RETURNING o.subscription_credits, o.payg_credits, o.refund_debt_credits
    INTO _post_subscription, _post_payg, _post_refund_debt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  INSERT INTO gateway_charge_admission_events (
    admission_id, org_id, event_key, event_kind,
    released_subscription_credits, released_payg_credits,
    debt_repaid_credits, expired_subscription_credits, metadata
  ) VALUES (
    _billing_request_id, _org_id, 'cancellation', 'cancellation',
    _released_subscription, _released_payg, _debt_repaid,
    _expired_subscription, '{}'::jsonb
  );

  PERFORM aiag_quota_terminal(_billing_request_id,FALSE);

  UPDATE gateway_charge_admissions a
  SET state = 'cancelled', cancelled_at = clock_timestamp(),
      released_subscription_credits = _released_subscription,
      released_payg_credits = _released_payg,
      debt_repaid_credits = _debt_repaid,
      expired_subscription_credits = _expired_subscription
  WHERE a.billing_request_id = _billing_request_id AND a.state = 'held';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANCELLATION_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_admit_gateway_charge(
 _org_id UUID,_billing_request_id UUID,_api_key_id UUID,_client_request_id VARCHAR,_route_kind VARCHAR,_billing_mode VARCHAR,_model_slug VARCHAR,_authorized_max_credits BIGINT,_quote_snapshot JSONB,_pre_dispatch_deadline_at TIMESTAMPTZ
) RETURNS SETOF gateway_charge_admission_result LANGUAGE sql AS $$
 SELECT * FROM aiag_admit_gateway_charge_impl(_org_id,_billing_request_id,_api_key_id,_client_request_id,_route_kind,_billing_mode,_model_slug,_authorized_max_credits,_quote_snapshot,_pre_dispatch_deadline_at,1::smallint,NULL,NULL);
$$;
CREATE OR REPLACE FUNCTION aiag_admit_gateway_charge_v2(
 _org_id UUID,_billing_request_id UUID,_api_key_id UUID,_client_request_id VARCHAR,_route_kind VARCHAR,_billing_mode VARCHAR,_model_slug VARCHAR,_authorized_max_credits BIGINT,_quote_snapshot JSONB,_pre_dispatch_deadline_at TIMESTAMPTZ,_declared_session_id VARCHAR,_supplier_quote_snapshot JSONB
) RETURNS SETOF gateway_charge_admission_result LANGUAGE sql AS $$
 SELECT * FROM aiag_admit_gateway_charge_impl(_org_id,_billing_request_id,_api_key_id,_client_request_id,_route_kind,_billing_mode,_model_slug,_authorized_max_credits,_quote_snapshot,_pre_dispatch_deadline_at,2::smallint,_declared_session_id,_supplier_quote_snapshot);
$$;
CREATE OR REPLACE FUNCTION aiag_record_gateway_charge_outcome(_org_id UUID,_billing_request_id UUID,_actual_cost_credits BIGINT,_usage_snapshot JSONB,_outcome_kind VARCHAR)
RETURNS SETOF gateway_charge_admission_result LANGUAGE sql AS $$
 SELECT * FROM aiag_record_gateway_charge_outcome_impl(_org_id,_billing_request_id,_actual_cost_credits,_usage_snapshot,_outcome_kind,1::smallint);
$$;
CREATE OR REPLACE FUNCTION aiag_record_gateway_charge_outcome_v2(_org_id UUID,_billing_request_id UUID,_actual_cost_credits BIGINT,_usage_snapshot JSONB,_outcome_kind VARCHAR)
RETURNS SETOF gateway_charge_admission_result LANGUAGE sql AS $$
 SELECT * FROM aiag_record_gateway_charge_outcome_impl(_org_id,_billing_request_id,_actual_cost_credits,_usage_snapshot,_outcome_kind,2::smallint);
$$;

COMMIT;
