-- Operator-only resolution of persisted author obligations. No provider calls.
BEGIN;
CREATE TABLE author_operator_resolutions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 billing_request_id UUID NOT NULL UNIQUE REFERENCES author_request_bindings(billing_request_id),
 attempt_id UUID NOT NULL, actor_id UUID NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind='verified_no_charge'),
 evidence_reference TEXT NOT NULL CHECK(length(evidence_reference) BETWEEN 3 AND 1024),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER author_resolution_immutable BEFORE UPDATE OR DELETE ON author_operator_resolutions
 FOR EACH ROW EXECUTE FUNCTION aiag_author_money_immutable();

CREATE FUNCTION aiag_resolve_author_no_charge(_billing UUID,_attempt UUID,_actor UUID,_evidence TEXT)
RETURNS TABLE(billing_request_id UUID,state TEXT,actual_cost_credits TEXT) LANGUAGE plpgsql AS $$
DECLARE _b author_request_bindings%ROWTYPE; _a gateway_charge_admissions%ROWTYPE; _r author_operator_resolutions%ROWTYPE; _email TEXT; _usage JSONB;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 IF _attempt IS NULL OR _evidence IS NULL OR length(_evidence) NOT BETWEEN 3 AND 1024 THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_INVALID'; END IF;
 SELECT * INTO _b FROM author_request_bindings b WHERE b.billing_request_id=_billing;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
 PERFORM 1 FROM organizations WHERE id=_b.org_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing::text,0));
 SELECT * INTO _a FROM gateway_charge_admissions a WHERE a.billing_request_id=_billing FOR UPDATE;
 IF NOT FOUND OR _a.attempt_id IS DISTINCT FROM _attempt OR _a.org_id IS DISTINCT FROM _b.org_id OR _a.api_key_id IS DISTINCT FROM _b.api_key_id THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_CONFLICT'; END IF;
 SELECT * INTO _r FROM author_operator_resolutions r WHERE r.billing_request_id=_billing;
 IF FOUND THEN
  IF _r.attempt_id IS DISTINCT FROM _attempt OR _r.evidence_reference IS DISTINCT FROM _evidence OR _a.state<>'settled'
   OR _a.actual_cost_credits<>0 OR _a.outcome_kind<>'verified_no_charge' THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_CONFLICT'; END IF;
  RETURN QUERY SELECT _billing,_a.state::text,_a.actual_cost_credits::text; RETURN;
 END IF;
 IF _a.state<>'dispatched' OR _a.actual_cost_credits IS NOT NULL THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_CONFLICT'; END IF;
 IF _a.reconcile_after IS NULL OR _a.reconcile_after>clock_timestamp() THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_NOT_DUE'; END IF;
 IF EXISTS(SELECT 1 FROM gateway_http_results r WHERE r.billing_request_id=_billing) THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_CONFLICT'; END IF;
 INSERT INTO author_operator_resolutions(billing_request_id,attempt_id,actor_id,kind,evidence_reference)
 VALUES(_billing,_attempt,_actor,'verified_no_charge',_evidence) RETURNING * INTO _r;
 _usage:=jsonb_build_object('version',1,'formulaVersion','author-verified-no-charge-v1','billingRequestId',_billing,
  'attemptId',_attempt,'upstreamId',_a.upstream_id,'resolutionId',_r.id);
 PERFORM 1 FROM aiag_record_gateway_charge_outcome_v2(_b.org_id,_billing,0,_usage,'verified_no_charge');
 PERFORM 1 FROM aiag_settle_admitted_gateway_charge(_b.org_id,_billing);
 INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
 VALUES(_email,'admin','author.request.no_charge','gateway_request',_billing::text,jsonb_build_object('resolution_id',_r.id,'evidence_reference',_evidence));
 RETURN QUERY SELECT a.billing_request_id,a.state::text,a.actual_cost_credits::text FROM gateway_charge_admissions a WHERE a.billing_request_id=_billing;
END $$;

