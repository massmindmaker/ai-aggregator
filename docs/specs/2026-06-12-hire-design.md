# Дизайн-спек: настоящий «наём» агента (запуск без владения)

Дата: 2026-06-12 · Автор-агент: дизайн-спек по запросу основателя · Статус: ПРОЕКТ (не реализовано)

> Документ проектирует **«Нанять»** — четвёртую операцию из синтеза (`docs/specs/2026-06-12-product-model-hermes-IA-synthesis.md`, §1–2). Сегодня в коде её НЕТ: любая «попробовать чужого агента» = клон с владением. Здесь спроектирована честная аренда-запуск: наниматель гоняет ЧУЖОГО агента, спек создателя read-only, память и история — изолированы per-наниматель (OWASP LLM06), биллинг — на нанимателя, `settleRun` не ломается.
>
> Везде помечено: **[ЕСТЬ]** = подтверждено в коде, **[НЕТ]** = нужно построить, **[ИЗМЕНИТЬ]** = существующая функция требует правки сигнатуры/SQL.

---

## 0. Что есть в коде сегодня (база, на которую опираемся)

| Факт | Где | Статус |
|---|---|---|
| Память агента = KV `agent_memory (agent_id, key, value)`, PK `(agent_id, key)` | `agent-worker/src/db.ts:385-421` (`memorySet/Get/List`) | **[ЕСТЬ]** ключ = только `agent_id` |
| `memory`-tool передаёт `ctx.agentId` в memorySet/Get/List | `agent-worker/src/tools.ts:314-337, 431-435` | **[ЕСТЬ]** |
| История диалога = `loadHistory(agent.id, excludeRunId, 10)` по `agent_id` | `db.ts:234-250`, вызов `agent-runner.ts:530` | **[ЕСТЬ]** скоупится только по `agent_id` |
| Биллинг = `settleRun({runId, tgUserId, agentId, costCredits, isExternal})`, дебетует `tg_user_balances` по `tgUserId`, дневной гард по `agentId` | `db.ts:527-588` | **[ЕСТЬ]** |
| Клон = создаёт ВЛАДЕЮЩУЮ копию, `tg_user_id = клонирующий`, секреты NULL | `templates/[id]/clone/route.ts` | **[ЕСТЬ]** |
| Платный клон/аренда автору → 402 `rent_not_available_yet` | `clone/route.ts:49-51` | **[ЕСТЬ]** заглушка |
| Дневной бюджет хранится НА агенте (`agents.daily_budget_credits/spent_today_credits`) | `db.ts:197-228`, settleRun-гард `db.ts:554-562` | **[ЕСТЬ]** ⚠️ ключевая коллизия для найма |
| Таблица `agent_sessions` | — | **[НЕТ]** |
| Память/история в namespace на нанимателя | — | **[НЕТ]** |
| Роут `POST /agents/[id]/hire` | — | **[НЕТ]** |

🔴 **Ключевой риск №1 (память):** `memorySet/Get/List` и `loadHistory` скоупятся ТОЛЬКО по `agent_id`. Если наниматель гоняет чужой `agent_id` как есть — он пишет/читает **ту же строку памяти и ту же историю**, что владелец и любой другой наниматель. Это и есть OWASP **LLM06: Sensitive Information Disclosure** (cross-tenant memory leak). Без правки этих функций наём строить НЕЛЬЗЯ.

🔴 **Ключевой риск №2 (бюджет):** дневной бюджет физически лежит на строке `agents`. Если 100 нанимателей делят одного агента, они делят ОДИН `spent_today_credits` → гонка + DoS (один наниматель выжигает дневной лимит для всех). Бюджет найма должен жить на **сессии**, а не на агенте.

---

## 1. Терминология и продуктовая модель

Четыре операции (из синтеза §1), чёткие ярлыки:

