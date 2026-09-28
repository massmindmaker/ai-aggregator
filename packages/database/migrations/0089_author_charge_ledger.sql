-- Author versions reuse the stored gateway charge authority and durable quota counters.
BEGIN;
CREATE TABLE author_request_bindings (
 billing_request_id UUID PRIMARY KEY REFERENCES gateway_http_requests(billing_request_id) ON DELETE RESTRICT,
 org_id UUID NOT NULL REFERENCES organizations(id), api_key_id UUID NOT NULL REFERENCES gateway_api_keys(id),
 model_id UUID NOT NULL REFERENCES models(id), version_id UUID NOT NULL REFERENCES author_model_versions(id),
 policy_id UUID NOT NULL REFERENCES author_price_policies(id), author_user_id UUID NOT NULL REFERENCES users(id),
 author_quote JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 disputed BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE author_credit_ledger (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 billing_request_id UUID NOT NULL REFERENCES author_request_bindings(billing_request_id) ON DELETE RESTRICT,
 author_user_id UUID NOT NULL REFERENCES users(id), version_id UUID NOT NULL REFERENCES author_model_versions(id),
 policy_id UUID NOT NULL REFERENCES author_price_policies(id),
 kind TEXT NOT NULL CHECK(kind IN('accrual','reversal')),
 amount_microcredits BIGINT NOT NULL,
 available_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(billing_request_id,kind),
 CHECK((kind='accrual' AND amount_microcredits>=0) OR (kind='reversal' AND amount_microcredits<=0))
);
CREATE INDEX author_credit_owner ON author_credit_ledger(author_user_id,created_at);
CREATE TABLE author_charge_refunds (
 billing_request_id UUID PRIMARY KEY REFERENCES author_request_bindings(billing_request_id),
 refund_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(), actor_id UUID NOT NULL REFERENCES users(id),
 total_microcredits BIGINT NOT NULL CHECK(total_microcredits>0),
 subscription_microcredits BIGINT NOT NULL CHECK(subscription_microcredits>=0),
 payg_microcredits BIGINT NOT NULL CHECK(payg_microcredits>=0),
 expired_subscription_microcredits BIGINT NOT NULL CHECK(expired_subscription_microcredits>=0),
 debt_repaid_microcredits BIGINT NOT NULL CHECK(debt_repaid_microcredits>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(total_microcredits=subscription_microcredits+payg_microcredits+expired_subscription_microcredits+debt_repaid_microcredits)
);
CREATE TABLE author_mock_payouts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), author_user_id UUID NOT NULL REFERENCES users(id),
 idempotency_key_digest TEXT NOT NULL CHECK(idempotency_key_digest ~ '^[0-9a-f]{64}$'),
 recipient_reference TEXT NOT NULL CHECK(recipient_reference ~ '^mock:[A-Za-z0-9._:-]{1,128}$'),
 amount_microcredits BIGINT NOT NULL CHECK(amount_microcredits>0), claim_token UUID NOT NULL,
 state TEXT NOT NULL CHECK(state IN('dispatching','unknown','paid')),
 deadline_at TIMESTAMPTZ NOT NULL, receipt_reference TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), finished_at TIMESTAMPTZ,
 UNIQUE(author_user_id,idempotency_key_digest),
 CHECK((state='paid' AND receipt_reference='mock:'||id::text AND finished_at IS NOT NULL) OR (state<>'paid' AND receipt_reference IS NULL))
);

CREATE FUNCTION aiag_author_money_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='author_request_bindings' THEN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'disputed') IS DISTINCT FROM (to_jsonb(OLD)-'disputed') THEN RAISE EXCEPTION 'AUTHOR_BINDING_IMMUTABLE'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='author_mock_payouts' AND TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','receipt_reference','finished_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','receipt_reference','finished_at'])
   OR OLD.state='paid' AND NEW IS DISTINCT FROM OLD OR OLD.state='unknown' AND NEW.state='dispatching'
  THEN RAISE EXCEPTION 'AUTHOR_PAYOUT_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'AUTHOR_LEDGER_IMMUTABLE';