CREATE FUNCTION aiag_recover_author_settlement(_billing UUID,_actor UUID)
RETURNS TABLE(billing_request_id UUID,state TEXT,actual_cost_credits TEXT) LANGUAGE plpgsql AS $$
DECLARE _b author_request_bindings%ROWTYPE; _email TEXT;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 SELECT * INTO _b FROM author_request_bindings b WHERE b.billing_request_id=_billing;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
 PERFORM 1 FROM aiag_recover_gateway_http_settlement_v1(_b.org_id,_b.api_key_id,_billing);
 INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
 VALUES(_email,'admin','author.request.recover','gateway_request',_billing::text,'{}'::jsonb);
 RETURN QUERY SELECT a.billing_request_id,a.state::text,a.actual_cost_credits::text FROM gateway_charge_admissions a WHERE a.billing_request_id=_billing;
END $$;

CREATE FUNCTION aiag_set_author_dispute(_billing UUID,_actor UUID,_disputed BOOLEAN,_reason TEXT)
RETURNS TABLE(billing_request_id UUID,disputed BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE _b author_request_bindings%ROWTYPE; _email TEXT;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 IF _disputed IS NULL OR _reason IS NULL OR length(_reason) NOT BETWEEN 3 AND 1024 THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_INVALID'; END IF;
 SELECT * INTO _b FROM author_request_bindings b WHERE b.billing_request_id=_billing;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
 PERFORM 1 FROM organizations WHERE id=_b.org_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('author:'||_b.author_user_id::text,0));
 UPDATE author_request_bindings b SET disputed=_disputed WHERE b.billing_request_id=_billing;
 INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
 VALUES(_email,'admin','author.request.dispute','gateway_request',_billing::text,jsonb_build_object('disputed',_disputed,'reason',_reason));
 RETURN QUERY SELECT _billing,_disputed;
END $$;

CREATE OR REPLACE FUNCTION aiag_quota_supplier_actual(_a gateway_charge_admissions,_actual BIGINT,_usage JSONB)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE _p JSONB; _k TEXT; _prompt NUMERIC; _completion NUMERIC; _total NUMERIC; _cached NUMERIC;
 _i NUMERIC; _o NUMERIC; _m NUMERIC; _d NUMERIC; _base NUMERIC; _charged NUMERIC; _supplier BIGINT; _bounds NUMERIC[];
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
-- Caller is the single admission core, already holding org -> billing -> admission -> policies/keys.

CREATE OR REPLACE FUNCTION aiag_accrue_pinned_author_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _b author_request_bindings%ROWTYPE; _share BIGINT; _existing author_credit_ledger%ROWTYPE;
BEGIN
 IF NEW.state<>'settled' OR OLD.state='settled' THEN RETURN NEW; END IF;
 SELECT * INTO _b FROM author_request_bindings WHERE billing_request_id=NEW.billing_request_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('author:'||_b.author_user_id::text,0));
 IF NEW.outcome_kind='verified_no_charge' AND NEW.actual_cost_credits=0
  AND NEW.org_id=_b.org_id AND NEW.api_key_id=_b.api_key_id AND NEW.quote_snapshot->'authorQuote'=_b.author_quote
  AND EXISTS(SELECT 1 FROM author_operator_resolutions r WHERE r.billing_request_id=NEW.billing_request_id AND r.attempt_id=NEW.attempt_id AND r.id::text=NEW.usage_snapshot->>'resolutionId')
 THEN RETURN NEW; END IF;

 IF NEW.org_id IS DISTINCT FROM _b.org_id OR NEW.api_key_id IS DISTINCT FROM _b.api_key_id OR NEW.actual_cost_credits IS DISTINCT FROM (_b.author_quote->>'priceMicrocredits')::bigint
  OR NEW.quote_snapshot->'authorQuote' IS DISTINCT FROM _b.author_quote OR NEW.outcome_kind<>'success'
 THEN RAISE EXCEPTION 'AUTHOR_ACCRUAL_CONFLICT'; END IF;
 _share:=(_b.author_quote->>'authorMicrocredits')::bigint;
 INSERT INTO author_credit_ledger(billing_request_id,author_user_id,version_id,policy_id,kind,amount_microcredits,available_at)
 VALUES(NEW.billing_request_id,_b.author_user_id,_b.version_id,_b.policy_id,'accrual',_share,
  NEW.settled_at+make_interval(secs=>(_b.author_quote->>'availabilityDelaySeconds')::integer))
 ON CONFLICT(billing_request_id,kind) DO NOTHING;
 SELECT * INTO _existing FROM author_credit_ledger WHERE billing_request_id=NEW.billing_request_id AND kind='accrual';
 IF _existing.amount_microcredits IS DISTINCT FROM _share OR _existing.policy_id IS DISTINCT FROM _b.policy_id THEN RAISE EXCEPTION 'AUTHOR_ACCRUAL_CONFLICT'; END IF;
 RETURN NEW;
