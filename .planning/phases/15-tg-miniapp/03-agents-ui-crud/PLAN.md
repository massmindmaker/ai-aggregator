# Phase 15 / Wave 03 — 3-tab nav + agents list/new/[id] + 6 templates

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Реализовать UI каркас Mini App: bottom nav (Агенты/Маркет/Профиль), CRUD API для `agents`, 6 prebuilt-шаблонов (см. spec §5.3), форму создания агента и chat-style detail page.

**Architecture:** Drizzle migration `0016_agents.sql` (spec §7). API routes под `/tg/api/tma/agents` используют JWT из middleware. Клиент — RSC list + client-side форма. Bottom nav — fixed-bottom компонент с safe-area-insets.

**Tech stack:** Drizzle, Next 14 App Router, Tailwind (или CSS modules с tokens из wave 01), Zod для валидации.

**Prereq:** Waves 01, 02.

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Create | `packages/database/migrations/0016_agents.sql` | agents + agent_runs tables |
| Create | `packages/database/src/schema/agents.ts` | Drizzle schema |
| Create | `apps/tg-miniapp/src/lib/agent-templates.ts` | 6 prebuilt templates |
| Create | `apps/tg-miniapp/src/lib/api-client.ts` | Authed fetch helper |
| Create | `apps/tg-miniapp/app/api/tma/agents/route.ts` | GET list / POST create |
| Create | `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts` | GET / PATCH / DELETE |
| Create | `apps/tg-miniapp/app/(app)/layout.tsx` | App shell с bottom nav |
| Create | `apps/tg-miniapp/src/components/bottom-nav.tsx` | 3-tab fixed nav |
| Create | `apps/tg-miniapp/app/(app)/agents/page.tsx` | List of agents |
| Create | `apps/tg-miniapp/app/(app)/agents/new/page.tsx` | Template picker + form |
| Create | `apps/tg-miniapp/app/(app)/agents/[id]/page.tsx` | Chat-style detail |
| Create | `apps/tg-miniapp/app/(app)/market/page.tsx` | Placeholder (wave 06) |
| Create | `apps/tg-miniapp/app/(app)/profile/page.tsx` | Placeholder profile |

---

## Task 1: Migration

- [ ] **Step 1: `0016_agents.sql`** — копировать DDL из spec §7 (agents + agent_runs + indexes). Idempotent через `IF NOT EXISTS`.
- [ ] **Step 2:** Drizzle schema `packages/database/src/schema/agents.ts` (export `agents`, `agentRuns`).

Verification:

```bash
psql "$DATABASE_URL" -f packages/database/migrations/0016_agents.sql
psql "$DATABASE_URL" -c '\d agents' | head -20
```

---

## Task 2: Six prebuilt templates

- [ ] **Step 1: `src/lib/agent-templates.ts`**

```ts
export interface Template {
  slug: 'artist'|'director'|'composer'|'writer'|'analyst'|'custom';
  emoji: string; title: string; description: string;
  systemPrompt: string;
  allowedTools: string[]; allowedModels: string[];
}
export const TEMPLATES: Template[] = [
  { slug:'artist', emoji:'🎨', title:'Художник', description:'Генерация изображений',
    systemPrompt:'Ты — художник. Подбираешь модель и стиль под запрос.',
    allowedTools:['image_gen'], allowedModels:['flux-pro','midjourney-v7','recraft-v3'] },
  { slug:'director', emoji:'🎬', title:'Режиссёр', description:'Видео и кадры',
    systemPrompt:'Ты — режиссёр. Сначала reference-кадр, потом видео.',
    allowedTools:['video_gen','image_gen'], allowedModels:['kling-3.0','sora-2','veo-3'] },
  { slug:'composer', emoji:'🎵', title:'Композитор', description:'Музыка и звук',
    systemPrompt:'Ты — композитор. Создаёшь треки по описанию настроения.',
    allowedTools:['audio_gen'], allowedModels:['suno-v4'] },
  { slug:'writer', emoji:'✍️', title:'Писатель', description:'Тексты, статьи, посты',
    systemPrompt:'Ты — писатель. Уточняешь tone of voice и формат.',
    allowedTools:['web_search','memory'], allowedModels:['nousresearch/hermes-4-405b'] },
  { slug:'analyst', emoji:'🔍', title:'Аналитик', description:'Ресёрч и таблицы',
    systemPrompt:'Ты — аналитик. Ищешь данные, делаешь сводные таблицы.',
    allowedTools:['web_search','code_interpreter'], allowedModels:['nousresearch/hermes-4-405b','openai/gpt-4o'] },
  { slug:'custom', emoji:'🤖', title:'Свой', description:'Полная кастомизация',
    systemPrompt:'', allowedTools:[], allowedModels:[] },
];
```