END $$;
CREATE TRIGGER author_binding_immutable BEFORE UPDATE OR DELETE ON author_request_bindings FOR EACH ROW EXECUTE FUNCTION aiag_author_money_immutable();
CREATE TRIGGER author_credit_immutable BEFORE UPDATE OR DELETE ON author_credit_ledger FOR EACH ROW EXECUTE FUNCTION aiag_author_money_immutable();
CREATE TRIGGER author_refund_immutable BEFORE UPDATE OR DELETE ON author_charge_refunds FOR EACH ROW EXECUTE FUNCTION aiag_author_money_immutable();
CREATE TRIGGER author_payout_immutable BEFORE UPDATE OR DELETE ON author_mock_payouts FOR EACH ROW EXECUTE FUNCTION aiag_author_money_immutable();

CREATE FUNCTION aiag_author_price_quote(_version UUID,_policy UUID) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE _v author_model_versions%ROWTYPE; _p author_price_policies%ROWTYPE; _slug TEXT;
BEGIN
 SELECT * INTO _v FROM author_model_versions WHERE id=_version;
 SELECT * INTO _p FROM author_price_policies WHERE id=_policy AND version_id=_version;
 IF _v.id IS NULL OR _p.id IS NULL OR _p.approved_at IS NULL OR _p.accepted_by IS DISTINCT FROM _v.author_user_id
  OR _p.manifest_digest IS DISTINCT FROM _v.manifest_digest THEN RAISE EXCEPTION 'AUTHOR_POLICY_CONFLICT'; END IF;
 SELECT slug INTO _slug FROM models WHERE id=_v.model_id;
 RETURN jsonb_build_object('version',1,'formulaVersion','author-fixed-microcredits-v1','modelSlug',_slug,
  'modelId',_v.model_id,'versionId',_version,'manifestDigest',_v.manifest_digest,'policyId',_policy,'policyDigest',_p.policy_digest,
  'priceMicrocredits',_p.price_microcredits::text,'authorShareBps',_p.author_share_bps,
  'authorMicrocredits',floor(_p.price_microcredits::numeric*_p.author_share_bps/10000)::bigint::text,
  'availabilityDelaySeconds',_p.availability_delay_seconds);
END $$;
CREATE FUNCTION aiag_author_quote_values(_q JSONB,_slug TEXT) RETURNS BIGINT[] LANGUAGE plpgsql STABLE AS $$
DECLARE _p author_price_policies%ROWTYPE; _v author_model_versions%ROWTYPE; _price BIGINT; _share BIGINT;
BEGIN
 IF NOT aiag_quota_keys(_q,ARRAY['version','formulaVersion','modelSlug','modelId','versionId','manifestDigest','policyId','policyDigest','priceMicrocredits','authorShareBps','authorMicrocredits','availabilityDelaySeconds'])
  OR _q->'version' IS DISTINCT FROM '1'::jsonb OR _q->>'formulaVersion' IS DISTINCT FROM 'author-fixed-microcredits-v1'
  OR _q->>'modelSlug' IS DISTINCT FROM _slug OR coalesce(_q->>'versionId','') !~ '^[0-9a-f-]{36}$' OR coalesce(_q->>'policyId','') !~ '^[0-9a-f-]{36}$'
 THEN RAISE EXCEPTION 'AUTHOR_QUOTE_INVALID'; END IF;
 SELECT * INTO _v FROM author_model_versions WHERE id=(_q->>'versionId')::uuid;
 SELECT * INTO _p FROM author_price_policies WHERE id=(_q->>'policyId')::uuid AND version_id=_v.id;
 IF _p.id IS NULL OR _p.approved_at IS NULL OR _p.accepted_by IS DISTINCT FROM _v.author_user_id
  OR _p.policy_digest IS DISTINCT FROM _q->>'policyDigest' OR _v.manifest_digest IS DISTINCT FROM _q->>'manifestDigest'
  OR _v.model_id::text IS DISTINCT FROM _q->>'modelId' OR to_jsonb(_p.author_share_bps) IS DISTINCT FROM _q->'authorShareBps'
  OR to_jsonb(_p.availability_delay_seconds) IS DISTINCT FROM _q->'availabilityDelaySeconds'
 THEN RAISE EXCEPTION 'AUTHOR_QUOTE_INVALID'; END IF;
 _price:=aiag_quota_money(aiag_quota_decimal(_q->'priceMicrocredits',true));
 _share:=aiag_quota_money(aiag_quota_decimal(_q->'authorMicrocredits',true));
 IF _price<>_p.price_microcredits OR _share<>floor(_price::numeric*_p.author_share_bps/10000) THEN RAISE EXCEPTION 'AUTHOR_QUOTE_INVALID'; END IF;
 RETURN ARRAY[_price,aiag_quota_money(_share::numeric*10)];
