-- 0103: mainnet observations + operator-triggered retry settlement
-- (review fix pass: Critical C2.2 + Important I1).
-- Observation recording (0074) was testnet-pinned; it now derives the
-- network/provider pair from the source cursor and the invoice itself.
CREATE OR REPLACE FUNCTION aiag_ton_observation_input_v1(_input JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE _kind TEXT; _reason TEXT; _digest JSONB; _event JSONB; _provider TEXT;
BEGIN
  PERFORM aiag_ton_keys_v1(
    _input,
    ARRAY['schemaVersion','invoiceId','sourceId','recipientAccount','eventIdentity',
          'providerId','evidenceModel','result','providerCursor','snapshot','observedAtMs']
  );
  _provider:=_input->>'providerId';
  IF octet_length(_input::text)>65536 OR _input->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR
     (_provider IS DISTINCT FROM 'toncenter-v3-testnet' AND _provider IS DISTINCT FROM 'toncenter-v3-mainnet') OR
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

CREATE OR REPLACE FUNCTION aiag_record_ton_chain_observation_v1(_input JSONB)
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
  _asset JSONB;
BEGIN
  PERFORM aiag_ton_observation_input_v1(_input);
  _invoice_id:=(_input->>'invoiceId')::uuid;
  _kind:=_input->'result'->>'kind';
  _reason:=_input->'result'->>'reason';
  SELECT * INTO _cursor FROM ton_reconciliation_cursors
   WHERE source_id=_input->>'sourceId';
  IF NOT FOUND OR _cursor.network NOT IN ('tvm:-3','tvm:-1') OR
     _cursor.provider_id IS DISTINCT FROM (CASE _cursor.network WHEN 'tvm:-1' THEN 'toncenter-v3-mainnet' ELSE 'toncenter-v3-testnet' END) OR
     _cursor.provider_id<>_input->>'providerId' OR
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
    IF _invoice.network NOT IN ('tvm:-3','tvm:-1') OR _invoice.network<>_cursor.network OR _invoice.asset_kind<>'native' OR
       _invoice.master_address IS NOT NULL OR _invoice.asset_decimals<>9 OR
       _invoice.recipient<>_cursor.recipient_binding->'derivation'->>'ownerAddress' OR
       _input->'snapshot'->>'reference' IS DISTINCT FROM _invoice.reference THEN
      RAISE EXCEPTION 'TON_OBSERVATION_INVOICE_MISMATCH';
    END IF;
    _asset:=jsonb_build_object('decimals',9,'kind','native','network',_invoice.network);
    _expected_source:=aiag_ton_reconciliation_source_id_v1(
      CASE _invoice.network WHEN 'tvm:-1' THEN 'toncenter-v3-mainnet' ELSE 'toncenter-v3-testnet' END,
      _asset,
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

-- Operator-triggered retry settlement (I1): rebuilds the verified credit from
-- the persisted event snapshots and re-runs the settle core under the same
-- worker-only session gate as settle_invoice_v1.
CREATE FUNCTION aiag_ton_worker.retry_reviewed_invoice_v1(_invoice UUID,_event UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $aiag$
DECLARE
  _e ton_chain_events;
  _credit JSONB;
BEGIN
 IF SESSION_USER::text <> 'aiag_ton_worker' THEN RAISE EXCEPTION 'TON_SETTLEMENT_SESSION_REQUIRED' USING ERRCODE='42501'; END IF;
 IF _invoice IS NULL OR _event IS NULL THEN RAISE EXCEPTION 'TON_SETTLEMENT_INPUT_INVALID'; END IF;
 SELECT * INTO _e FROM ton_chain_events WHERE id=_event;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM ton_invoice_event_decisions d WHERE d.invoice_id=_invoice AND d.event_id=_event) THEN
   RAISE EXCEPTION 'TON_SETTLEMENT_INPUT_INVALID';
 END IF;
 -- facts ∪ evidence cover every credit field except the observation/verification
 -- timestamps, which live on the event row itself.
 _credit:=_e.fact_snapshot||_e.evidence_snapshot||jsonb_build_object(
   'observedAtMs',(extract(epoch FROM _e.observed_at)*1000)::bigint,
   'verifiedAtMs',(extract(epoch FROM _e.verified_at)*1000)::bigint
 );
 RETURN public.aiag_settle_ton_invoice_v1(_invoice,_credit);
END
$aiag$;
ALTER FUNCTION aiag_ton_worker.retry_reviewed_invoice_v1(uuid,uuid) OWNER TO aiag_ton_worker_owner;
REVOKE ALL ON FUNCTION aiag_ton_worker.retry_reviewed_invoice_v1(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiag_ton_worker.retry_reviewed_invoice_v1(uuid,uuid) TO aiag_ton_worker;
GRANT SELECT ON public.ton_invoice_event_decisions TO aiag_ton_worker;

-- Operator retry queue read (I1): worker-only, returns {invoiceId,eventId}[]
-- for retry_requested invoices that are neither settled nor acknowledged.
CREATE FUNCTION aiag_list_retry_requested_ton_invoices_v1(_limit INTEGER)
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(row_data ORDER BY row_data->>'createdAt'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object('invoiceId',r.invoice_id::text,'eventId',r.event_id::text,'createdAt',r.created_at::text) AS row_data
    FROM ton_invoice_event_decisions r
    JOIN ton_invoices i ON i.id=r.invoice_id
    WHERE r.decision='retry_requested'
      AND i.status<>'settled'
      AND NOT EXISTS (SELECT 1 FROM ton_invoice_event_decisions a
        WHERE a.invoice_id=r.invoice_id AND a.decision='acknowledged_no_credit')
      AND NOT EXISTS (SELECT 1 FROM ton_invoice_event_decisions s
        WHERE s.invoice_id=r.invoice_id AND s.decision='settled')
    ORDER BY r.created_at, r.id
    LIMIT LEAST(GREATEST(COALESCE(_limit,20),1),100)
  ) queued
$$;
REVOKE EXECUTE ON FUNCTION aiag_list_retry_requested_ton_invoices_v1(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiag_list_retry_requested_ton_invoices_v1(integer) TO aiag_ton_worker;
