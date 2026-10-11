-- 0108_agent_quota_writers.sql
-- Agent routing-policy / quota self-service writers (plan 2026-10-09
-- agentic-rail, Task 8). Two SQL entrypoints behind PUT /v1/agent/policy:
--
--  1. aiag_set_agent_key_quota_v1(_key_id,_session_micro,_monthly_credits)
--     Authorization is the 0106/0107 predicate: a LIVE gateway_api_keys row
--     (not revoked, not disabled, not past expires_at per 0105) whose org
--     has an ACTIVE agent_principals principal. Writes:
--       - session limit  -> gateway_quota_key_policies
--                           .session_microcredits_limit_v2 (0068), the v2
--                           column the admission core actually reads;
--       - monthly limit  -> gateway_api_keys.cost_limit_monthly_rub — the
--           column 0068:429-432 reads as the v2 key_month source. UNIT NOTE:
--           despite the name, 0061 converted this column to CREDITS
--           (1 credit = 1000 micro = 1 US cent), and 0068 derives the v2
--           micro limit as cost_limit_monthly_rub*1000. _monthly_credits is
--           therefore integer credits, stored 1:1.
--     NULL clears a limit. 0 also clears it: 0068 itself maps a zero cap to
--     "no limit" (NULLIF(aiag_quota_money(...*1000),0)) and treats
--     per_session_budget_cap_rub=0 as unenforced, so zero-as-clear is the
--     established semantics, not a new one. Clearing the session limit
--     DELETEs the gateway_quota_key_policies row (no row = no policy, the
--     pre-0068 state; the monthly clear NULLs the column).
--     EVERY successful call also scrubs the legacy fields that make a v2
--     admission raise QUOTA_POLICY_MIGRATION_REQUIRED (0068:421-438):
--     daily_usd_cap := NULL and policies.per_session_budget_cap_rub := 0
--     (rewritten only when present and non-null — 0 already passes 0068 and
--     disables the legacy spend-counters path, which is falsy at 0). An
--     agent org that self-manages quotas must never be locked out of v2 by
--     fields only the human dashboard ever wrote.
--     Guarded: the key row is locked FOR UPDATE before any write; the
--     session-policy upsert bumps revision (the value 0068 freezes into
--     policy_snapshot); audit_log 'agent.policy' in the same transaction.
--
--  2. aiag_set_agent_org_quota_v1(_org_id,_daily_supplier_usd_micro)
--     Called by the route with the CALLING KEY's org (never a body value).
--     Authorization: the org must carry an ACTIVE agent principal (0104
--     rail; one principal per org). Upserts
--     gateway_quota_org_policies.daily_supplier_usd_micro_limit_v2 (0068),
--     revision+1. On INSERT the row enrolls the org into v2 quota
--     enforcement (enforcement_version=2): 0068 requires it for every
--     aiag_admit_gateway_charge_v2 call, and the stored execution paths the
--     agent rail runs on are v2-only. On conflict the enforcement_version
--     is deliberately left untouched (an org already pinned to v1 by an
--     operator keeps that pin; limits still only take effect under v2).
--     NULL (or 0) clears the daily limit but KEEPS enforcement_version —
--     un-enrolling would silently flip every future admission between
--     contract versions, and the legacy key fields were already scrubbed by
--     the key writer. No row + NULL = no-op.
--
-- No monetary columns are touched: these are limit registers only.
BEGIN;

