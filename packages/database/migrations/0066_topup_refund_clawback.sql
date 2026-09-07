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

CREATE OR REPLACE FUNCTION aiag_assert_refund_admission_allowed(
  _org_id UUID
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  _refund_debt BIGINT;
BEGIN
  SELECT refund_debt_credits
    INTO _refund_debt
  FROM organizations
  WHERE id = _org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF _refund_debt > 0 OR EXISTS (
    SELECT 1
    FROM payments
    WHERE topup_org_id = _org_id
      AND refund_claim_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'REFUND_BLOCKED' USING ERRCODE = 'P0005';
  END IF;
END;
$$;

COMMIT;