END $$;

CREATE FUNCTION aiag_bind_author_request(_org UUID,_key UUID,_billing UUID,_version UUID,_policy UUID,_fingerprint TEXT)
RETURNS TABLE(author_quote JSONB) LANGUAGE plpgsql AS $$
DECLARE _m models%ROWTYPE; _v author_model_versions%ROWTYPE; _r gateway_http_requests%ROWTYPE; _b author_request_bindings%ROWTYPE; _quote JSONB;
BEGIN
 PERFORM 1 FROM organizations WHERE id=_org FOR UPDATE;
 SELECT * INTO _r FROM gateway_http_requests WHERE billing_request_id=_billing FOR UPDATE;
 IF NOT FOUND OR _r.org_id IS DISTINCT FROM _org OR _r.api_key_id IS DISTINCT FROM _key OR _r.route_kind<>'chat' OR _r.billing_mode<>'stored'
  OR _r.contract_version<>1 OR _r.request_fingerprint IS DISTINCT FROM _fingerprint THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
 SELECT * INTO _b FROM author_request_bindings WHERE billing_request_id=_billing;
 IF FOUND THEN
  IF _b.version_id IS DISTINCT FROM _version OR _b.policy_id IS DISTINCT FROM _policy THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
  RETURN QUERY SELECT _b.author_quote; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM gateway_charge_admissions WHERE billing_request_id=_billing) THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
 SELECT * INTO _m FROM models WHERE id=(SELECT model_id FROM author_model_versions WHERE id=_version) FOR SHARE;
 SELECT * INTO _v FROM author_model_versions WHERE id=_version;
 IF _m.id IS NULL OR NOT _m.enabled OR _m.status<>'live' OR _m.current_author_version_id IS DISTINCT FROM _version OR _v.status<>'approved'
  OR _m.author_user_id IS DISTINCT FROM _v.author_user_id OR NOT EXISTS(SELECT 1 FROM users WHERE id=_v.author_user_id AND is_active AND NOT is_banned)
 THEN RAISE EXCEPTION 'AUTHOR_VERSION_UNAVAILABLE'; END IF;
 _quote:=aiag_author_price_quote(_version,_policy);
 INSERT INTO author_request_bindings(billing_request_id,org_id,api_key_id,model_id,version_id,policy_id,author_user_id,author_quote)
 VALUES(_billing,_org,_key,_m.id,_version,_policy,_v.author_user_id,_quote);
 RETURN QUERY SELECT _quote;
END $$;

