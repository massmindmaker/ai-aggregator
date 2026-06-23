-- 0043_usdt_topup_and_payouts.sql
-- R2-readiness: USDT-on-TON top-up (additive credit path) + author-payout SCAFFOLD.
-- R&D synthesis 2026-06-13 (sanctioned): credit is OFF-CHAIN; top-up via native TON
-- (already live, migration 0019/0029) PLUS USDT-on-TON jetton (USD-peg WITHOUT an
-- oracle: 1 USDT = 100 credits = $1.00). Payouts (money-OUT, real funds) = an
-- off-chain ledger accrual → batch direct USDT transfer; kept behind an env flag
-- (TON_PAYOUTS_ENABLED) so NO real funds ever move without explicit configuration.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0043_usdt_topup_and_payouts.sql
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS only.
-- Touches NO existing money path: tg_user_balances debit / settleRun / rent_charges
-- are unchanged. tg_topups gains optional columns; the native-TON branch ignores them.
--
-- DEPENDS ON 0019_ton_wallets.sql (tg_topups) + 0029_usd_ledger.sql (tg_ledger_entries).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) tg_topups: describe WHICH asset / network funded a top-up.
--    Existing rows are native TON → asset='TON', network='ton' defaults apply.
--    expected_amount = the asset's smallest unit we expect to receive
--      * for TON:  nano-TON (same value already in amount_nano_ton; kept NULL for
--                  legacy rows, the reconciler still reads amount_nano_ton there).
--      * for USDT: jetton smallest unit (USDT-on-TON has 6 decimals → 1 USDT = 1e6).
--    quote_ts = when the asset→credits quote was struck (audit; USDT has no oracle
--               quote — it is a fixed peg — but the column is kept symmetric).
-- ---------------------------------------------------------------------------
ALTER TABLE tg_topups ADD COLUMN IF NOT EXISTS asset TEXT DEFAULT 'TON';
ALTER TABLE tg_topups ADD COLUMN IF NOT EXISTS network TEXT DEFAULT 'ton';
ALTER TABLE tg_topups ADD COLUMN IF NOT EXISTS expected_amount BIGINT;
ALTER TABLE tg_topups ADD COLUMN IF NOT EXISTS quote_ts TIMESTAMPTZ;

COMMENT ON COLUMN tg_topups.asset IS
  'Актив пополнения: TON | USDT (USDT-on-TON jetton). Дефолт TON для legacy-строк.';
COMMENT ON COLUMN tg_topups.network IS 'Сеть актива (ton). Зарезервировано на будущее.';
COMMENT ON COLUMN tg_topups.expected_amount IS
  'Ожидаемая сумма в минимальных единицах актива (TON: nano; USDT: 1e6 = 1 USDT).';
COMMENT ON COLUMN tg_topups.quote_ts IS 'Момент фиксации котировки актив→кредиты (аудит).';

-- ---------------------------------------------------------------------------
-- 2) author_payouts — money-OUT SCAFFOLD (off by default).
--    An author-payout REQUEST against accrued off-chain income. Real on-chain
--    send is gated by TON_PAYOUTS_ENABLED in the worker; without it a request just
--    sits in 'pending' and NOTHING leaves the wallet. status lifecycle:
--      pending  → requested, not yet sent (the ONLY state reachable with the flag OFF)
--      sending  → claimed by a batch worker (single-worker seqno serialization)
--      sent     → broadcast on-chain (tx_hash set)
--      failed   → send errored; safe to retry into a new request
--    amount_credits = how much income (US cents) this payout consumes.
--    The matching off-chain DEBIT (so income can't be paid twice) is a
--    tg_ledger_entries row kind='author_payout' ref_kind='author_payout' ref_id=id,
--    written under the live uq_ledger_ref(ref_kind,ref_id,kind) idempotency index.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS author_payouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_tg_user_id BIGINT NOT NULL,
  amount_credits  BIGINT NOT NULL CHECK (amount_credits > 0), -- US cents to pay out
  asset           TEXT NOT NULL DEFAULT 'USDT',               -- payout asset
  dest_address    TEXT NOT NULL,                              -- author's TON wallet
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  tx_hash         TEXT,
  error           TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_author_payouts_author
  ON author_payouts(author_tg_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_author_payouts_pending
  ON author_payouts(status) WHERE status = 'pending';

COMMIT;
