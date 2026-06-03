# apps/tg-miniapp — TMA (Telegram Mini App)

Telegram agents marketplace. Product reality + the two-products split: `/CLAUDE.md`.
Auth/security rules (JWT pin, nginx strip): `/SECURITY.md`. Topology: `/docs/ARCHITECTURE.md`.

## Non-obvious facts
- **Next is pinned to `14.2.33` — NEVER bump/downgrade.** That exact patch is the
  CVE-2025-29927 (`x-middleware-subrequest`) fix. A lockfile drift here is a live
  security regression, not a chore. (bun.lock must agree — see commit history.)
- Serves under **basePath `/tg`** on **port `:3100`**; health probe is `/tg/health`
  (NOT `/health`). All in-app links/assets must respect the basePath.
- Auth = HS256-pinned JWT verified against `TMA_JWT_SECRET` (`middleware.ts`); fail-hard
  if secret unset/<32 chars. nginx strips spoofable headers — see `/SECURITY.md`.

## Currency — read before touching anything money-shaped
- TMA currency is **crypto credits (USDT/TON), NOT rubles.** ₽ lives only in `apps/web`.
- ⚠️ Code today still debits a **RUB** balance (`tg_user_balances`); the ₽→crypto-credit
  unit migration is **pending**. Do not assume the column already means credits; do not
  draw ₽ in any TMA UI. New money code should target the credit unit, not entrench ₽.

## Build / run
- `bun run dev` (next dev `-p 3100`), `bun run build`, `bun run start` (`-p 3100`).
- type-check: `bun run typecheck`. lint: `bun run lint`.
- **Built MANUALLY on the VPS** — the CI pipeline does not build tg-miniapp (root-owned
  dirs, no build step). Verify on prod; do NOT spin up a local runtime. Deploy = skill
  `aiag-deploy`. Build turbo libs first (gateway/db/shared) before this app.
