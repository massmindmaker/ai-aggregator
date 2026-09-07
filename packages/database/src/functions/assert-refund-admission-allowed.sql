-- Additive pre-upstream refund admission guard.
--
-- Call this function inside the same transaction that writes a durable stored-
-- credit admission. Its organization row lock serializes that admission with
-- top-up refund claims and clawback settlement. Calling it as a standalone
-- preflight does not close the gateway's existing preflight/upstream TOCTOU gap.
-- Legacy aiag_settle_charge_credits remains unchanged until the admission-aware
-- settlement cutover ships with the gateway.

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
