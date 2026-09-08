-- TON testnet invoice core. No runtime verifier or payment route.
CREATE TABLE ton_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  purpose TEXT NOT NULL CHECK (purpose='gateway_topup'),
  idempotency_key VARCHAR(96) NOT NULL CHECK (idempotency_key ~ '\A[A-Za-z0-9_-]{1,96}\Z'),
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '\A[0-9a-f]{64}\Z'),
  request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  price_revision VARCHAR(96) NOT NULL CHECK (length(price_revision)>0),
  grant_microcredits BIGINT NOT NULL CHECK (grant_microcredits>0 AND grant_microcredits<=9007199254740991),
  source_price_unit TEXT NOT NULL CHECK (source_price_unit='gateway_microcredits'),
  source_price_atomic BIGINT NOT NULL CHECK (source_price_atomic=grant_microcredits),
  quote_id VARCHAR(96) NOT NULL CHECK (length(quote_id)>0),
  quote_snapshot JSONB NOT NULL CHECK (jsonb_typeof(quote_snapshot)='object'),
  network TEXT NOT NULL CHECK (network='tvm:-3'),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('native','jetton')),
  master_address VARCHAR(67),
  asset_decimals SMALLINT NOT NULL CHECK (asset_decimals BETWEEN 0 AND 18),
  amount_atomic BIGINT NOT NULL CHECK (amount_atomic>0),
  recipient VARCHAR(67) NOT NULL CHECK (recipient ~ '\A(0|-1):[0-9a-f]{64}\Z'),
  expected_sender VARCHAR(67) CHECK (expected_sender ~ '\A(0|-1):[0-9a-f]{64}\Z'),
  reference VARCHAR(64) NOT NULL UNIQUE DEFAULT ('aiag-ton:' || gen_random_uuid()::text) CHECK (reference ~ '\Aaiag-ton:[0-9a-f-]{36}\Z'),
  finality_policy_id VARCHAR(96) NOT NULL CHECK (length(finality_policy_id)>0),
  verifier_version VARCHAR(96) NOT NULL CHECK (length(verifier_version)>0),
  quoted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','observed','confirmed','settled','expired','review_required')),
  review_reason VARCHAR(64),
  settled_event_id UUID UNIQUE,
  receipt_id UUID UNIQUE REFERENCES gateway_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  UNIQUE(owner_user_id,org_id,idempotency_key),
  UNIQUE(id,org_id),
  CHECK (expires_at>quoted_at AND quoted_at<=created_at),
  CHECK ((asset_kind='native' AND master_address IS NULL AND asset_decimals=9)
    OR (asset_kind='jetton' AND master_address IS NOT NULL AND master_address ~ '\A(0|-1):[0-9a-f]{64}\Z')),
  CHECK ((status='settled') = (settled_event_id IS NOT NULL AND receipt_id IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (status='settled' OR (settled_event_id IS NULL AND receipt_id IS NULL AND settled_at IS NULL)),
  CHECK ((status='review_required') = (review_reason IS NOT NULL)),
  CHECK (octet_length(request_payload::text)<=16384 AND octet_length(quote_snapshot::text)<=8192)
);

CREATE TABLE ton_chain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network TEXT NOT NULL CHECK (network='tvm:-3'),
  recipient_account VARCHAR(67) NOT NULL CHECK (recipient_account ~ '\A(0|-1):[0-9a-f]{64}\Z'),
  tx_hash CHAR(64) NOT NULL CHECK (tx_hash ~ '\A[0-9a-f]{64}\Z'),
  message_hash CHAR(64) NOT NULL CHECK (message_hash ~ '\A[0-9a-f]{64}\Z'),
  tx_lt VARCHAR(78) NOT NULL CHECK (tx_lt ~ '\A(0|[1-9][0-9]{0,77})\Z'),
  message_index INTEGER NOT NULL CHECK (message_index>=0),
  fact_snapshot JSONB NOT NULL CHECK (jsonb_typeof(fact_snapshot)='object'),
  evidence_snapshot JSONB NOT NULL CHECK (jsonb_typeof(evidence_snapshot)='object'),
  observed_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(network,recipient_account,tx_hash,message_hash),
  CHECK (observed_at<=verified_at AND verified_at<=created_at),
  CHECK (octet_length(fact_snapshot::text)<=8192 AND octet_length(evidence_snapshot::text)<=32768)
);
ALTER TABLE ton_invoices ADD CONSTRAINT ton_invoice_settled_event_fk
  FOREIGN KEY(settled_event_id) REFERENCES ton_chain_events(id) ON DELETE RESTRICT;

