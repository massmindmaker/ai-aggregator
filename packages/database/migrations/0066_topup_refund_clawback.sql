-- 0066_topup_refund_clawback.sql
-- Atomic snapshot, claim and cumulative clawback primitives for Tinkoff top-ups.

BEGIN;

ALTER TABLE organizations
  ADD COLUMN refund_debt_credits BIGINT NOT NULL DEFAULT 0;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_refund_debt_credits_nonneg
  CHECK (refund_debt_credits >= 0);

ALTER TABLE payments
  ADD COLUMN topup_org_id UUID REFERENCES organizations(id) ON DELETE RESTRICT,
  ADD COLUMN topup_paid_kopecks BIGINT,
  ADD COLUMN topup_grant_credits BIGINT,
  ADD COLUMN topup_refunded_kopecks BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN topup_clawed_credits BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN refund_claim_id UUID,
  ADD COLUMN refund_claim_kopecks BIGINT,
  ADD COLUMN refund_claimed_at TIMESTAMPTZ,
  ADD COLUMN refund_provider_key VARCHAR(255),
  ADD COLUMN refund_method_route VARCHAR(32),
  ADD COLUMN refund_method_source VARCHAR(32),
  ADD COLUMN refund_receipt_mode VARCHAR(40),
  ADD COLUMN refund_dispatched_at TIMESTAMPTZ;

ALTER TABLE payments
  ADD CONSTRAINT payments_topup_refund_state_check
  CHECK (
    (
      topup_org_id IS NULL
      AND topup_paid_kopecks IS NULL
      AND topup_grant_credits IS NULL
      AND topup_refunded_kopecks = 0
      AND topup_clawed_credits = 0
      AND refund_claim_id IS NULL
      AND refund_claim_kopecks IS NULL
      AND refund_claimed_at IS NULL
      AND refund_provider_key IS NULL
      AND refund_method_route IS NULL
      AND refund_method_source IS NULL
      AND refund_receipt_mode IS NULL
      AND refund_dispatched_at IS NULL
    )
    OR
    (
      topup_org_id IS NOT NULL
      AND topup_paid_kopecks IS NOT NULL
      AND topup_paid_kopecks > 0
      AND topup_grant_credits IS NOT NULL
      AND topup_grant_credits > 0
      AND topup_refunded_kopecks >= 0
      AND topup_refunded_kopecks <= topup_paid_kopecks
      AND topup_clawed_credits >= 0
      AND topup_clawed_credits <= topup_grant_credits
      AND (
        (
          refund_claim_id IS NULL
          AND refund_claim_kopecks IS NULL
          AND refund_claimed_at IS NULL
          AND refund_provider_key IS NULL
          AND refund_method_route IS NULL
          AND refund_method_source IS NULL
          AND refund_receipt_mode IS NULL
          AND refund_dispatched_at IS NULL
        )
        OR
        (
          refund_claim_id IS NOT NULL
          AND refund_claim_kopecks IS NOT NULL
          AND refund_claim_kopecks > 0
          AND refund_claim_kopecks <= topup_paid_kopecks - topup_refunded_kopecks
          AND refund_claimed_at IS NOT NULL
          AND refund_provider_key IS NOT NULL
          AND btrim(refund_provider_key) <> ''
          AND length(refund_provider_key) <= 255
          AND refund_method_route = 'ACQ'
          AND refund_method_source = 'cards'
          AND refund_receipt_mode IN ('full_no_receipt', 'trusted_no_receipt_required')
          AND (
            refund_receipt_mode <> 'full_no_receipt'
            OR refund_claim_kopecks = topup_paid_kopecks - topup_refunded_kopecks
          )
          AND (
            refund_dispatched_at IS NULL
            OR refund_dispatched_at >= refund_claimed_at
          )
        )
      )
    )
  );

CREATE INDEX payments_active_topup_refund_claim_idx
  ON payments (topup_org_id)
  WHERE refund_claim_id IS NOT NULL;

CREATE UNIQUE INDEX gateway_transactions_refund_uniq
  ON gateway_transactions (request_id, source)
  WHERE type = 'refund';

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
  _refund_debt   BIGINT;
  _sub_portion   BIGINT := 0;
  _payg_portion  BIGINT := 0;
  _existing_sub  BIGINT;
  _existing_payg BIGINT;
BEGIN
  IF _cost_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  -- Lock org row (serializes per-org concurrency)
  SELECT subscription_credits, payg_credits, subscription_credits_expires_at,
         refund_debt_credits
    INTO _sub_avail, _payg_avail, _sub_expires, _refund_debt
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

  -- Existing receipts remain replayable even while the org is blocked. New
  -- non-BYOK settlement is rejected under the same org lock that serializes
  -- claim creation and refund settlement.
  IF _refund_debt > 0 OR EXISTS (
    SELECT 1
    FROM payments
    WHERE topup_org_id = _org_id
      AND refund_claim_id IS NOT NULL
      AND refund_claim_kopecks IS NOT NULL
      AND refund_claimed_at IS NOT NULL
      AND refund_provider_key IS NOT NULL
      AND refund_method_route IS NOT NULL
      AND refund_method_source IS NOT NULL
      AND refund_receipt_mode IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'REFUND_BLOCKED' USING ERRCODE = 'P0005';
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

COMMIT;
