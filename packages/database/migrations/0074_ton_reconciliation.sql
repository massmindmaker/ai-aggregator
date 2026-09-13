-- TON testnet reconciliation persistence. Native source continuation only.
CREATE TABLE ton_chain_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES ton_invoices(id) ON DELETE RESTRICT,
  source_id VARCHAR(96) NOT NULL,
  recipient_account VARCHAR(67) NOT NULL,
  tx_hash CHAR(64),
  message_hash CHAR(64),
  tx_lt VARCHAR(78),
  provider_id VARCHAR(96) NOT NULL,
  evidence_model TEXT NOT NULL CHECK (evidence_model='server_trusted_indexer'),
  result_kind TEXT NOT NULL CHECK
    (result_kind IN ('source_error','observed','unmatched','verified_candidate','review_required')),
  reason VARCHAR(64) NOT NULL,
  observation_key CHAR(64) NOT NULL UNIQUE,
  evidence_digest CHAR(64),
  provider_cursor JSONB,
  snapshot JSONB NOT NULL CHECK
    (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=32768),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_id ~ '\A[0-9a-f]{64}\Z'),
  CHECK (recipient_account ~ '\A(0|-1):[0-9a-f]{64}\Z'),
  CHECK (observation_key ~ '\A[0-9a-f]{64}\Z'),
  CHECK (evidence_digest IS NULL OR evidence_digest ~ '\A[0-9a-f]{64}\Z'),
  CHECK ((tx_hash IS NULL AND message_hash IS NULL AND tx_lt IS NULL)
      OR (tx_hash ~ '\A[0-9a-f]{64}\Z'
      AND message_hash ~ '\A[0-9a-f]{64}\Z'
      AND tx_lt ~ '\A(0|[1-9][0-9]{0,77})\Z'))
);

CREATE TABLE ton_reconciliation_cursors (
  source_id VARCHAR(96) PRIMARY KEY,
  schema_version SMALLINT NOT NULL CHECK (schema_version=1),
  network TEXT NOT NULL CHECK (network='tvm:-3'),
  provider_id VARCHAR(96) NOT NULL,
  cursor JSONB,
  recipient_account VARCHAR(67),
  recipient_binding JSONB,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_id ~ '\A[0-9a-f]{64}\Z'),
  CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((recipient_account IS NULL)=(recipient_binding IS NULL)),
  CHECK (recipient_account IS NULL OR recipient_account ~ '\A(0|-1):[0-9a-f]{64}\Z'),
  CHECK (cursor IS NULL OR (jsonb_typeof(cursor)='object' AND octet_length(cursor::text)<=1024)),
  CHECK (recipient_binding IS NULL OR (jsonb_typeof(recipient_binding)='object'
    AND octet_length(recipient_binding::text)<=2048))
);

CREATE INDEX ton_invoices_reconciliation_source
  ON ton_invoices(network,asset_kind,master_address,asset_decimals,recipient,created_at,id);
CREATE INDEX ton_chain_observations_invoice_created
  ON ton_chain_observations(invoice_id,created_at,id);

CREATE FUNCTION aiag_ton_reconciliation_immutable_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'TON_RECONCILIATION_IMMUTABLE';
END
$$;

CREATE FUNCTION aiag_ton_reconciliation_cursor_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.source_id,NEW.schema_version,NEW.network,NEW.provider_id)
       IS DISTINCT FROM
       ROW(OLD.source_id,OLD.schema_version,OLD.network,OLD.provider_id) THEN
      RAISE EXCEPTION 'TON_SOURCE_IDENTITY_IMMUTABLE';
    END IF;
    IF OLD.recipient_binding IS NOT NULL AND
       ROW(NEW.recipient_account,NEW.recipient_binding)
       IS DISTINCT FROM ROW(OLD.recipient_account,OLD.recipient_binding) THEN
      RAISE EXCEPTION 'TON_RECIPIENT_BINDING_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ton_chain_observation_immutable
