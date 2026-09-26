-- 0084_gateway_media_supplier_rounding.sql
-- Align SQL supplier USD-micro reserve with the TypeScript microcredit ceil boundary.

CREATE OR REPLACE FUNCTION aiag_quota_supplier_max(_mode TEXT,_model TEXT,_max BIGINT,_quote JSONB,_supplier JSONB)
RETURNS BIGINT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _q JSONB; _c JSONB; _v NUMERIC[]; _retail NUMERIC:=0; _s NUMERIC:=0; _discount NUMERIC; _base NUMERIC; _m NUMERIC;
BEGIN
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
