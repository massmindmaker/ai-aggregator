# Разделение AI-агрегатор (web) ↔ Agents Market (TMA) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать Agents Market (TMA) **клиентом** AI-агрегатора, а не сиамским близнецом: своя организация, свой ключ, свой кошелёк, свой каталог через публичный API, своя БД.

**Architecture:** Канон это уже описывает («отдельное иностранное юрлицо покупает модели У AIAG-агрегатора как клиент RF-провайдера»), но реализовано не было. Сегодня продукты делят одну оргу `00000000-…-0001`, один кошелёк, одну Postgres. Хорошая новость (разведка 2026-07-17): в **коде** они уже почти разделены — `tg-miniapp`/`agent-worker` не имеют **ни одной** зависимости `@aiag/*`, не пишут **ни в одну** таблицу web/гейтвея. Связывают только данные: 5 межконтурных FK (2 живых жёстких), `models`/`model_upstreams` на чтение, одна БД, один ключ. Разводим по этапам: клиент → разрыв FK → каталог через API → физический сплит БД.

**Tech Stack:** Postgres 16 (self-hosted), postgres-js (сырой, без ORM в TMA), Hono/Bun gateway `:4000`, Next 14 (`apps/tg-miniapp`), BullMQ (`apps/agent-worker`).

## Global Constraints

- **Решения основателя 2026-07-17:** трансфертная цена = **те же 1.2×, как всем** (per-org markup НЕ строим, кода ноль). Разделение БД — **делаем сейчас** (необратимо; окно: 0 ранов, 0 наймов, 0 балансов, 2 агента). Кошелёк TMA фондируется **нулём** — раны TMA будут честно отдавать 402 до ручного пополнения.
- 🔴 **Риск №1:** если `AIAG_GATEWAY_KEY` не задан/неверен — `apps/agent-worker/src/agent-runner.ts:200-203` **молча** уходит на прямой OpenRouter: утечка маржи + слом white-label **без единой ошибки в логах**. Любая правка ключа проверяется эффектом.
- Миграции на прод — **только вручную**: `sudo -u postgres psql aiag -f <файл>` (app-user `aiag` не может ALTER). Таблицы учёта применённых миграций **НЕТ** → каждая миграция идемпотентна, эффект проверяется SELECT-ом. **Никогда** `drizzle-kit push/migrate` на прод (`src/schema` неполна → дропнет TMA-контур).
- 🔴 **`pg_dump` перед КАЖДЫМ необратимым шагом.** Бэкапы сейчас на том же диске, что БД (S3 = TODO) → делать дамп **вне VPS** перед сплитом.
- Ценовая колонка `price_per_1k_*` = **ЦЕНТЫ** (`USD × 100`), не рубли и не USD. Кредит = 1 цент. Никогда не умножать на курс.
- SQL — prepared statements. Деньги — атомарно (`UPDATE … WHERE <guard> RETURNING`).
- White-label: имя апстрима никогда не доходит до юзера.
- Проверять **эффектом**, не фактом: зелёный деплой ≠ живой код (ловили трижды). `pm2` uptime + `readlink current` + curl-факт.
- Не ломать: BYOK = нулевое списание; изоляция памяти найма `(agent_id, hirer_tg_user_id)`.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `packages/database/migrations/00NN_tma_own_org.sql` | **создать** — синтетический владелец + орга TMA + кошелёк 0 + ключ |
| `/srv/aiag/shared/.env` (VPS) | **править** — `AIAG_GATEWAY_KEY` → новый ключ TMA |
| `apps/tg-miniapp/src/lib/catalog.ts` | **создать** — каталог моделей через публичный `/v1/models`, не через SQL |
| `apps/tg-miniapp/app/market/[slug]/page.tsx`, `app/api/tma/agents/[id]/route.ts` | **править** — снять `JOIN model_upstreams` (утечка себестоимости RF) |
| `packages/database/migrations/00NN_break_cross_contour_fks.sql` | **создать** — разорвать 2 жёстких FK + 1 nullable |
| `packages/database/migrations/00NN_tma_providers_local.sql` | **создать** — локальный справочник провайдеров для TMA |
| `docs/canon/AIAG-CANON.md`, `docs/ARCHITECTURE.md` | **править** — зафиксировать сплит |