CREATE FUNCTION aiag_set_agent_key_quota_v1(_key_id UUID, _session_micro BIGINT, _monthly_credits BIGINT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _org UUID; _owner UUID; _row gateway_api_keys%ROWTYPE; _revision BIGINT;
BEGIN
 -- Live-key gate, byte-for-byte the 0106/0107 predicate: revoked/disabled/
 -- expired keys authorize nothing, and a dead or unknown key id is
 -- indistinguishable from a foreign one.
 IF _key_id IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 SELECT k.org_id INTO _org FROM gateway_api_keys k
  JOIN agent_principals p ON p.org_id=k.org_id
  WHERE k.id=_key_id AND k.revoked_at IS NULL AND k.disabled_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND p.status='active';
 IF _org IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 _owner:=aiag_agent_owner_user_v1();
 IF _owner IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;

 -- Bounds before any write. Session is micro (compared against micro sums in
 -- 0068); monthly is integer credits, capped by NUMERIC(10,2) capacity
 -- (99999999.99). Both use the 0106 Number.MAX_SAFE_INTEGER compatibility
 -- ceiling for micro-scale values.
 IF _session_micro IS NOT NULL AND (_session_micro<0 OR _session_micro>9007199254740991)
  THEN RAISE EXCEPTION 'AGENT_QUOTA_OUT_OF_RANGE'; END IF;
 IF _monthly_credits IS NOT NULL AND (_monthly_credits<0 OR _monthly_credits>99999999)
  THEN RAISE EXCEPTION 'AGENT_QUOTA_OUT_OF_RANGE'; END IF;
 -- 0 = no limit (0068 NULLIF semantics).
 IF _session_micro=0 THEN _session_micro:=NULL; END IF;
 IF _monthly_credits=0 THEN _monthly_credits:=NULL; END IF;

 -- Serialize writers on the key row before reading/patching it.
 SELECT * INTO _row FROM gateway_api_keys WHERE id=_key_id FOR UPDATE;
 IF _row.id IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;

 -- Session limit: v2 policy row. NULL -> DELETE (no row, no policy).
 IF _session_micro IS NULL THEN
  DELETE FROM gateway_quota_key_policies WHERE api_key_id=_key_id AND org_id=_org;
 ELSE
  INSERT INTO gateway_quota_key_policies(api_key_id,org_id,session_microcredits_limit_v2,revision)
   VALUES(_key_id,_org,_session_micro,1)
   ON CONFLICT(api_key_id) DO UPDATE SET
    session_microcredits_limit_v2=EXCLUDED.session_microcredits_limit_v2,
    revision=gateway_quota_key_policies.revision+1,
    updated_at=clock_timestamp();
 END IF;
 SELECT revision INTO _revision FROM gateway_quota_key_policies WHERE api_key_id=_key_id;
 IF _revision IS NULL THEN _revision:=0; END IF;

 -- Monthly limit + legacy scrub in ONE guarded UPDATE. cost_limit_monthly_rub
 -- is CREDITS since 0061 (see header); the ::numeric keeps NUMERIC(10,2)
 -- arithmetic exact for the integer bound enforced above. The per-session
 -- rewrite only fires when the legacy key exists with a non-null value, so a
 -- clean key does not grow a new policies entry.
 UPDATE gateway_api_keys SET
  cost_limit_monthly_rub=_monthly_credits::numeric,
  daily_usd_cap=NULL,
  policies=CASE WHEN policies IS DISTINCT FROM '{}'::jsonb
    AND policies?'per_session_budget_cap_rub'
    AND policies->'per_session_budget_cap_rub' IS DISTINCT FROM 'null'::jsonb
   THEN jsonb_set(policies,'{per_session_budget_cap_rub}','0'::jsonb) ELSE policies END
 WHERE id=_key_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;

 INSERT INTO audit_log(actor_id,actor_type,action,resource_type,resource_id,details)
  VALUES(_owner,'system','agent.policy','gateway_api_key',_key_id::text,
   jsonb_build_object('orgId',_org::text,'sessionMicrocreditsLimit',_session_micro,
    'monthlyCreditsLimit',_monthly_credits,'sessionPolicyRevision',_revision));
 -- Limits serialize as JSON STRINGS: bigint values must never cross as JSON
 -- numbers (precision + the AtomicString seam convention).
 RETURN jsonb_build_object('sessionMicrocreditsLimit',to_jsonb(_session_micro::text),
  'monthlyCreditsLimit',to_jsonb(_monthly_credits::text));
END $$;

CREATE FUNCTION aiag_set_agent_org_quota_v1(_org_id UUID, _daily_supplier_usd_micro BIGINT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE _owner UUID; _enforcement SMALLINT;
BEGIN
 -- Org belongs to an agent principal (the route derives it from the calling
 -- key, so this predicate is the whole authorization surface).
 IF _org_id IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM agent_principals p WHERE p.org_id=_org_id AND p.status='active')
  THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;
 _owner:=aiag_agent_owner_user_v1();
 IF _owner IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_AUTHORIZED'; END IF;

 IF _daily_supplier_usd_micro IS NOT NULL AND (_daily_supplier_usd_micro<0 OR _daily_supplier_usd_micro>9007199254740991)
  THEN RAISE EXCEPTION 'AGENT_QUOTA_OUT_OF_RANGE'; END IF;
 IF _daily_supplier_usd_micro=0 THEN _daily_supplier_usd_micro:=NULL; END IF;

 SELECT enforcement_version INTO _enforcement FROM gateway_quota_org_policies WHERE org_id=_org_id FOR UPDATE;
 IF _enforcement IS NULL THEN
  IF _daily_supplier_usd_micro IS NULL THEN
   -- Nothing to clear and nothing to enroll.
   _enforcement:=1;
  ELSE
   INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2,revision)
    VALUES(_org_id,2,_daily_supplier_usd_micro,1);
   _enforcement:=2;
  END IF;
 ELSE
  IF _daily_supplier_usd_micro IS NULL THEN
   UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=NULL,
    revision=revision+1,updated_at=clock_timestamp() WHERE org_id=_org_id;
  ELSE
   UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=_daily_supplier_usd_micro,
    revision=revision+1,updated_at=clock_timestamp() WHERE org_id=_org_id;
  END IF;
 END IF;

 INSERT INTO audit_log(actor_id,actor_type,action,resource_type,resource_id,details)
  VALUES(_owner,'system','agent.policy','organization',_org_id::text,
   jsonb_build_object('orgId',_org_id::text,'dailySupplierUsdMicroLimit',_daily_supplier_usd_micro,
    'enforcementVersion',_enforcement));
 RETURN jsonb_build_object('dailySupplierUsdMicroLimit',to_jsonb(_daily_supplier_usd_micro::text),
  'enforcementVersion',to_jsonb(_enforcement::text));
END $$;

REVOKE EXECUTE ON FUNCTION aiag_set_agent_key_quota_v1(uuid,bigint,bigint),aiag_set_agent_org_quota_v1(uuid,bigint) FROM PUBLIC;

COMMIT;