CREATE FUNCTION aiag_accrue_pinned_author_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _b author_request_bindings%ROWTYPE; _share BIGINT; _existing author_credit_ledger%ROWTYPE;
BEGIN
 IF NEW.state<>'settled' OR OLD.state='settled' THEN RETURN NEW; END IF;
 SELECT * INTO _b FROM author_request_bindings WHERE billing_request_id=NEW.billing_request_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('author:'||_b.author_user_id::text,0));
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
CREATE TRIGGER author_credit_on_settlement AFTER UPDATE OF state ON gateway_charge_admissions FOR EACH ROW EXECUTE FUNCTION aiag_accrue_pinned_author_credit();

CREATE FUNCTION aiag_author_credit_balance(_author UUID)
RETURNS TABLE(available_microcredits TEXT,pending_microcredits TEXT,paid_microcredits TEXT,reserved_microcredits TEXT) LANGUAGE sql VOLATILE AS $$
 WITH earnings AS (
  SELECT l.billing_request_id,sum(l.amount_microcredits) AS amount,min(l.available_at) AS available_at,b.disputed
  FROM author_credit_ledger l JOIN author_request_bindings b USING(billing_request_id)
  WHERE l.author_user_id=_author GROUP BY l.billing_request_id,b.disputed
 ), amounts AS (
  SELECT coalesce(sum(amount) FILTER(WHERE available_at<=clock_timestamp() AND NOT disputed),0) AS available,
   coalesce(sum(amount) FILTER(WHERE available_at>clock_timestamp() OR disputed),0) AS pending FROM earnings
 ), payouts AS (
  SELECT coalesce(sum(amount_microcredits) FILTER(WHERE state='paid'),0) AS paid,
   coalesce(sum(amount_microcredits) FILTER(WHERE state IN('dispatching','unknown')),0) AS reserved
  FROM author_mock_payouts WHERE author_user_id=_author
 ) SELECT (available-paid-reserved)::text,pending::text,paid::text,reserved::text FROM amounts CROSS JOIN payouts
$$;

CREATE FUNCTION aiag_claim_author_mock_payout(_author UUID,_key TEXT,_recipient TEXT,_amount BIGINT,_claim UUID)
RETURNS TABLE(id UUID,state TEXT,did_claim BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE _p author_mock_payouts%ROWTYPE; _balance NUMERIC;
BEGIN
 IF _author IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE users.id=_author AND is_active AND NOT is_banned) THEN RAISE EXCEPTION 'AUTHOR_OWNER_REQUIRED'; END IF;
 IF _claim IS NULL OR _amount IS NULL OR _amount<=0 OR _key IS NULL OR _key !~ '^[0-9a-f]{64}$' OR _recipient IS NULL OR _recipient !~ '^mock:[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'AUTHOR_PAYOUT_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('author:'||_author::text,0));
 SELECT * INTO _p FROM author_mock_payouts p WHERE p.author_user_id=_author AND p.idempotency_key_digest=_key FOR UPDATE;
 IF FOUND THEN
  IF _p.recipient_reference IS DISTINCT FROM _recipient OR _p.amount_microcredits IS DISTINCT FROM _amount THEN RAISE EXCEPTION 'AUTHOR_PAYOUT_CONFLICT'; END IF;
  IF _p.state='dispatching' AND _p.deadline_at<=clock_timestamp() THEN
   UPDATE author_mock_payouts p SET state='unknown' WHERE p.id=_p.id RETURNING * INTO _p;
  END IF;
  RETURN QUERY SELECT _p.id,_p.state,false; RETURN;
 END IF;
 SELECT available_microcredits::numeric INTO _balance FROM aiag_author_credit_balance(_author);
 IF _amount>_balance THEN RAISE EXCEPTION 'AUTHOR_PAYOUT_BALANCE'; END IF;
 INSERT INTO author_mock_payouts(author_user_id,idempotency_key_digest,recipient_reference,amount_microcredits,claim_token,state,deadline_at)
 VALUES(_author,_key,_recipient,_amount,_claim,'dispatching',clock_timestamp()+INTERVAL '10 seconds') RETURNING * INTO _p;
 RETURN QUERY SELECT _p.id,_p.state,true;
