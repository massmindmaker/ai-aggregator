-- 0102: mainnet reconciliation sources (plan AG-TON-L mainnet wiring).
-- The source identity pairs each network with its canonical provider id:
-- 'tvm:-3' → toncenter-v3-testnet, 'tvm:-1' → toncenter-v3-mainnet. All
-- reconciliation functions below were testnet-pinned in 0074/0076; they now
-- validate against the network carried by the source itself.
CREATE OR REPLACE FUNCTION aiag_ton_reconciliation_source_v1(_source JSONB,_provider TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _expected TEXT;
  _network TEXT;
  _asset JSONB;
BEGIN
  PERFORM aiag_ton_keys_v1(
    _source,
    ARRAY['sourceId','network','asset','invoiceRecipient','scanFloorTimeMs']
  );
  _network:=_source->>'network';
  IF _network='tvm:-1' THEN
    _asset:='{"decimals":9,"kind":"native","network":"tvm:-1"}'::jsonb;
  ELSIF _network='tvm:-3' THEN
    _asset:='{"decimals":9,"kind":"native","network":"tvm:-3"}'::jsonb;
  ELSE
    RAISE EXCEPTION 'TON_INVALID_SOURCE';
  END IF;
  IF _provider IS DISTINCT FROM (CASE _network WHEN 'tvm:-1' THEN 'toncenter-v3-mainnet' ELSE 'toncenter-v3-testnet' END) OR
     _source->'asset' IS DISTINCT FROM _asset THEN
    RAISE EXCEPTION 'TON_INVALID_SOURCE';
  END IF;
  PERFORM aiag_ton_text_v1(_source->'sourceId','\A[0-9a-f]{64}\Z',64);
  PERFORM aiag_ton_text_v1(_source->'invoiceRecipient','\A(0|-1):[0-9a-f]{64}\Z',67);
  PERFORM aiag_ton_time_v1(_source->'scanFloorTimeMs');
  _expected:=aiag_ton_reconciliation_source_id_v1(
    _provider,
    _asset,
    _source->>'invoiceRecipient'
  );
  IF _source->>'sourceId' IS DISTINCT FROM _expected THEN
    RAISE EXCEPTION 'TON_INVALID_SOURCE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION aiag_claim_ton_reconciliation_lease_v1(
  _source JSONB,
  _provider TEXT,
  _lease_owner UUID,
  _lease_ms INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _claimed ton_reconciliation_cursors;
  _current ton_reconciliation_cursors;
  _now TIMESTAMPTZ;
  _inserted BOOLEAN := FALSE;
BEGIN
  PERFORM aiag_ton_reconciliation_source_v1(_source,_provider);
  IF _lease_owner IS NULL OR _lease_ms<>90000 THEN
    RAISE EXCEPTION 'TON_INVALID_LEASE';
  END IF;

  INSERT INTO ton_reconciliation_cursors(
    source_id,schema_version,network,provider_id,next_attempt_at,updated_at
  ) VALUES (
    _source->>'sourceId',1,_source->>'network',_provider,'-infinity'::timestamptz,
    '-infinity'::timestamptz
  )
  ON CONFLICT(source_id) DO NOTHING
  RETURNING TRUE INTO _inserted;
  IF NOT FOUND THEN _inserted:=FALSE; END IF;

  SELECT * INTO _current
    FROM ton_reconciliation_cursors
   WHERE source_id=_source->>'sourceId'
   FOR UPDATE;
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.network<>_source->>'network' OR _current.provider_id<>_provider THEN
    RETURN jsonb_build_object('kind','source_identity_mismatch');
  END IF;
  IF _current.next_attempt_at>_now OR
     (_current.lease_owner IS NOT NULL AND _current.lease_expires_at>_now) THEN
    RETURN jsonb_build_object('kind','busy');
  END IF;

  UPDATE ton_reconciliation_cursors
     SET lease_owner=_lease_owner,
         lease_expires_at=_now+interval '90 seconds',
         next_attempt_at=CASE WHEN _inserted THEN _now ELSE _current.next_attempt_at END,
         updated_at=_now
   WHERE source_id=_current.source_id
  RETURNING * INTO _claimed;
  RETURN jsonb_build_object(
    'kind','claimed','cursor',_claimed.cursor,'binding',_claimed.recipient_binding
  );
END
$$;

CREATE OR REPLACE FUNCTION aiag_bind_ton_reconciliation_recipient_v1(
  _source JSONB,
  _lease_owner UUID,
  _expected JSONB,
  _binding JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _current ton_reconciliation_cursors;
  _now TIMESTAMPTZ;
  _provider TEXT;
BEGIN
  _provider:=CASE _source->>'network' WHEN 'tvm:-1' THEN 'toncenter-v3-mainnet' ELSE 'toncenter-v3-testnet' END;
  PERFORM aiag_ton_reconciliation_source_v1(_source,_provider);
  PERFORM aiag_ton_reconciliation_cursor_v1(_expected);
  PERFORM aiag_ton_reconciliation_binding_v1(_binding,_source);

  SELECT * INTO _current
    FROM ton_reconciliation_cursors
   WHERE source_id=_source->>'sourceId'
   FOR UPDATE;
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.network<>_source->>'network' OR
     _current.provider_id<>_provider THEN
    RETURN 'source_identity_mismatch';
  END IF;
  IF _current.lease_owner IS DISTINCT FROM _lease_owner OR
     _current.lease_expires_at<=_now THEN
    RETURN 'lease_lost';
  END IF;
  IF _current.cursor IS DISTINCT FROM _expected THEN
    RETURN 'cursor_conflict';
  END IF;
  IF _current.recipient_binding IS NOT NULL AND
     ROW(_current.recipient_account,_current.recipient_binding)
     IS DISTINCT FROM ROW(_binding->>'recipientAccount',_binding) THEN
    RETURN 'binding_mismatch';
  END IF;

  UPDATE ton_reconciliation_cursors
     SET recipient_account=_binding->>'recipientAccount',
         recipient_binding=_binding,
         updated_at=_now
   WHERE source_id=_current.source_id
     AND lease_owner=_lease_owner;
  RETURN 'bound';
END
$$;

CREATE OR REPLACE FUNCTION aiag_find_ton_invoices_for_reconciliation_v1(
  _source JSONB,
  _references TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _result JSONB; _provider TEXT;
BEGIN
  _provider:=CASE _source->>'network' WHEN 'tvm:-1' THEN 'toncenter-v3-mainnet' ELSE 'toncenter-v3-testnet' END;
  PERFORM aiag_ton_reconciliation_source_v1(_source,_provider);
  IF _references IS NULL OR cardinality(_references)<1 OR cardinality(_references)>8 OR
     EXISTS(SELECT 1 FROM unnest(_references) r WHERE r !~ '\Aaiag-ton:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z') OR
     cardinality(_references)<>(SELECT count(DISTINCT r) FROM unnest(_references) r) THEN
    RAISE EXCEPTION 'TON_INVALID_REFERENCES';
  END IF;
  SELECT COALESCE(jsonb_agg(aiag_ton_invoice_json_v1(i) ORDER BY i.reference),'[]'::jsonb)
    INTO _result
    FROM ton_invoices i
   WHERE i.reference=ANY(_references)
     AND i.network=_source->>'network'
     AND i.asset_kind='native'
     AND i.master_address IS NULL
     AND i.asset_decimals=9
     AND i.recipient=_source->>'invoiceRecipient';
  RETURN _result;
END
$$;

CREATE OR REPLACE FUNCTION aiag_list_ton_reconciliation_sources_v1(
  _after_source_id TEXT,
  _limit INTEGER,
  _asset_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _result JSONB;
BEGIN
  IF _limit IS NULL OR _limit<1 OR _limit>16 OR _asset_kind IS DISTINCT FROM 'native' OR
     (_after_source_id IS NOT NULL AND _after_source_id !~ '\A[0-9a-f]{64}\Z') THEN
    RAISE EXCEPTION 'TON_INVALID_SOURCE_LIST';
  END IF;
  WITH grouped AS (
    SELECT network,recipient,min(quoted_at) AS floor_time
      FROM ton_invoices
     WHERE network IN ('tvm:-3','tvm:-1') AND asset_kind='native'
       AND master_address IS NULL AND asset_decimals=9
     GROUP BY network,recipient
  ), sources AS (
    SELECT aiag_ton_reconciliation_source_id_v1(
             CASE network WHEN 'tvm:-1' THEN 'toncenter-v3-mainnet' ELSE 'toncenter-v3-testnet' END,
             jsonb_build_object('decimals',9,'kind','native','network',network),
             recipient
           ) AS source_id,
           network,
           recipient,
           floor_time
      FROM grouped
  ), bounded AS (
    SELECT * FROM sources
     WHERE _after_source_id IS NULL OR source_id>_after_source_id
     ORDER BY source_id
     LIMIT _limit
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'sourceId',source_id,
        'network',network,
        'asset',jsonb_build_object('decimals',9,'kind','native','network',network),
        'invoiceRecipient',recipient,
        'scanFloorTimeMs',floor(extract(epoch FROM floor_time)*1000)::bigint
      ) ORDER BY source_id
    ),
    '[]'::jsonb
  ) INTO _result FROM bounded;
  RETURN _result;
END
$$;