BEFORE UPDATE OR DELETE ON ton_chain_observations
FOR EACH ROW EXECUTE FUNCTION aiag_ton_reconciliation_immutable_v1();

CREATE TRIGGER ton_reconciliation_cursor_guard
BEFORE UPDATE ON ton_reconciliation_cursors
FOR EACH ROW EXECUTE FUNCTION aiag_ton_reconciliation_cursor_guard_v1();

CREATE FUNCTION aiag_ton_reconciliation_source_id_v1(
  _provider TEXT,
  _asset JSONB,
  _recipient TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(
    sha256(
      convert_to(_provider,'UTF8') || decode('00','hex') ||
      convert_to(
        CASE
          WHEN _asset='{"decimals":9,"kind":"native","network":"tvm:-3"}'::jsonb
            THEN '{"decimals":9,"kind":"native","network":"tvm:-3"}'
          ELSE _asset::text
        END,
        'UTF8'
      ) || decode('00','hex') ||
      convert_to(_recipient,'UTF8')
    ),
    'hex'
  )
$$;

CREATE FUNCTION aiag_ton_reconciliation_cursor_v1(_cursor JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF _cursor IS NULL THEN RETURN; END IF;
  PERFORM aiag_ton_keys_v1(
    _cursor,
    ARRAY['schemaVersion','beforeLt','beforeTransactionHash','cycleUpperLt']
  );
  IF _cursor->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'TON_INVALID_CURSOR';
  END IF;
  PERFORM aiag_ton_text_v1(_cursor->'beforeLt','\A(0|[1-9][0-9]{0,77})\Z',78);
  PERFORM aiag_ton_text_v1(_cursor->'beforeTransactionHash','\A[0-9a-f]{64}\Z',64);
  PERFORM aiag_ton_text_v1(_cursor->'cycleUpperLt','\A(0|[1-9][0-9]{0,77})\Z',78);
  IF (_cursor->>'beforeLt')::numeric>(_cursor->>'cycleUpperLt')::numeric THEN
    RAISE EXCEPTION 'TON_INVALID_CURSOR';
  END IF;
END
$$;

CREATE FUNCTION aiag_ton_reconciliation_source_v1(
  _source JSONB,
  _provider TEXT
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _expected TEXT;
  _asset CONSTANT JSONB := '{"decimals":9,"kind":"native","network":"tvm:-3"}'::jsonb;
BEGIN
  PERFORM aiag_ton_keys_v1(
    _source,
    ARRAY['sourceId','network','asset','invoiceRecipient','scanFloorTimeMs']
  );
  IF _provider IS DISTINCT FROM 'toncenter-v3-testnet' OR
     _source->'network' IS DISTINCT FROM '"tvm:-3"'::jsonb OR
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

CREATE FUNCTION aiag_ton_reconciliation_binding_v1(
  _binding JSONB,
  _source JSONB
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM aiag_ton_keys_v1(_binding,ARRAY['recipientAccount','derivation']);
  PERFORM aiag_ton_keys_v1(_binding->'derivation',ARRAY['kind','ownerAddress']);
  IF _binding->'derivation'->'kind' IS DISTINCT FROM '"native"'::jsonb THEN
    RAISE EXCEPTION 'TON_INVALID_BINDING';
  END IF;
  PERFORM aiag_ton_text_v1(_binding->'recipientAccount','\A(0|-1):[0-9a-f]{64}\Z',67);
  PERFORM aiag_ton_text_v1(_binding->'derivation'->'ownerAddress','\A(0|-1):[0-9a-f]{64}\Z',67);
  IF _binding->>'recipientAccount' IS DISTINCT FROM _source->>'invoiceRecipient' OR
     _binding->'derivation'->>'ownerAddress' IS DISTINCT FROM _source->>'invoiceRecipient' THEN
    RAISE EXCEPTION 'TON_INVALID_BINDING';
  END IF;
END
$$;

CREATE FUNCTION aiag_list_ton_reconciliation_sources_v1(
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
    SELECT recipient,min(quoted_at) AS floor_time
      FROM ton_invoices
     WHERE network='tvm:-3' AND asset_kind='native'
       AND master_address IS NULL AND asset_decimals=9
     GROUP BY recipient
  ), sources AS (
    SELECT aiag_ton_reconciliation_source_id_v1(
             'toncenter-v3-testnet',
             '{"decimals":9,"kind":"native","network":"tvm:-3"}'::jsonb,
             recipient
           ) AS source_id,
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
        'network','tvm:-3',
        'asset','{"decimals":9,"kind":"native","network":"tvm:-3"}'::jsonb,
        'invoiceRecipient',recipient,
        'scanFloorTimeMs',floor(extract(epoch FROM floor_time)*1000)::bigint
      ) ORDER BY source_id
    ),
    '[]'::jsonb
  ) INTO _result FROM bounded;
  RETURN _result;
END
$$;

CREATE FUNCTION aiag_find_ton_invoices_for_reconciliation_v1(
  _source JSONB,
  _references TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _result JSONB;
BEGIN
  PERFORM aiag_ton_reconciliation_source_v1(_source,'toncenter-v3-testnet');
  IF _references IS NULL OR cardinality(_references)<1 OR cardinality(_references)>8 OR
     EXISTS(SELECT 1 FROM unnest(_references) r WHERE r !~ '\Aaiag-ton:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z') OR
     cardinality(_references)<>(SELECT count(DISTINCT r) FROM unnest(_references) r) THEN
    RAISE EXCEPTION 'TON_INVALID_REFERENCES';
  END IF;
  SELECT COALESCE(jsonb_agg(aiag_ton_invoice_json_v1(i) ORDER BY i.reference),'[]'::jsonb)
    INTO _result
    FROM ton_invoices i
   WHERE i.reference=ANY(_references)
     AND i.network='tvm:-3'
     AND i.asset_kind='native'
     AND i.master_address IS NULL
     AND i.asset_decimals=9
     AND i.recipient=_source->>'invoiceRecipient';
  RETURN _result;
END
$$;

CREATE FUNCTION aiag_get_ton_invoice_for_reconciliation_v1(_invoice UUID)
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT aiag_ton_invoice_json_v1(i) FROM ton_invoices i WHERE i.id=_invoice
$$;

CREATE FUNCTION aiag_ton_observation_input_v1(_input JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _kind TEXT; _reason TEXT; _digest JSONB; _event JSONB;
BEGIN
  PERFORM aiag_ton_keys_v1(
    _input,
    ARRAY['schemaVersion','invoiceId','sourceId','recipientAccount','eventIdentity',
          'providerId','evidenceModel','result','providerCursor','snapshot','observedAtMs']
  );
  IF octet_length(_input::text)>65536 OR _input->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR
     _input->'providerId' IS DISTINCT FROM '"toncenter-v3-testnet"'::jsonb OR
     _input->'evidenceModel' IS DISTINCT FROM '"server_trusted_indexer"'::jsonb THEN
    RAISE EXCEPTION 'TON_INVALID_OBSERVATION';
  END IF;
  PERFORM aiag_ton_text_v1(_input->'sourceId','\A[0-9a-f]{64}\Z',64);
  PERFORM aiag_ton_text_v1(_input->'recipientAccount','\A(0|-1):[0-9a-f]{64}\Z',67);
  PERFORM aiag_ton_time_v1(_input->'observedAtMs');
  PERFORM aiag_ton_reconciliation_cursor_v1(_input->'providerCursor');
  IF jsonb_typeof(_input->'snapshot') IS DISTINCT FROM 'object' OR
     octet_length((_input->'snapshot')::text)>32768 THEN
    RAISE EXCEPTION 'TON_INVALID_SNAPSHOT';
  END IF;
  PERFORM aiag_ton_keys_v1(_input->'result',ARRAY['kind','reason','evidenceDigest']);
  _kind:=_input->'result'->>'kind';
  _reason:=_input->'result'->>'reason';
  _digest:=_input->'result'->'evidenceDigest';
  IF _kind='source_error' THEN
    IF _reason<>ALL(ARRAY['origin_mismatch','redirect_rejected','response_too_large',
       'http_unauthorized','rate_limited','timeout','upstream_5xx','provider_schema_invalid',
       'pagination_regressed','recipient_binding_changed','unsupported_asset']) OR
       _digest IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'TON_INVALID_OBSERVATION_RESULT';
    END IF;
  ELSIF _kind='observed' THEN
    IF _reason<>ALL(ARRAY['candidate_not_found','trace_incomplete','finality_pending']) OR
       (_digest<>'null'::jsonb AND aiag_ton_text_v1(_digest,'\A[0-9a-f]{64}\Z',64) IS NULL) THEN
      RAISE EXCEPTION 'TON_INVALID_OBSERVATION_RESULT';
    END IF;
  ELSIF _kind='unmatched' THEN
    IF _reason IS DISTINCT FROM 'invoice_reference_not_found' THEN RAISE EXCEPTION 'TON_INVALID_OBSERVATION_RESULT'; END IF;
    PERFORM aiag_ton_text_v1(_digest,'\A[0-9a-f]{64}\Z',64);
  ELSIF _kind='verified_candidate' THEN
    IF _reason IS DISTINCT FROM 'verified_candidate' THEN RAISE EXCEPTION 'TON_INVALID_OBSERVATION_RESULT'; END IF;
    PERFORM aiag_ton_text_v1(_digest,'\A[0-9a-f]{64}\Z',64);
  ELSIF _kind='review_required' THEN
    IF _reason<>ALL(ARRAY['network_mismatch','policy_mismatch','trace_oversized','trace_emulated',
       'trace_aborted','trace_bounced','trace_failed','message_linkage_invalid','inclusion_mismatch',
       'asset_mismatch','recipient_mismatch','sender_mismatch','reference_mismatch','amount_mismatch',
       'jetton_master_mismatch','jetton_wallet_mismatch','jetton_notification_invalid',
       'settlement_evidence_conflict']) THEN
      RAISE EXCEPTION 'TON_INVALID_OBSERVATION_RESULT';
    END IF;
    PERFORM aiag_ton_text_v1(_digest,'\A[0-9a-f]{64}\Z',64);
  ELSE
    RAISE EXCEPTION 'TON_INVALID_OBSERVATION_RESULT';
  END IF;
  _event:=_input->'eventIdentity';
  IF _event<>'null'::jsonb THEN
    PERFORM aiag_ton_keys_v1(_event,ARRAY['txHash','messageHash','txLt']);
    PERFORM aiag_ton_text_v1(_event->'txHash','\A[0-9a-f]{64}\Z',64);
    PERFORM aiag_ton_text_v1(_event->'messageHash','\A[0-9a-f]{64}\Z',64);
    PERFORM aiag_ton_text_v1(_event->'txLt','\A(0|[1-9][0-9]{0,77})\Z',78);
  END IF;
  IF (_kind='source_error' OR (_kind='observed' AND _reason='candidate_not_found')) THEN
    IF _input->'invoiceId'<>'null'::jsonb OR _event<>'null'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_OBSERVATION_IDENTITY'; END IF;
  ELSIF _kind='unmatched' THEN
    IF _input->'invoiceId'<>'null'::jsonb OR _event='null'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_OBSERVATION_IDENTITY'; END IF;
  ELSE
    IF jsonb_typeof(_input->'invoiceId') IS DISTINCT FROM 'string' OR _event='null'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_OBSERVATION_IDENTITY'; END IF;
    PERFORM (_input->>'invoiceId')::uuid;
  END IF;
END
$$;

CREATE FUNCTION aiag_record_ton_chain_observation_v1(_input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  _invoice_id UUID;
  _org UUID;
  _invoice ton_invoices;
  _cursor ton_reconciliation_cursors;
  _observation UUID;
  _inserted UUID;
  _key TEXT;
  _kind TEXT;
  _reason TEXT;
  _status TEXT;
  _expected_source TEXT;
BEGIN
  PERFORM aiag_ton_observation_input_v1(_input);
  _invoice_id:=(_input->>'invoiceId')::uuid;
  _kind:=_input->'result'->>'kind';
  _reason:=_input->'result'->>'reason';
  SELECT * INTO _cursor FROM ton_reconciliation_cursors
   WHERE source_id=_input->>'sourceId';
  IF NOT FOUND OR _cursor.network<>'tvm:-3' OR _cursor.provider_id<>'toncenter-v3-testnet' OR
     _cursor.recipient_account IS NULL OR _cursor.recipient_binding IS NULL OR
     _cursor.recipient_account<>_input->>'recipientAccount' OR
     _cursor.recipient_binding->>'recipientAccount'<>_input->>'recipientAccount' THEN
    RAISE EXCEPTION 'TON_SOURCE_BINDING_MISMATCH';
  END IF;
  IF _invoice_id IS NOT NULL THEN
    SELECT org_id INTO _org FROM ton_invoices WHERE id=_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TON_INVOICE_NOT_FOUND'; END IF;
    PERFORM id FROM organizations WHERE id=_org FOR UPDATE;
    SELECT * INTO _invoice FROM ton_invoices
     WHERE id=_invoice_id AND org_id=_org FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TON_INVOICE_NOT_FOUND'; END IF;
    IF _invoice.network<>'tvm:-3' OR _invoice.asset_kind<>'native' OR
       _invoice.master_address IS NOT NULL OR _invoice.asset_decimals<>9 OR
       _invoice.recipient<>_cursor.recipient_binding->'derivation'->>'ownerAddress' OR
       _input->'snapshot'->>'reference' IS DISTINCT FROM _invoice.reference THEN
      RAISE EXCEPTION 'TON_OBSERVATION_INVOICE_MISMATCH';
    END IF;
    _expected_source:=aiag_ton_reconciliation_source_id_v1(
      'toncenter-v3-testnet',
      '{"decimals":9,"kind":"native","network":"tvm:-3"}'::jsonb,
      _invoice.recipient
    );
    IF _expected_source IS DISTINCT FROM _input->>'sourceId' THEN
      RAISE EXCEPTION 'TON_OBSERVATION_INVOICE_MISMATCH';
    END IF;
  END IF;
  _key:=encode(sha256(convert_to((_input-'observedAtMs')::text,'UTF8')),'hex');
  INSERT INTO ton_chain_observations(
    invoice_id,source_id,recipient_account,tx_hash,message_hash,tx_lt,
    provider_id,evidence_model,result_kind,reason,observation_key,evidence_digest,
    provider_cursor,snapshot,observed_at
  ) VALUES (
    _invoice_id,_input->>'sourceId',_input->>'recipientAccount',
    _input->'eventIdentity'->>'txHash',_input->'eventIdentity'->>'messageHash',
    _input->'eventIdentity'->>'txLt',_input->>'providerId',_input->>'evidenceModel',
    _kind,_reason,_key,_input->'result'->>'evidenceDigest',_input->'providerCursor',
    _input->'snapshot',to_timestamp((_input->>'observedAtMs')::numeric/1000)
  ) ON CONFLICT(observation_key) DO NOTHING RETURNING id INTO _inserted;
  IF _inserted IS NULL THEN
    SELECT id INTO _observation FROM ton_chain_observations WHERE observation_key=_key;
    IF _observation IS NULL THEN RAISE EXCEPTION 'TON_OBSERVATION_CAS'; END IF;
  ELSE
    _observation:=_inserted;
  END IF;
  IF _invoice_id IS NOT NULL AND _kind='verified_candidate' THEN
    UPDATE ton_invoices SET status='observed',updated_at=clock_timestamp()
     WHERE id=_invoice_id AND org_id=_org AND status='pending';
  ELSIF _invoice_id IS NOT NULL AND _kind='review_required' THEN
    UPDATE ton_invoices SET status='review_required',review_reason=_reason,updated_at=clock_timestamp()
     WHERE id=_invoice_id AND org_id=_org AND status IN ('pending','observed','expired');
  END IF;
  IF _invoice_id IS NOT NULL THEN SELECT status INTO _status FROM ton_invoices WHERE id=_invoice_id; END IF;
  RETURN jsonb_build_object(
    'observationId',_observation::text,
    'outcome',CASE WHEN _inserted IS NULL THEN 'already_recorded' ELSE 'inserted' END,
    'invoiceStatus',_status
  );
END
$$;

CREATE FUNCTION aiag_claim_ton_reconciliation_lease_v1(
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
DECLARE _claimed ton_reconciliation_cursors; _current ton_reconciliation_cursors;
BEGIN
  PERFORM aiag_ton_reconciliation_source_v1(_source,_provider);
  IF _lease_owner IS NULL OR _lease_ms<>90000 THEN RAISE EXCEPTION 'TON_INVALID_LEASE'; END IF;
  WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS now),
  inserted AS (
    INSERT INTO ton_reconciliation_cursors(
      source_id,schema_version,network,provider_id,lease_owner,lease_expires_at,
      next_attempt_at,updated_at
    )
    SELECT _source->>'sourceId',1,'tvm:-3',_provider,_lease_owner,
           tick.now+interval '90 seconds',tick.now,tick.now
      FROM tick
    ON CONFLICT(source_id) DO NOTHING
    RETURNING *
  ), updated AS (
    UPDATE ton_reconciliation_cursors c
       SET lease_owner=_lease_owner,
           lease_expires_at=tick.now+interval '90 seconds',
           updated_at=tick.now
      FROM tick
     WHERE c.source_id=_source->>'sourceId'
       AND c.network='tvm:-3' AND c.provider_id=_provider
       AND c.next_attempt_at<=tick.now
       AND (c.lease_owner IS NULL OR c.lease_expires_at<=tick.now)
       AND NOT EXISTS(SELECT 1 FROM inserted)
    RETURNING c.*
  )
  SELECT * INTO _claimed FROM (
    SELECT * FROM inserted UNION ALL SELECT * FROM updated
  ) claimed LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('kind','claimed','cursor',_claimed.cursor,'binding',_claimed.recipient_binding);
  END IF;
  SELECT * INTO _current FROM ton_reconciliation_cursors WHERE source_id=_source->>'sourceId';
  IF NOT FOUND OR _current.network<>'tvm:-3' OR _current.provider_id<>_provider THEN
    RETURN jsonb_build_object('kind','source_identity_mismatch');
  END IF;
  RETURN jsonb_build_object('kind','busy');
END
$$;

CREATE FUNCTION aiag_bind_ton_reconciliation_recipient_v1(
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
DECLARE _updated TEXT; _current ton_reconciliation_cursors; _now TIMESTAMPTZ;
BEGIN
  PERFORM aiag_ton_reconciliation_source_v1(_source,'toncenter-v3-testnet');
  PERFORM aiag_ton_reconciliation_cursor_v1(_expected);
  PERFORM aiag_ton_reconciliation_binding_v1(_binding,_source);
  WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS now), updated AS (
    UPDATE ton_reconciliation_cursors c
       SET recipient_account=_binding->>'recipientAccount',
           recipient_binding=_binding,
           updated_at=tick.now
      FROM tick
     WHERE c.source_id=_source->>'sourceId'
       AND c.network='tvm:-3' AND c.provider_id='toncenter-v3-testnet'
       AND c.lease_owner=_lease_owner AND c.lease_expires_at>tick.now
       AND c.cursor IS NOT DISTINCT FROM _expected
       AND (c.recipient_binding IS NULL OR
            ROW(c.recipient_account,c.recipient_binding) IS NOT DISTINCT FROM
            ROW(_binding->>'recipientAccount',_binding))
    RETURNING c.source_id
  ) SELECT source_id INTO _updated FROM updated;
  IF _updated IS NOT NULL THEN RETURN 'bound'; END IF;
  SELECT * INTO _current
    FROM ton_reconciliation_cursors WHERE source_id=_source->>'sourceId';
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.network<>'tvm:-3' OR _current.provider_id<>'toncenter-v3-testnet' THEN RETURN 'source_identity_mismatch'; END IF;
  IF _current.lease_owner IS DISTINCT FROM _lease_owner OR _current.lease_expires_at<=_now THEN RETURN 'lease_lost'; END IF;
  IF _current.cursor IS DISTINCT FROM _expected THEN RETURN 'cursor_conflict'; END IF;
  RETURN 'binding_mismatch';
END
$$;

CREATE FUNCTION aiag_renew_ton_reconciliation_lease_v1(
  _source_id TEXT,
  _lease_owner UUID,
  _expected JSONB,
  _lease_ms INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _updated TEXT; _current ton_reconciliation_cursors; _now TIMESTAMPTZ;
BEGIN
  IF _source_id !~ '\A[0-9a-f]{64}\Z' OR _lease_owner IS NULL OR _lease_ms<>90000 THEN RAISE EXCEPTION 'TON_INVALID_LEASE'; END IF;
  PERFORM aiag_ton_reconciliation_cursor_v1(_expected);
  WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS now), updated AS (
    UPDATE ton_reconciliation_cursors c
       SET lease_expires_at=tick.now+interval '90 seconds',updated_at=tick.now
      FROM tick
     WHERE c.source_id=_source_id AND c.lease_owner=_lease_owner
       AND c.lease_expires_at>tick.now
       AND c.cursor IS NOT DISTINCT FROM _expected
    RETURNING c.source_id
  ) SELECT source_id INTO _updated FROM updated;
  IF _updated IS NOT NULL THEN RETURN 'renewed'; END IF;
  SELECT * INTO _current FROM ton_reconciliation_cursors WHERE source_id=_source_id;
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.lease_owner IS DISTINCT FROM _lease_owner OR _current.lease_expires_at<=_now THEN RETURN 'lease_lost'; END IF;
  RETURN 'cursor_conflict';
END
$$;

CREATE FUNCTION aiag_advance_ton_reconciliation_cursor_v1(
  _source_id TEXT,
  _lease_owner UUID,
  _expected JSONB,
  _next JSONB,
  _outcome TEXT,
  _retry_after_ms INTEGER,
  _error_code TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _updated TEXT; _current ton_reconciliation_cursors; _now TIMESTAMPTZ;
BEGIN
  IF _source_id !~ '\A[0-9a-f]{64}\Z' OR _lease_owner IS NULL THEN RAISE EXCEPTION 'TON_INVALID_ADVANCE'; END IF;
  PERFORM aiag_ton_reconciliation_cursor_v1(_expected);
  PERFORM aiag_ton_reconciliation_cursor_v1(_next);
  IF _outcome='success' THEN
    IF _retry_after_ms IS NOT NULL OR _error_code IS NOT NULL THEN RAISE EXCEPTION 'TON_INVALID_ADVANCE'; END IF;
  ELSIF _outcome='source_error' THEN
    IF _error_code<>ALL(ARRAY['origin_mismatch','redirect_rejected','response_too_large',
       'http_unauthorized','rate_limited','timeout','upstream_5xx','provider_schema_invalid',
       'pagination_regressed','recipient_binding_changed','unsupported_asset']) OR
       _next IS DISTINCT FROM _expected OR _retry_after_ms<0 OR _retry_after_ms>900000 OR
       (_error_code<>'rate_limited' AND _retry_after_ms IS NOT NULL) THEN
      RAISE EXCEPTION 'TON_INVALID_ADVANCE';
    END IF;
  ELSE RAISE EXCEPTION 'TON_INVALID_ADVANCE';
  END IF;
  WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS now), updated AS (
    UPDATE ton_reconciliation_cursors c
       SET cursor=_next,
           lease_expires_at=tick.now+interval '90 seconds',
           consecutive_failures=CASE WHEN _outcome='success' THEN 0 ELSE c.consecutive_failures+1 END,
           next_attempt_at=CASE WHEN _outcome='success' THEN tick.now ELSE
             tick.now + make_interval(secs =>
               (CASE WHEN _error_code='rate_limited' AND _retry_after_ms IS NOT NULL
                     THEN least(greatest(_retry_after_ms,1000),900000)::numeric
                     ELSE least(5000::numeric*power(2::numeric,least(c.consecutive_failures,8)),900000::numeric)
                END)/1000)
             END,
           last_error_code=CASE WHEN _outcome='success' THEN NULL ELSE _error_code END,
           updated_at=tick.now
      FROM tick
     WHERE c.source_id=_source_id AND c.lease_owner=_lease_owner
       AND c.lease_expires_at>tick.now
       AND c.cursor IS NOT DISTINCT FROM _expected
    RETURNING c.source_id
  ) SELECT source_id INTO _updated FROM updated;
  IF _updated IS NOT NULL THEN RETURN 'advanced'; END IF;
  SELECT * INTO _current FROM ton_reconciliation_cursors WHERE source_id=_source_id;
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.lease_owner IS DISTINCT FROM _lease_owner OR _current.lease_expires_at<=_now THEN RETURN 'lease_lost'; END IF;
  RETURN 'cursor_conflict';
END
$$;

CREATE FUNCTION aiag_release_ton_reconciliation_lease_v1(
  _source_id TEXT,
  _lease_owner UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _updated TEXT;
BEGIN
  IF _source_id !~ '\A[0-9a-f]{64}\Z' OR _lease_owner IS NULL THEN RAISE EXCEPTION 'TON_INVALID_LEASE'; END IF;
  WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS now), updated AS (
    UPDATE ton_reconciliation_cursors c
       SET lease_owner=NULL,lease_expires_at=NULL,updated_at=tick.now
      FROM tick
     WHERE c.source_id=_source_id AND c.lease_owner=_lease_owner
       AND c.lease_expires_at>tick.now
    RETURNING c.source_id
  ) SELECT source_id INTO _updated FROM updated;
  IF _updated IS NULL THEN RETURN 'lease_lost'; END IF;
  RETURN 'released';
END
$$;

REVOKE EXECUTE ON FUNCTION
  aiag_ton_reconciliation_immutable_v1(),
  aiag_ton_reconciliation_cursor_guard_v1(),
  aiag_ton_reconciliation_source_id_v1(text,jsonb,text),
  aiag_ton_reconciliation_cursor_v1(jsonb),
  aiag_ton_reconciliation_source_v1(jsonb,text),
  aiag_ton_reconciliation_binding_v1(jsonb,jsonb),
  aiag_list_ton_reconciliation_sources_v1(text,integer,text),
  aiag_find_ton_invoices_for_reconciliation_v1(jsonb,text[]),
  aiag_get_ton_invoice_for_reconciliation_v1(uuid),
  aiag_ton_observation_input_v1(jsonb),
  aiag_record_ton_chain_observation_v1(jsonb),
  aiag_claim_ton_reconciliation_lease_v1(jsonb,text,uuid,integer),
  aiag_bind_ton_reconciliation_recipient_v1(jsonb,uuid,jsonb,jsonb),
  aiag_renew_ton_reconciliation_lease_v1(text,uuid,jsonb,integer),
  aiag_advance_ton_reconciliation_cursor_v1(text,uuid,jsonb,jsonb,text,integer,text),
  aiag_release_ton_reconciliation_lease_v1(text,uuid)
FROM PUBLIC;
