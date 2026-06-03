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
- **Markup is per-upstream**: `model_upstreams.markup` (default `1.25`). Pricing math lives
  in `src/lib/pricing.ts` (`cost = upstreamUsd × rate × markup × batchDiscount × caching`);
  resolution in `src/routing/resolver.ts`. BYOK bypasses markup (fixed fee) — see
  `/SECURITY.md`. Do not hardcode a markup constant.

## Build / run
- `bun run build` (tsup → `dist/`), `bun run start` (`bun dist/server.js`),
  `bun run dev` (tsup watch). type-check: `bun run type-check`.
- Deployed via CI rsync for the web product; see skill `aiag-deploy`. No local runtime.