---

### Task 1: TMA получает свою оргу, ключ и кошелёк

**Files:**
- Create: `packages/database/migrations/00NN_tma_own_org.sql` (номер — следующий свободный; на момент написания в репе до `0055`, плюс невлитые `0056`-`0059` в `task/t1-t2-credit-ledger` → уточни `ls` перед именованием)
- Test: проверка эффектом на проде (SELECT), кода нет

**Interfaces:**
- Produces: новая орга TMA (`slug='agents-market'`), её `gateway_api_keys`-строка (префикс запомнить), кошелёк `payg_credits=0`, `subscription_credits=0`.
- Consumes: существующий механизм `auth-plan04.ts` (ключ → `orgId`), `aiag_settle_charge` (списание с орги).

**Почему так:** сейчас три ключа (`playground-system-key`, `aiag-house-agent-worker` = боевой путь TMA, `e2e-test`) живут в **одной** орге `00000000-…-0001` с общим кошельком (`737.74` + `1000.00`). Плейграунд и TMA пьют из него же и конкурируют за `FOR UPDATE` на строке орги. У ключа TMA **капа нет вообще**. Нового кода не нужно — все механизмы есть.

- [ ] **Step 1: Снять факт с прода (SELECT, один SSH-батч)**

```sql
SELECT id, slug, owner_id, subscription_credits, payg_credits
FROM organizations WHERE id='00000000-0000-0000-0000-000000000001';

SELECT name, key_prefix, org_id, rpm_limit, daily_usd_cap, cost_limit_monthly_rub,
       revoked_at, disabled_at, last_used_at
FROM gateway_api_keys WHERE org_id='00000000-0000-0000-0000-000000000001';

-- прецедент синтетического владельца:
SELECT id, email FROM users WHERE email='gateway-test@aiag.local';

-- структура, чтобы миграция не гадала:
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_name IN ('organizations','gateway_api_keys')
ORDER BY table_name, ordinal_position;
```
Ожидаемо: `owner_id` у орги — NOT NULL с FK на `users`; прецедент синтетического юзера `gateway-test@aiag.local` живой. Если картина иная — **СТОП**, сообщи координатору: план опирался на это.

- [ ] **Step 2: Написать миграцию**

Содержание (точные имена колонок — из Step 1, не выдумывай):
1. Синтетический владелец: `INSERT INTO users (email, ...) VALUES ('agents-market@aiag.local', ...) ON CONFLICT (email) DO NOTHING`.
2. Орга: `INSERT INTO organizations (id, slug, owner_id, subscription_credits, payg_credits, ...)` — фиксированный UUID (напр. `00000000-0000-0000-0000-000000000002`), `slug='agents-market'`, **оба бакета = 0** (решение основателя: фондируем позже).
3. Ключ: `INSERT INTO gateway_api_keys (...)` для этой орги. 🔴 Хеш ключа — по тому же алгоритму, что существующие (прочитай, как хешируется в `auth-plan04.ts` / как выпускает `api/dashboard/keys/route.ts`; **не изобретай**). Сам ключ **не коммить** — сгенерировать при применении и отдать координатору для env.
4. 🔴 Кап: задать `daily_usd_cap` и `cost_limit_monthly_rub` осмысленными (у ключа TMA сейчас капа нет вообще). Значение согласуй в отчёте.
- 🔴 **Идемпотентна** (`ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS`) — таблицы учёта миграций нет, прогон может повториться.
- 🔴 Старую оргу/ключи **НЕ трогать** в этой задаче (откат).

- [ ] **Step 3: Применить на прод (координатор, не исполнитель)**

Исполнитель миграцию **не применяет**. В отчёте — точный SQL + команда + что проверить SELECT-ом.

- [ ] **Step 4: Проверка эффектом (после применения)**

```sql
SELECT o.slug, o.subscription_credits, o.payg_credits, k.name, k.key_prefix, k.daily_usd_cap
FROM organizations o JOIN gateway_api_keys k ON k.org_id=o.id
WHERE o.slug='agents-market';
```
Ожидаемо: одна орга, один ключ, бакеты 0, кап задан.

- [ ] **Step 5: Коммит**