-- Append-only durable decisions, including second transfers after an invoice settled.
CREATE TABLE ton_invoice_event_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES ton_invoices(id) ON DELETE RESTRICT,
  event_id UUID NOT NULL REFERENCES ton_chain_events(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('settled','review_required')),
  reason VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(invoice_id,event_id),
  CHECK ((decision='review_required') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX ton_event_one_settlement ON ton_invoice_event_decisions(event_id)
  WHERE decision='settled';
CREATE UNIQUE INDEX ton_invoice_one_settlement ON ton_invoice_event_decisions(invoice_id)
  WHERE decision='settled';
CREATE UNIQUE INDEX gateway_transactions_ton_invoice_uniq ON gateway_transactions(request_id)
  WHERE type='topup' AND source='ton';
CREATE INDEX ton_invoices_pending_expiry ON ton_invoices(expires_at,id)
  WHERE status IN ('pending','observed');
CREATE INDEX ton_invoices_owner_read ON ton_invoices(owner_user_id,org_id,created_at,id);
CREATE INDEX ton_invoice_reviews ON ton_invoice_event_decisions(created_at,id)
  WHERE decision='review_required';

-- Mirror of migration 0072 functions and triggers; SECURITY INVOKER throughout.
CREATE FUNCTION aiag_ton_invoice_json_v1(_i ton_invoices) RETURNS JSONB LANGUAGE SQL STABLE SET search_path = pg_catalog, public, pg_temp AS $$
SELECT jsonb_build_object('schemaVersion',1,'product','aggregator','purpose',_i.purpose,
 'invoiceId',_i.id::text,'ownerId',_i.owner_user_id::text,'orgId',_i.org_id::text,'orderId',_i.order_id::text,
 'idempotencyKey',_i.idempotency_key,'quoteId',_i.quote_id,'quote',_i.quote_snapshot,'grantMicrocredits',_i.grant_microcredits::text,
 'priceRevision',_i.price_revision,'network',_i.network,'asset',_i.quote_snapshot->'asset','amountAtomic',_i.amount_atomic::text,
 'recipient',_i.recipient,'reference',_i.reference,'expectedSender',_i.expected_sender,'finalityPolicyId',_i.finality_policy_id,
 'verifierVersion',_i.verifier_version,'expiresAt',_i.expires_at,'createdAt',_i.created_at,'status',_i.status,'reviewReason',_i.review_reason)
$$;
CREATE FUNCTION aiag_ton_invoice_guard_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'TON_INVALID_TRANSITION'; END IF;
  PERFORM aiag_ton_payload_v1(NEW.request_payload,NEW.owner_user_id,NEW.org_id);
  IF NEW.quote_snapshot IS DISTINCT FROM NEW.request_payload->'quote' OR
   NEW.idempotency_key IS DISTINCT FROM NEW.request_payload->>'idempotencyKey' OR
   NEW.grant_microcredits::text IS DISTINCT FROM NEW.request_payload->>'grantMicrocredits' OR
   NEW.price_revision IS DISTINCT FROM NEW.request_payload->>'priceRevision' OR
   NEW.recipient IS DISTINCT FROM NEW.request_payload->>'recipient' OR
   NEW.expected_sender IS DISTINCT FROM NEW.request_payload->>'expectedSender' OR
   NEW.finality_policy_id IS DISTINCT FROM NEW.request_payload->>'finalityPolicyId' OR
   NEW.verifier_version IS DISTINCT FROM NEW.request_payload->>'verifierVersion' OR
   NEW.quote_id IS DISTINCT FROM NEW.quote_snapshot->>'quoteId' OR
   NEW.network IS DISTINCT FROM NEW.quote_snapshot->'asset'->>'network' OR
   NEW.asset_kind IS DISTINCT FROM NEW.quote_snapshot->'asset'->>'kind' OR
   NEW.master_address IS DISTINCT FROM NEW.quote_snapshot->'asset'->>'masterAddress' OR
   NEW.asset_decimals IS DISTINCT FROM (NEW.quote_snapshot->'asset'->>'decimals')::smallint OR
   NEW.amount_atomic::text IS DISTINCT FROM NEW.quote_snapshot->>'amountAtomic' OR
   NEW.quoted_at IS DISTINCT FROM to_timestamp((NEW.quote_snapshot->>'quotedAtMs')::numeric/1000) OR
   NEW.expires_at IS DISTINCT FROM to_timestamp((NEW.quote_snapshot->>'expiresAtMs')::numeric/1000) THEN
   RAISE EXCEPTION 'TON_SNAPSHOT_MISMATCH';
  END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','review_reason','settled_event_id','receipt_id','updated_at','settled_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','review_reason','settled_event_id','receipt_id','updated_at','settled_at']) THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 IF NEW.status=OLD.status THEN
  IF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 ELSIF NOT ((OLD.status='pending' AND NEW.status IN ('observed','expired','review_required')) OR
   (OLD.status='observed' AND NEW.status IN ('confirmed','review_required')) OR
   (OLD.status='confirmed' AND NEW.status='settled') OR (OLD.status='expired' AND NEW.status='review_required')) THEN
  RAISE EXCEPTION 'TON_INVALID_TRANSITION';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION aiag_ton_event_immutable_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION 'TON_IMMUTABLE'; END $$;
CREATE FUNCTION aiag_ton_decision_immutable_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION 'TON_IMMUTABLE'; END $$;
CREATE FUNCTION aiag_ton_receipt_immutable_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF (OLD.type='topup' AND OLD.source='ton') OR (TG_OP='UPDATE' AND NEW.type='topup' AND NEW.source='ton') THEN RAISE EXCEPTION 'TON_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION aiag_ton_settlement_consistent_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _id UUID; _i ton_invoices; _r gateway_transactions; _d ton_invoice_event_decisions;
BEGIN
 IF TG_TABLE_NAME='ton_invoices' THEN _id:=NEW.id;
 ELSIF TG_TABLE_NAME='ton_invoice_event_decisions' THEN
  _id:=NEW.invoice_id;
 ELSE
  IF NEW.type<>'topup' OR NEW.source<>'ton' THEN RETURN NULL; END IF;
  SELECT id INTO _id FROM ton_invoices WHERE receipt_id=NEW.id;
  IF _id IS NULL THEN RAISE EXCEPTION 'TON_RECEIPT_ORPHAN'; END IF;
 END IF;
 SELECT * INTO _i FROM ton_invoices WHERE id=_id;
 IF NOT FOUND OR _i.status='confirmed' THEN RAISE EXCEPTION 'TON_SETTLEMENT_INCONSISTENT'; END IF;
 SELECT * INTO _d FROM ton_invoice_event_decisions WHERE invoice_id=_id AND decision='settled';
 IF _i.status<>'settled' THEN
  IF FOUND THEN RAISE EXCEPTION 'TON_SETTLEMENT_INCONSISTENT'; END IF;
  RETURN NULL;
 END IF;
 IF _d.id IS NULL OR _d.event_id IS DISTINCT FROM _i.settled_event_id THEN RAISE EXCEPTION 'TON_SETTLEMENT_INCONSISTENT'; END IF;
 SELECT * INTO _r FROM gateway_transactions WHERE id=_i.receipt_id;
 IF NOT FOUND OR _r.org_id IS DISTINCT FROM _i.org_id OR _r.request_id IS DISTINCT FROM ('ton:invoice:'||_i.id::text) OR
    _r.type<>'topup' OR _r.source<>'ton' OR _r.delta IS DISTINCT FROM _i.grant_microcredits OR
    _r.metadata->>'invoice_id' IS DISTINCT FROM _i.id::text OR _r.metadata->>'order_id' IS DISTINCT FROM _i.order_id::text OR
    _r.metadata->>'event_id' IS DISTINCT FROM _i.settled_event_id::text OR
    _r.metadata->'schema_version' IS DISTINCT FROM '1'::jsonb OR
    _r.metadata->'grant_microcredits' IS DISTINCT FROM to_jsonb(_i.grant_microcredits::text) OR
    _r.metadata->'amount_atomic' IS DISTINCT FROM to_jsonb(_i.amount_atomic::text) OR
    _r.metadata->'owner_user_id' IS DISTINCT FROM to_jsonb(_i.owner_user_id::text) OR
    _r.metadata->'network' IS DISTINCT FROM to_jsonb(_i.network) OR
    _r.metadata->'asset' IS DISTINCT FROM _i.quote_snapshot->'asset' OR
    _r.metadata->'price_revision' IS DISTINCT FROM to_jsonb(_i.price_revision::text) OR
    _r.metadata->'quote_id' IS DISTINCT FROM to_jsonb(_i.quote_id::text) OR
    _r.metadata->'refund_debt_after_microcredits' IS DISTINCT FROM '"0"'::jsonb OR
    _r.metadata->'settled_at' IS DISTINCT FROM to_jsonb(_i.settled_at) THEN RAISE EXCEPTION 'TON_SETTLEMENT_INCONSISTENT'; END IF;
 IF aiag_ton_atomic_v1(_r.metadata->'payg_after_microcredits',TRUE)>9007199254740991 THEN RAISE EXCEPTION 'TON_SETTLEMENT_INCONSISTENT'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER ton_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON ton_invoices FOR EACH ROW EXECUTE FUNCTION aiag_ton_invoice_guard_v1();
CREATE TRIGGER ton_event_immutable BEFORE UPDATE OR DELETE ON ton_chain_events FOR EACH ROW EXECUTE FUNCTION aiag_ton_event_immutable_v1();
CREATE TRIGGER ton_decision_immutable BEFORE UPDATE OR DELETE ON ton_invoice_event_decisions FOR EACH ROW EXECUTE FUNCTION aiag_ton_decision_immutable_v1();
CREATE TRIGGER ton_receipt_immutable BEFORE UPDATE OR DELETE ON gateway_transactions FOR EACH ROW EXECUTE FUNCTION aiag_ton_receipt_immutable_v1();
CREATE CONSTRAINT TRIGGER ton_invoice_consistent AFTER INSERT OR UPDATE ON ton_invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiag_ton_settlement_consistent_v1();
CREATE CONSTRAINT TRIGGER ton_decision_consistent AFTER INSERT ON ton_invoice_event_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiag_ton_settlement_consistent_v1();
CREATE CONSTRAINT TRIGGER ton_receipt_consistent AFTER INSERT ON gateway_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiag_ton_settlement_consistent_v1();

-- Validate JSON types and byte bounds before casts. Strict key sets prevent hidden IDs.
CREATE FUNCTION aiag_ton_keys_v1(_j JSONB,_keys TEXT[]) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF jsonb_typeof(_j) IS DISTINCT FROM 'object' OR octet_length(_j::text)>32768 THEN RAISE EXCEPTION 'TON_INVALID_OBJECT'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(_j) k WHERE NOT k=ANY(_keys)) OR NOT _j ?& _keys THEN RAISE EXCEPTION 'TON_INVALID_FIELDS'; END IF;
END $$;
CREATE FUNCTION aiag_ton_text_v1(_j JSONB,_pattern TEXT,_max INTEGER) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _t TEXT;
BEGIN
 IF jsonb_typeof(_j) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'TON_INVALID_STRING'; END IF;
 _t:=_j#>>'{}';
 IF length(_t)>_max OR _t !~ _pattern THEN RAISE EXCEPTION 'TON_INVALID_STRING'; END IF;
 RETURN _t;
