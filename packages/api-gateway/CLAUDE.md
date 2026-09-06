# packages/api-gateway — OpenAI-compatible gateway

Hono on **Bun**, `:4000`. This is the Aggregator gateway. Other products consume it as
external organization clients through a versioned HTTP contract. Money/auth rules:
`/SECURITY.md`. Topology: `/docs/ARCHITECTURE.md`.

## Non-obvious facts
- **White-label is a hard rule.** Never leak the upstream brand (OpenRouter / Kie) in
  responses, error labels, logs that surface to users, or model metadata. The aiag path
  routes via this gateway; OpenRouter appears only as a documented degraded fallback.
- **The model registry is the source of truth for valid slugs.** A slug absent from the
  registry → 400 "Unknown model". Routing/markup decisions key off the registered upstream,
  not the caller's string. Client default slugs must be registered.
- Auth: callers authenticate with organization gateway keys (`sk_aiag_live_…`). Agents
  Market owns its client key and reader implementation in `/home/bob/Projects/agents-market`.
- **Markup is per-upstream**: `model_upstreams.markup` (column DEFAULT `1.8` as of migration
  0057; live values raised to `1.8` on all upstreams, floor is `1.20` via `chk_markup_floor`).
  Pricing math lives in `src/lib/pricing.ts` — **MICRO-credits, not ₽** as of T1-fix
  (migrations 0056/0058/0059, 2026-07-16 rework): `model_upstreams.price_per_1k_*` /
  `price_per_image` / `price_per_audio_sec` are already **US CENTS** (`= USD × 100`, see
  `COMMENT ON COLUMN` in 0059) — the per-call cost computed from them (`upstreamCents`) is
  passed straight into `chargeCents = upstreamCents × markup × batchDiscount × caching;
  costCredits = round(chargeCents × 1000)` (1 credit = 1000 micro-credits = 1 US cent — no
  `rate`/FX, no `× 100`, no ceil-to-1 floor in this formula). ⚠️ **`resolver.ts` does NOT read
  `markup` live/uncached** — it caches the resolved model (markup included) in Redis with
  `TTL_SEC = 600` (`src/routing/resolver.ts:10,36,76`). A markup UPDATE (e.g. 0057) takes up
  to **10 minutes** to reach the gateway unless the deploy explicitly flushes the cache
  (`redis-cli DEL model:*` / FLUSH the `cache` Redis db) — this MUST be a step in the deploy
  runbook, not an assumption (Opus review MED-1; the earlier "no caching layer" claim in this
  file was false and is corrected here — 0057's own header still carries the original false
  claim, left as-is per an explicit out-of-scope boundary on that already-applied migration;
  this file is the authoritative correction). Cache-bust does NOT by itself
  update the static web catalog display, see `packages/database/scripts/gen-marketplace-catalog.ts`.
  BYOK bypasses markup (fixed fee in whole MICRO-credits, `calcByokFeeCredits()` =
  `config.BYOK_FEE_CREDITS × 1000`) — see `/SECURITY.md`. Do not hardcode a markup constant.
- **Settlement is `aiag_settle_charge_credits`**, called via `src/billing/settle.ts`. The
  readable source is `packages/database/src/functions/settle-charge.sql`, but the function is
  actually DEPLOYED via `packages/database/migrations/0058_settle_charge_credits_fn.sql` (prod
  migrations are hand-run from `migrations/` only — `src/functions/*.sql` alone never reaches
  prod, see 0058's header / Opus review P0-1). Keep both files in sync by hand on any edit. The
  old `aiag_settle_charge` (₽) is superseded, kept only as a rollback target — do not call it
  from new code.

## Build / run
- `bun run build` (tsup → `dist/`), `bun run start` (`bun dist/server.js`),
  `bun run dev` (tsup watch). type-check: `bun run type-check`.
- Deployed via CI rsync for the web product; see skill `aiag-deploy`. No local runtime.
