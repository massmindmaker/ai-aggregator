-- fix/rub-payments-tinkoff: Tinkoff webhook belt-and-suspenders dedup.
--
-- The app-level guard is the atomic gate in apps/web/.../webhooks/tinkoff/route.ts:
--   UPDATE payments SET status='confirmed' WHERE id=$1 AND status <> 'confirmed'
--   RETURNING *
-- Only the delivery whose UPDATE actually returns a row proceeds to credit
-- users.balance and insert a balance_transactions row. That alone is sufficient
-- under Postgres READ COMMITTED (row lock + WHERE-guard serializes concurrent/
-- repeated CONFIRMED callbacks for the SAME payment).
--
-- This migration adds a second, independent line of defence at the DB layer:
-- a payment can never end up with two 'deposit' balance_transactions rows,
-- even if a future code change or bug bypasses the app-level gate.
--
-- Partial (WHERE payment_id IS NOT NULL): usage/adjustment transactions that
-- are not tied to a specific payment keep paymentId NULL and are untouched by
-- this constraint. A payment CAN legitimately have both a 'deposit' row and a
-- later 'refund' row — the constraint is on (payment_id, type), not payment_id
-- alone, so that stays allowed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_tx_payment_type
  ON balance_transactions (payment_id, type)
  WHERE payment_id IS NOT NULL;