END $$;
CREATE FUNCTION aiag_complete_author_mock_payout(_id UUID,_claim UUID,_state TEXT)
RETURNS TABLE(id UUID,state TEXT) LANGUAGE plpgsql AS $$
DECLARE _p author_mock_payouts%ROWTYPE;
BEGIN
 SELECT * INTO _p FROM author_mock_payouts p WHERE p.id=_id FOR UPDATE;
 IF NOT FOUND OR _p.claim_token IS DISTINCT FROM _claim OR _claim IS NULL OR _state IS NULL OR _state NOT IN('unknown','paid') THEN RAISE EXCEPTION 'AUTHOR_PAYOUT_CONFLICT'; END IF;
 IF _p.state='paid' AND _state<>'paid' THEN RAISE EXCEPTION 'AUTHOR_PAYOUT_CONFLICT'; END IF;
 IF _p.state<>_state THEN
  UPDATE author_mock_payouts p SET state=_state,receipt_reference=CASE WHEN _state='paid' THEN 'mock:'||_id::text ELSE NULL END,
   finished_at=CASE WHEN _state='paid' THEN clock_timestamp() ELSE NULL END WHERE p.id=_id RETURNING * INTO _p;
 END IF;
 RETURN QUERY SELECT _p.id,_p.state;
END $$;

CREATE FUNCTION aiag_refund_author_request(_billing UUID,_actor UUID)
RETURNS SETOF author_charge_refunds LANGUAGE plpgsql AS $$
DECLARE _b author_request_bindings%ROWTYPE; _a gateway_charge_admissions%ROWTYPE; _o organizations%ROWTYPE;
 _r author_charge_refunds%ROWTYPE; _credit author_credit_ledger%ROWTYPE; _sub BIGINT; _payg BIGINT; _expired BIGINT:=0; _debt BIGINT; _email TEXT;