| Ярлык | Владение | Память/история | Кто платит | Спек | Статус |
|---|---|---|---|---|---|
| **Создать** (из шаблона, free) | ✅ наниматель владеет копией | своя, чистая | сам (BYOK = 0) | копия шаблона | [ЕСТЬ] `/clone` |
| **Арендовать** (платный клон, рента автору) | ✅ владеет копией | своя | сам + рента автору | копия шаблона | [НЕТ] `/rent` план |
| **Скопировать агента** (напрямую, если `cloneable`) | ✅ владеет копией | своя, чистая | сам | копия агента | [НЕТ] |
| **🆕 Нанять** (этот документ) | ❌ **НЕ владеет** | **изолированная per-наниматель** | **наниматель** (дебет gateway) | **read-only создателя** | **[НЕТ]** |

**Суть найма:** наниматель запускает ЖИВОГО агента создателя (его актуальную персону/тулы/MCP), но:
- спек создателя **read-only** — наниматель не может его править, не видит ключей создателя;
- **память и история — приватные нанимателя** в рамках этого агента; владелец и другие наниматели их не видят;
- платит **наниматель** (его баланс кредитов, AIAG-наценка), создатель НЕ платит за чужие прогоны;
- создатель может получать **ренту/долю** (опционально, Slice 2 — не в MVP этого спека).

**Зачем это, а не клон:** клон замораживает спек в момент копирования (обновления создателя не доходят) и плодит мусорных агентов в инбоксе. Наём = «попробовать как есть, без обязательств», создатель сохраняет контроль над спеком, обновления видны сразу. Это паттерн GPT-Store «use» против Dify «duplicate» (синтез §2, источники).

---

## 2. Таблица `agent_sessions` [НЕТ — создать]

Сессия = «один наниматель запускает одного чужого агента». Контейнер для приватной памяти, истории и бюджета найма.

```sql
-- migration 00XX_agent_sessions.sql  (применяется вручную на prod, см. ARCHITECTURE.md)
CREATE TABLE agent_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               uuid    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hirer_tg_user_id       bigint  NOT NULL,         -- наниматель (НЕ владелец агента)
  owner_tg_user_id       bigint  NOT NULL,         -- денормализованный agents.tg_user_id на момент найма (для выплат/аудита)
  status                 varchar(16) NOT NULL DEFAULT 'active',  -- active | ended | revoked
  -- бюджет НАЙМА живёт здесь, НЕ на agents (risk №2):
  daily_budget_credits   bigint  NOT NULL DEFAULT 2000,   -- $20/день дефолт; cap нанимателя на эту сессию
  spent_today_credits    bigint  NOT NULL DEFAULT 0,
  spent_today_date       date    NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/Moscow')::date,
  -- рента/доля создателя (Slice 2; в MVP NULL = бесплатный наём, как free-clone сегодня):
  rent_credits_monthly   bigint,                   -- сколько наниматель платит создателю/мес (NULL = free)
  created_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz
);

-- Один активный наём агента на нанимателя (повторный «Нанять» = переиспользовать сессию, не плодить):
CREATE UNIQUE INDEX uq_session_active
  ON agent_sessions (agent_id, hirer_tg_user_id)
  WHERE status = 'active';

CREATE INDEX ix_sessions_hirer ON agent_sessions (hirer_tg_user_id, status);
CREATE INDEX ix_sessions_agent ON agent_sessions (agent_id, status);
```

Замечания:
- `owner_tg_user_id` денормализован, потому что владелец может смениться (Phase 16 transfer-iNFT перепривязывает `agents.tg_user_id`). Для выплат ренты нужен владелец **на момент найма**.
- Бюджет на сессии решает risk №2: каждый наниматель имеет свой `daily_budget_credits/spent_today_credits`, гонки за общий счётчик нет.
- `ON DELETE CASCADE` от `agents`: если создатель удалил агента, сессии уезжают (но см. §6 — soft-delete агентов, поэтому реально гасим сессии в роуте).

