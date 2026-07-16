-- 0058_settle_charge_credits_fn.sql
--
-- 🔴 P0-1 fix (Opus adversarial review of c173a88, 2026-07-16 rework).
--
-- The credit-unit settlement function `aiag_settle_charge_credits` was
-- defined ONLY in packages/database/src/functions/settle-charge.sql, which is
-- NOT one of the files prod migrations are run from. Per
-- packages/database/CLAUDE.md, prod migrations are hand-run, in order, from
-- `migrations/` — `src/functions/*.sql` is a source-controlled MIRROR for
-- readability, never applied directly on prod. Deploying 0056+0057 alone
-- (the documented procedure) would NOT create this function; the gateway's
-- `settle.ts` calls it on every billed request →
-- `42883 function aiag_settle_charge_credits(...) does not exist` →
-- `settle.ts`'s catch only maps P0001-P0004, so 42883 falls through to
-- `throw e` → 500 on chat/sse/images/embeddings/completions/audio/video. A
-- total billing outage, not a degradation.
--
-- Fix: ship the function body as a migration. This file MUST be byte-for-byte
-- the same CREATE OR REPLACE body as
-- packages/database/src/functions/settle-charge.sql's
-- `aiag_settle_charge_credits` definition — that file remains the
-- documented/readable source, this one is what actually reaches Postgres.
-- Keep both in sync by hand on any future edit to the function.
--
-- `CREATE OR REPLACE FUNCTION` is naturally idempotent — safe to re-run.
--
-- Deploy ordering: must land in the SAME migration window as 0056 (and
-- before/with the api-gateway code deploy that starts calling this
-- function) — see 0056's header and packages/database/CLAUDE.md /
-- skill aiag-deploy for the full sequenced runbook.

CREATE OR REPLACE FUNCTION aiag_settle_charge_credits(
  _org_id        UUID,
  _request_id    VARCHAR,
  _cost_credits  BIGINT,
  _metadata      JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE(
  sub_portion  BIGINT,
  payg_portion BIGINT,
  new_sub      BIGINT,
  new_payg     BIGINT,
  idempotent   BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
  _sub_avail     BIGINT;
  _payg_avail    BIGINT;
  _sub_expires   TIMESTAMPTZ;
  _sub_portion   BIGINT := 0;
  _payg_portion  BIGINT := 0;
  _existing_sub  BIGINT;
  _existing_payg BIGINT;
BEGIN
  IF _cost_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  -- Lock org row (serializes per-org concurrency)
  SELECT subscription_credits, payg_credits, subscription_credits_expires_at
    INTO _sub_avail, _payg_avail, _sub_expires
  FROM organizations
  WHERE id = _org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency check INSIDE lock (same pattern as aiag_settle_charge).
  -- Reuses gateway_transactions (api_usage rows). If rows exist — return
  -- existing values, no UPDATE.
  SELECT
    COALESCE(SUM(CASE WHEN source = 'subscription' THEN ABS(delta) END), 0),
    COALESCE(SUM(CASE WHEN source = 'payg'         THEN ABS(delta) END), 0)
    INTO _existing_sub, _existing_payg
  FROM gateway_transactions
  WHERE request_id = _request_id
    AND type = 'api_usage'
    AND source IN ('subscription', 'payg');

  IF _existing_sub > 0 OR _existing_payg > 0 THEN
    sub_portion  := _existing_sub;
    payg_portion := _existing_payg;
    new_sub      := _sub_avail;
    new_payg     := _payg_avail;
    idempotent   := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Expired sub credits treated as zero
  IF _sub_expires IS NOT NULL AND _sub_expires < NOW() THEN
    _sub_avail := 0;
  END IF;

  _sub_portion  := LEAST(_cost_credits, _sub_avail);
  _payg_portion := _cost_credits - _sub_portion;

  IF _payg_portion > _payg_avail THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: need % payg, have %', _payg_portion, _payg_avail
      USING ERRCODE = 'P0003';
  END IF;

  UPDATE organizations
     SET subscription_credits = subscription_credits - _sub_portion,
         payg_credits         = payg_credits - _payg_portion,
         updated_at           = NOW()
   WHERE id = _org_id
     AND subscription_credits >= _sub_portion
     AND payg_credits         >= _payg_portion
  RETURNING subscription_credits, payg_credits INTO new_sub, new_payg;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  IF _sub_portion > 0 THEN
    INSERT INTO gateway_transactions (org_id, request_id, type, source, delta, metadata, created_at)
    VALUES (_org_id, _request_id, 'api_usage', 'subscription', -_sub_portion, COALESCE(_metadata, '{}'::jsonb), NOW());
  END IF;

  IF _payg_portion > 0 THEN
    INSERT INTO gateway_transactions (org_id, request_id, type, source, delta, metadata, created_at)
    VALUES (_org_id, _request_id, 'api_usage', 'payg', -_payg_portion, COALESCE(_metadata, '{}'::jsonb), NOW());
  END IF;

  sub_portion  := _sub_portion;
  payg_portion := _payg_portion;
  idempotent   := FALSE;
  RETURN NEXT;
END;
$$;
