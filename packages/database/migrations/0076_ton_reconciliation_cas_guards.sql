-- Additive Task 3 review correction. Applied 0074/0075 remain immutable.
CREATE OR REPLACE FUNCTION aiag_ton_reconciliation_cursor_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'TON_RECONCILIATION_CURSOR_IMMUTABLE';
  END IF;
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
  RETURN NEW;
END
$$;

DROP TRIGGER ton_reconciliation_cursor_guard ON ton_reconciliation_cursors;
CREATE TRIGGER ton_reconciliation_cursor_guard
BEFORE UPDATE OR DELETE ON ton_reconciliation_cursors
FOR EACH ROW EXECUTE FUNCTION aiag_ton_reconciliation_cursor_guard_v1();

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
    _source->>'sourceId',1,'tvm:-3',_provider,'-infinity'::timestamptz,
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
  IF NOT FOUND OR _current.network<>'tvm:-3' OR _current.provider_id<>_provider THEN
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
BEGIN
  PERFORM aiag_ton_reconciliation_source_v1(_source,'toncenter-v3-testnet');
  PERFORM aiag_ton_reconciliation_cursor_v1(_expected);
  PERFORM aiag_ton_reconciliation_binding_v1(_binding,_source);

  SELECT * INTO _current
    FROM ton_reconciliation_cursors
   WHERE source_id=_source->>'sourceId'
   FOR UPDATE;
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.network<>'tvm:-3' OR
     _current.provider_id<>'toncenter-v3-testnet' THEN
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
   WHERE source_id=_current.source_id;
  RETURN 'bound';
END
$$;

CREATE OR REPLACE FUNCTION aiag_renew_ton_reconciliation_lease_v1(
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
DECLARE
  _current ton_reconciliation_cursors;
  _now TIMESTAMPTZ;
BEGIN
  IF _source_id !~ '\A[0-9a-f]{64}\Z' OR _lease_owner IS NULL OR _lease_ms<>90000 THEN
    RAISE EXCEPTION 'TON_INVALID_LEASE';
  END IF;
  PERFORM aiag_ton_reconciliation_cursor_v1(_expected);

  SELECT * INTO _current
    FROM ton_reconciliation_cursors
   WHERE source_id=_source_id
   FOR UPDATE;
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.lease_owner IS DISTINCT FROM _lease_owner OR
     _current.lease_expires_at<=_now THEN
    RETURN 'lease_lost';
  END IF;
  IF _current.cursor IS DISTINCT FROM _expected THEN
    RETURN 'cursor_conflict';
  END IF;

  UPDATE ton_reconciliation_cursors
     SET lease_expires_at=_now+interval '90 seconds',updated_at=_now
   WHERE source_id=_current.source_id;
  RETURN 'renewed';
END
$$;

CREATE OR REPLACE FUNCTION aiag_advance_ton_reconciliation_cursor_v1(
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
DECLARE
  _current ton_reconciliation_cursors;
  _now TIMESTAMPTZ;
BEGIN
  IF _source_id !~ '\A[0-9a-f]{64}\Z' OR _lease_owner IS NULL THEN
    RAISE EXCEPTION 'TON_INVALID_ADVANCE';
  END IF;
  PERFORM aiag_ton_reconciliation_cursor_v1(_expected);
  PERFORM aiag_ton_reconciliation_cursor_v1(_next);
  IF _outcome='success' THEN
    IF _retry_after_ms IS NOT NULL OR _error_code IS NOT NULL THEN
      RAISE EXCEPTION 'TON_INVALID_ADVANCE';
    END IF;
  ELSIF _outcome='source_error' THEN
    IF _error_code<>ALL(ARRAY['origin_mismatch','redirect_rejected','response_too_large',
       'http_unauthorized','rate_limited','timeout','upstream_5xx','provider_schema_invalid',
       'pagination_regressed','recipient_binding_changed','unsupported_asset']) OR
       _next IS DISTINCT FROM _expected OR _retry_after_ms<0 OR _retry_after_ms>900000 OR
       (_error_code<>'rate_limited' AND _retry_after_ms IS NOT NULL) THEN
      RAISE EXCEPTION 'TON_INVALID_ADVANCE';
    END IF;
  ELSE
    RAISE EXCEPTION 'TON_INVALID_ADVANCE';
  END IF;

  SELECT * INTO _current
    FROM ton_reconciliation_cursors
   WHERE source_id=_source_id
   FOR UPDATE;
  _now:=clock_timestamp();
  IF NOT FOUND OR _current.lease_owner IS DISTINCT FROM _lease_owner OR
     _current.lease_expires_at<=_now THEN
    RETURN 'lease_lost';
  END IF;
  IF _current.cursor IS DISTINCT FROM _expected THEN
    RETURN 'cursor_conflict';
  END IF;

  UPDATE ton_reconciliation_cursors
     SET cursor=_next,
         lease_expires_at=_now+interval '90 seconds',
         consecutive_failures=CASE
           WHEN _outcome='success' THEN 0 ELSE _current.consecutive_failures+1
         END,
         next_attempt_at=CASE WHEN _outcome='success' THEN _now ELSE
           _now + make_interval(secs =>
             (CASE WHEN _error_code='rate_limited' AND _retry_after_ms IS NOT NULL
                   THEN least(greatest(_retry_after_ms,1000),900000)::numeric
                   ELSE least(
                     5000::numeric*power(2::numeric,least(_current.consecutive_failures,8)),
                     900000::numeric
                   )
              END)/1000
           )
         END,
         last_error_code=CASE WHEN _outcome='success' THEN NULL ELSE _error_code END,
         updated_at=_now
   WHERE source_id=_current.source_id;
  RETURN 'advanced';
END
$$;

REVOKE EXECUTE ON FUNCTION
  aiag_ton_reconciliation_cursor_guard_v1(),
  aiag_claim_ton_reconciliation_lease_v1(jsonb,text,uuid,integer),
  aiag_bind_ton_reconciliation_recipient_v1(jsonb,uuid,jsonb,jsonb),
  aiag_renew_ton_reconciliation_lease_v1(text,uuid,jsonb,integer),
  aiag_advance_ton_reconciliation_cursor_v1(text,uuid,jsonb,jsonb,text,integer,text)
FROM PUBLIC;