```bash
git add packages/database/migrations/00NN_tma_own_org.sql
git commit -m "feat(db): give Agents Market its own org, key and wallet (split step 1)"
```

---

### Task 2: Переключить agent-worker на новый ключ и доказать, что он не ушёл на прямой OpenRouter

**Files:**
- Modify: `/srv/aiag/shared/.env` (VPS, координатор) — `AIAG_GATEWAY_KEY`
- Test: `apps/agent-worker/src/__tests__/no-silent-openrouter-fallback.test.ts` (**создать**)

**Interfaces:**
- Consumes: ключ из Task 1.
- Produces: гарантия, что при 402/неверном ключе воркер **не** уходит на прямой апстрим.

**Почему так:** 🔴 `apps/agent-worker/src/agent-runner.ts:200-203` при проблеме с ключом **молча** уходит на прямой OpenRouter — утечка маржи + слом white-label **без ошибки в логах**. Кошелёк TMA = 0 (решение основателя) → **каждый** ран сразу 402. Надо доказать, что 402 ведёт к честной ошибке, а не к тихому фолбэку.

- [ ] **Step 1: Прочитать фолбэк**

Прочитай `agent-runner.ts:190-215`. Установи **точно**: на каком условии срабатывает фолбэк на прямой OpenRouter — `isModelNotFound`? отсутствие ключа? любая ошибка гейтвея? 402? Выпиши условие дословно.

- [ ] **Step 2: Написать падающий тест**

```ts
// apps/agent-worker/src/__tests__/no-silent-openrouter-fallback.test.ts
import { describe, it, expect } from 'vitest';
import { shouldFallbackToDirectUpstream } from '../agent-runner';

describe('no silent direct-upstream fallback', () => {
  it('🔴 402 (нет кредитов) — НЕ фолбэчить на прямой апстрим', () => {
    expect(shouldFallbackToDirectUpstream({ status: 402, code: 'insufficient_funds' })).toBe(false);
  });

  it('🔴 401/403 (ключ не принят) — НЕ фолбэчить: это утечка маржи + слом white-label', () => {
    expect(shouldFallbackToDirectUpstream({ status: 401, code: 'unauthorized' })).toBe(false);
    expect(shouldFallbackToDirectUpstream({ status: 403, code: 'forbidden' })).toBe(false);
  });
});
```

- [ ] **Step 3: Прогнать — падает**

Run: `cd apps/agent-worker && bunx vitest run src/__tests__/no-silent-openrouter-fallback.test.ts`
Expected: FAIL — функция не экспортирована/не существует

- [ ] **Step 4: Реализовать**

Вынеси условие фолбэка в чистую экспортируемую `shouldFallbackToDirectUpstream(err)`. Разреши фолбэк **только** для тех случаев, где он осмыслен (по результату Step 1 — вероятно только «модель не найдена у нас», и то спорно). 402/401/403 → **не фолбэчить**, отдать честную ошибку.
🔴 Если по Step 1 фолбэк вообще не нужен — предложи убрать его совсем, но **не убирай молча**: опиши в отчёте, решение за координатором.

- [ ] **Step 5: Прогнать — зелёные**

Run: `cd apps/agent-worker && bunx vitest run && bun run build`
Expected: новые PASS; прежние 30 passed/4 skipped не упали.

- [ ] **Step 6: Коммит**

```bash
git add apps/agent-worker/src/agent-runner.ts apps/agent-worker/src/__tests__/no-silent-openrouter-fallback.test.ts
git commit -m "fix(agent-worker): never silently fall back to direct upstream on auth/funds errors"
```

- [ ] **Step 7: Смена ключа на проде (координатор)**

Порядок: (1) задать новый `AIAG_GATEWAY_KEY`; (2) `pm2 restart ecosystem.config.cjs --only agent-worker --update-env` (🔴 `--update-env` НЕ перечитывает `.env` — только из ecosystem); (3) проверить `/proc/PID/environ`, что ключ подхватился; (4) прогнать ран → ожидаем **честный 402** (кошелёк 0), а НЕ ответ модели (ответ = ушёл на прямой OpenRouter = провал); (5) старый ключ отзывать **только после** этой проверки.

---

### Task 3: Каталог моделей в TMA — через публичный API, не через SQL

