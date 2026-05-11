# @aiag/tg-miniapp

Telegram Mini App for AIAG — Next.js 14 App Router on port `3100`, served under `basePath: /tg`.

Phase 15 / Wave 01 scaffold:

- Next 14.2.15 + React 18.3.1
- `@tonconnect/ui-react@2.4.4` inside a `'use client'` boundary (`app/providers.tsx`)
- `@telegram-apps/sdk-react@^3.3.9` (installed; wired in later waves)
- AIAG dark + amber palette (mirrors `apps/web` tokens)

## Local

```bash
bun install
bun run --filter @aiag/tg-miniapp dev
# → http://localhost:3100/tg
```

## Build smoke test

```bash
bun run --filter @aiag/tg-miniapp build
```

Must pass with no `createContext is not a function` error (that error appears the moment
`TonConnectUIProvider` leaks into a server component — see `app/providers.tsx`).

## TON Connect manifest

Served from `public/tonconnect-manifest.json` → public URL after deploy:
`https://app.ai-aggregator.ru/tg/tonconnect-manifest.json`.

Override per-environment via `NEXT_PUBLIC_TONCONNECT_MANIFEST_URL`.

## BotFather setup (Human Gate, do this once after Wave 07 deploy)

Performed manually by the owner via `@BotFather` in Telegram. **Not automated.**

1. `/newbot` → name `AIAG`, username `aiag_bot` → receive `BOT_TOKEN`.
2. Save token on VPS: append `TG_BOT_TOKEN=...` to `/srv/aiag/shared/.env`.
3. `/setdomain` → `app.ai-aggregator.ru`.
4. `/newapp` (Mini App):
   - Bot: `@aiag_bot`
   - Title: `AIAG`
   - Short name: `app`
   - Description: `AI агрегатор — все модели, один баланс.`
   - Web App URL: `https://app.ai-aggregator.ru/tg`
   - Photo: 640×360 PNG (placeholder OK for Wave 01)
   - GIF: optional (skip for Wave 01)
5. `/setmenubutton` → text `Открыть AIAG`, URL same as Web App URL.
6. `/setcommands`:

   ```
   start - Открыть AIAG
   agents - Мои агенты
   balance - Баланс и пополнение
   help - Помощь
   ```

7. Webhook (configured in Wave 04/07 — placeholder):
   `https://app.ai-aggregator.ru/tg/api/telegram/webhook`

## Layout

- `app/layout.tsx` — server (RSC) root layout, imports `<Providers>` and `globals.css`.
- `app/providers.tsx` — **`'use client'`** boundary; mounts `TonConnectUIProvider`.
- `app/page.tsx` — client landing with `<TonConnectButton />` smoke test.
- `public/tonconnect-manifest.json` — TON Connect dApp manifest.

## Wave 02 — HMAC verify + JWT auth

Adds Telegram WebApp `initData` HMAC-SHA256 verification → issues 24h JWT, persists user in `tg_users`, JWT auth middleware on `/api/tma/*`.

Files:
- `src/lib/verify-init-data.ts` — pure HMAC verifier (Telegram WebApp algorithm).
- `app/api/tma/auth/verify/route.ts` — POST { initData } → { token, user }.
- `src/hooks/useAuth.ts` — client hook; checks `Telegram.WebApp.CloudStorage` cache, falls back to `/tg/api/tma/auth/verify`.
- `middleware.ts` — protects `/api/tma/*` (except `/api/tma/auth/*`), injects `x-tma-user-id` header.
- `packages/database/migrations/0016_tg_users.sql` — `tg_users` table linked to `users.id`.

### Required env vars (add manually to `/srv/aiag/shared/.env` on VPS)

```
TELEGRAM_BOT_TOKEN=<from BotFather>
TMA_JWT_SECRET=<openssl rand -hex 32>
DATABASE_URL=<existing>
```

## Constraints

- Do not import `@tonconnect/ui-react` from any server component.
- Do not deploy from this wave — Wave 07 owns pm2/nginx wiring.
