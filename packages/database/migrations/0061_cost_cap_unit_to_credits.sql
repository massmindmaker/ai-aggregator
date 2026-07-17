-- 0061_cost_cap_unit_to_credits.sql
-- T2 blocker 2 fix (Opus review, 2026-07-17): cbr.ru was in the hot billing
-- path. key-limits.ts called fetchUsdRubRate() on EVERY request once a key
-- had any accumulated spend, to convert the MICRO-credit spend counter into
-- ₽ so it could be compared against gateway_api_keys.cost_limit_monthly_rub.
-- A cold CBR cache + an unreachable cbr.ru (2 URLs x 3 retries, see
-- lib/cbr.ts's RETRIES schedule) could block a billed request for up to
-- ~88s, with no fail-open and no per-request budget. The unit tests never
-- exercised this cold: they pre-seed 'cbr:usd_rub:today' in the mocked
-- Redis, so the network branch was always skipped in CI.
--
-- Fix (founder-directed, not "move the FX call elsewhere"): remove the
-- exchange rate from the runtime entirely. Convert the CAP itself, once,
-- here, from ₽ to CREDITS (1 credit = 1 US cent — the same unit the spend
-- counter already accumulates in, see chat.ts's monthlyCostCounterKey INCR).
-- key-limits.ts can then compare the micro-credit counter directly against
-- this column with zero network calls.
--
-- One-time conversion at a FIXED rate baked into this migration (no network
-- call from a migration, per the task's explicit instruction): ~90 RUB/USD,
-- an approximate CBR rate as of 2026-07-17. This is a one-off unit
-- conversion of EXISTING rows — the column is plain credits from here on,
-- with no further FX involved at read or write time.
--
-- Column is NOT renamed here (still says "..._rub") — that rename is T6,
-- tracked separately (finmodel-build-spec §6/§8). COMMENT ON COLUMN records
-- the truth so nobody re-reads the stale name as rubles again.
--
-- Idempotency (T2 follow-up, 2026-07-17): this repo runs migrations manually,
-- untracked (no migrations table) — a re-run is a real risk, not a
-- hypothetical. A second UPDATE would double-convert every cap (÷90×100
-- applied twice ≈ ×1.111 on top of the correct value). Guarded below by
-- reading the column's own COMMENT before converting: the COMMENT this
-- migration sets (below) contains the literal string "migration 0061" — on
-- a second run that substring is already present, so the UPDATE is skipped.
-- The COMMENT statement itself is naturally idempotent (re-setting identical
-- text is a no-op), so running this file N times has the same effect as
-- running it once.

DO $$
BEGIN
  IF position('migration 0061' in coalesce(
       (SELECT d.description
          FROM pg_catalog.pg_description d
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = d.objoid AND a.attnum = d.objsubid
         WHERE a.attrelid = 'gateway_api_keys'::regclass
           AND a.attname = 'cost_limit_monthly_rub'),
       '')) = 0 THEN
    UPDATE gateway_api_keys
    SET cost_limit_monthly_rub = ROUND(cost_limit_monthly_rub / 90.0 * 100, 2)
    WHERE cost_limit_monthly_rub IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN gateway_api_keys.cost_limit_monthly_rub IS
  'Monthly spend cap in CREDITS (1 credit = 1 US cent), NOT rubles, despite '
  'the column name. Converted from a genuine RUB value by migration 0061 '
  '(2026-07-17) at a fixed one-time rate (~90 RUB/USD) specifically to '
  'remove cbr.ru from the hot billing path (middleware/key-limits.ts used to '
  'call fetchUsdRubRate() per request to bridge the unit gap — up to ~88s of '
  'added latency on a cold cache + unreachable CBR, no fail-open, no budget). '
  'Rename to cost_limit_monthly_credits is tracked as T6; do not add a new '
  'runtime FX conversion on top of this column — enter new values already in '
  'credits.';