**Files:**
- Create: `apps/tg-miniapp/src/lib/catalog.ts`
- Modify: `apps/tg-miniapp/app/market/[slug]/page.tsx`, `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts`
- Test: `apps/tg-miniapp/src/__tests__/catalog-no-cost-leak.test.ts`

**Interfaces:**
- Produces: `fetchCatalog(): Promise<PublicModel[]>` — читает `/v1/models` гейтвея с ключом TMA.
- Consumes: ключ TMA (Task 1).

**Почему так:** сейчас TMA делает `SELECT` из `models` (3 места) и **`JOIN model_upstreams`** ради цены и markup — то есть клиент читает **таблицу себестоимости провайдера**. После сплита БД этого не будет физически, но и до него это неверно: клиент не должен видеть COGS другого юрлица. Плюс это блокер этапа сплита БД (Task 5). Плюс веб-админ, заморозивший модель, сейчас молча глушит агентов TMA.

- [ ] **Step 1: Найти все чтения реестра из TMA**

```bash
cd apps/tg-miniapp && grep -rn "model_upstreams\|FROM models\|JOIN models" app/ src/ --include=*.ts --include=*.tsx
```
Выпиши каждое: файл:строка, что берёт, зачем. Ожидаемо ~4 места (3 × `models`, 1 × JOIN `model_upstreams`). Если больше — сообщи.

- [ ] **Step 2: Написать падающий тест**

```ts
// apps/tg-miniapp/src/__tests__/catalog-no-cost-leak.test.ts
import { describe, it, expect } from 'vitest';
import { toPublicModel } from '../lib/catalog';

describe('catalog: клиент не видит себестоимость провайдера', () => {
  it('🔴 публичная модель НЕ содержит upstream-цену и markup', () => {
    const pub = toPublicModel({
      slug: 'openai/gpt-4o-mini', display_name: 'GPT-4o mini',
      price_per_1k_input: 0.015, price_per_1k_output: 0.06, markup: 1.8,
    } as never);
    expect(pub).not.toHaveProperty('price_per_1k_input');
    expect(pub).not.toHaveProperty('markup');
    expect(Object.keys(pub).join(',')).not.toMatch(/upstream|cost|markup/i);
  });

  it('retail-цена отдаётся в кредитах (1 кредит = 1 цент)', () => {
    const pub = toPublicModel({
      slug: 'openai/gpt-4o-mini', display_name: 'GPT-4o mini',
      price_per_1k_input: 0.015, price_per_1k_output: 0.06, markup: 1.8,
    } as never);
    // 0.015 центов × 1.8 = 0.027 кредита за 1k input
    expect(pub.priceInputPer1kCredits).toBeCloseTo(0.027, 6);
  });
});
```

- [ ] **Step 3: Прогнать — падает**

Run: `cd apps/tg-miniapp && bunx vitest run src/__tests__/catalog-no-cost-leak.test.ts`

- [ ] **Step 4: Реализовать**

`apps/tg-miniapp/src/lib/catalog.ts`:
- `fetchCatalog()` — GET `/v1/models` гейтвея с `Authorization: Bearer ${AIAG_GATEWAY_KEY}`. 🔴 Прочитай, что реально отдаёт `/v1/models` (`packages/api-gateway/src/routes/v1/models.ts` или аналог) — если он уже отдаёт retail-цену без себестоимости, бери как есть; если отдаёт лишнее — **не чини гейтвей в этой задаче**, опиши в отчёте.
- `toPublicModel()` — чистая функция: из строки реестра оставить только публичное (slug, display_name, тип, retail-цена в кредитах). **Никаких** `price_per_1k_*` (это центы себестоимости) и `markup` наружу.
- Заменить SQL-чтения реестра в найденных местах на `fetchCatalog()`. Кэш — если нужен, простой in-memory с TTL; 🔴 **не** тащить новую зависимость.

- [ ] **Step 5: Прогнать**

Run: `cd apps/tg-miniapp && bunx vitest run && bunx tsc --noEmit && NODE_OPTIONS=--max-old-space-size=8192 TMA_JWT_SECRET=x bun run build`
Expected: тесты PASS, tsc не вырос, build exit 0.

