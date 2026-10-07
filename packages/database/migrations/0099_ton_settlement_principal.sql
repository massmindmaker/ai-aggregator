-- 0099: worker-only settlement principal (plan AG-TON-L task 3.1).
-- Mirrors the local rehearsal installer (scripts/ton-worker-boundary.ts) with
-- fixed production names: aiag_ton_worker_owner (NOLOGIN authority, owns the
-- definer surface) and aiag_ton_worker (LOGIN, the only session the wrapper
-- accepts; its password is issued at deploy time, never in a migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='aiag_ton_worker') THEN
    CREATE ROLE aiag_ton_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='aiag_ton_worker_owner') THEN
    CREATE ROLE aiag_ton_worker_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA aiag_ton_worker;
REVOKE ALL ON SCHEMA aiag_ton_worker FROM PUBLIC;
GRANT USAGE ON SCHEMA public, aiag_ton_worker TO aiag_ton_worker_owner, aiag_ton_worker;

-- Owner authority: the definer surface used inside the wrapper transaction.
GRANT SELECT ON public.users, public.organizations, public.payments, public.ton_invoices,
  public.ton_chain_events, public.ton_invoice_event_decisions, public.gateway_transactions
  TO aiag_ton_worker_owner;
GRANT INSERT ON public.ton_chain_events, public.ton_invoice_event_decisions, public.gateway_transactions
  TO aiag_ton_worker_owner;
-- SELECT FOR UPDATE requires UPDATE privilege; immutable event triggers still reject actual updates.
GRANT UPDATE(created_at) ON public.ton_chain_events TO aiag_ton_worker_owner;
GRANT UPDATE(status,review_reason,settled_event_id,receipt_id,updated_at,settled_at)
  ON public.ton_invoices TO aiag_ton_worker_owner;
GRANT UPDATE(payg_credits,updated_at) ON public.organizations TO aiag_ton_worker_owner;
GRANT EXECUTE ON FUNCTION
  public.aiag_settle_ton_invoice_v1(uuid,jsonb),
  public.aiag_ton_credit_v1(jsonb),
  public.aiag_ton_keys_v1(jsonb,text[]),
  public.aiag_ton_text_v1(jsonb,text,integer),
  public.aiag_ton_asset_v1(jsonb),
  public.aiag_ton_time_v1(jsonb),
  public.aiag_ton_atomic_v1(jsonb,boolean,boolean),
  public.aiag_ton_receipt_json_v1(uuid),
  public.aiag_ton_invoice_guard_v1(),
  public.aiag_ton_settlement_consistent_v1(),
  public.aiag_ton_event_immutable_v1(),
  public.aiag_ton_decision_immutable_v1(),
  public.aiag_ton_receipt_immutable_v1(),
  public.aiag_ton_invoice_json_v1(public.ton_invoices),
  public.aiag_create_ton_invoice_v1(uuid,uuid,jsonb,text),
  public.aiag_read_ton_invoice_v1(uuid,uuid,uuid),
  public.aiag_expire_ton_invoice_v1(uuid),
  public.aiag_ton_payload_v1(jsonb,uuid,uuid)
  TO aiag_ton_worker_owner;

-- Worker session: read the settlement facts and call the helpers the deferred
-- consistency checks execute at COMMIT under the caller.
GRANT SELECT ON public.ton_invoices, public.ton_invoice_event_decisions, public.gateway_transactions
  TO aiag_ton_worker;
GRANT EXECUTE ON FUNCTION public.aiag_ton_atomic_v1(jsonb,boolean,boolean), public.aiag_ton_text_v1(jsonb,text,integer)
  TO aiag_ton_worker;

CREATE FUNCTION aiag_ton_worker.settle_invoice_v1(_invoice uuid,_credit jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $aiag$
BEGIN
 IF SESSION_USER::text <> 'aiag_ton_worker' THEN RAISE EXCEPTION 'TON_SETTLEMENT_SESSION_REQUIRED' USING ERRCODE='42501'; END IF;
 IF _invoice IS NULL OR _credit IS NULL OR pg_catalog.octet_length(_credit::text)>32768 THEN RAISE EXCEPTION 'TON_SETTLEMENT_INPUT_INVALID'; END IF;
 -- Testnet pin until the Phase 3.2 settle-mode wiring widens the accepted network.
 IF _credit->>'network' IS DISTINCT FROM 'tvm:-3' OR _credit->'asset'->>'kind' IS DISTINCT FROM 'native' OR _credit->'asset'->'decimals' IS DISTINCT FROM '9'::jsonb THEN RAISE EXCEPTION 'TON_SETTLEMENT_ASSET_UNSUPPORTED'; END IF;
 RETURN public.aiag_settle_ton_invoice_v1(_invoice,_credit);
END
$aiag$;
ALTER FUNCTION aiag_ton_worker.settle_invoice_v1(uuid,jsonb) OWNER TO aiag_ton_worker_owner;
REVOKE ALL ON FUNCTION aiag_ton_worker.settle_invoice_v1(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiag_ton_worker.settle_invoice_v1(uuid,jsonb) TO aiag_ton_worker;
