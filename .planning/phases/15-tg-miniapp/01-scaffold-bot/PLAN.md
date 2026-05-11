# Phase 15 / Wave 01 — TMA scaffold + BotFather + TON Connect provider

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Создать новый Next.js 14 App Router app `apps/tg-miniapp/` (port 3100), настроить BotFather (`@aiag_bot`), подключить TON Connect через client-boundary провайдер.

**Architecture:** Monorepo workspace `apps/tg-miniapp/`. Server-side `layout.tsx` (RSC) импортирует client-side `app/providers.tsx` (`'use client'`), который оборачивает дерево в `TonConnectUIProvider`. Это обязательный паттерн — без `'use client'` boundary Next 14 ломается с `TypeError: createContext is not a function` (см. spike result).

**Tech stack:** Next.js 14 (App Router), React 18, TypeScript, Bun, `@telegram-apps/sdk-react` v3.x, `@tonconnect/ui-react` v2.4.4.

**Prereq:** TON Connect spike PASSED (2026-05-11).

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Create | `apps/tg-miniapp/package.json` | Workspace manifest |
| Create | `apps/tg-miniapp/next.config.mjs` | Next config, `basePath: '/tg'` |
| Create | `apps/tg-miniapp/tsconfig.json` | Extends shared `@aiag/typescript-config` |
| Create | `apps/tg-miniapp/app/layout.tsx` | Root server layout |
| Create | `apps/tg-miniapp/app/providers.tsx` | `'use client'` TON Connect provider |
| Create | `apps/tg-miniapp/app/page.tsx` | Smoke landing with `TonConnectButton` |
| Create | `apps/tg-miniapp/app/globals.css` | Dark+amber tokens from spec §2.4 |
| Create | `apps/tg-miniapp/public/tonconnect-manifest.json` | TON Connect manifest |
| Modify | `package.json` (root) | Add `apps/tg-miniapp` to workspaces if missing |

---

## Task 1: Scaffold workspace

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@aiag/tg-miniapp",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3100",
    "build": "next build",
    "start": "next start -p 3100",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "14.2.15",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "@telegram-apps/sdk-react": "^3.3.9",
    "@tonconnect/ui-react": "2.4.4"
  },
  "devDependencies": {
    "@aiag/typescript-config": "workspace:*",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: next.config.mjs** — `basePath: '/tg'`, `reactStrictMode: true`, transpilePackages for `@tonconnect/ui-react`.
- [ ] **Step 3: tsconfig.json** — `"extends": "@aiag/typescript-config/nextjs.json"`, paths alias `@/*` → `./src/*` and `./app/*`.
- [ ] **Step 4: Install**

```bash
bun install
```

Verification: `bun run --filter @aiag/tg-miniapp typecheck` exits 0.

---

## Task 2: TON Connect manifest

- [ ] **Step 1: Create `public/tonconnect-manifest.json`**

```json
{
  "url": "https://app.ai-aggregator.ru",
  "name": "AIAG",
  "iconUrl": "https://ai-aggregator.ru/icon-512.png",
  "termsOfUseUrl": "https://ai-aggregator.ru/terms",
  "privacyPolicyUrl": "https://ai-aggregator.ru/privacy"
}
```

---

## Task 3: Client provider boundary (MANDATORY pattern)

- [ ] **Step 1: `app/providers.tsx`**

```tsx
'use client';
import { TonConnectUIProvider } from '@tonconnect/ui-react';
import { ReactNode } from 'react';

const MANIFEST_URL =
  process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL ??
  'https://app.ai-aggregator.ru/tg/tonconnect-manifest.json';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <TonConnectUIProvider manifestUrl={MANIFEST_URL}>
      {children}
    </TonConnectUIProvider>
  );
}
```

- [ ] **Step 2: `app/layout.tsx`** (server)

```tsx
import { Providers } from './providers';
import './globals.css';

export const metadata = { title: 'AIAG', description: 'AI Aggregator Mini App' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: `app/page.tsx`** — smoke page

```tsx
'use client';
import { TonConnectButton } from '@tonconnect/ui-react';
export default function Home() {
  return (
    <main style={{ padding: 24, color: '#f4f4f5', background: '#0a0a0b', minHeight: '100vh' }}>
      <h1>AIAG TMA — scaffold OK</h1>
      <TonConnectButton />
    </main>
  );
}
```

- [ ] **Step 4: globals.css** — copy tokens from spec §2.4 (`--bg`, `--accent`, etc.).

Verification:

```bash
bun run --filter @aiag/tg-miniapp build
```

Build должен пройти без `createContext` ошибки.

---

## Task 4: BotFather setup (Human Gate)

- [ ] **Step 1:** В Telegram написать `@BotFather` → `/newbot` → name `AIAG`, username `aiag_bot`.
- [ ] **Step 2:** Сохранить `BOT_TOKEN` в `/srv/aiag/shared/.env` на VPS как `TG_BOT_TOKEN=...`.
- [ ] **Step 3:** `/setdomain` → `app.ai-aggregator.ru`.
- [ ] **Step 4:** `/newapp` (Mini App) → title "AIAG", short name `app`, URL `https://app.ai-aggregator.ru/tg`, photo + GIF placeholder.
- [ ] **Step 5:** `/setmenubutton` → text "Открыть AIAG", url same.
- [ ] **Step 6:** `/setcommands`:

```
start - Открыть AIAG
agents - Мои агенты
balance - Баланс и пополнение
help - Помощь
```

---

## Commit

```bash
git add apps/tg-miniapp/ package.json bun.lock
git commit -m "feat(tma): scaffold Next 14 app + TON Connect client-boundary provider (port 3100)"
```

---

## Done when

- `bun run --filter @aiag/tg-miniapp build` succeeds.
- Локально `bun run --filter @aiag/tg-miniapp dev` отдаёт страницу на `:3100/tg` с TonConnectButton.
- `@aiag_bot` отвечает на `/start` (default greeting от BotFather).
- `tonconnect-manifest.json` доступен публично после deploy (валидация — wave 07).