- [ ] **Step 6: Доказать, что SQL-связь с реестром разорвана**

```bash
cd apps/tg-miniapp && grep -rn "model_upstreams\|FROM models\|JOIN models" app/ src/ --include=*.ts --include=*.tsx
```
Expected: пусто (или только комментарии). Это предусловие Task 5.

- [ ] **Step 7: Коммит**

```bash
git add apps/tg-miniapp/src/lib/catalog.ts apps/tg-miniapp/app/market/[slug]/page.tsx apps/tg-miniapp/app/api/tma/agents/[id]/route.ts apps/tg-miniapp/src/__tests__/catalog-no-cost-leak.test.ts
git commit -m "feat(tma): read model catalog via public gateway API, stop reading provider COGS"
```

---

### Task 4: Разорвать межконтурные FK

**Files:**
- Create: `packages/database/migrations/00NN_tma_providers_local.sql`
- Create: `packages/database/migrations/00NN_break_cross_contour_fks.sql`

**Почему так:** межконтурных FK в проде **5**; живых жёстких — **два**: `agents.provider_id → providers` и `agent_provider_credentials.provider_id → providers`; плюс nullable `tg_users.user_id → users` (`ON DELETE SET NULL`). Пока FK живы, разделить БД **физически невозможно** (Task 5).

- [ ] **Step 1: Снять факт (SELECT)**

```sql
SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name
JOIN information_schema.referential_constraints rc ON tc.constraint_name=rc.constraint_name
WHERE tc.constraint_type='FOREIGN KEY'
  AND (tc.table_name IN ('agents','agent_provider_credentials','tg_users')
       OR ccu.table_name IN ('providers','users'));

SELECT count(*) FROM agents WHERE provider_id IS NOT NULL;
SELECT count(*) FROM agent_provider_credentials WHERE provider_id IS NOT NULL;
SELECT count(*) FROM tg_users WHERE user_id IS NOT NULL;
SELECT id, slug, name FROM providers ORDER BY slug;
```
Если картина отличается от «2 жёстких + 1 nullable» — **СТОП**, сообщи.

- [ ] **Step 2: Локальный справочник провайдеров для TMA**

Миграция: создать `tma_providers` (или как назовёшь — обоснуй) с теми же id/slug, что нужны TMA, скопировать актуальные строки из `providers`. Идемпотентна. 🔴 Копируем **только публичное** (id, slug, имя, базовый URL если нужен) — не тащить в TMA-контур ничего про себестоимость/ключи RF-контура.

- [ ] **Step 3: Перевесить FK**

Миграция: `agents.provider_id` и `agent_provider_credentials.provider_id` → FK на `tma_providers` вместо `providers`. `tg_users.user_id` → снять FK (оставить колонку как «мягкую» ссылку; это связь «тот же человек в двух продуктах», после сплита БД она в любом случае перестаёт быть FK).
🔴 Идемпотентно: `DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` под `IF NOT EXISTS`-проверкой через `pg_constraint`.
🔴 **Не удалять** `providers` — она нужна web-контуру.

- [ ] **Step 4: Проверка эффектом**

Повтори SELECT из Step 1 → межконтурных FK (TMA→web) должно остаться **0**.

- [ ] **Step 5: Коммит**

```bash
git add packages/database/migrations/00NN_tma_providers_local.sql packages/database/migrations/00NN_break_cross_contour_fks.sql
git commit -m "feat(db): local provider registry for TMA, break cross-contour FKs (split step 2)"
```

---

### Task 5: 🔴 Физическое разделение БД (НЕОБРАТИМО)

**Files:**
- Create: `docs/runbooks/2026-07-17-db-split.md` (пошаговый ранбук — исполняет координатор)

**Почему так:** решение основателя 2026-07-17 — разделять сейчас, пока данных почти нет (2 агента, 0 ранов, 0 наймов, 0 балансов). Возможно **только** при нулевых межконтурных FK (Task 4) и разорванной SQL-связи с реестром (Task 3).

🔴 **Предусловия — все обязательны:**
1. Task 3 закрыт (grep по TMA не находит `models`/`model_upstreams`).
2. Task 4 закрыт (межконтурных FK = 0).
3. **`pg_dump` вне VPS** — бэкапы сейчас на том же диске, что БД; локального дампа НЕДОСТАТОЧНО.

