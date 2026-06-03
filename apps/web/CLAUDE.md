# apps/web — Aggregator (ai-aggregator.ru)

The RU-market models+agents marketplace. **A DIFFERENT PRODUCT from the TMA** — do not
conflate them (`/CLAUDE.md` has the full split). Topology: `/docs/ARCHITECTURE.md`.

## Non-obvious facts
- **Currency is RUBLES (₽) ONLY.** Crypto credits live exclusively in `apps/tg-miniapp`.
  No crypto/TON code belongs here. Entity behind this app = RF (ИП).
- **Prices are computed, never hardcoded.** Marketplace pricing math lives in
  `src/lib/marketplace/pricing-calc.ts`. Don't sprinkle magic price numbers in routes/UI.
- **Auth is NextAuth**, not a custom `getAuthenticatedUser()` (that's a different project's
  convention — ignore the global rule here). Pattern: `const session = await auth()`
  (from `@/auth`) → guard `if (!session?.user?.id)` → use **`session.user.id`** as the
  user id everywhere. Never trust a client-supplied id.
- **SQL: prepared statements only**, parameterized. Atomic money ops use guarded
  `UPDATE … WHERE … RETURNING` — see `/SECURITY.md`.
- Payments go through the `@aiag/tinkoff` and `@aiag/yookassa` workspace packages
  (Tinkoff card pay + YooKassa); webhooks under `src/app/api/webhooks/` and
  `.../subscriptions/webhook/[provider]`.

## Build / run
- `bun run dev` (next dev), `bun run build`, `bun run start`. type-check: `bun run type-check`.
- `prebuild` builds the workspace libs (shared, database, email, tinkoff, yookassa, worker)
  first — run it / `turbo` before a bare `next build` or imports break.
- Deployed via CI rsync; see skill `aiag-deploy`. Verify on prod, no local runtime.
