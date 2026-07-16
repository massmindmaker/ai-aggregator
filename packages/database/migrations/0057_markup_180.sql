-- 0057_markup_180.sql
-- T2: raise markup to 1.8 on every upstream (founder decision 2026-07-15,
-- pricing sheet in docs/specs/2026-07-16-finmodel-build-spec.md §4). The
-- entire Free/Lite/Basic/Starter/Pro credit-allotment table in that spec is
-- costed assuming markup=1.8 — at the current prod value (1.20 on 75 rows /
-- 1.25 on 1 row) Basic-tier margin falls from 43.2% to ~14.8%. This migration
-- is a hard prerequisite for that pricing sheet (T3), not optional polish.
--
-- Ground truth (prod SELECT, 2026-07-16): model_upstreams.markup = 1.2000 ×
-- 75 rows, 1.2500 × 1 row. chk_markup_floor (0047_markup_floor_120.sql)
-- requires markup >= 1.20 — 1.8 clears that floor with room to spare, no
-- conflict.
--
-- ⚠️ Scope note (verification the T2 task asked for): this migration updates
-- the DB value that packages/api-gateway/src/routing/resolver.ts reads live,
-- per-request, with no caching layer — the GATEWAY (actual billing) picks up
-- 1.8 the instant this migration commits. It does NOT, by itself, change the
-- prices shown in the web marketplace catalog: apps/web/src/lib/marketplace/
-- catalog.generated.ts is a STATIC file built by
-- packages/database/scripts/gen-marketplace-catalog.ts from a DB dump (see
-- packages/database/CLAUDE.md "bun run gen:catalog regenerates the static
-- marketplace catalog from a prod dump") and apps/web/src/lib/marketplace/
-- pricing-calc.ts explicitly re-displays that static snapshot without
-- re-applying markup. Whoever deploys this migration must also re-run
-- `gen:catalog` against prod and redeploy `apps/web`, or the catalog will
-- keep showing pre-1.8 prices while the gateway bills at 1.8 (a display lie,
-- not a billing bug — but still needs closing before T3/T5 ship).
--
-- Deliberately does NOT rewrite migration 0004_gateway_core.sql's column
-- DEFAULT 1.25 in place (0047's convention: already-applied migrations stay
-- as history; raise on top, additively) — the DEFAULT is bumped forward-only
-- below so freshly-inserted upstreams don't regress to 1.25.
--
-- Idempotency: UPDATE ... WHERE markup IS DISTINCT FROM 1.8 — a second run
-- touches 0 rows. ALTER COLUMN SET DEFAULT is naturally idempotent.

UPDATE model_upstreams
SET markup = 1.8
WHERE markup IS DISTINCT FROM 1.8;

ALTER TABLE model_upstreams ALTER COLUMN markup SET DEFAULT 1.8;