BEGIN
 _email:=aiag_require_author_admin(_actor);
 SELECT * INTO _b FROM author_request_bindings WHERE billing_request_id=_billing;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
 SELECT * INTO _o FROM organizations WHERE id=_b.org_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(_billing::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('author:'||_b.author_user_id::text,0));
 SELECT * INTO _r FROM author_charge_refunds WHERE billing_request_id=_billing;
 IF FOUND THEN RETURN NEXT _r; RETURN; END IF;
 SELECT * INTO _a FROM gateway_charge_admissions WHERE billing_request_id=_billing FOR UPDATE;
 SELECT * INTO _credit FROM author_credit_ledger WHERE billing_request_id=_billing AND kind='accrual';
 IF _a.state IS DISTINCT FROM 'settled' OR _credit.id IS NULL OR _a.actual_cost_credits<=0 THEN RAISE EXCEPTION 'AUTHOR_REFUND_NOT_READY'; END IF;
 _sub:=least(_a.actual_cost_credits,_a.held_subscription_credits);_payg:=_a.actual_cost_credits-_sub;
 IF _a.captured_subscription_expires_at IS DISTINCT FROM _o.subscription_credits_expires_at OR (_a.captured_subscription_expires_at IS NOT NULL AND _a.captured_subscription_expires_at<=clock_timestamp()) THEN _expired:=_sub;_sub:=0; END IF;
 _debt:=least(_payg,_o.refund_debt_credits);_payg:=_payg-_debt;
 UPDATE organizations SET subscription_credits=aiag_quota_money(subscription_credits::numeric+_sub),payg_credits=aiag_quota_money(payg_credits::numeric+_payg),refund_debt_credits=refund_debt_credits-_debt,updated_at=clock_timestamp()
 WHERE id=_o.id AND subscription_credits=_o.subscription_credits AND payg_credits=_o.payg_credits AND refund_debt_credits=_o.refund_debt_credits;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTHOR_REFUND_CONFLICT'; END IF;
 INSERT INTO author_charge_refunds(billing_request_id,actor_id,total_microcredits,subscription_microcredits,payg_microcredits,expired_subscription_microcredits,debt_repaid_microcredits)
 VALUES(_billing,_actor,_a.actual_cost_credits,_sub,_payg,_expired,_debt) RETURNING * INTO _r;
 IF _sub>0 THEN INSERT INTO gateway_transactions(org_id,request_id,type,source,delta,metadata) VALUES(_b.org_id,'author-refund:'||_billing::text,'refund','subscription',_sub,jsonb_build_object('billingRequestId',_billing,'refundId',_r.refund_id)); END IF;
 IF _payg>0 THEN INSERT INTO gateway_transactions(org_id,request_id,type,source,delta,metadata) VALUES(_b.org_id,'author-refund:'||_billing::text,'refund','payg',_payg,jsonb_build_object('billingRequestId',_billing,'refundId',_r.refund_id)); END IF;
 INSERT INTO author_credit_ledger(billing_request_id,author_user_id,version_id,policy_id,kind,amount_microcredits,available_at)
 VALUES(_billing,_b.author_user_id,_b.version_id,_b.policy_id,'reversal',-_credit.amount_microcredits,_credit.available_at);
 INSERT INTO audit_log(actor_email,actor_type,action,resource_type,resource_id,details)
 VALUES(_email,'admin','author.charge.refund','gateway_request',_billing::text,jsonb_build_object('refund_id',_r.refund_id,'microcredits',_r.total_microcredits::text));
 RETURN NEXT _r;
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
   OR coalesce(_q->>'routeKind','') NOT IN('image','video','audio_speech')
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
CREATE OR REPLACE FUNCTION aiag_quota_validate_dispatch(_a gateway_charge_admissions,_upstream TEXT,_pricing JSONB)
RETURNS VOID LANGUAGE plpgsql STABLE AS $$
DECLARE _ctx gateway_charge_quota_contexts%ROWTYPE;
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
 _i NUMERIC; _o NUMERIC; _m NUMERIC; _d NUMERIC; _base NUMERIC; _charged NUMERIC; _supplier BIGINT; _bounds NUMERIC[];
BEGIN
 PERFORM aiag_quota_validate_dispatch(_a,_a.upstream_id,_a.pricing_snapshot);
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


CREATE FUNCTION aiag_author_admission_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _b author_request_bindings%ROWTYPE; _m models%ROWTYPE;
BEGIN
 SELECT * INTO _b FROM author_request_bindings WHERE billing_request_id=NEW.billing_request_id;
 IF NOT FOUND AND NOT NEW.quote_snapshot ? 'authorQuote' THEN RETURN NEW; END IF;
 IF _b.billing_request_id IS NULL OR NEW.billing_mode<>'stored' OR NEW.route_kind<>'chat'
  OR NEW.org_id IS DISTINCT FROM _b.org_id OR NEW.api_key_id IS DISTINCT FROM _b.api_key_id
  OR NEW.quote_snapshot->'authorQuote' IS DISTINCT FROM _b.author_quote
 THEN RAISE EXCEPTION 'AUTHOR_REQUEST_CONFLICT'; END IF;
 SELECT * INTO _m FROM models WHERE id=_b.model_id FOR SHARE;
 IF _m.id IS NULL OR NOT _m.enabled OR _m.status<>'live' OR _m.current_author_version_id IS DISTINCT FROM _b.version_id
  OR NOT EXISTS(SELECT 1 FROM users WHERE id=_b.author_user_id AND is_active AND NOT is_banned)
 THEN RAISE EXCEPTION 'AUTHOR_VERSION_UNAVAILABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER author_admission_binding BEFORE INSERT ON gateway_charge_admissions FOR EACH ROW EXECUTE FUNCTION aiag_author_admission_binding_guard();

COMMIT;