END $$;


CREATE FUNCTION aiag_read_author_no_charge(_org UUID,_key UUID,_key_digest TEXT,_fingerprint TEXT,_contract SMALLINT,_mode TEXT)
RETURNS TABLE(billing_request_id UUID) LANGUAGE plpgsql AS $$
DECLARE _request gateway_http_requests%ROWTYPE;
BEGIN
 PERFORM aiag_http_validate_identity(_org,_key,'chat',_mode,_key_digest,_fingerprint,_contract);
 PERFORM 1 FROM organizations WHERE id=_org FOR UPDATE;
 PERFORM aiag_http_require_key(_org,_key,TRUE);
 SELECT * INTO _request FROM gateway_http_requests r WHERE r.org_id=_org AND r.api_key_id=_key AND r.route_kind='chat' AND r.idempotency_key_digest=_key_digest;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_request.billing_request_id::text,0));
 IF _request.request_fingerprint IS DISTINCT FROM _fingerprint OR _request.contract_version IS DISTINCT FROM _contract OR _request.billing_mode IS DISTINCT FROM _mode
 THEN RAISE EXCEPTION 'HTTP_IDENTITY_CONFLICT' USING ERRCODE='P0005'; END IF;
 RETURN QUERY SELECT a.billing_request_id FROM gateway_charge_admissions a JOIN author_operator_resolutions r USING(billing_request_id)
 WHERE a.billing_request_id=_request.billing_request_id AND a.org_id=_org AND a.api_key_id=_key
  AND a.attempt_id=r.attempt_id AND a.state='settled' AND a.actual_cost_credits=0 AND a.outcome_kind='verified_no_charge'
  AND r.kind='verified_no_charge' AND a.usage_snapshot->>'resolutionId'=r.id::text;
END $$;


