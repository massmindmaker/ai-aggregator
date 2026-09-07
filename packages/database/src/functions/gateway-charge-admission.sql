CREATE OR REPLACE FUNCTION aiag_gateway_charge_admission_result(
  _billing_request_id UUID,
  _did_transition BOOLEAN
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE sql STABLE AS $$
  SELECT
    a.billing_request_id, a.org_id, a.api_key_id, a.client_request_id,
    a.route_kind, a.billing_mode, a.model_slug, a.authorized_max_credits,
    a.held_subscription_credits, a.held_payg_credits,
    a.captured_subscription_expires_at, a.quote_snapshot, a.attempt_id,
    a.upstream_id, a.pricing_snapshot, a.actual_cost_credits,
    a.usage_snapshot, a.outcome_kind, a.state, a.pre_dispatch_deadline_at,
    a.created_at, a.dispatched_at, a.outcome_recorded_at, a.settled_at,
    a.cancelled_at, a.reconcile_after, a.released_subscription_credits,
    a.released_payg_credits, a.debt_repaid_credits,
    a.expired_subscription_credits, _did_transition
  FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id;
$$;

CREATE OR REPLACE FUNCTION aiag_admit_gateway_charge(
  _org_id UUID,
  _billing_request_id UUID,
  _api_key_id UUID,
  _client_request_id VARCHAR,
  _route_kind VARCHAR,
  _billing_mode VARCHAR,
  _model_slug VARCHAR,
  _authorized_max_credits BIGINT,
  _quote_snapshot JSONB,
  _pre_dispatch_deadline_at TIMESTAMPTZ
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _subscription_credits BIGINT;
  _payg_credits BIGINT;
  _refund_debt BIGINT;
  _subscription_expires_at TIMESTAMPTZ;
  _held_subscription BIGINT := 0;
  _held_payg BIGINT := 0;
  _existing gateway_charge_admissions%ROWTYPE;
BEGIN
  IF _org_id IS NULL OR _billing_request_id IS NULL OR _api_key_id IS NULL
    OR _route_kind IS NULL OR btrim(_route_kind) = '' OR length(_route_kind) > 32
    OR _billing_mode NOT IN ('stored', 'byok_fee')
    OR _model_slug IS NULL OR btrim(_model_slug) = '' OR length(_model_slug) > 128
    OR (_client_request_id IS NOT NULL AND
        (btrim(_client_request_id) = '' OR length(_client_request_id) > 255))
    OR _authorized_max_credits IS NULL OR _authorized_max_credits <= 0
    OR _quote_snapshot IS NULL OR jsonb_typeof(_quote_snapshot) <> 'object'
    OR _pre_dispatch_deadline_at IS NULL
  THEN
    RAISE EXCEPTION 'INVALID_ADMISSION' USING ERRCODE = 'P0001';
  END IF;

  SELECT o.subscription_credits, o.payg_credits, o.refund_debt_credits,
         o.subscription_credits_expires_at
    INTO _subscription_credits, _payg_credits, _refund_debt,
         _subscription_expires_at
  FROM organizations o
  WHERE o.id = _org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));

  SELECT a.* INTO _existing
  FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF _existing.org_id IS DISTINCT FROM _org_id
      OR _existing.api_key_id IS DISTINCT FROM _api_key_id
      OR _existing.client_request_id IS DISTINCT FROM _client_request_id
      OR _existing.route_kind IS DISTINCT FROM _route_kind
      OR _existing.billing_mode IS DISTINCT FROM _billing_mode
      OR _existing.model_slug IS DISTINCT FROM _model_slug
      OR _existing.authorized_max_credits IS DISTINCT FROM _authorized_max_credits
      OR _existing.quote_snapshot IS DISTINCT FROM _quote_snapshot
      OR _existing.pre_dispatch_deadline_at IS DISTINCT FROM _pre_dispatch_deadline_at
    THEN
      RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
    END IF;
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;

  IF _pre_dispatch_deadline_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'ADMISSION_DEADLINE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM gateway_api_keys k
    WHERE k.id = _api_key_id AND k.org_id = _org_id
      AND k.disabled_at IS NULL AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'API_KEY_ORG_MISMATCH' USING ERRCODE = 'P0005';
  END IF;

  IF _billing_mode = 'stored' THEN
    PERFORM aiag_assert_refund_admission_allowed(_org_id);
  END IF;

  IF _subscription_expires_at IS NULL
    OR _subscription_expires_at > clock_timestamp()
  THEN
    _held_subscription := LEAST(_authorized_max_credits, _subscription_credits);
  END IF;
  _held_payg := _authorized_max_credits - _held_subscription;

  IF _held_payg > _payg_credits THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS' USING ERRCODE = 'P0003';
  END IF;

  UPDATE organizations o
  SET subscription_credits = o.subscription_credits - _held_subscription,
      payg_credits = o.payg_credits - _held_payg,
      updated_at = clock_timestamp()
  WHERE o.id = _org_id
    AND o.subscription_credits >= _held_subscription
    AND o.payg_credits >= _held_payg
  RETURNING o.subscription_credits, o.payg_credits
    INTO _subscription_credits, _payg_credits;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  INSERT INTO gateway_charge_admissions (
    billing_request_id, org_id, api_key_id, client_request_id, route_kind,
    billing_mode, model_slug, authorized_max_credits,
    held_subscription_credits, held_payg_credits,
    captured_subscription_expires_at, quote_snapshot,
    pre_dispatch_deadline_at
  ) VALUES (
    _billing_request_id, _org_id, _api_key_id, _client_request_id, _route_kind,
    _billing_mode, _model_slug, _authorized_max_credits,
    _held_subscription, _held_payg, _subscription_expires_at, _quote_snapshot,
    _pre_dispatch_deadline_at
  );

  INSERT INTO gateway_charge_admission_events (
    admission_id, org_id, event_key, event_kind,
    held_subscription_credits, held_payg_credits, metadata
  ) VALUES (
    _billing_request_id, _org_id, 'hold', 'hold',
    _held_subscription, _held_payg,
    jsonb_build_object('billing_mode', _billing_mode, 'model_slug', _model_slug)
  );

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_mark_gateway_charge_dispatched(
  _org_id UUID,
  _billing_request_id UUID,
  _attempt_id UUID,
  _upstream_id VARCHAR,
  _pricing_snapshot JSONB
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
  _dispatch_at TIMESTAMPTZ;
  _updated_billing_request_id UUID;
BEGIN
  IF _org_id IS NULL OR _billing_request_id IS NULL OR _attempt_id IS NULL
    OR _upstream_id IS NULL OR btrim(_upstream_id) = '' OR length(_upstream_id) > 64
    OR _pricing_snapshot IS NULL OR jsonb_typeof(_pricing_snapshot) <> 'object'
  THEN
    RAISE EXCEPTION 'INVALID_DISPATCH' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  IF _existing.attempt_id IS NOT NULL THEN
    IF _existing.attempt_id IS DISTINCT FROM _attempt_id
      OR _existing.upstream_id IS DISTINCT FROM _upstream_id
      OR _existing.pricing_snapshot IS DISTINCT FROM _pricing_snapshot
    THEN
      RAISE EXCEPTION 'DISPATCH_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
    END IF;
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;

  IF _existing.state <> 'held' THEN
    RAISE EXCEPTION 'DISPATCH_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  _dispatch_at := clock_timestamp();
  IF _existing.pre_dispatch_deadline_at <= _dispatch_at THEN
    RAISE EXCEPTION 'ADMISSION_DEADLINE_EXPIRED' USING ERRCODE = 'P0005';
  END IF;

  UPDATE gateway_charge_admissions a
  SET state = 'dispatched', attempt_id = _attempt_id,
      upstream_id = _upstream_id, pricing_snapshot = _pricing_snapshot,
      dispatched_at = _dispatch_at,
      reconcile_after = _dispatch_at + INTERVAL '15 minutes'
  WHERE a.billing_request_id = _billing_request_id
    AND a.state = 'held'
    AND a.pre_dispatch_deadline_at > _dispatch_at
  RETURNING a.billing_request_id INTO _updated_billing_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPATCH_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_record_gateway_charge_outcome(
  _org_id UUID,
  _billing_request_id UUID,
  _actual_cost_credits BIGINT,
  _usage_snapshot JSONB,
  _outcome_kind VARCHAR
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
BEGIN
  IF _org_id IS NULL OR _billing_request_id IS NULL
    OR _actual_cost_credits IS NULL OR _actual_cost_credits < 0
    OR _usage_snapshot IS NULL OR jsonb_typeof(_usage_snapshot) <> 'object'
    OR _outcome_kind IS NULL OR btrim(_outcome_kind) = ''
    OR length(_outcome_kind) > 32
    OR (_actual_cost_credits = 0
        AND _outcome_kind NOT IN ('success', 'verified_no_charge'))
  THEN
    RAISE EXCEPTION 'INVALID_OUTCOME' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  IF _actual_cost_credits > _existing.authorized_max_credits THEN
    RAISE EXCEPTION 'ACTUAL_EXCEEDS_AUTHORIZED_MAX' USING ERRCODE = 'P0001';
  END IF;

  IF _existing.actual_cost_credits IS NOT NULL THEN
    IF _existing.actual_cost_credits IS DISTINCT FROM _actual_cost_credits
      OR _existing.usage_snapshot IS DISTINCT FROM _usage_snapshot
      OR _existing.outcome_kind IS DISTINCT FROM _outcome_kind
    THEN
      RAISE EXCEPTION 'OUTCOME_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
    END IF;
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;

  IF _existing.state <> 'dispatched' THEN
    RAISE EXCEPTION 'OUTCOME_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  UPDATE gateway_charge_admissions a
  SET state = 'outcome_recorded', actual_cost_credits = _actual_cost_credits,
      usage_snapshot = _usage_snapshot, outcome_kind = _outcome_kind,
      outcome_recorded_at = clock_timestamp(), reconcile_after = clock_timestamp()
  WHERE a.billing_request_id = _billing_request_id AND a.state = 'dispatched';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_settle_admitted_gateway_charge(
  _org_id UUID,
  _billing_request_id UUID
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
  _current_expiry TIMESTAMPTZ;
  _refund_debt BIGINT;
  _used_subscription BIGINT;
  _used_payg BIGINT;
  _unused_subscription BIGINT;
  _unused_payg BIGINT;
  _released_subscription BIGINT := 0;
  _released_payg BIGINT;
  _debt_repaid BIGINT;
  _expired_subscription BIGINT := 0;
  _receipt_id VARCHAR;
  _post_subscription BIGINT;
  _post_payg BIGINT;
  _post_refund_debt BIGINT;
BEGIN
  SELECT o.subscription_credits_expires_at, o.refund_debt_credits
    INTO _current_expiry, _refund_debt
  FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  IF _existing.state = 'settled' THEN
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;
  IF _existing.state <> 'outcome_recorded' THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  _used_subscription := LEAST(
    _existing.actual_cost_credits, _existing.held_subscription_credits
  );
  _used_payg := _existing.actual_cost_credits - _used_subscription;
  _unused_subscription := _existing.held_subscription_credits - _used_subscription;
  _unused_payg := _existing.held_payg_credits - _used_payg;
  _debt_repaid := LEAST(_unused_payg, _refund_debt);
  _released_payg := _unused_payg - _debt_repaid;

  IF _existing.captured_subscription_expires_at IS NOT DISTINCT FROM _current_expiry
    AND (_existing.captured_subscription_expires_at IS NULL
         OR _existing.captured_subscription_expires_at > clock_timestamp())
  THEN
    _released_subscription := _unused_subscription;
  ELSE
    _expired_subscription := _unused_subscription;
  END IF;

  UPDATE organizations o
  SET subscription_credits = o.subscription_credits + _released_subscription,
      payg_credits = o.payg_credits + _released_payg,
      refund_debt_credits = o.refund_debt_credits - _debt_repaid,
      updated_at = clock_timestamp()
  WHERE o.id = _org_id AND o.refund_debt_credits >= _debt_repaid
  RETURNING o.subscription_credits, o.payg_credits, o.refund_debt_credits
    INTO _post_subscription, _post_payg, _post_refund_debt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  _receipt_id := 'gw:' || _billing_request_id::text;
  IF _used_subscription > 0 THEN
    INSERT INTO gateway_transactions (
      org_id, request_id, type, source, delta, metadata, created_at
    ) VALUES (
      _org_id, _receipt_id, 'api_usage', 'subscription', -_used_subscription,
      jsonb_build_object(
        'billing_request_id', _billing_request_id,
        'model_slug', _existing.model_slug,
        'outcome_kind', _existing.outcome_kind,
        'usage', _existing.usage_snapshot
      ), clock_timestamp()
    );
  END IF;
  IF _used_payg > 0 THEN
    INSERT INTO gateway_transactions (
      org_id, request_id, type, source, delta, metadata, created_at
    ) VALUES (
      _org_id, _receipt_id, 'api_usage', 'payg', -_used_payg,
      jsonb_build_object(
        'billing_request_id', _billing_request_id,
        'model_slug', _existing.model_slug,
        'outcome_kind', _existing.outcome_kind,
        'usage', _existing.usage_snapshot
      ), clock_timestamp()
    );
  END IF;

  INSERT INTO gateway_charge_admission_events (
    admission_id, org_id, event_key, event_kind,
    used_subscription_credits, used_payg_credits,
    released_subscription_credits, released_payg_credits,
    debt_repaid_credits, expired_subscription_credits, metadata
  ) VALUES (
    _billing_request_id, _org_id, 'settlement', 'settlement',
    _used_subscription, _used_payg, _released_subscription, _released_payg,
    _debt_repaid, _expired_subscription,
    jsonb_build_object('actual_cost_credits', _existing.actual_cost_credits)
  );

  UPDATE gateway_charge_admissions a
  SET state = 'settled', settled_at = clock_timestamp(), reconcile_after = NULL,
      released_subscription_credits = _released_subscription,
      released_payg_credits = _released_payg,
      debt_repaid_credits = _debt_repaid,
      expired_subscription_credits = _expired_subscription
  WHERE a.billing_request_id = _billing_request_id
    AND a.state = 'outcome_recorded';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION aiag_cancel_undispatched_gateway_charge(
  _org_id UUID,
  _billing_request_id UUID
) RETURNS SETOF gateway_charge_admission_result
LANGUAGE plpgsql AS $$
DECLARE
  _existing gateway_charge_admissions%ROWTYPE;
  _current_expiry TIMESTAMPTZ;
  _refund_debt BIGINT;
  _released_subscription BIGINT := 0;
  _released_payg BIGINT;
  _debt_repaid BIGINT;
  _expired_subscription BIGINT := 0;
  _post_subscription BIGINT;
  _post_payg BIGINT;
  _post_refund_debt BIGINT;
BEGIN
  SELECT o.subscription_credits_expires_at, o.refund_debt_credits
    INTO _current_expiry, _refund_debt
  FROM organizations o WHERE o.id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_billing_request_id::text, 0));
  SELECT a.* INTO _existing FROM gateway_charge_admissions a
  WHERE a.billing_request_id = _billing_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMISSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _existing.org_id IS DISTINCT FROM _org_id THEN
    RAISE EXCEPTION 'ADMISSION_IDENTITY_CONFLICT' USING ERRCODE = 'P0005';
  END IF;
  IF _existing.state = 'cancelled' THEN
    RETURN QUERY
      SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, FALSE);
    RETURN;
  END IF;
  IF _existing.state <> 'held' THEN
    RAISE EXCEPTION 'CANCELLATION_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  _debt_repaid := LEAST(_existing.held_payg_credits, _refund_debt);
  _released_payg := _existing.held_payg_credits - _debt_repaid;
  IF _existing.captured_subscription_expires_at IS NOT DISTINCT FROM _current_expiry
    AND (_existing.captured_subscription_expires_at IS NULL
         OR _existing.captured_subscription_expires_at > clock_timestamp())
  THEN
    _released_subscription := _existing.held_subscription_credits;
  ELSE
    _expired_subscription := _existing.held_subscription_credits;
  END IF;

  UPDATE organizations o
  SET subscription_credits = o.subscription_credits + _released_subscription,
      payg_credits = o.payg_credits + _released_payg,
      refund_debt_credits = o.refund_debt_credits - _debt_repaid,
      updated_at = clock_timestamp()
  WHERE o.id = _org_id AND o.refund_debt_credits >= _debt_repaid
  RETURNING o.subscription_credits, o.payg_credits, o.refund_debt_credits
    INTO _post_subscription, _post_payg, _post_refund_debt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE = 'P0004';
  END IF;

  INSERT INTO gateway_charge_admission_events (
    admission_id, org_id, event_key, event_kind,
    released_subscription_credits, released_payg_credits,
    debt_repaid_credits, expired_subscription_credits, metadata
  ) VALUES (
    _billing_request_id, _org_id, 'cancellation', 'cancellation',
    _released_subscription, _released_payg, _debt_repaid,
    _expired_subscription, '{}'::jsonb
  );

  UPDATE gateway_charge_admissions a
  SET state = 'cancelled', cancelled_at = clock_timestamp(),
      released_subscription_credits = _released_subscription,
      released_payg_credits = _released_payg,
      debt_repaid_credits = _debt_repaid,
      expired_subscription_credits = _expired_subscription
  WHERE a.billing_request_id = _billing_request_id AND a.state = 'held';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANCELLATION_STATE_CONFLICT' USING ERRCODE = 'P0005';
  END IF;

  RETURN QUERY
    SELECT * FROM aiag_gateway_charge_admission_result(_billing_request_id, TRUE);
END;
$$;