END $$;
CREATE FUNCTION aiag_ton_time_v1(_j JSONB) RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _t TEXT; _n NUMERIC;
BEGIN
 IF jsonb_typeof(_j) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'TON_INVALID_TIME'; END IF;
 _t:=_j#>>'{}'; IF length(_t)>16 OR _t !~ '\A(0|[1-9][0-9]*)\Z' THEN RAISE EXCEPTION 'TON_INVALID_TIME'; END IF;
 _n:=_t::numeric; IF _n>8640000000000000 THEN RAISE EXCEPTION 'TON_INVALID_TIME'; END IF; RETURN _n;
END $$;
CREATE FUNCTION aiag_ton_atomic_v1(_j JSONB,_zero BOOLEAN DEFAULT FALSE,_evidence BOOLEAN DEFAULT FALSE) RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _n NUMERIC;
BEGIN
 _n:=aiag_ton_text_v1(_j,'\A(0|[1-9][0-9]*)\Z',78)::numeric;
 IF (NOT _zero AND _n=0) OR (NOT _evidence AND _n>9223372036854775807) THEN RAISE EXCEPTION 'TON_INVALID_AMOUNT'; END IF; RETURN _n;
END $$;
CREATE FUNCTION aiag_ton_asset_v1(_j JSONB) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF _j->>'kind'='native' THEN
  PERFORM aiag_ton_keys_v1(_j,ARRAY['network','kind','decimals']);
  IF _j->'decimals' IS DISTINCT FROM '9'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_ASSET'; END IF;
 ELSIF _j->>'kind'='jetton' THEN
  PERFORM aiag_ton_keys_v1(_j,ARRAY['network','kind','decimals','masterAddress']);
  PERFORM aiag_ton_text_v1(_j->'masterAddress','\A(0|-1):[0-9a-f]{64}\Z',67);
  IF aiag_ton_time_v1(_j->'decimals')>18 THEN RAISE EXCEPTION 'TON_INVALID_ASSET'; END IF;
 ELSE RAISE EXCEPTION 'TON_INVALID_ASSET'; END IF;
 IF _j->'network' IS DISTINCT FROM '"tvm:-3"'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_NETWORK'; END IF;