CREATE TABLE author_probe_operator_reviews (
 probe_id UUID PRIMARY KEY REFERENCES author_probe_operations(id),
 actor_id UUID NOT NULL REFERENCES users(id),
 evidence_reference TEXT NOT NULL CHECK(length(evidence_reference) BETWEEN 3 AND 1024),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER author_probe_review_immutable BEFORE UPDATE OR DELETE ON author_probe_operator_reviews
 FOR EACH ROW EXECUTE FUNCTION aiag_author_money_immutable();
CREATE FUNCTION aiag_review_author_probe(_probe UUID,_actor UUID,_evidence TEXT)
RETURNS TABLE(probe_id UUID,reviewed BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE _p author_probe_operations%ROWTYPE; _review author_probe_operator_reviews%ROWTYPE; _email TEXT;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 IF _evidence IS NULL OR length(_evidence) NOT BETWEEN 3 AND 1024 THEN RAISE EXCEPTION 'AUTHOR_RECONCILIATION_INVALID'; END IF;
 PERFORM 1 FROM models m JOIN author_model_versions v ON v.model_id=m.id JOIN author_probe_operations p ON p.version_id=v.id WHERE p.id=_probe FOR UPDATE OF m;
 SELECT * INTO _p FROM author_probe_operations p WHERE p.id=_probe FOR UPDATE;
 IF NOT FOUND OR NOT (_p.state='unknown' OR (_p.state='dispatching' AND _p.deadline_at<=clock_timestamp())) THEN RAISE EXCEPTION 'AUTHOR_PROBE_CONFLICT'; END IF;
 INSERT INTO author_probe_operator_reviews(probe_id,actor_id,evidence_reference) VALUES(_probe,_actor,_evidence) ON CONFLICT ON CONSTRAINT author_probe_operator_reviews_pkey DO NOTHING;
 SELECT * INTO _review FROM author_probe_operator_reviews r WHERE r.probe_id=_probe;
 IF _review.evidence_reference IS DISTINCT FROM _evidence THEN RAISE EXCEPTION 'AUTHOR_PROBE_CONFLICT'; END IF;
 INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
 VALUES(_email,'admin','author.probe.review','author_probe',_probe::text,jsonb_build_object('evidence_reference',_evidence));
 RETURN QUERY SELECT _probe,true;
END $$;

CREATE OR REPLACE FUNCTION aiag_claim_author_probe(_version UUID,_digest TEXT,_actor UUID,_body_digest TEXT,_claim UUID)
RETURNS TABLE(id UUID,state TEXT,did_claim BOOLEAN,deadline_at TIMESTAMPTZ) LANGUAGE plpgsql AS $$
DECLARE _v author_model_versions%ROWTYPE; _p author_probe_operations%ROWTYPE; _email TEXT; _inserted BOOLEAN;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 IF _claim IS NULL OR _body_digest IS NULL OR _body_digest !~ '^sha256:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'AUTHOR_PROBE_INVALID'; END IF;
 PERFORM 1 FROM models m WHERE m.id=(SELECT v.model_id FROM author_model_versions v WHERE v.id=_version) FOR UPDATE;
 SELECT * INTO _v FROM author_model_versions v WHERE v.id=_version FOR UPDATE;
 IF NOT FOUND OR _v.manifest_digest IS DISTINCT FROM _digest OR _v.status<>'candidate' THEN RAISE EXCEPTION 'AUTHOR_VERSION_CONFLICT'; END IF;
 IF _v.author_user_id=_actor THEN RAISE EXCEPTION 'AUTHOR_INDEPENDENT_REVIEW_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE users.id=_v.author_user_id AND is_active AND NOT is_banned) THEN RAISE EXCEPTION 'AUTHOR_OWNER_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM author_probe_operations previous JOIN author_model_versions v ON v.id=previous.version_id
  WHERE v.model_id=_v.model_id AND previous.version_id<>_version AND previous.state IN('dispatching','unknown')
   AND NOT EXISTS(SELECT 1 FROM author_probe_operator_reviews review WHERE review.probe_id=previous.id))
 THEN RAISE EXCEPTION 'AUTHOR_PROBE_REVIEW_REQUIRED'; END IF;
 INSERT INTO author_probe_operations(version_id,manifest_digest,request_digest,claim_token,requested_by,state,deadline_at)
 VALUES(_version,_digest,_body_digest,_claim,_actor,'dispatching',clock_timestamp()+INTERVAL '10 seconds')
 ON CONFLICT(version_id) DO NOTHING;
 _inserted:=FOUND;
 SELECT * INTO _p FROM author_probe_operations p WHERE p.version_id=_version FOR UPDATE;
 IF _p.manifest_digest IS DISTINCT FROM _digest OR _p.request_digest IS DISTINCT FROM _body_digest THEN RAISE EXCEPTION 'AUTHOR_PROBE_CONFLICT'; END IF;
 IF NOT _inserted AND _p.state='dispatching' AND _p.deadline_at<=clock_timestamp() THEN
  UPDATE author_probe_operations p SET state='unknown',error_code='ENDPOINT_UNAVAILABLE',finished_at=clock_timestamp() WHERE p.id=_p.id RETURNING * INTO _p;
 END IF;
 IF _inserted THEN
  INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
  VALUES(_email,'admin','author.probe.claim','author_version',_version::text,jsonb_build_object('operation_id',_p.id));
 END IF;
 RETURN QUERY SELECT _p.id,_p.state,_inserted,_p.deadline_at;
END $$;


COMMIT;