---

## 3. Модель памяти в namespace `(agent_id, hirer_tg_user_id)` [ИЗМЕНИТЬ]

### 3.1 Проблема

Сегодня (`db.ts`): PK `agent_memory(agent_id, key)`, история — `loadHistory(agent_id,...)`. Скоуп = только агент. Для найма этого недостаточно → cross-tenant утечка.

### 3.2 Решение: добавить тенант-измерение

**Схема `agent_memory` [ИЗМЕНИТЬ]:**

```sql
ALTER TABLE agent_memory ADD COLUMN scope_tg_user_id bigint;
-- NULL = «память владельца» (бэк-совместимо: все существующие строки = владелец).
-- NOT NULL = приватная память нанимателя с этим id.

-- старый PK (agent_id, key) → расширить тенантом.
-- COALESCE(scope, 0): NULL-владельца ведёт себя как одно стабильное значение в индексе.
ALTER TABLE agent_memory DROP CONSTRAINT agent_memory_pkey;  -- имя уточнить на prod
CREATE UNIQUE INDEX uq_agent_memory_scope
  ON agent_memory (agent_id, COALESCE(scope_tg_user_id, 0), key);
```

**Сигнатуры функций `db.ts` [ИЗМЕНИТЬ]** — добавить параметр scope, дефолт NULL = поведение владельца (никакой существующий вызывающий код не ломается):

```ts
// scope = null  → память владельца (как сейчас); scope = hirer id → приватная нанимателю
export async function memorySet(agentId, key, value, scope: string | null = null) {
  await sql`
    INSERT INTO agent_memory (agent_id, scope_tg_user_id, key, value, updated_at)
    VALUES (${agentId}::uuid, ${scope}::bigint, ${key}, ${value}, NOW())
    ON CONFLICT (agent_id, COALESCE(scope_tg_user_id, 0), key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}
