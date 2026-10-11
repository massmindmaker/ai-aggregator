-- 0109_usdt_jetton_reconciliation.sql
-- USDT (jetton) intake for the reconciliation rail (plan task 9).
--
-- 1) The 0106 agent-topup peg was mainnet-only; the jetton branch of
--    aiag_agent_ton_payload_v1 now accepts the canonical (network, master)
--    pair of BOTH chains: 'tvm:-1' + the raw TON mainnet USDT master, and
--    'tvm:-3' + an operator-configurable testnet master read from the
--    'aiag.usdt_testnet_master' GUC (session/role/database scope) with a
--    placeholder default that no real contract can occupy. There is no
--    canonical testnet USDT master in the repo/env sources, so the owner
--    confirms the address at testnet launch (GUC + a ton_asset_allowlist row;
--    until then invoice creation stays gated by TON_ASSET_NOT_ALLOWLISTED).
--    The function moves IMMUTABLE → STABLE because it reads that GUC; both
--    call sites (trigger guard, create entrypoint) PERFORM it per row inside
--    volatile plpgsql, so no planner/index consumer is affected.
-- 2) Allowlist seed: USDT mainnet jetton only. The testnet row is NOT seeded
--    (master undefined at migration time) — the owner INSERTs it at launch.
-- 3) Reconciliation sources become asset-aware following the 0102 pattern:
--    jetton sources group ton_invoices by (network, master, recipient) and
--    carry the same source-id derivation, binding, observation and
--    invoice-lookup contracts the native rail already enforces. The jetton
--    wallet contract of a merchant is chain data, not cursor state: it lives
--    in the evidence credit path (derivedMerchantWallet), never in the
--    immutable recipient binding.
BEGIN;