- [ ] **Step 1: Написать ранбук (исполнитель пишет, координатор исполняет)**

Ранбук обязан содержать:
- Точный список таблиц TMA-контура (снять SELECT-ом, не по памяти): `agents`, `agent_*`, `tg_*`, `membership_*`, `tma_providers`, … — полный.
- `pg_dump` **на локальную машину** (не на VPS), проверка целостности дампа.
- Создание БД `aiag_tma`, права.
- Перенос таблиц (`pg_dump -t` по списку → restore в новую БД), проверка счётчиков строк до/после **по каждой таблице**.
- Смена `DATABASE_URL` для `tma` и `agent-worker` в `/srv/aiag/shared/.env`; 🔴 рестарт **из ecosystem** (`--update-env` не перечитывает `.env`).
- Проверка **эффектом**: `/tg/health` 200; ран → честный 402 (кошелёк 0); web не сломан (`/`, `/marketplace`, `/dashboard` 200).
- Удаление перенесённых таблиц из старой БД — **отдельным шагом, после** подтверждения, что новая работает. Не в одном окне.
- **План отката**: пока таблицы не удалены из старой БД — откат = вернуть `DATABASE_URL`. После удаления — только restore из дампа.

- [ ] **Step 2: Коммит ранбука**

```bash
git add docs/runbooks/2026-07-17-db-split.md
git commit -m "docs: runbook for physical DB split (web ↔ TMA)"
```

---

### Task 6: Документация — зафиксировать сплит

**Files:**
- Modify: `docs/canon/AIAG-CANON.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`
- Modify: `~/.claude/projects/C--Users-----projects-aggregator/memory/MEMORY.md` (+ новый файл памяти)

- [ ] **Step 1: Канон**

Зафиксировать решение основателя 2026-07-17: web и TMA — **два разных проекта**; агрегатор = **провайдер** для Agents Market; TMA = клиент со своей оргой/ключом/кошельком; трансфертная цена = **те же 1.2×**; БД разделены. Старые формулировки о «двух продуктах в одной БД» — пометить `DEPRECATED → §сплит`, не удалять.

- [ ] **Step 2: ARCHITECTURE.md**

Обновить карту: две БД, кто чей, TMA ходит в гейтвей как внешний клиент, реестр моделей — через `/v1/models`. Убрать утверждения про общий контур.

- [ ] **Step 3: Память**

Новый файл `project_web_tma_split_2026_07_17.md`: решение, этапы, что сделано, что осталось, риск №1 (тихий фолбэк на OpenRouter), кошелёк TMA = 0 (E2E заблокирован до пополнения). Указатель в `MEMORY.md`.

- [ ] **Step 4: Коммит**

```bash
git add docs/canon/AIAG-CANON.md docs/ARCHITECTURE.md CLAUDE.md
git commit -m "docs: record web ↔ TMA split decision and new architecture"
```

---

## Порядок и зависимости

```
Task 1 (орга+ключ+кошелёк) → Task 2 (ключ на проде + no-fallback)
                                   ↓
                          Task 3 (каталог через API)  ─┐
                          Task 4 (разрыв FK)          ─┴→ Task 5 (сплит БД, НЕОБРАТИМО)
                                                              ↓
                                                        Task 6 (доки)
```
Task 3 и Task 4 — параллельны. Task 5 требует обоих.

## Что этот план НЕ закрывает

- **Мост оплата→кошелёк** — TMA фондируется вручную (`topupPayg`), инвойс-следа нет. Отдельный план.
- **Per-org markup** — не строим (решение: те же 1.2×).
- **Инфра-сплит** (отдельный VPS/Redis/nginx) и **репо-сплит** — этапы 5-6 карты, отдельные планы.
- **Утечки гейтвея** (6 P0) — план `2026-07-16-gateway-money-leak-closure.md`.
- **Фейковые продукты** (эмбеддинги `Math.sin()`, подписку нельзя купить, лендинг врёт про тарифы) — отдельный план.
- **39 пулов postgres в TMA** (`max=10`, `idle_timeout=0` → исчерпание `max_connections=97`) — отдельный план, приоритетный.
