# Wave 1 — Маркетплейс агентов по модели «авторская аренда»

> **Дата:** 2026-06-04 · **Автор:** ведущий архитектор AIAG · **Статус:** план к реализации
> **Канон:** `/CLAUDE.md` (решение основателя #7), `docs/specs/2026-06-03-monetization.md`
> **Источники-ресёрчи:** `docs/specs/research/wave1-1-marketplace-state.md`, `…/wave1-2-ledger-money-flow.md`, `…/wave1-3-monetization-rules.md`
> **Фундамент:** денежная основа **D-0 (gateway отдаёт реальную маржу) + D-1 (USD-кредитный реестр)** уже **ЖИВАЯ**. Этот план строится поверх неё, ничего в ней не переписывает.

---

## TL;DR (для основателя, на человеческом языке)

Сегодня в TMA нет двустороннего рынка. «Шаблоны» — это 6 объектов, зашитых в код; `/market` — каталог **моделей**, а не агентов. Опубликовать своего агента, склонировать чужого или заработать на аренде — нельзя. Всё это **нарисовано в вайрфреймах (s34/s35/s36), но не построено**.

Wave 1 строит этот рынок в **три среза**, от безопасного к денежному:

1. **Срез 1 — публикация + витрина + бесплатный клон.** Автор публикует настройку агента (без ключей). Другие листают витрину и клонируют бесплатно. **Денег не касается вообще** — низкий риск, выпускаем первым.
2. **Срез 2 — платная аренда + выплата автору.** Арендатор платит **точную сумму, назначенную автором**, она целиком уходит автору. Атомарно, идемпотентно, на уже живом реестре.
3. **Срез 3 — экран дохода автора + вывод.** Заблокирован до решения основателя **FD-2** (можно ли кэшить кредиты или только тратить внутри).

**Денежное правило, зашитое в код:** арендатор платит **ровно** авторскую сумму, AIAG берёт с аренды **0%**. AIAG зарабатывает на наценке за модель + платных тулзах + деплое — **не** на цене автора.

---

## 1. Модель данных

Две новые таблицы. Обе используют конвенцию TMA: ключ — `tg_user_id BIGINT` (как у `agents`), **НЕ** `users(id)` (это веб-сторона, рубли). Никаких новых таблиц баланса — деньги автора живут в уже существующем `tg_user_balances.balance_credits`.

### 1.1 `agent_templates` — опубликованная настройка (спека БЕЗ секретов)

Шаблон = **спека агента**: персона, промпт, модель, тулзы, MCP-дефиниции, рекомендуемые скиллы. **Ни одного `*_encrypted` / `*_hint` столбца** — секрет физически не может попасть в шаблон, потому что для него нет колонки. Памяти, знаний и истории тут тоже нет (они в отдельных таблицах `agent_memory` / `agent_runs`, на которые шаблон не ссылается).

```sql
-- migration 0031_agent_templates.sql (применяется на проде вручную, sudo -u postgres psql aiag)
CREATE TABLE IF NOT EXISTS agent_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_tg_user_id   BIGINT NOT NULL,            -- совпадает с agents.tg_user_id
  source_agent_id     UUID NULL,                  -- провенанс: из какого агента опубликовано
  parent_template_id  UUID NULL,                  -- lineage / ремикс (s36), single-hop

  -- ШАРИМ (публичная спека) ----------------------------------------------
  name                TEXT NOT NULL,
  description         TEXT NULL,
  system_prompt       TEXT NOT NULL,              -- персона / промпт
  tools               JSONB NOT NULL DEFAULT '[]',-- скиллы + тулзы (defs)
  model_slug          TEXT NULL,                  -- ТОЛЬКО имя модели
  connection_type     VARCHAR(24) NOT NULL DEFAULT 'aiag', -- ТИП связи, не ключ
  mcp_endpoint_url    TEXT NULL,                  -- MCP-дефиниция (публичный URL; приватный — автор сам опускает)
  suggested_skills    JSONB NOT NULL DEFAULT '[]',-- рекомендуемые скиллы

  -- ДЕНЬГИ / ДОСТУП ------------------------------------------------------
  price_credits       BIGINT NULL,                -- NULL = бесплатно; иначе авторская аренда (US-центы)
  rent_period         VARCHAR(16) NULL,           -- 'month' | 'deploy' | 'use' (NULL если бесплатно)
  visibility          VARCHAR(16) NOT NULL DEFAULT 'private', -- 'private' (draft) | 'public' | 'unlisted'

  clone_count         INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_templates_public
  ON agent_templates(visibility, created_at DESC) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS idx_templates_author
  ON agent_templates(author_tg_user_id, created_at DESC);
```

**Почему ровно эти столбцы шарятся** (из ресёрча wave1-1, маппинг на колонки `agents`): `system_prompt`, `tools`, `model_slug`, `connection_type` (только тип), `mcp_endpoint_url` (только def) — публичны. А `external_api_key_encrypted`, `external_api_key_hint`, `mcp_auth_encrypted` — **отсутствуют в схеме шаблона by design**. Это «share-spec, keep-secrets» на уровне самой таблицы, а не на уровне аккуратного SELECT.

**`price_credits NULL = бесплатно.** Это явная семантика: NULL ⇒ автор не назначил цену ⇒ `settleRent` никогда не вызывается. Любое значение должно быть `> 0` (см. адверсариальный раздел про ноль/негатив).

### 1.2 `template_rentals` — аренды / entitlements

Кто что арендовал, когда, до какого срока (для месячной подписки), и в каком статусе. Это «право пользоваться» (entitlement); сам клон-агент создаётся отдельно при аренде и привязывается к ренту.

```sql
-- та же migration 0031
CREATE TABLE IF NOT EXISTS template_rentals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         UUID NOT NULL REFERENCES agent_templates(id),
  renter_tg_user_id   BIGINT NOT NULL,
  author_tg_user_id   BIGINT NOT NULL,            -- денормализовано: автор на момент аренды
  cloned_agent_id     UUID NULL,                  -- агент-клон, который получил арендатор
  price_credits       BIGINT NOT NULL,            -- зафиксированная цена на момент аренды
  rent_period         VARCHAR(16) NOT NULL,       -- 'month' | 'deploy' | 'use'
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NULL,           -- для 'month'; NULL для разовых
  status              VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'cancelled'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rentals_renter
  ON template_rentals(renter_tg_user_id, status);
```

### 1.3 `rent_charges` — якорь идемпотентности денежного движения

Каждое **списание за аренду** — отдельная строка с UUID, который служит `ref_id` для двух записей реестра. Это то, что делает выплату ровно-однократной (см. §2).

```sql
-- та же migration 0031
CREATE TABLE IF NOT EXISTS rent_charges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_id           UUID NOT NULL REFERENCES template_rentals(id),
  renter_tg_user_id   BIGINT NOT NULL,
  author_tg_user_id   BIGINT NOT NULL,
  amount_credits      BIGINT NOT NULL,            -- > 0, US-центы
  status              VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending' | 'settled'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at          TIMESTAMPTZ NULL
);
```

### 1.4 Выплата автору — БЕЗ новой таблицы баланса

Доход автора уходит в **тот же** `tg_user_balances.balance_credits` (BIGINT, US-центы), из которого арендатор списывается, и **тот же** `tg_ledger_entries` пишет аудит. Автор — это просто ещё один `tg_user`. Поэтому:

- **дебет арендатора** = `UPDATE tg_user_balances SET balance_credits = balance_credits - amount WHERE tg_user_id = renter AND balance_credits >= amount RETURNING …` (паттерн `settleRun`);
- **кредит автора** = `INSERT … ON CONFLICT (tg_user_id) DO UPDATE SET balance_credits = balance_credits + EXCLUDED …` (паттерн topup-check; upsert, потому что у нового автора строки баланса может ещё не быть);
- две записи в `tg_ledger_entries` с **одним** `ref_id` (= `rent_charges.id`) и **разным** `kind` (`rent_debit` / `rent_credit`). Уникальный индекс `uq_ledger_ref(ref_kind, ref_id, kind)` позволяет обеим строкам сосуществовать и делает каждую идемпотентной.

Новые значения enum (колонки `VARCHAR(24)` без DB-level CHECK, ALTER не требуется — только задокументировать): `kind ∈ {'rent_debit','rent_credit'}`, `ref_kind = 'rent_charge'`.

---

## 2. Потоки

### 2.1 Publish (опубликовать шаблон)

`POST /api/tma/agents/[id]/publish` — снимок спеки агента минус секреты.

1. `loadAgent(id, tgUserId)` — гард владения (уже есть в `[id]/route.ts:46`). Только владелец публикует своего агента.
2. Скопировать **share-subset** колонок в `agent_templates`: `name`, `description`, `system_prompt`, `tools`, `model_slug`, `connection_type`, `mcp_endpoint_url`, `suggested_skills`.
3. **Явно НЕ копировать** `external_api_key_encrypted`, `external_api_key_hint`, `mcp_auth_encrypted` — для них в целевой таблице **нет колонок**, так что утечка структурно невозможна.
4. Из тела запроса: `price_credits` (NULL=бесплатно), `rent_period`, `visibility` (по умолчанию `'private'` — публикация = осознанный шаг к `'public'`).
5. `source_agent_id = id`, `parent_template_id` = lineage родителя, если этот агент сам клон.

### 2.2 Browse / discover (витрина)

`GET /api/tma/templates` (список `WHERE visibility='public'`) + `GET /api/tma/templates/[id]` (одна спека). Зеркалит `app/api/tma/marketplace/route.ts` (готовый read-only-каталожный паттерн), но по `agent_templates`. Это питает галерею s14 и ленту «Для тебя» s03 вместо зашитого `AGENT_TEMPLATES`. Отдаём **только публичные** поля; цену показываем как `price_credits`/`rent_period` (или «бесплатно» при NULL).

### 2.3 Clone-free (бесплатный клон) — СРЕЗ 1

`POST /api/tma/templates/[id]/clone` — инверсия публикации, **без денег**.

1. `SELECT` шаблон; разрешён, только если `visibility='public'` **и** (`price_credits IS NULL` — бесплатный). Платный клон в Срезе 1 запрещён (вернуть `402 rent_required`).
2. `INSERT INTO agents` для `tg_user_id` **вызывающего** — ровно той же формой INSERT, что в `agents/route.ts:165`. Все `*_encrypted` остаются NULL ⇒ клонёр подставит свой ключ через существующий BYOK-flow (`PATCH …/[id]`).
3. `parent_template_id` шаблона → для lineage; `clone_count = clone_count + 1`.
4. Клон по умолчанию садится на `connection_type='aiag'` (наш gateway), пока клонёр не подключит свой провайдер.

### 2.4 Rent-paid (платная аренда + выплата автору) — СРЕЗ 2

Это денежный поток. Порядок: сначала создаём `template_rentals` + `rent_charges(status='pending')`, потом атомарно проводим `settleRent`, потом клонируем агента арендатору.

**Атомарная форма `settleRent`** (хелпер в `apps/agent-worker/src/db.ts`, рядом с `settleRun`):

```ts
export async function settleRent(args: {
  chargeId: string;      // uuid — rent_charges.id, служит ledger ref_id
  renterId: string;      // tg_user, который платит
  authorId: string;      // tg_user, который получает (должен отличаться — см. §6)
  amountCredits: number; // целое, US-центы, > 0
}): Promise<void> {
  const { chargeId, renterId, authorId, amountCredits } = args;

  // дешёвые гарды ДО открытия транзакции (fail-fast, без захвата локов):
  if (!Number.isInteger(amountCredits) || amountCredits <= 0) throw new Error('rent_amount_invalid');
  if (renterId === authorId) throw new SelfDealError();

  await sql.begin(async (sql) => {
    // a) claim charge: статус в WHERE = concurrency-guard; 0 строк ⇒ уже проведено ⇒ выходим
    const claim = await sql`
      UPDATE rent_charges SET status='settled', settled_at=NOW()
      WHERE id=${chargeId}::uuid AND status='pending' RETURNING id::text`;
    if (claim.length === 0) return; // идемпотентно: конкурент уже провёл

    // b) ГАРДИРОВАННЫЙ ДЕБЕТ арендатора (over-spend-safe)
    const debit = await sql`
      UPDATE tg_user_balances SET balance_credits = balance_credits - ${amountCredits}, updated_at=NOW()
      WHERE tg_user_id=${renterId}::bigint AND balance_credits >= ${amountCredits}
      RETURNING balance_credits::text AS balance_credits`;
    if (debit.length === 0) throw new InsufficientBalanceError(); // ROLLBACK всего

    // c) UPSERT-КРЕДИТ автора (создаёт строку, если у автора её ещё нет); 100% pass-through
    const credit = await sql`
      INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
      VALUES (${authorId}::bigint, ${amountCredits}::bigint, NOW())
      ON CONFLICT (tg_user_id) DO UPDATE
        SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits, updated_at=NOW()
      RETURNING balance_credits::text AS balance_credits`;

    // d) ДВЕ записи реестра: ОДИН ref_id (charge), РАЗНЫЙ kind. Индекс (ref_kind,ref_id,kind) = идемпотентность.
    await sql`INSERT INTO tg_ledger_entries (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES (${renterId}::bigint, ${-amountCredits}, 'rent_debit', 'rent_charge', ${chargeId}::uuid, ${debit[0]!.balance_credits}::bigint)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING`;
    await sql`INSERT INTO tg_ledger_entries (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES (${authorId}::bigint, ${amountCredits}, 'rent_credit', 'rent_charge', ${chargeId}::uuid, ${credit[0]!.balance_credits}::bigint)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING`;
  });
}
```

После успешного `settleRent`: `INSERT INTO agents` клона арендатору (как в clone-free), `UPDATE template_rentals SET cloned_agent_id=…, status='active'`. Клон уже привязан к ключам/кошельку арендатора (его BYOK или наш gateway) — автор не получает доступа к ключам арендатора, а арендатор не получает секретов автора.

**Денежное правило в коде:** `delta_credits` кредита автора = `-delta_credits` дебета арендатора, точно. AIAG не берёт ничего с этой пары — сумма пары = 0 (сохранение). Доход AIAG = наценка модели + тулзы + деплой, на отдельных линиях, не здесь.

---

## 3. Денежное правило (зашитое)

| Линия | Кто назначает | Куда идёт |
|---|---|---|
| Использование модели | наценка AIAG на `:4000` | **доход AIAG** (BYOK/свой провайдер ⇒ 0) |
| Платные тулзы | наценка AIAG (брокер) | **доход AIAG** |
| Деплой / runtime | плата AIAG за инфру | **доход AIAG** |
| **Авторская аренда** | **точная сумма автора** | **автору целиком (pass-through, 0% AIAG)** |

Инвариант, который должен держать код: в `settleRent` две записи реестра **равны и противоположны**; никакой линии «platform_fee» в паре нет. Если когда-нибудь основатель захочет комиссию — это будущее решение и **третья** запись, а не урезание авторской.

---

## 4. Разбивка по срезам

### Срез 1 — publish + browse + clone-FREE (БЕЗ денежного пути, низкий риск, выпускаем первым)

Не касается `tg_user_balances`, `tg_ledger_entries`, `agent-worker`, `settleRun`. Только перенос спек-колонок между `agents` и новой `agent_templates`. Это и есть первый отгружаемый кусок.

**EXACT файлы — создать:**

1. `packages/database/migrations/0031_agent_templates.sql` — таблицы `agent_templates`, `template_rentals`, `rent_charges` (в Срезе 1 пишется только `agent_templates`; две другие создаём сразу, чтобы не плодить миграции, но не используем до Среза 2). Применять вручную на проде: `sudo -u postgres psql aiag -f 0031_agent_templates.sql`.
2. `apps/tg-miniapp/app/api/tma/agents/[id]/publish/route.ts` — `POST`. Reuse `loadAgent` + `postgres`-клиент из того же каталога. Копирует share-subset в `agent_templates`, выставляет `visibility`, `price_credits`, `rent_period`. Сосед `PATCH`/`DELETE`.
3. `apps/tg-miniapp/app/api/tma/templates/route.ts` — `GET`, список `WHERE visibility='public'` (зеркало `marketplace/route.ts`).
4. `apps/tg-miniapp/app/api/tma/templates/[id]/route.ts` — `GET`, одна публичная спека.
5. `apps/tg-miniapp/app/api/tma/templates/[id]/clone/route.ts` — `POST`, бесплатный клон (та же форма INSERT, что `agents/route.ts:165`); платные шаблоны → `402 rent_required`.
6. `apps/tg-miniapp/app/templates/page.tsx` — витрина (Server Component, потребляет `GET /api/tma/templates`); карточки в дизайн-языке коллекционных карт (DESIGN.md, per-character hue), статус-пилл `live`.
7. `apps/tg-miniapp/app/templates/[id]/page.tsx` — детальная спека + кнопка «Клонировать» (бесплатно) / для платных пока `скоро`-пилл до Среза 2.

**EXACT файлы — изменить:**

8. `apps/tg-miniapp/app/agents/[id]/page.tsx` — добавить кнопку «Опубликовать» (вызывает `…/publish`), вторичная (ghost), одна amber-CTA на экран остаётся за RUN.
9. `apps/tg-miniapp/app/agents/page.tsx` (или `app/(tabs)`/нав) — пункт «Шаблоны» в навигации к витрине `/templates`.
10. `apps/tg-miniapp/src/lib/agent-templates.ts` — **оставить как fallback**, но галерею «Из шаблона» (s14) переориентировать на `GET /api/tma/templates`; хардкод-6 остаются seed-ом каталога, не единственным источником.

**Гарды Среза 1 (без денег, но не без безопасности):** publish только владельцем; clone только публичного бесплатного; `visibility` дефолт `private`; никаких `*_encrypted` в ответах витрины; `system_prompt`/`name` ограничить длиной как в create-route (8000/200).

> Координационная заметка для реализации: миграция `0029` переименовала `budget_rub_monthly → budget_credits_monthly` и `cost_rub → cost_credits`, но текущий код агентов (`agents/route.ts`, `[id]/route.ts`) ещё читает старые имена `budget_rub_monthly`/`cost_rub`. Значит на проде либо `0029` ещё не накатана, либо код отстал. **Перед Срезом 1 свериться, что живёт на VPS** (см. `packages/database/CLAUDE.md`: миграции ручные, untracked). Срез 1 сам по себе не трогает эти колонки, но publish/clone копируют бюджет — использовать **то же имя**, что реально на проде, иначе INSERT упадёт.

### Срез 2 — rent-paid + author payout (денежный поток)

Активирует `template_rentals` + `rent_charges`, добавляет `settleRent` в `apps/agent-worker/src/db.ts`, и `POST /api/tma/templates/[id]/rent`, который создаёт rental+charge и зовёт `settleRent`. Идемпотентность через `uq_ledger_ref`. BYOK-исключение: клон на своём ключе не даёт AIAG наценки за модель (правило `if (isExternal) return` остаётся). Самосделка и ноль/негатив — гарды до транзакции (§6). Это **money-path slice — осторожно, deploy + верификация на VPS**, не локально.

### Срез 3 — экран дохода автора + вывод (gated на FD-2)

Экран s34: карточки «арендаторов / клоны / доход», список аренд, кнопка «Вывести доход → баланс». **Заблокирован до решения основателя FD-2** (withdrawable vs non-withdrawable credits — лицензионные/юрисдикционные последствия, legal «not factored now»). До FD-2 показываем доход автора как **внутренний spendable-баланс** (он и так уже в `tg_user_balances` — автор может тратить на свои ранане/аренды), но **без кэш-аута**. Анти-абьюз ранжирование (по distinct funded renters, dust-floor, single-hop) — здесь же.

---

## 5. Технический раздел (для исполнителя)

### 5.1 Конвенции, которые нельзя нарушать
- Ключ TMA-мира — `tg_user_id BIGINT`, **не** `users(id)`. `0014_contest_marketplace.sql` (веб, рубли, `users(id)` UUID) — **референс механики accrual, но НЕ переиспользовать** напрямую.
- Деньги: только `UPDATE … WHERE <guard> RETURNING` + upsert для кредита. READ COMMITTED, без SERIALIZABLE/40001-retry. `/SECURITY.md`, `packages/database/CLAUDE.md`.
- Idempotency `ref_id` — **всегда UUID** (`rent_charges.id`). NULL `ref_id` отключает `uq_ledger_ref` ⇒ никогда не оставлять NULL для денежных записей.
- Один `ref_id` на пару debit+credit, различие по `kind`. Не использовать `agent_run.id` как ref для аренды.
- Секреты: `agent_templates` физически без `*_encrypted`/`*_hint` колонок. Витрина не отдаёт ничего, кроме публичной спеки.
- Миграции на проде — **ручные, untracked**, ALTER через `sudo -u postgres psql aiag`. Сверять реальное состояние VPS перед накатом.
- Next в tg-miniapp **прибит к 14.2.33** (CVE-2025-29927) — не двигать. basePath `/tg`, health `/tg/health`.
- Сборка tg-miniapp — **вручную на VPS**, CI её не собирает. Не поднимать локальный runtime; верифицировать на проде (`aiag-deploy`).

### 5.2 Опорные файлы (load-bearing)
- `apps/tg-miniapp/app/api/tma/agents/route.ts:165` — форма INSERT для клона.
- `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:46` — `loadAgent` ownership-гард (reuse для publish).
- `apps/tg-miniapp/app/api/tma/marketplace/route.ts` — read-only-каталог-паттерн (зеркалить для templates).
- `apps/agent-worker/src/db.ts` — `settleRun` (дебет, ~:381-402) + откуда брать паттерн `settleRent`.
- `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:149-156` — upsert-кредит-паттерн (для кредита автора).
- `packages/database/migrations/0029_usd_ledger.sql:102-116` — `tg_ledger_entries` + `uq_ledger_ref`.
- `docs/wireframes/tma/index.html` — s05 (карточка), s14 (галерея), s34 (доход), s35 (publish), s36 (ремикс).

---

## 6. Адверсариальный раздел (что может сломать деньги/безопасность)

1. **Атомарность выплаты.** Все четыре записи (claim, debit, credit, 2× ledger) — в **одном** `sql.begin`. Любой throw авто-ROLLBACK-ит всё: автор не может быть прокредитован без дебета арендатора, и наоборот. Дебет арендатора — гардированный `WHERE balance_credits >= amount RETURNING`; 0 строк ⇒ throw ⇒ rollback ⇒ автор НЕ прокредитован. *Lock-ordering-оговорка:* если два разных charge одновременно затронут одну пару юзеров в противоположных ролях — возможен deadlock; для масштаба перейти на **author-payout sweep** (дебет арендатора и кредит автора — два прохода), оба идемпотентны через `uq_ledger_ref`. На низком объёме single-tx ок.

2. **Предотвращение самосделки.** `if (renterId === authorId) throw new SelfDealError()` **до** транзакции. Без этого автор фармит ранг/доход арендой у себя, а debit+credit одной строки `tg_user_balances` — в лучшем случае churn, в худшем deadlock/lost-update. Belt-and-suspenders: создатель `rent_charges` отказывается создавать charge, где `renter = template.author_tg_user_id`. Ранг защищён дополнительно — считаем по **distinct funded renters**.

3. **Двойная оплата / идемпотентность.** Два слоя: (a) claim-гард `UPDATE rent_charges … WHERE status='pending' RETURNING` — ретрай видит `settled`, 0 строк, выходит; (b) `ON CONFLICT (ref_kind,ref_id,kind) DO NOTHING` на обеих ledger-записях — даже при частичном реплее повтор вставки = no-op. Один `ref_id` (UUID charge) на пару, различие по `kind`. **Никогда** не оставлять `ref_id` NULL (отключает индекс).

4. **Утечка секрета в опубликованной спеке.** Структурная защита: в `agent_templates` **нет** колонок `external_api_key_encrypted` / `external_api_key_hint` / `mcp_auth_encrypted` — секрет некуда записать. Publish копирует только whitelisted share-subset; никогда не `SELECT *` из `agents`. Витрина (`GET /templates`) отдаёт только публичные поля. `agent_memory` / `agent_runs` шаблон не трогает (нет FK). Дополнительно: при копировании `mcp_endpoint_url` показать автору в publish-sheet, что URL станет публичным (s35), чтобы он мог опустить приватный инфра-URL.

5. **Негативная / нулевая цена.** `if (!Number.isInteger(amountCredits) || amountCredits <= 0) throw`. **Негатив** инвертировал бы гардированный дебет (`balance − (−x) = balance + x`) в over-credit, который тривиально проходит `>= amount` — эксплойт вывода. **Ноль** пишет две нулевые ledger-строки и грязнит аудит. На уровне публикации: `price_credits` либо `NULL` (бесплатно ⇒ `settleRent` не зовётся вообще), либо `> 0`. На уровне API publish валидировать `price_credits` (целое, в разумных пределах, например ≤ 100000 центов = $1000) до записи.

6. **Автор удалил аккаунт.** Сценарии и реакция: (a) **в момент аренды** — `author_tg_user_id` денормализован в `rent_charges`/`template_rentals`, кредит делается **upsert**-ом, так что строка баланса автора создастся, даже если автор «исчез» из других таблиц; деньги не теряются и не зависают. (b) **существующие клоны** продолжают работать — клон самодостаточен (своя спека + ключи арендатора), не зависит от живого автора. (c) **шаблон** — при удалении аккаунта переводим его шаблоны в `visibility='private'` (снять с витрины), но строки **не каскадим** в ноль: `template_rentals`/`rent_charges` ссылаются на них для аудита; FK без `ON DELETE CASCADE`. (d) **накопленный доход** удалённого автора остаётся в `tg_user_balances` как orphan-баланс — политика его судьбы (сжечь/заморозить/вернуть) — это **FD-2-смежный вопрос основателя**, не блокирует Срез 1/2. Не реализовывать «hard delete автора» так, чтобы он рушил FK денежных строк.

---

## Итоговое summary (5 предложений)

Модель данных — три новые таблицы на ключе `tg_user_id BIGINT`: `agent_templates` (спека агента БЕЗ единого секретного столбца — персона, промпт, модель, тулзы, MCP-деф, рекомендуемые скиллы, `author_tg_user_id`, `price_credits NULL=бесплатно`, `visibility`), `template_rentals` (арендатор, шаблон, `started_at`/`expires_at`, статус) и `rent_charges` (UUID-якорь идемпотентности), при этом доход автора уходит в **уже существующий** `tg_user_balances.balance_credits` + `tg_ledger_entries`, без новой таблицы баланса. Атомарная выплата `settleRent` — в одном `sql.begin`: claim-гард charge → гардированный дебет арендатора (`WHERE balance_credits >= amount RETURNING`) → upsert-кредит автора (`ON CONFLICT DO UPDATE`) → две записи реестра с одним `ref_id` и разным `kind` (`rent_debit`/`rent_credit`), идемпотентные через `uq_ledger_ref(ref_kind,ref_id,kind)`. Денежное правило зашито инвариантом «пара записей равна и противоположна»: арендатор платит ровно авторскую сумму, AIAG берёт 0% с аренды и зарабатывает только на наценке модели + тулзах + деплое. Срез 1 — это **публикация + витрина + БЕСПЛАТНЫЙ клон, без денежного пути вообще**: новая миграция `0031_agent_templates.sql` плюс routes `…/agents/[id]/publish`, `…/templates`, `…/templates/[id]`, `…/templates/[id]/clone` и страницы `/templates` + `/templates/[id]`, переиспользуя `loadAgent`-гард и форму INSERT из существующего create-route — низкий риск, отгружаем первым. Адверсариальные риски (атомарность, самосделка, двойная оплата, утечка секрета, ноль/негатив, удаление автора) закрыты структурно (нет секретных колонок в шаблоне), гардами до транзакции и денормализацией `author_tg_user_id` + upsert, чтобы деньги не терялись.
