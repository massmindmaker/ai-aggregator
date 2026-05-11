# Phase 15 / Wave 02 — initData HMAC verify + JWT в CloudStorage + tg_users

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Реализовать серверную проверку `initData` через HMAC-SHA256 (spec §3.1), upsert в `tg_users`, выдачу JWT, хранение токена в `WebApp.CloudStorage`, и middleware-guard `/api/tma/*`.

**Architecture:** Client получает `initData` из `window.Telegram.WebApp.initData` → POST `/api/tma/auth/verify` → сервер HMAC-проверяет против `TG_BOT_TOKEN`, парсит `user`, upsertit в `tg_users`, подписывает JWT (HS256, 24h TTL) → клиент кладёт JWT в `WebApp.CloudStorage`. Все защищённые endpoints проверяют `Authorization: Bearer <jwt>` через middleware.

**Tech stack:** Node `crypto`, `jsonwebtoken`, Drizzle migrations, `@telegram-apps/sdk-react`.

**Prereq:** Wave 01 (scaffold).

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Create | `packages/database/migrations/0015_tg_users.sql` | tg_users table + users.tg_user_id col |
| Create | `packages/database/src/schema/tg-users.ts` | Drizzle schema |
| Create | `apps/tg-miniapp/src/lib/verify-init-data.ts` | HMAC verify util |
| Create | `apps/tg-miniapp/src/lib/jwt.ts` | sign/verify JWT |
| Create | `apps/tg-miniapp/app/api/tma/auth/verify/route.ts` | POST verify endpoint |
| Create | `apps/tg-miniapp/src/hooks/use-auth.ts` | Client auth hook |
| Create | `apps/tg-miniapp/middleware.ts` | JWT guard for /api/tma/* |
| Modify | `packages/database/src/schema/index.ts` | Export tg_users |

---

## Task 1: Migration & schema

- [ ] **Step 1: `0015_tg_users.sql`**

```sql
CREATE TABLE IF NOT EXISTS tg_users (
  tg_user_id BIGINT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  first_name VARCHAR(64),
  last_name VARCHAR(64),
  username VARCHAR(64),
  language_code VARCHAR(8),
  is_premium BOOLEAN DEFAULT false,
  photo_url TEXT,
  auth_date TIMESTAMPTZ,
  jwt_kid VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tg_users_user_id ON tg_users(user_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_user_id BIGINT UNIQUE;
```

- [ ] **Step 2:** Drizzle schema mirror в `packages/database/src/schema/tg-users.ts`, export из `index.ts`.

Verification: `bun run --filter @aiag/database build` clean.

---

## Task 2: HMAC verify utility

- [ ] **Step 1: `src/lib/verify-init-data.ts`**

```ts
import { createHmac } from 'node:crypto';

export interface TgUser {
  id: number; first_name: string; last_name?: string;
  username?: string; language_code?: string; is_premium?: boolean; photo_url?: string;
}
export interface VerifiedInit { user: TgUser; auth_date: number; query_id?: string; }

export function verifyInitData(initData: string, botToken: string): VerifiedInit | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dcs).digest('hex');
  if (expected !== hash) return null;
  const auth_date = Number(params.get('auth_date') ?? 0);
  if (Date.now()/1000 - auth_date > 86400) return null; // 24h TTL
  const userRaw = params.get('user'); if (!userRaw) return null;
  return { user: JSON.parse(userRaw), auth_date, query_id: params.get('query_id') ?? undefined };
}
```

- [ ] **Step 2:** Unit test с фикстурой valid/expired/tampered initData (`bun test`).

---

## Task 3: JWT helper

- [ ] **Step 1: `src/lib/jwt.ts`** — `signSession({uid, tg})` → 24h HS256, `verifySession(token)` → payload | null. Secret из `TMA_JWT_SECRET` env (generate `openssl rand -hex 32`).

---

## Task 4: Verify endpoint

- [ ] **Step 1: `app/api/tma/auth/verify/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyInitData } from '@/lib/verify-init-data';
import { signSession } from '@/lib/jwt';
import { db, tgUsers, users } from '@aiag/database';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export async function POST(req: NextRequest) {
  const { initData } = await req.json();
  const verified = verifyInitData(initData ?? '', process.env.TG_BOT_TOKEN!);
  if (!verified) return NextResponse.json({ error: 'invalid_init_data' }, { status: 401 });

  const tg = verified.user;
  // Upsert tg_users
  await db.insert(tgUsers).values({
    tgUserId: BigInt(tg.id), firstName: tg.first_name, lastName: tg.last_name,
    username: tg.username, languageCode: tg.language_code, isPremium: tg.is_premium ?? false,
    photoUrl: tg.photo_url, authDate: new Date(verified.auth_date * 1000),
  }).onConflictDoUpdate({
    target: tgUsers.tgUserId,
    set: { firstName: tg.first_name, username: tg.username, lastSeenAt: new Date() },
  });

  // Resolve linked user (auto-create if first-touch)
  const [existing] = await db.select().from(tgUsers).where(eq(tgUsers.tgUserId, BigInt(tg.id)));
  let uid = existing?.userId;
  if (!uid) {
    const [u] = await db.insert(users).values({ tgUserId: BigInt(tg.id) }).returning();
    uid = u.id;
    await db.update(tgUsers).set({ userId: uid }).where(eq(tgUsers.tgUserId, BigInt(tg.id)));
  }

  const jwt = signSession({ uid, tg: tg.id });
  return NextResponse.json({ jwt, userId: uid });
}
```

Verification:

```bash
curl -X POST http://localhost:3100/tg/api/tma/auth/verify \
  -H 'Content-Type: application/json' \
  -d '{"initData":"<paste-valid-fixture>"}'
```

Expected: `{jwt: "...", userId: "..."}`.

---

## Task 5: Client useAuth hook

- [ ] **Step 1: `src/hooks/use-auth.ts`**

```ts
'use client';
import { useEffect, useState } from 'react';
import { useRawInitData, useCloudStorage } from '@telegram-apps/sdk-react';

export function useAuth() {
  const initData = useRawInitData();
  const cs = useCloudStorage();
  const [jwt, setJwt] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const cached = await cs.get('aiag_jwt').catch(() => null);
      if (cached) { setJwt(cached); return; }
      if (!initData) return;
      const r = await fetch('/tg/api/tma/auth/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      if (!r.ok) return;
      const { jwt: newJwt } = await r.json();
      await cs.set('aiag_jwt', newJwt);
      setJwt(newJwt);
    })();
  }, [initData]);
  return jwt;
}
```

---

## Task 6: Middleware guard

- [ ] **Step 1: `apps/tg-miniapp/middleware.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/jwt';

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (!path.startsWith('/tg/api/tma/') || path.endsWith('/auth/verify')) return NextResponse.next();
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifySession(token)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.next();
}
export const config = { matcher: '/tg/api/tma/:path*' };
```

---

## Commit

```bash
git add packages/database apps/tg-miniapp
git commit -m "feat(tma): HMAC initData verify + JWT session in CloudStorage + tg_users migration"
```

## Done when

- Unit test verifyInitData: valid/expired/tampered → pass/null/null.
- E2E (mock initData) → /verify returns JWT, повторный заход через CloudStorage → no re-verify.
- Middleware blocks unauthenticated /api/tma/*.