-- 1. Network-parameterized USDT peg (0106 replacement; only the jetton branch differs).
CREATE OR REPLACE FUNCTION aiag_agent_ton_payload_v1(_p JSONB,_actor UUID,_org UUID) RETURNS VOID LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _q JSONB; _fx JSONB; _grant NUMERIC; _num NUMERIC; _den NUMERIC; _prod NUMERIC; _converted NUMERIC; _rem NUMERIC; _fee NUMERIC; _key TEXT; _testnet_master TEXT;
BEGIN
 PERFORM aiag_ton_keys_v1(_p,ARRAY['schemaVersion','purpose','ownerId','orgId','idempotencyKey','grantMicrocredits','priceRevision','quote','recipient','finalityPolicyId','verifierVersion']);
 IF octet_length(_p::text)>16384 OR _p->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR _p->'purpose' IS DISTINCT FROM '"agent_topup"'::jsonb OR
    _p->>'ownerId' IS DISTINCT FROM _actor::text OR _p->>'orgId' IS DISTINCT FROM _org::text THEN RAISE EXCEPTION 'TON_INVALID_PAYLOAD'; END IF;
 PERFORM aiag_ton_text_v1(_p->'idempotencyKey','\A[A-Za-z0-9_-]{1,96}\Z',96);
 FOREACH _key IN ARRAY ARRAY['priceRevision','finalityPolicyId','verifierVersion'] LOOP
  PERFORM aiag_ton_text_v1(_p->_key,'\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 END LOOP;
 PERFORM aiag_ton_text_v1(_p->'recipient','\A(0|-1):[0-9a-f]{64}\Z',67);
 _grant:=aiag_ton_atomic_v1(_p->'grantMicrocredits');
 IF _grant<100000 THEN RAISE EXCEPTION 'AGENT_GRANT_TOO_SMALL'; END IF;
 _q:=_p->'quote';
 PERFORM aiag_ton_keys_v1(_q,ARRAY['schemaVersion','quoteId','sourcePrice','asset','fx','additionalFeeAtomic','expiresAtMs','amountAtomic','quotedAtMs']);
 IF octet_length(_q::text)>8192 OR _q->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_QUOTE'; END IF;
 PERFORM aiag_ton_text_v1(_q->'quoteId','\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 PERFORM aiag_ton_keys_v1(_q->'sourcePrice',ARRAY['unit','amountAtomic']);
 PERFORM aiag_ton_asset_v1(_q->'asset');
 _fx:=_q->'fx'; PERFORM aiag_ton_keys_v1(_fx,ARRAY['sourceUnit','targetAsset','numerator','denominator','rounding','source','observedAtMs','expiresAtMs']);
 PERFORM aiag_ton_asset_v1(_fx->'targetAsset');
 IF _q->'asset' IS DISTINCT FROM _fx->'targetAsset' OR _q->'sourcePrice'->'unit' IS DISTINCT FROM '"gateway_microcredits"'::jsonb OR
   _fx->'sourceUnit' IS DISTINCT FROM '"gateway_microcredits"'::jsonb OR _q->'sourcePrice'->'amountAtomic' IS DISTINCT FROM _p->'grantMicrocredits' THEN RAISE EXCEPTION 'TON_INVALID_GRANT_BINDING'; END IF;
 PERFORM aiag_ton_text_v1(_fx->'source','\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 _num:=aiag_ton_atomic_v1(_fx->'numerator'); _den:=aiag_ton_atomic_v1(_fx->'denominator'); _fee:=aiag_ton_atomic_v1(_q->'additionalFeeAtomic',TRUE);
 _prod:=_grant*_num; IF _prod>9223372036854775807 THEN RAISE EXCEPTION 'TON_FX_OVERFLOW'; END IF;
 _converted:=div(_prod,_den); _rem:=mod(_prod,_den);
 IF _fx->>'rounding'='ceil' THEN IF _rem>0 THEN _converted:=_converted+1; END IF;
 ELSIF _fx->>'rounding'='half-up' THEN IF _rem>=_den-_rem THEN _converted:=_converted+1; END IF;
 ELSIF _fx->>'rounding' IS DISTINCT FROM 'floor' THEN RAISE EXCEPTION 'TON_INVALID_ROUNDING'; END IF;
 IF _converted<=0 OR _converted+_fee>9223372036854775807 OR _converted+_fee<>aiag_ton_atomic_v1(_q->'amountAtomic') THEN RAISE EXCEPTION 'TON_QUOTE_MISMATCH'; END IF;
 -- USDT peg, oracle-free and identical for both chains: 1 USDT = 100 credits
 -- = 100_000 micro and USDT has 6 decimals, so amount_atomic MUST equal
 -- grant_microcredits x 10 exactly (additionalFeeAtomic is forced to 0 by
 -- this equality). Accepted (network, master) pairs:
 --   tvm:-1  0:b113a994...  raw form of EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs
 --   tvm:-3  <aiag.usdt_testnet_master GUC> or the all-zero placeholder
 -- Admission beyond this pair check still runs through ton_asset_allowlist
 -- (0098/0106), which stays empty for tvm:-3 until the owner seeds it.
 IF _q->'asset'->>'kind'='jetton' THEN
  _testnet_master:=coalesce(nullif(current_setting('aiag.usdt_testnet_master',TRUE),''),'0:'||repeat('0',64));
  IF _q->'asset'->>'decimals' IS DISTINCT FROM '6' OR NOT (
       (_q->'asset'->>'network'='tvm:-1'
        AND _q->'asset'->>'masterAddress'='0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe')
       OR (_q->'asset'->>'network'='tvm:-3'
        AND _q->'asset'->>'masterAddress'=_testnet_master)
     ) THEN RAISE EXCEPTION 'AGENT_ASSET_UNSUPPORTED'; END IF;
  IF aiag_ton_atomic_v1(_q->'amountAtomic') IS DISTINCT FROM _grant*10 THEN RAISE EXCEPTION 'AGENT_PEG_VIOLATION'; END IF;
 END IF;
 IF aiag_ton_time_v1(_q->'quotedAtMs')>=aiag_ton_time_v1(_q->'expiresAtMs') OR
  aiag_ton_time_v1(_fx->'observedAtMs')>aiag_ton_time_v1(_q->'quotedAtMs') OR
  aiag_ton_time_v1(_q->'expiresAtMs')>aiag_ton_time_v1(_fx->'expiresAtMs') THEN RAISE EXCEPTION 'TON_INVALID_TIME_ORDER'; END IF;
END $$;

-- 2. Allowlist seed: canonical USDT mainnet jetton (native rows were seeded in 0098).
INSERT INTO ton_asset_allowlist (network,asset_kind,master_address,asset_decimals) VALUES
 ('tvm:-1','jetton','0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',6)
ON CONFLICT (network, COALESCE(master_address,'')) DO NOTHING;

-- 3. Asset-aware source identity: the hashed asset text is the deterministic
--    alphabetical literal (the 0074 native convention) for both kinds, so the
--    worker computes identical ids from TS.
CREATE OR REPLACE FUNCTION aiag_ton_reconciliation_source_id_v1(
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
          WHEN _asset->>'kind'='native' AND _asset->'decimals'='9'::jsonb
            AND _asset->>'network' IN ('tvm:-3','tvm:-1')
            THEN '{"decimals":9,"kind":"native","network":"' || (_asset->>'network') || '"}'
          WHEN _asset->>'kind'='jetton'
            THEN '{"decimals":' || (_asset->>'decimals') || ',"kind":"jetton","masterAddress":"'
                 || lower(_asset->>'masterAddress') || '","network":"' || (_asset->>'network') || '"}'
          ELSE _asset::text
        END,
        'UTF8'
      ) || decode('00','hex') ||
      convert_to(_recipient,'UTF8')
    ),
    'hex'
  )
$$;

-- 4. Jetton source validation (0102 pattern: provider follows the network).
CREATE OR REPLACE FUNCTION aiag_ton_reconciliation_source_v1(
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
  _network TEXT;
  _asset JSONB;
BEGIN
  PERFORM aiag_ton_keys_v1(
    _source,
    ARRAY['sourceId','network','asset','invoiceRecipient','scanFloorTimeMs']
  );
  _network:=_source->>'network';
  IF _network='tvm:-1' AND _source->'asset'->>'kind'='native' THEN
    _asset:='{"decimals":9,"kind":"native","network":"tvm:-1"}'::jsonb;
  ELSIF _network='tvm:-3' AND _source->'asset'->>'kind'='native' THEN
    _asset:='{"decimals":9,"kind":"native","network":"tvm:-3"}'::jsonb;
  ELSIF _network IN ('tvm:-1','tvm:-3') AND _source->'asset'->>'kind'='jetton' THEN
    PERFORM aiag_ton_keys_v1(_source->'asset',ARRAY['network','kind','masterAddress','decimals']);
    PERFORM aiag_ton_text_v1(_source->'asset'->'masterAddress','\A(0|-1):[0-9a-fA-F]{64}\Z',67);
    IF aiag_ton_time_v1(_source->'asset'->'decimals')>18 THEN RAISE EXCEPTION 'TON_INVALID_SOURCE'; END IF;
    _asset:=jsonb_build_object(
      'decimals',(_source->'asset'->>'decimals')::smallint,
      'kind','jetton',
      'masterAddress',lower(_source->'asset'->>'masterAddress'),
      'network',_network
    );
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

-- 5. Jetton recipient binding: derivation pins master + owner. The merchant's
--    jetton wallet CONTRACT is chain data (credit-path evidence), deliberately
--    not part of the immutable binding.
CREATE OR REPLACE FUNCTION aiag_ton_reconciliation_binding_v1(
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
  PERFORM aiag_ton_text_v1(_binding->'recipientAccount','\A(0|-1):[0-9a-f]{64}\Z',67);
  PERFORM aiag_ton_text_v1(_binding->'derivation'->'ownerAddress','\A(0|-1):[0-9a-f]{64}\Z',67);
  IF _binding->'derivation'->'kind' IS DISTINCT FROM '"native"'::jsonb
     AND _binding->'derivation'->'kind' IS DISTINCT FROM '"jetton"'::jsonb THEN
    RAISE EXCEPTION 'TON_INVALID_BINDING';
  END IF;
  IF _binding->'derivation'->'kind'='"native"'::jsonb THEN
    PERFORM aiag_ton_keys_v1(_binding->'derivation',ARRAY['kind','ownerAddress']);
  ELSE
    PERFORM aiag_ton_keys_v1(_binding->'derivation',ARRAY['kind','masterAddress','ownerAddress']);
    PERFORM aiag_ton_text_v1(_binding->'derivation'->'masterAddress','\A(0|-1):[0-9a-f]{64}\Z',67);
    IF _binding->'derivation'->>'masterAddress' IS DISTINCT FROM lower(_source->'asset'->>'masterAddress') THEN
      RAISE EXCEPTION 'TON_INVALID_BINDING';
    END IF;
  END IF;
  IF _binding->>'recipientAccount' IS DISTINCT FROM _source->>'invoiceRecipient' OR
     _binding->'derivation'->>'ownerAddress' IS DISTINCT FROM _source->>'invoiceRecipient' THEN
    RAISE EXCEPTION 'TON_INVALID_BINDING';
  END IF;
END
$$;

-- 6. Asset-aware source listing: native groups as in 0102, jetton groups by
--    (network, master, decimals, recipient). _asset_kind: 'native' | 'jetton' | 'all'.
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
  IF _limit IS NULL OR _limit<1 OR _limit>16 OR _asset_kind NOT IN ('native','jetton','all') OR
     (_after_source_id IS NOT NULL AND _after_source_id !~ '\A[0-9a-f]{64}\Z') THEN
    RAISE EXCEPTION 'TON_INVALID_SOURCE_LIST';
  END IF;
  WITH grouped AS (
    SELECT network,('{"decimals":9,"kind":"native","network":"' || network || '"}')::jsonb AS asset,
           NULL::varchar AS master_address,9 AS asset_decimals,recipient,min(quoted_at) AS floor_time
      FROM ton_invoices
     WHERE network IN ('tvm:-3','tvm:-1') AND asset_kind='native'
       AND master_address IS NULL AND asset_decimals=9
     GROUP BY network,recipient
    UNION ALL
    SELECT network,jsonb_build_object('decimals',asset_decimals,'kind','jetton','masterAddress',lower(master_address),'network',network) AS asset,
           master_address,asset_decimals,recipient,min(quoted_at) AS floor_time
      FROM ton_invoices
     WHERE network IN ('tvm:-3','tvm:-1') AND asset_kind='jetton'
       AND master_address IS NOT NULL
     GROUP BY network,master_address,asset_decimals,recipient
  ), filtered AS (
    SELECT * FROM grouped
     WHERE _asset_kind='all' OR asset->>'kind'=_asset_kind
  ), sources AS (
    SELECT aiag_ton_reconciliation_source_id_v1(
             CASE network WHEN 'tvm:-1' THEN 'toncenter-v3-mainnet' ELSE 'toncenter-v3-testnet' END,
             asset,
             recipient
           ) AS source_id,
           network,
           asset,
           recipient,
           floor_time
      FROM filtered
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
        'asset',asset,
        'invoiceRecipient',recipient,
        'scanFloorTimeMs',floor(extract(epoch FROM floor_time)*1000)::bigint
      ) ORDER BY source_id
    ),
    '[]'::jsonb
  ) INTO _result FROM bounded;
  RETURN _result;
END
$$;

-- 7. Asset-aware invoice lookup: the invoice asset must equal the source asset.
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
     EXISTS(SELECT 1 FROM unnest(_references) r WHERE r !~ '\Aaiag-ton:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z') OR
     cardinality(_references)<>(SELECT count(DISTINCT r) FROM unnest(_references) r) THEN
    RAISE EXCEPTION 'TON_INVALID_REFERENCES';
  END IF;
  SELECT COALESCE(jsonb_agg(aiag_ton_invoice_json_v1(i) ORDER BY i.reference),'[]'::jsonb)
    INTO _result
    FROM ton_invoices i
   WHERE i.reference=ANY(_references)
     AND i.network=_source->>'network'
     AND i.asset_kind=_source->'asset'->>'kind'
     AND i.master_address IS NOT DISTINCT FROM lower(_source->'asset'->>'masterAddress')
     AND i.asset_decimals=(_source->'asset'->>'decimals')::smallint
     AND i.recipient=_source->>'invoiceRecipient';
  RETURN _result;
END
$$;

-- 8. Jetton observations: invoice/cursor/source agreement generalized from the
--    0103 native pinning to the invoice's own asset.
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
    IF _invoice.network NOT IN ('tvm:-3','tvm:-1') OR _invoice.network<>_cursor.network OR
       (_invoice.asset_kind='native' AND (_invoice.master_address IS NOT NULL OR _invoice.asset_decimals<>9)) OR
       (_invoice.asset_kind='jetton' AND (_invoice.master_address IS NULL OR _invoice.asset_decimals NOT BETWEEN 0 AND 18)) OR
       _invoice.asset_kind NOT IN ('native','jetton') OR
       (_invoice.asset_kind='jetton' AND _invoice.master_address IS DISTINCT FROM _cursor.recipient_binding->'derivation'->>'masterAddress') OR
       _invoice.recipient<>_cursor.recipient_binding->'derivation'->>'ownerAddress' OR
       _input->'snapshot'->>'reference' IS DISTINCT FROM _invoice.reference THEN
      RAISE EXCEPTION 'TON_OBSERVATION_INVOICE_MISMATCH';
    END IF;
    _asset:=CASE
      WHEN _invoice.asset_kind='native' THEN jsonb_build_object('decimals',9,'kind','native','network',_invoice.network)
      ELSE jsonb_build_object('decimals',_invoice.asset_decimals,'kind','jetton','masterAddress',_invoice.master_address,'network',_invoice.network)
    END;
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

REVOKE EXECUTE ON FUNCTION aiag_agent_ton_payload_v1(jsonb,uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  aiag_ton_reconciliation_source_id_v1(text,jsonb,text),
  aiag_ton_reconciliation_source_v1(jsonb,text),
  aiag_ton_reconciliation_binding_v1(jsonb,jsonb),
  aiag_list_ton_reconciliation_sources_v1(text,integer,text),
  aiag_find_ton_invoices_for_reconciliation_v1(jsonb,text[]),
  aiag_record_ton_chain_observation_v1(jsonb)
FROM PUBLIC;

COMMIT;
