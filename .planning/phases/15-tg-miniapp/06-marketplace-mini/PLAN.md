# Phase 15 / Wave 06 — Marketplace mini (compact model browser, reuse @aiag/database)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Упрощённый browser моделей в TMA (вкладка «Маркет»): grid карточек, detail page, CTA «Использовать в агенте X» → pre-fill при редактировании агента. Никаких конкурсов / supply / отзывов — только browse+select.

**Architecture:** Reuse существующего каталога моделей через `packages/database` (`models` таблица из marketplace) и/или `@/lib/marketplace/catalog` из `apps/web`. Отдельный endpoint `/tg/api/tma/models` (read-only). Detail page переиспользует данные. CTA сохраняет `selectedModelSlug` в localStorage → при возврате на `agents/[id]/edit` форма pre-filled.

**Tech stack:** Drizzle (read), Next 14 App Router, server components где возможно.

**Prereq:** Waves 01, 02, 03.

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Create | `apps/tg-miniapp/src/lib/models-catalog.ts` | Read query из shared schema |
| Create | `apps/tg-miniapp/app/api/tma/models/route.ts` | GET list + filter |
| Create | `apps/tg-miniapp/app/api/tma/models/[slug]/route.ts` | GET detail |
| Replace | `apps/tg-miniapp/app/(app)/market/page.tsx` | Replace placeholder w/ grid |
| Create | `apps/tg-miniapp/app/(app)/market/[slug]/page.tsx` | Detail page |
| Create | `apps/tg-miniapp/src/components/model-card.tsx` | Compact card |
| Modify | `apps/tg-miniapp/app/(app)/agents/[id]/edit/page.tsx` | Read selectedModelSlug from localStorage |

---

## Task 1: Models catalog read

- [ ] **Step 1: `src/lib/models-catalog.ts`** — функции `listModels({ category?, q? })`, `getModel(slug)` поверх `packages/database` schema (или импорт из `apps/web/src/lib/marketplace/catalog` если данные хардкод).

```ts
import { db, models } from '@aiag/database';
import { eq, ilike, and } from 'drizzle-orm';

export async function listModels(opts: { category?: string; q?: string }) {
  const where: any[] = [eq(models.status, 'active')];
  if (opts.category) where.push(eq(models.category, opts.category));
  if (opts.q) where.push(ilike(models.name, `%${opts.q}%`));
  return db.select({
    slug: models.slug, name: models.name, category: models.category,
    iconUrl: models.iconUrl, pricePer1k: models.pricePer1k,
  }).from(models).where(and(...where)).limit(50);
}
```

---

## Task 2: API endpoints

- [ ] **Step 1: `GET /api/tma/models?category=&q=`** → `listModels()`.
- [ ] **Step 2: `GET /api/tma/models/[slug]`** → `getModel(slug)` + `pricing.estimate` под typical request size.

Verification:

```bash
curl -H "Authorization: Bearer $JWT" http://localhost:3100/tg/api/tma/models?category=image
```

---

## Task 3: Market UI

- [ ] **Step 1: `components/model-card.tsx`**

```tsx
export function ModelCard({ m }: { m: { slug:string; name:string; iconUrl?:string; pricePer1k:string } }) {
  return (
    <a href={`/tg/market/${m.slug}`} style={{
      display:'flex', flexDirection:'column', gap:8, padding:12,
      background:'#111114', border:'1px solid rgba(255,255,255,0.08)', borderRadius:12,
      color:'#f4f4f5', textDecoration:'none',
    }}>
      {m.iconUrl && <img src={m.iconUrl} alt="" style={{width:'100%', aspectRatio:'1/1', borderRadius:8}}/>}
      <div style={{fontWeight:600, fontSize:14}}>{m.name}</div>
      <div style={{color:'#f59e0b', fontSize:12}}>{m.pricePer1k}₽/1k</div>
    </a>
  );
}
```

- [ ] **Step 2: `app/(app)/market/page.tsx`** — RSC, fetch `listModels()`, render search + category tabs (image/video/audio/text) + 2-col grid из `ModelCard`. Tap card → `/tg/market/[slug]`.
- [ ] **Step 3: `app/(app)/market/[slug]/page.tsx`** — hero (icon + name + price + description), CTA bottom-sticky «Использовать в моём агенте» → opens модалку выбора агента (список user agents). При выборе сохраняем `localStorage.setItem('aiag_selected_model', slug); localStorage.setItem('aiag_selected_for_agent', agentId)` → `router.push(\`/agents/${agentId}/edit\`)`.

---

## Task 4: Wire to agent editor

- [ ] **Step 1:** В `agents/[id]/edit/page.tsx` (создаётся в wave 03 как часть detail или extension):

```ts
useEffect(() => {
  const slug = localStorage.getItem('aiag_selected_model');
  const forId = localStorage.getItem('aiag_selected_for_agent');
  if (slug && forId === agentId) {
    setAllowedModels(prev => prev.includes(slug) ? prev : [...prev, slug]);
    localStorage.removeItem('aiag_selected_model');
    localStorage.removeItem('aiag_selected_for_agent');
  }
}, [agentId]);
```

---

## Commit

```bash
git add apps/tg-miniapp
git commit -m "feat(tma): marketplace mini — compact grid + detail + use-in-agent flow"
```

## Done when

- `/tg/market` показывает grid моделей (≥10 карточек если БД заполнена).
- Search + category filter работают.
- Detail → выбор агента → возврат на edit → модель добавилась в allowedModels.
- Никаких конкурсов / отзывов / supply не показывается (verified via UI screenshot).
