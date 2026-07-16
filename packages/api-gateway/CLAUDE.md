# packages/api-gateway — OpenAI-compatible gateway

Hono on **Bun**, `:4000`. Shared by both products (web aggregator + TMA worker) as the
model provider. Money/auth rules: `/SECURITY.md`. Topology: `/docs/ARCHITECTURE.md`.

## Non-obvious facts
- **White-label is a hard rule.** Never leak the upstream brand (OpenRouter / Kie) in
  responses, error labels, logs that surface to users, or model metadata. The aiag path
  routes via this gateway; OpenRouter appears only as a documented degraded fallback.
- **The model registry is the source of truth for valid slugs.** A slug absent from the
  registry → 400 "Unknown model". Routing/markup decisions key off the registered upstream,
  not the caller's string. (This is why agent-worker's `DEFAULT_MODEL` must be registered.)
- Auth: callers authenticate with **`AIAG_GATEWAY_KEY`** (`sk_aiag_live_…`). agent-worker →
  gateway uses this key.
- **Markup is per-upstream**: `model_upstreams.markup` (column DEFAULT `1.8` as of migration
  0057; live values raised to `1.8` on all upstreams, floor is `1.20` via `chk_markup_floor`).
  Pricing math lives in `src/lib/pricing.ts` — **credits, not ₽** as of T1 (migration 0056):
  `chargeUsd = upstreamUsd × markup × batchDiscount × caching; costCredits = max(1, ceil(chargeUsd × 100))`
  (1 credit = 1 US cent — no `rate`/FX in this formula anymore). Resolution in
  `src/routing/resolver.ts` (reads `markup` live per-request, no caching layer — a markup
  UPDATE takes effect on the next request, but does NOT by itself update the static web
  catalog display, see `packages/database/scripts/gen-marketplace-catalog.ts`). BYOK bypasses
  markup (fixed fee in whole credits, `config.BYOK_FEE_CREDITS`) — see `/SECURITY.md`. Do not
  hardcode a markup constant.
- **Settlement is `aiag_settle_charge_credits`** (`packages/database/src/functions/settle-charge.sql`),
  called via `src/billing/settle.ts`. The old `aiag_settle_charge` (₽) is superseded, kept only
  as a rollback target — do not call it from new code.

## Build / run
- `bun run build` (tsup → `dist/`), `bun run start` (`bun dist/server.js`),
  `bun run dev` (tsup watch). type-check: `bun run type-check`.
- Deployed via CI rsync for the web product; see skill `aiag-deploy`. No local runtime.