export async function memoryGet(agentId, key, scope: string | null = null) {
  const rows = await sql`
    SELECT value FROM agent_memory
    WHERE agent_id = ${agentId}::uuid
      AND COALESCE(scope_tg_user_id, 0) = COALESCE(${scope}::bigint, 0)
      AND key = ${key} LIMIT 1`;
  ...
}
export async function memoryList(agentId, limit = 100, scope: string | null = null) {
  // фильтр COALESCE(scope_tg_user_id,0)=COALESCE(${scope},0) — НИКОГДА не возвращать чужой скоуп
}
```

⚠️ `ON CONFLICT` нельзя задать на выражение `COALESCE(...)` напрямую в синтаксисе `ON CONFLICT (col)`; нужно `ON CONFLICT ON CONSTRAINT uq_agent_memory_scope`. На prep-statement постгресе это рабочая форма — указать **имя индекса** в `ON CONFLICT`.

**`loadHistory` [ИЗМЕНИТЬ]** — историю тоже скоупим. Сегодня `agent_runs` фильтруется по `agent_id`. Для найма история нанимателя = `agent_id` И `tg_user_id = hirer` (поле `agent_runs.tg_user_id` уже есть — `db.ts:48`, `loadRun` его читает):

```ts
export async function loadHistory(agentId, excludeRunId, limit, scopeTgUserId: string | null = null) {
  // ... WHERE agent_id = ${agentId}
  //     AND (${scopeTgUserId} IS NULL OR tg_user_id = ${scopeTgUserId}::bigint)
}
```
Для владельца (scope=null) — поведение прежнее. Для найма передаём `hirer_tg_user_id` → наниматель видит ТОЛЬКО свои прогоны этого агента.

### 3.3 Как раннер прокидывает scope [ИЗМЕНИТЬ]

`ToolContext.agentId` сейчас один (`tools.ts:366`). Добавить `memoryScope: string | null`:
- обычный прогон (владелец) → `memoryScope = null`;
- прогон сессии найма → `memoryScope = session.hirer_tg_user_id`.

`memoryTool` (`tools.ts:314`) передаёт `ctx.memoryScope` в `memorySet/Get/List`. `loadHistory` в `agent-runner.ts:530` получает scope из контекста прогона.

**Источник scope = run, не клиент.** scope берётся из `agent_runs`/сессии, привязанной к этому `runId` на сервере — НЕ из тела запроса. LLM/инструмент не может попросить «дай память юзера X»: `ctx.memoryScope` зашит воркером по факту того, кто владелец прогона. Это и есть граница изоляции LLM06.

---

## 4. Биллинг: дебет нанимателя, спек создателя read-only

### 4.1 Принцип

- **Платит наниматель.** `settleRun` уже дебетует `tg_user_balances` по `tgUserId` (`db.ts:565-573`). Для прогона-найма `tgUserId = hirer_tg_user_id` → деньги списываются с нанимателя автоматически, БЕЗ правок дебетной логики.
- **Создатель не платит и не отдаёт ключи.** Модель идёт через **AIAG-gateway** (`connection_type='aiag'`), наценка применяется, как обычно. Наниматель НЕ использует BYOK-ключи создателя (их нет в read-only спеке).
- **Commission rule сохраняется:** наём всегда `isExternal = false` (AIAG-путь) → дебет + наценка. BYOK-ветка (`if (isExternal) return`) к найму неприменима by design (нанимателю не отдают чужой ключ).

### 4.2 Read-only спек создателя

Раннер найма грузит `loadAgent(session.agent_id)` (актуальный спек создателя), но:
- **не пишет** в `agents` от имени нанимателя (никаких PATCH);
- секреты создателя (`external_api_key_encrypted`, `mcp_auth_encrypted`, OAuth-токены) **используются на сервере воркера**, наружу нанимателю не отдаются (как и при обычном прогоне — секрет живёт только в процессе);
- если спек создателя = BYOK (`connection_type='external_openai'`/provider_id) — это **политическое решение**: либо наём таких агентов запрещён (создатель не обязан оплачивать чужой трафик своим ключом), либо наём принудительно переключается на AIAG-gateway-модель того же слага (наниматель платит сам). **MVP: разрешать наём только для `connection_type='aiag'`-агентов** (см. §5 гард). Это убирает риск «наниматель жжёт ключ создателя».

### 4.3 Дневной бюджет — с сессии, не с агента [ИЗМЕНИТЬ для пути найма]

Сегодня дневной гард в `settleRun` (`db.ts:554-562`) бьёт по `agents.daily_budget_credits`. Для найма это неверно (risk №2 — общий счётчик). Минимальная правка `settleRun`: принять **необязательный** `sessionId`:

```ts
settleRun({ runId, tgUserId, agentId, sessionId?: string, costCredits, ..., isExternal })
```
- `sessionId == null` (обычный прогон владельца) → дневной гард по `agents` (как сейчас, ноль изменений поведения).
- `sessionId != null` (прогон найма) → дневной гард по `agent_sessions`:

```sql
UPDATE agent_sessions
SET spent_today_credits = CASE WHEN spent_today_date < (now() AT TIME ZONE 'Europe/Moscow')::date
                               THEN ${costCredits} ELSE spent_today_credits + ${costCredits} END,
    spent_today_date = (now() AT TIME ZONE 'Europe/Moscow')::date
WHERE id = ${sessionId}::uuid
  AND (CASE WHEN spent_today_date < (now() AT TIME ZONE 'Europe/Moscow')::date THEN 0 ELSE spent_today_credits END)
      + ${costCredits} <= daily_budget_credits
