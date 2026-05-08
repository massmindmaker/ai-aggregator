-- =============================================================================
-- aiag_settle_charge(_org_id, _request_id, _total_rub)
--
-- Atomic dual-bucket settlement per spec §4.3 (Post Round-2 review fixes
-- C1/C2/R2/R3/R4):
--  - SELECT FOR UPDATE on organizations row serializes per-org concurrent calls.
--  - Idempotency check INSIDE lock (before UPDATE) eliminates TOCTOU (FIX C2).
--  - Two conditional INSERTs (source='subscription' + source='payg') per spec (C1).
--  - Partial UNIQUE (request_id, source) WHERE type='api_usage' ensures
--    idempotency at the row level (see migration 0004_gateway_core.sql).
--
-- Phase 14: appended accrue_author_earnings hook (spec §5 Step 5).
--
-- Returns: (sub_portion, payg_portion, new_sub, new_payg, idempotent)
-- Raises:
--   P0001 INVALID_AMOUNT            if _total_rub <= 0
--   P0002 ORG_NOT_FOUND             if organization missing
--   P0003 INSUFFICIENT_FUNDS        if payg insufficient for remainder
--   P0004 CONCURRENT_MODIFICATION   if UPDATE WHERE-guards fail (should not normally)
-- =============================================================================

CREATE OR REPLACE FUNCTION aiag_settle_charge(
  _org_id       UUID,
  _request_id   VARCHAR,
  _total_rub    NUMERIC
) RETURNS TABLE(
  sub_portion  NUMERIC,
  payg_portion NUMERIC,
  new_sub      NUMERIC,
  new_payg     NUMERIC,
  idempotent   BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
  _sub_avail     NUMERIC;
  _payg_avail    NUMERIC;
  _sub_expires   TIMESTAMPTZ;
  _sub_portion   NUMERIC := 0;
  _payg_portion  NUMERIC := 0;
  _existing_sub  NUMERIC;
  _existing_payg NUMERIC;
  -- Phase 14: hook locals (declared at top level — Postgres disallows nested DECLARE)
  _author_id     UUID;
  _model_id      UUID;
  _tier_pct      NUMERIC;
BEGIN
  IF _total_rub <= 0 THEN
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

  -- Idempotency check INSIDE lock (FIX C2). Reuses gateway_transactions table
  -- (api_usage rows). If rows exist — return existing values, no UPDATE.
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

  -- Expired sub credits treated as zero (R2)
  IF _sub_expires IS NOT NULL AND _sub_expires < NOW() THEN
    _sub_avail := 0;
  END IF;

  _sub_portion  := LEAST(_total_rub, _sub_avail);
  _payg_portion := _total_rub - _sub_portion;

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

  -- Two conditional INSERTs per spec §4.3 (FIX C1)
  IF _sub_portion > 0 THEN
    INSERT INTO gateway_transactions (org_id, request_id, type, source, delta, metadata, created_at)
    VALUES (_org_id, _request_id, 'api_usage', 'subscription', -_sub_portion, '{}'::jsonb, NOW());
  END IF;

  IF _payg_portion > 0 THEN
    INSERT INTO gateway_transactions (org_id, request_id, type, source, delta, metadata, created_at)
    VALUES (_org_id, _request_id, 'api_usage', 'payg', -_payg_portion, '{}'::jsonb, NOW());
  END IF;

  -- -----------------------------------------------------------------------
  -- Phase 14 §5 Step 5 — accrue_author_earnings hook.
  -- Skipped on idempotent replays (early-return above). Filter `m.status='live'`
  -- is the authoritative cutoff for whether a settled charge accrues to the
  -- author. Failures isolated by inner BEGIN/EXCEPTION (settlement must succeed
  -- even if accrual fails — accrual can be reconciled, settlement cannot).
  -- -----------------------------------------------------------------------
  BEGIN
    SELECT m.author_user_id, m.id INTO _author_id, _model_id
    FROM requests r
    JOIN models m ON m.slug = r.model_slug
    WHERE r.request_id = _request_id
      AND m.author_user_id IS NOT NULL
      AND m.status = 'live'
    LIMIT 1;

    IF _author_id IS NOT NULL THEN
      _tier_pct := current_tier_pct(_author_id);
      INSERT INTO author_earnings (
        author_id, model_id, period_month,
        gross_rub, tier_pct, tier_pct_decimal, net_rub, author_share_rub,
        gateway_request_id, status, available_at
      ) VALUES (
        _author_id, _model_id, NULL,
        _total_rub, (_tier_pct * 100)::int, _tier_pct, _total_rub * _tier_pct, _total_rub * _tier_pct,
        _request_id, 'accruing', NOW() + INTERVAL '30 days'
      )
      ON CONFLICT (gateway_request_id) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'accrue_author_earnings hook failed for request_id=%: %', _request_id, SQLERRM;
  END;

  sub_portion  := _sub_portion;
  payg_portion := _payg_portion;
  idempotent   := FALSE;
  RETURN NEXT;
END;
$$;


-- =============================================================================
-- aiag_ensure_request_partition(_month_offset)
-- Creates next-month partition for `requests` if missing. Called by worker
-- cron job (see apps/worker/src/jobs/partition-ensure.ts).
-- =============================================================================

CREATE OR REPLACE FUNCTION aiag_ensure_request_partition(_month_offset INT DEFAULT 2)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  _start  DATE;
  _end    DATE;
  _pname  TEXT;
BEGIN
  _start := date_trunc('month', NOW() + (_month_offset || ' months')::interval)::date;
  _end   := (_start + INTERVAL '1 month')::date;
  _pname := 'requests_' || to_char(_start, 'YYYY_MM');

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = _pname) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF requests FOR VALUES FROM (%L) TO (%L)',
      _pname, _start, _end
    );
    RAISE NOTICE 'Created partition %', _pname;
  END IF;
END;
$$;