---

## Task 3: CRUD API

- [ ] **Step 1: `app/api/tma/agents/route.ts`** — `GET` returns `agents WHERE owner_user_id = uid AND status != 'deleted'`, `POST` body `{ templateKind, name, systemPrompt, allowedTools, allowedModels, dailyBudgetRub }` → insert (Zod-валидация).
- [ ] **Step 2: `app/api/tma/agents/[id]/route.ts`** — `GET` (404 if not owner), `PATCH` (partial update), `DELETE` (soft → status='deleted').
- [ ] **Step 3:** Helper `getUidFromAuth(req)` берёт JWT, возвращает `uid`. Все endpoints используют его.

Verification:

```bash
JWT=$(curl ... /api/tma/auth/verify | jq -r .jwt)
curl -H "Authorization: Bearer $JWT" http://localhost:3100/tg/api/tma/agents
curl -X POST -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"templateKind":"artist","name":"Мой художник","systemPrompt":"...","allowedTools":["image_gen"]}' \
  http://localhost:3100/tg/api/tma/agents
```

---

## Task 4: App shell + bottom nav

- [ ] **Step 1: `src/components/bottom-nav.tsx`**

```tsx
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/agents', label: 'Агенты', icon: '🤖' },
  { href: '/market', label: 'Маркет', icon: '🛍' },
  { href: '/profile', label: 'Профиль', icon: '👤' },
];
export function BottomNav() {
  const p = usePathname();
  return (
    <nav style={{
      position:'fixed', bottom:0, left:0, right:0, background:'#111114',
      borderTop:'1px solid rgba(255,255,255,0.08)',
      paddingBottom:'env(safe-area-inset-bottom)',
      display:'grid', gridTemplateColumns:'1fr 1fr 1fr',
    }}>
      {TABS.map(t => {
        const active = p.startsWith(t.href);
        return <Link key={t.href} href={t.href}
          style={{ padding:'10px 0', textAlign:'center',
                   color: active ? '#f59e0b' : '#a1a1aa', textDecoration:'none' }}>
          <div>{t.icon}</div><div style={{fontSize:11}}>{t.label}</div>
        </Link>;
      })}
    </nav>
  );
}
```

- [ ] **Step 2: `app/(app)/layout.tsx`** — wraps children + `<BottomNav />`, padding-bottom 64px.

---

## Task 5: Agents list / new / detail screens

- [ ] **Step 1:** `agents/page.tsx` — список карточек (name + template emoji + last_run_at), CTA «+ Создать агента» → `/agents/new`.
- [ ] **Step 2:** `agents/new/page.tsx` — grid 6 шаблонов, клик → форма (name, systemPrompt prefilled, tools-чекбоксы, dailyBudget input) → POST → redirect на `/agents/[id]`.
- [ ] **Step 3:** `agents/[id]/page.tsx` — header (name + edit), список последних 20 `agent_runs.steps` рендерится как чат-пузыри, нижний sticky input «Сообщение агенту…» (wave 04 заводит run).

---

## Commit

```bash
git add apps/tg-miniapp packages/database
git commit -m "feat(tma): 3-tab nav + agents CRUD + 6 prebuilt templates UI"
```

## Done when

- Можно создать агента из шаблона «Художник», увидеть его в списке, открыть detail.
- Bottom nav переключается между табами, активный — amber.
- DELETE soft-удаляет (status='deleted').