RETURNING id
```
Тот же паттерн guarded-`UPDATE … WHERE … RETURNING`, что в §SECURITY.md — атомарно, double-spend-safe, всё в том же `sql.begin`. **Баланс-дебет (`tg_user_balances` по `tgUserId`) и ledger-запись НЕ меняются** — они уже на нанимателе.

### 4.4 Рента создателю (Slice 2, не MVP)

Если `session.rent_credits_monthly != null` — отдельный месячный дебет нанимателя → кредит владельцу (`owner_tg_user_id`). Это **НЕ % с прогонов** (founder decision №7: 0% комиссии на ренту автора), а фиксированная сумма автора. Реализуется как отдельная ledger-операция вне `settleRun` (как `/rent`-план), здесь только резервируем поле. В MVP `rent_credits_monthly = NULL` → наём бесплатный (как free-clone), AIAG зарабатывает на наценке модели.

### 4.5 Почему `settleRun` НЕ ломается (инвариант)

`settleRun`-контракт меняется аддитивно:
1. markCompleted — без изменений.
2. `isExternal` short-circuit — без изменений (наём всегда isExternal=false).
3. Дневной гард — **ветвится** по наличию `sessionId`; для существующих вызовов (`sessionId` отсутствует) путь идентичен текущему. Интеграционный тест `run-settle.integration.test.ts` (4/4) остаётся зелёным, т.к. вызовы без `sessionId` не меняют поведение.
4. Баланс-дебет + ledger — без изменений (уже по `tgUserId`).
Всё в одном `sql.begin` → атомарность сохранена. UNIQUE `(ref_kind, ref_id, kind)` идемпотентность сохранена.

---

## 5. Роут `POST /agents/[id]/hire` [НЕТ — создать]

Файл: `apps/tg-miniapp/app/api/tma/agents/[id]/hire/route.ts`. Создаёт/переиспользует сессию найма. НЕ запускает прогон сам — отдаёт `session_id`, дальше чат шлёт `/run` с `session_id` (как обычный run, но в скоупе сессии).

Псевдокод (паттерн `clone/route.ts`):

```ts
export async function POST(req, { params }) {
  const hirer = req.headers.get('x-tma-user-id');         // [ЕСТЬ] nginx-проверенный
  if (!hirer) return 401;
  if (!UUID_RE.test(params.id)) return 400;

  // спек агента (НЕ шаблона) — нанимаем живого агента
  const a = await sql`
    SELECT id::text, tg_user_id::text AS owner, status, connection_type, provider_id, hireable
    FROM agents WHERE id = ${params.id}::uuid LIMIT 1`;
  if (!a[0] || a[0].status !== 'active') return 404;

  // ГАРД 1: нельзя нанять самого себя (свой агент → используешь напрямую)
  if (a[0].owner === hirer) return 400 'own_agent';

  // ГАРД 2: создатель должен явно разрешить наём (opt-in, как cloneable)
  //   нужен новый столбец agents.hireable boolean DEFAULT false  [НЕТ]
  if (!a[0].hireable) return 403 'not_hireable';

  // ГАРД 3: MVP — только AIAG-агенты (нельзя жечь чужой BYOK-ключ, §4.2)
  if (a[0].connection_type !== 'aiag' || a[0].provider_id !== null)
    return 409 'byok_agent_not_hireable';

  // upsert активной сессии (uq_session_active гарантирует одну на пару)
  const s = await sql`
    INSERT INTO agent_sessions (agent_id, hirer_tg_user_id, owner_tg_user_id, daily_budget_credits)
    VALUES (${params.id}::uuid, ${hirer}::bigint, ${a[0].owner}::bigint, 2000)
    ON CONFLICT (agent_id, hirer_tg_user_id) WHERE status='active'
      DO UPDATE SET status='active'   -- идемпотентный повторный наём
    RETURNING id::text`;
  return NextResponse.json({ session_id: s[0].id }, { status: 201 });
}
```

Нужны также [НЕТ]:
- столбец `agents.hireable boolean NOT NULL DEFAULT false` (opt-in создателя; ставится на экране Публикация);
- `DELETE /agents/[id]/hire` (или `/sessions/[id]`) → `status='ended'` — наниматель «увольняет» агента;
- `/run`-роут [ИЗМЕНИТЬ] принимает необязательный `session_id`: если задан — валидирует, что сессия активна и `hirer_tg_user_id == x-tma-user-id`, пишет `agent_runs.session_id`, воркер ставит `memoryScope=hirer`, `loadHistory(scope=hirer)`, `settleRun(sessionId=...)`. Нужен столбец `agent_runs.session_id uuid NULL` [НЕТ].

**Безопасность роута (SECURITY.md):** prepared statements only [✓ tagged-template]; `x-tma-user-id` — только из nginx-проверенного заголовка [✓]; ownership-гард на `hirer != owner` [✓]; rate-limit на создание сессий (как у transfer-offer, `project_phase16`) — чтобы не наспамить сессий [НЕТ, добавить].

---

## 6. UI: «Нанять» vs «Клонировать/Создать»

Контекст из синтеза §5A: вкладка **Агенты → [Нанять · Мои · Создать]**. Карточка-персонаж (CharCard) готового агента в сегменте «Нанять».

**Две разные кнопки на досье агента / карточке — разный смысл, разные иконки:**

| | **Нанять** (primary, amber) | **Создать себе / Скопировать** (secondary, ghost) |
|---|---|---|
| Иконка/глагол | ▷ «Нанять» / «Запустить как есть» | ⧉ «Сделать копию» |
| Результат | сессия, агент остаётся у создателя | свой агент в инбоксе |
| Память | приватная, в этом найме | своя с нуля |
| Спек | read-only, обновления создателя видны | заморожен на момент копии |
| Платит | наниматель (наценка) | сам (BYOK=0 при своём ключе) |
| Доступно если | `agents.hireable = true` и AIAG-агент | шаблон опубликован / `cloneable` |
| Микрокопия | «Платите только за свои запуски. Память приватна. Агент остаётся у автора.» | «Полная копия в вашем кабинете. Настраивайте как угодно.» |

Правила (PRODUCT.md / DESIGN.md):
- **Одна amber-primary на экран** → «Нанять» primary (главный «попробуй без обязательств»), «Скопировать» — ghost-вторичка.
- Перед первым прогоном найма — честный **disclosure-шит**: «Вы запускаете агента автора @username. Ваша память и история приватны. Списываются ваши кредиты по тарифу + наценка. Дневной лимит: $20 (меняется).» (никогда не раскрывать апстрим-бренд — white-label).
- Бейдж на карточке: `НАЁМ` (mono, как статус-пилл) у hireable-агентов; иначе только «Скопировать».
- Пустой инбокс «Мои» → дефолт-сегмент «Нанять» (синтез §5A).
- На досье **своего** агента, секция «Публикация»: тумблер `Разрешить наём` (ставит `agents.hireable`) + (Slice 2) поле ренты. Подпись: «Другие смогут запускать вашего агента. Они платят за свои запуски; их память автору не видна.»

**Анти-паттерн:** не показывать «Нанять» там, где наём не построен (UI=reality). Пока роут не на проде — кнопка скрыта/`◷ скоро`, не ведёт в тупик платного флоу.

---

## 7. Изоляция (OWASP LLM06) — чек-лист границ

| Граница | Механизм | Где |
|---|---|---|
| Память нанимателя ≠ владельца ≠ другого нанимателя | namespace `(agent_id, COALESCE(scope_tg_user_id,0), key)` | §3.2 |
| История нанимателя приватна | `loadHistory` фильтр `tg_user_id = hirer` | §3.2 |
| scope нельзя подделать запросом | `ctx.memoryScope` зашит воркером из `runId`/сессии, не из тела | §3.3 |
| Наниматель не читает спек/ключи создателя | спек read-only, секреты живут только в процессе воркера | §4.2 |
| Наниматель не жжёт чужой ключ | MVP: наём только AIAG-агентов | §4.2 / §5 ГАРД 3 |
| Один наниматель не выжигает общий дневной бюджет | бюджет на `agent_sessions`, не на `agents` | §2 / §4.3 |
| Только владелец агента ↔ только наниматель сессии | `hirer != owner`, `hirer == x-tma-user-id`, активная сессия | §5 |
| Утечка при transfer-iNFT | `owner_tg_user_id` денормализован на момент найма | §2 |

---

## 8. Объём работ (что менять, по файлам)

**Миграции [НЕТ] (вручную на prod, ARCHITECTURE.md):**
- `agent_sessions` (новая таблица) — §2.
- `agent_memory.scope_tg_user_id` + новый уникальный индекс — §3.2.
- `agent_runs.session_id uuid NULL` — §5.
- `agents.hireable boolean DEFAULT false` — §5.

**`agent-worker/src/db.ts` [ИЗМЕНИТЬ]:**
- `memorySet/Get/List` + `scope` параметр (дефолт null = старое поведение) — §3.2.
- `loadHistory` + `scopeTgUserId` — §3.2.
- `settleRun` + необязательный `sessionId` (ветка дневного гарда) — §4.3/4.5.
- хелперы сессий: `loadSession`, `getOrResetSessionBucket` (по образцу `getOrResetDailyBucket`).

**`agent-worker/src/tools.ts` + `agent-runner.ts` [ИЗМЕНИТЬ]:**
- `ToolContext.memoryScope` + проброс в `memoryTool` — §3.3.
- раннер: если run привязан к сессии → `memoryScope=hirer`, `loadHistory(scope=hirer)`, `settleRun(sessionId)`.

**`apps/tg-miniapp` [НЕТ/ИЗМЕНИТЬ]:**
- `POST /api/tma/agents/[id]/hire` + `DELETE` — §5.
- `/run`-роут: принять `session_id`, валидация + `agent_runs.session_id` — §5.
- UI: сегмент «Нанять», кнопки/шит/бейдж — §6; тумблер `hireable` на Публикации.

**Не трогать:** баланс-дебет и ledger в `settleRun` (уже на нанимателе); `isExternal`-short-circuit; commission rule. Money/auth-путь изменяется только аддитивно (новая ветка по `sessionId`), что согласуется с coding-behavior.md «surgical changes» по live-billing.

---

## 9. Открытые вопросы основателю (до реализации)

1. **Наём BYOK-агентов** — запретить (MVP, §4.2) или принудительно переводить на AIAG-слаг? Запрет проще и безопаснее.
2. **Рента (§4.4)** — в MVP найма бесплатно (только наценка модели) или сразу с рентой автора? Рекомендация: MVP бесплатно, рента — Slice 2 вместе с `/rent`.
3. **Сегмент «Нанять» vs «Скопировать»** — оба показывать на карточке, или наём заменяет клон в маркете «готовых»? Рекомендация: оба, наём — primary.
4. **Hermes-курс:** при переходе на реальный Hermes REST API (синтез §3, §7-3) изоляция нанимателей = `hermes profile` на нанимателя. Этот спек проектирует под текущий stateless-loop; namespace-память переносится в Hermes-profile позже без смены контракта роутов.

---

## 10. Источники в коде
`agent-worker/src/db.ts` (memorySet/Get/List 385-421, loadHistory 234-250, settleRun 527-588, getOrResetDailyBucket 197-228) · `agent-worker/src/tools.ts` (memoryTool 314-337, ToolContext 364-377) · `agent-worker/src/agent-runner.ts` (loadHistory 530, settleRun 687) · `tg-miniapp/app/api/tma/templates/[id]/clone/route.ts` · `docs/specs/2026-06-12-product-model-hermes-IA-synthesis.md` §1-2 · `/SECURITY.md` (guarded-UPDATE, white-label) · OWASP LLM06:2025.