END $$;
CREATE FUNCTION aiag_ton_payload_v1(_p JSONB,_actor UUID,_org UUID) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _q JSONB; _fx JSONB; _grant NUMERIC; _num NUMERIC; _den NUMERIC; _prod NUMERIC; _converted NUMERIC; _rem NUMERIC; _fee NUMERIC; _key TEXT;
BEGIN
 PERFORM aiag_ton_keys_v1(_p,ARRAY['schemaVersion','purpose','ownerId','orgId','idempotencyKey','grantMicrocredits','priceRevision','quote','recipient','expectedSender','finalityPolicyId','verifierVersion']);
 IF octet_length(_p::text)>16384 OR _p->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR _p->'purpose' IS DISTINCT FROM '"gateway_topup"'::jsonb OR
    _p->>'ownerId' IS DISTINCT FROM _actor::text OR _p->>'orgId' IS DISTINCT FROM _org::text THEN RAISE EXCEPTION 'TON_INVALID_PAYLOAD'; END IF;
 PERFORM aiag_ton_text_v1(_p->'idempotencyKey','\A[A-Za-z0-9_-]{1,96}\Z',96);
 FOREACH _key IN ARRAY ARRAY['priceRevision','finalityPolicyId','verifierVersion'] LOOP
  PERFORM aiag_ton_text_v1(_p->_key,'\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 END LOOP;
 PERFORM aiag_ton_text_v1(_p->'recipient','\A(0|-1):[0-9a-f]{64}\Z',67);
 IF _p->'expectedSender'<>'null'::jsonb THEN PERFORM aiag_ton_text_v1(_p->'expectedSender','\A(0|-1):[0-9a-f]{64}\Z',67); END IF;
 _grant:=aiag_ton_atomic_v1(_p->'grantMicrocredits'); _q:=_p->'quote';
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
 IF aiag_ton_time_v1(_q->'quotedAtMs')>=aiag_ton_time_v1(_q->'expiresAtMs') OR
  aiag_ton_time_v1(_fx->'observedAtMs')>aiag_ton_time_v1(_q->'quotedAtMs') OR
  aiag_ton_time_v1(_q->'expiresAtMs')>aiag_ton_time_v1(_fx->'expiresAtMs') THEN RAISE EXCEPTION 'TON_INVALID_TIME_ORDER'; END IF;
END $$;

CREATE FUNCTION aiag_create_ton_invoice_v1(_actor UUID,_org UUID,_payload JSONB,_fingerprint TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _o organizations; _i ton_invoices; _q JSONB; _grant BIGINT; _now TIMESTAMPTZ;
BEGIN
 PERFORM aiag_ton_payload_v1(_payload,_actor,_org);
 IF _fingerprint IS NULL OR _fingerprint !~ '\A[0-9a-f]{64}\Z' THEN RAISE EXCEPTION 'TON_INVALID_FINGERPRINT'; END IF;
 SELECT * INTO _o FROM organizations WHERE id=_org AND owner_id=_actor FOR UPDATE;
 IF NOT FOUND OR NOT _o.is_active OR NOT EXISTS(SELECT 1 FROM users WHERE id=_actor AND is_active AND NOT is_banned) THEN RAISE EXCEPTION 'TON_NOT_AUTHORIZED'; END IF;
 SELECT * INTO _i FROM ton_invoices WHERE owner_user_id=_actor AND org_id=_org AND idempotency_key=_payload->>'idempotencyKey';
 IF FOUND THEN
  IF _i.request_fingerprint<>_fingerprint OR _i.request_payload<>_payload THEN RAISE EXCEPTION 'TON_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN aiag_ton_invoice_json_v1(_i);
 END IF;
 _grant:=(_payload->>'grantMicrocredits')::bigint; _q:=_payload->'quote'; _now:=clock_timestamp();
 IF _o.refund_debt_credits>0 OR EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL) THEN RAISE EXCEPTION 'TON_REFUND_BLOCKED'; END IF;
 IF _grant>9007199254740991 OR _o.payg_credits<0 OR _o.payg_credits>9007199254740991-_grant THEN RAISE EXCEPTION 'TON_BALANCE_COMPATIBILITY_LIMIT'; END IF;
 IF (_q->>'quotedAtMs')::numeric>extract(epoch FROM _now)*1000 OR (_q->>'expiresAtMs')::numeric<=extract(epoch FROM _now)*1000 THEN RAISE EXCEPTION 'TON_QUOTE_EXPIRED'; END IF;
 INSERT INTO ton_invoices(owner_user_id,org_id,purpose,idempotency_key,request_fingerprint,request_payload,price_revision,grant_microcredits,source_price_unit,source_price_atomic,
 quote_id,quote_snapshot,network,asset_kind,master_address,asset_decimals,amount_atomic,recipient,expected_sender,finality_policy_id,verifier_version,quoted_at,expires_at)
 VALUES(_actor,_org,'gateway_topup',_payload->>'idempotencyKey',_fingerprint,_payload,_payload->>'priceRevision',_grant,'gateway_microcredits',_grant,
 _q->>'quoteId',_q,'tvm:-3',_q->'asset'->>'kind',_q->'asset'->>'masterAddress',(_q->'asset'->>'decimals')::smallint,(_q->>'amountAtomic')::bigint,
 _payload->>'recipient',_payload->>'expectedSender',_payload->>'finalityPolicyId',_payload->>'verifierVersion',
 to_timestamp((_q->>'quotedAtMs')::numeric/1000),to_timestamp((_q->>'expiresAtMs')::numeric/1000)) RETURNING * INTO _i;
 RETURN aiag_ton_invoice_json_v1(_i);
END $$;
CREATE FUNCTION aiag_read_ton_invoice_v1(_actor UUID,_org UUID,_invoice UUID) RETURNS JSONB LANGUAGE SQL STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT aiag_ton_invoice_json_v1(i) FROM ton_invoices i JOIN organizations o ON o.id=i.org_id
 WHERE i.id=_invoice AND i.org_id=_org AND i.owner_user_id=_actor AND o.owner_id=_actor
$$;
CREATE FUNCTION aiag_expire_ton_invoice_v1(_invoice UUID) RETURNS TEXT LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _org UUID; _i ton_invoices; _updated UUID;
BEGIN
 SELECT org_id INTO _org FROM ton_invoices WHERE id=_invoice; IF NOT FOUND THEN RETURN 'not_found'; END IF;
 PERFORM id FROM organizations WHERE id=_org FOR UPDATE;
 SELECT * INTO _i FROM ton_invoices WHERE id=_invoice AND org_id=_org FOR UPDATE; IF NOT FOUND THEN RETURN 'not_found'; END IF;
 UPDATE ton_invoices SET status='expired',updated_at=clock_timestamp() WHERE id=_invoice AND org_id=_org AND status='pending' AND expires_at<=clock_timestamp() RETURNING id INTO _updated;
 IF _updated IS NULL THEN RETURN 'unchanged'; END IF; RETURN 'expired';
END $$;
CREATE FUNCTION aiag_ton_credit_v1(_c JSONB) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _key TEXT;
BEGIN
 PERFORM aiag_ton_keys_v1(_c,ARRAY['network','asset','recipient','recipientAccount','sender','amountAtomic','reference','txHash','txLt','messageHash','messageIndex','chainTimeMs','observedAtMs','verifiedAtMs','blockAnchor','masterchainAnchor','executionPathDigest','verifierVersion','finalityPolicyId','jettonCredit']);
 IF _c->'network' IS DISTINCT FROM '"tvm:-3"'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_NETWORK'; END IF;
 PERFORM aiag_ton_asset_v1(_c->'asset');
 FOREACH _key IN ARRAY ARRAY['recipient','recipientAccount','sender'] LOOP
  PERFORM aiag_ton_text_v1(_c->_key,'\A(0|-1):[0-9a-f]{64}\Z',67);
 END LOOP;
 FOREACH _key IN ARRAY ARRAY['txHash','messageHash','executionPathDigest'] LOOP
  PERFORM aiag_ton_text_v1(_c->_key,'\A[0-9a-f]{64}\Z',64);
 END LOOP;
 FOREACH _key IN ARRAY ARRAY['reference','blockAnchor','masterchainAnchor','verifierVersion','finalityPolicyId'] LOOP
  PERFORM aiag_ton_text_v1(_c->_key,'\A[^[:cntrl:][:space:]]([^[:cntrl:]]*[^[:cntrl:][:space:]])?\Z',96);
 END LOOP;
 PERFORM aiag_ton_atomic_v1(_c->'amountAtomic',FALSE,TRUE); PERFORM aiag_ton_atomic_v1(_c->'txLt',TRUE,TRUE);
 IF aiag_ton_time_v1(_c->'messageIndex')>2147483647 THEN RAISE EXCEPTION 'TON_INVALID_INDEX'; END IF;
 IF aiag_ton_time_v1(_c->'chainTimeMs')>aiag_ton_time_v1(_c->'observedAtMs') OR
    aiag_ton_time_v1(_c->'observedAtMs')>aiag_ton_time_v1(_c->'verifiedAtMs') THEN RAISE EXCEPTION 'TON_INVALID_TIME_ORDER'; END IF;
 IF _c->'asset'->>'kind'='native' THEN
  IF _c->'jettonCredit'<>'null'::jsonb THEN RAISE EXCEPTION 'TON_INVALID_JETTON'; END IF;
 ELSE
  PERFORM aiag_ton_keys_v1(_c->'jettonCredit',ARRAY['masterAddress','merchantJettonWallet']);
  PERFORM aiag_ton_text_v1(_c->'jettonCredit'->'masterAddress','\A(0|-1):[0-9a-f]{64}\Z',67);
  PERFORM aiag_ton_text_v1(_c->'jettonCredit'->'merchantJettonWallet','\A(0|-1):[0-9a-f]{64}\Z',67);
 END IF;
END $$;
CREATE FUNCTION aiag_ton_receipt_json_v1(_invoice UUID) RETURNS JSONB LANGUAGE SQL STABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object('receiptId',r.id::text,'invoiceId',r.metadata->>'invoice_id','ownerId',r.metadata->>'owner_user_id',
 'orgId',r.org_id::text,'orderId',r.metadata->>'order_id','eventId',r.metadata->>'event_id','grantMicrocredits',r.metadata->>'grant_microcredits',
 'amountAtomic',r.metadata->>'amount_atomic','network',r.metadata->>'network','asset',r.metadata->'asset','settledAt',r.metadata->>'settled_at',
 'paygAfterMicrocredits',r.metadata->>'payg_after_microcredits','refundDebtAfterMicrocredits',r.metadata->>'refund_debt_after_microcredits')
 FROM ton_invoices i JOIN gateway_transactions r ON r.id=i.receipt_id WHERE i.id=_invoice AND i.status='settled'
$$;
CREATE FUNCTION aiag_settle_ton_invoice_v1(_invoice UUID,_credit JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _org UUID; _o organizations; _i ton_invoices; _event ton_chain_events; _d ton_invoice_event_decisions;
 _facts JSONB; _evidence JSONB; _reason TEXT; _now TIMESTAMPTZ; _grant BIGINT; _receipt UUID; _changed UUID; _payg TEXT; _debt TEXT; _amount NUMERIC;
BEGIN
 PERFORM aiag_ton_credit_v1(_credit);
 IF (_credit->>'verifiedAtMs')::numeric>extract(epoch FROM clock_timestamp())*1000 THEN RAISE EXCEPTION 'TON_INVALID_TIME_ORDER'; END IF;
 SELECT org_id INTO _org FROM ton_invoices WHERE id=_invoice;
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','not_found'); END IF;
 SELECT * INTO _o FROM organizations WHERE id=_org FOR UPDATE;
 SELECT * INTO _i FROM ton_invoices WHERE id=_invoice AND org_id=_org FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','not_found'); END IF;
 _now:=clock_timestamp();
 _facts:=_credit-ARRAY['observedAtMs','verifiedAtMs','blockAnchor','masterchainAnchor','executionPathDigest','verifierVersion','finalityPolicyId'];
 _evidence:=_credit-ARRAY['amountAtomic','reference','sender','txHash','txLt','messageHash','messageIndex','chainTimeMs','observedAtMs','verifiedAtMs'];
 INSERT INTO ton_chain_events(network,recipient_account,tx_hash,message_hash,tx_lt,message_index,fact_snapshot,evidence_snapshot,observed_at,verified_at)
 VALUES('tvm:-3',_credit->>'recipientAccount',_credit->>'txHash',_credit->>'messageHash',_credit->>'txLt',(_credit->>'messageIndex')::integer,
 _facts,_evidence,to_timestamp((_credit->>'observedAtMs')::numeric/1000),to_timestamp((_credit->>'verifiedAtMs')::numeric/1000))
 ON CONFLICT(network,recipient_account,tx_hash,message_hash) DO NOTHING;
 SELECT * INTO _event FROM ton_chain_events WHERE network='tvm:-3' AND recipient_account=_credit->>'recipientAccount' AND tx_hash=_credit->>'txHash' AND message_hash=_credit->>'messageHash' FOR UPDATE;
 IF _event.id IS NULL THEN RAISE EXCEPTION 'TON_EVENT_CAS'; END IF;
 IF _event.fact_snapshot<>_facts THEN RETURN jsonb_build_object('kind','evidence_conflict','eventId',_event.id::text); END IF;
 SELECT * INTO _d FROM ton_invoice_event_decisions WHERE invoice_id=_invoice AND event_id=_event.id;
 IF FOUND THEN
  IF _d.decision='settled' THEN RETURN jsonb_build_object('kind','already_settled','receipt',aiag_ton_receipt_json_v1(_invoice)); END IF;
  RETURN jsonb_build_object('kind','review_required','invoiceId',_invoice::text,'eventId',_event.id::text,'reason',_d.reason);
 END IF;
 _grant:=_i.grant_microcredits; _amount:=(_credit->>'amountAtomic')::numeric;
 IF _i.status='settled' THEN _reason:='additional_transfer';
 ELSIF EXISTS(SELECT 1 FROM ton_invoice_event_decisions WHERE event_id=_event.id AND decision='settled' AND invoice_id<>_invoice) THEN _reason:='event_already_consumed';
 ELSIF _i.status='review_required' THEN _reason:='invoice_in_review';
 ELSIF _i.status='expired' OR _now>=_i.expires_at OR (_credit->>'chainTimeMs')::numeric>=extract(epoch FROM _i.expires_at)*1000 THEN _reason:='late_payment';
 ELSIF _o.owner_id<>_i.owner_user_id THEN _reason:='owner_changed';
 ELSIF _credit->>'recipient'<>_i.recipient OR _credit->'asset'<>_i.quote_snapshot->'asset' OR _credit->>'reference'<>_i.reference OR
  (_i.expected_sender IS NOT NULL AND _credit->>'sender'<>_i.expected_sender) OR
  (_i.asset_kind='native' AND _credit->>'recipientAccount'<>_i.recipient) OR
  (_i.asset_kind='jetton' AND (_credit->'jettonCredit'->>'masterAddress' IS DISTINCT FROM _i.master_address OR
   _credit->'jettonCredit'->>'merchantJettonWallet' IS DISTINCT FROM _credit->>'recipientAccount')) THEN _reason:='payment_mismatch';
 ELSIF _credit->>'verifierVersion'<>_i.verifier_version OR _credit->>'finalityPolicyId'<>_i.finality_policy_id THEN _reason:='verification_policy_mismatch';
 ELSIF EXISTS(SELECT 1 FROM ton_invoice_event_decisions WHERE invoice_id=_invoice AND event_id<>_event.id) THEN _reason:='multiple_transfers';
 ELSIF _amount<_i.amount_atomic THEN _reason:='underpayment';
 ELSIF _amount>_i.amount_atomic THEN _reason:='overpayment';
 ELSIF _o.refund_debt_credits>0 OR EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL) THEN _reason:='refund_blocked';
 ELSIF _o.payg_credits<0 THEN _reason:='balance_invariant';
 ELSIF _grant>9007199254740991 OR _o.payg_credits>9007199254740991-_grant THEN _reason:='balance_compatibility_limit';
 END IF;
 IF _reason IS NOT NULL THEN
  INSERT INTO ton_invoice_event_decisions(invoice_id,event_id,decision,reason) VALUES(_invoice,_event.id,'review_required',_reason);
  IF _i.status NOT IN ('settled','review_required') THEN
   UPDATE ton_invoices SET status='review_required',review_reason=_reason,updated_at=_now WHERE id=_invoice AND org_id=_org AND status IN ('pending','observed','expired') RETURNING id INTO _changed;
   IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
  END IF;
  RETURN jsonb_build_object('kind','review_required','invoiceId',_invoice::text,'eventId',_event.id::text,'reason',_reason);
 END IF;
 IF _i.status='pending' THEN
  UPDATE ton_invoices SET status='observed',updated_at=_now WHERE id=_invoice AND org_id=_org AND status='pending' RETURNING id INTO _changed;
  IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
 END IF;
 UPDATE ton_invoices SET status='confirmed',updated_at=_now WHERE id=_invoice AND org_id=_org AND status='observed' RETURNING id INTO _changed;
 IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
 UPDATE organizations SET payg_credits=payg_credits+_grant,updated_at=_now
 WHERE id=_org AND owner_id=_i.owner_user_id AND payg_credits>=0 AND refund_debt_credits=0
  AND _grant BETWEEN 1 AND 9007199254740991::bigint AND payg_credits<=9007199254740991::bigint-_grant
  AND NOT EXISTS(SELECT 1 FROM payments WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL)
 RETURNING payg_credits::text,refund_debt_credits::text INTO _payg,_debt;
 IF NOT FOUND THEN RAISE EXCEPTION 'TON_BALANCE_CAS'; END IF;
 INSERT INTO gateway_transactions(org_id,request_id,type,source,delta,metadata)
 VALUES(_org,'ton:invoice:'||_invoice::text,'topup','ton',_grant,jsonb_build_object('schema_version',1,'invoice_id',_invoice::text,
 'order_id',_i.order_id::text,'event_id',_event.id::text,'owner_user_id',_i.owner_user_id::text,'grant_microcredits',_grant::text,
 'amount_atomic',_i.amount_atomic::text,'asset',_i.quote_snapshot->'asset','network','tvm:-3','price_revision',_i.price_revision,
 'quote_id',_i.quote_id,'payg_after_microcredits',_payg,'refund_debt_after_microcredits',_debt,'settled_at',_now)) RETURNING id INTO _receipt;
 IF _receipt IS NULL THEN RAISE EXCEPTION 'TON_RECEIPT_CAS'; END IF;
 INSERT INTO ton_invoice_event_decisions(invoice_id,event_id,decision) VALUES(_invoice,_event.id,'settled');
 UPDATE ton_invoices SET status='settled',settled_event_id=_event.id,receipt_id=_receipt,settled_at=_now,updated_at=_now
 WHERE id=_invoice AND org_id=_org AND owner_user_id=_i.owner_user_id AND status='confirmed' AND settled_event_id IS NULL AND receipt_id IS NULL RETURNING id INTO _changed;
 IF _changed IS NULL THEN RAISE EXCEPTION 'TON_INVOICE_CAS'; END IF;
 RETURN jsonb_build_object('kind','settled','receipt',aiag_ton_receipt_json_v1(_invoice));
END $$;
REVOKE EXECUTE ON FUNCTION aiag_ton_invoice_json_v1(ton_invoices),aiag_ton_invoice_guard_v1(),aiag_ton_event_immutable_v1(),aiag_ton_decision_immutable_v1(),aiag_ton_receipt_immutable_v1(),aiag_ton_settlement_consistent_v1(),aiag_ton_keys_v1(jsonb,text[]),aiag_ton_text_v1(jsonb,text,integer),aiag_ton_time_v1(jsonb),aiag_ton_atomic_v1(jsonb,boolean,boolean),aiag_ton_asset_v1(jsonb),aiag_ton_payload_v1(jsonb,uuid,uuid),aiag_create_ton_invoice_v1(uuid,uuid,jsonb,text),aiag_read_ton_invoice_v1(uuid,uuid,uuid),aiag_expire_ton_invoice_v1(uuid),aiag_ton_credit_v1(jsonb),aiag_ton_receipt_json_v1(uuid),aiag_settle_ton_invoice_v1(uuid,jsonb) FROM PUBLIC;
