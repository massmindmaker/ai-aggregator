# Gateway Money-Leak Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать невозможным расход наших денег на апстрим без авторизованного баланса — до включения чат-прокси и приёма оплаты.

**Architecture:** Гейтвей сейчас зовёт апстрим ПЕРВЫМ, а списывает ПОТОМ (`chat.ts:92-138`), и в цепочке мидлварей (`server.ts:73-77`) **нет проверки баланса вообще**. Закрываем тремя приёмами по типу запроса: (1) **чат/эмбеддинги** — переменная стоимость → пред-проверка баланса до вызова апстрима + существующий атомарный settle после; (2) **медиа** (images/video/audio) — цена детерминирована (`price_per_image` фиксирована) → **списываем ДО** submit'а, возвращаем при отказе апстрима; (3) **стрим** — перестаём глотать ошибку списания + пишем счётчик `usd_day`, который сейчас недостижим. Плюс операционка: закрыть публичный плейграунд и проставить капы существующим ключам.

**Tech Stack:** Hono/Bun (`packages/api-gateway`), Postgres (stored fn `aiag_settle_charge_credits`), Redis (счётчики/кэш), vitest/bun test.

## Global Constraints

- 🔴 **Prerequisite:** ветка `task/t1-t2-credit-ledger` (переделка юнита) **должна быть влита первой**. Этот план строится на: кредит = 1 цент, хранение в **BIGINT микро-кредитах (1/1000 цента)**, функция **`aiag_settle_charge_credits`**, формула `micro = round(колонка × markup × batch × caching × 1000)`. Без неё математика здесь будет неверной.
- **Ценовая колонка `model_upstreams.price_per_1k_*` / `price_per_image` = ЦЕНТЫ (USD × 100), НЕ рубли и НЕ USD.** Никогда не умножать на курс. Настоящий USD = `колонка / 100`. См. `docs/canon/AIAG-CANON.md` + memory `project_price_column_is_cents_not_usd`.
- **Не переименовывать** micro-USD заголовок для TMA и не менять деление `/10_000` на стороне `apps/agent-worker` — контракт зафиксирован тестом `apps/agent-worker/src/__tests__/billing-100x-anchor.test.ts`.
- SQL — только prepared statements. Денежные операции — атомарно (`UPDATE … WHERE <guard> RETURNING`).
- Не ломать: BYOK = нулевое списание (`if (isExternal) return`); dual-bucket порядок subscription→payg; expiry-логику.
- White-label: никаких имён апстримов в ответах/ошибках клиенту.
- Никаких новых зависимостей.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `packages/api-gateway/src/lib/cost-estimate.ts` | **создать** — оценка стоимости запроса в микро-кредитах ДО вызова апстрима (чат: по max_tokens; медиа: точная цена операции) |
| `packages/api-gateway/src/middleware/require-balance.ts` | **создать** — мидлварь: отклонить 402, если баланс < оценки |
| `packages/api-gateway/src/server.ts:73-77` | **править** — вставить `requireBalance` в цепочку `/v1/*` после `keyLimits` |
| `packages/api-gateway/src/routes/v1/{images,video,audio}.ts` | **править** — списывать ДО submit, возвращать при отказе |
| `packages/api-gateway/src/streaming/sse.ts:118-130` | **править** — не глотать ошибку settle; писать `usd_day` |
| `packages/api-gateway/src/routes/v1/chat.ts:144-146` | **править** — вынести запись `usd_day` в общее место (сейчас недостижима для стрима) |
| `apps/web/src/app/api/playground/run/route.ts` | **править** — закрыть анонимный доступ |
| `packages/api-gateway/src/__tests__/money-leak.test.ts` | **создать** — якоря против всех шести P0 |

---

### Task 1: Оценщик стоимости (`cost-estimate.ts`)

**Files:**
- Create: `packages/api-gateway/src/lib/cost-estimate.ts`
- Test: `packages/api-gateway/src/__tests__/cost-estimate.test.ts`

**Interfaces:**
- Consumes: `calcCostCredits` из `packages/api-gateway/src/lib/pricing.ts` (после переделки T1/T2 возвращает микро-кредиты), тип модели/апстрима из `resolver.ts`.
- Produces:
  - `estimateChatMicro(args: { priceInputCents: number; priceOutputCents: number; markup: number; promptTokens: number; maxTokens: number }): number` — верхняя оценка микро-кредитов.
  - `exactMediaMicro(args: { pricePerOpCents: number; markup: number; count: number }): number` — точная стоимость медиа-операции.

- [ ] **Step 1: Прочитать текущий `pricing.ts`**

Прочитай `packages/api-gateway/src/lib/pricing.ts` после переделки T1/T2. Убедись: функция возвращает **микро-кредиты**, колонка трактуется как **центы**, умножения на `rate` НЕТ. Если это не так — **СТОП, план построен на T1/T2, сообщи координатору.**

- [ ] **Step 2: Написать падающий тест**

```ts
// packages/api-gateway/src/__tests__/cost-estimate.test.ts
import { describe, it, expect } from 'vitest';
import { estimateChatMicro, exactMediaMicro } from '../lib/cost-estimate';

describe('cost-estimate', () => {
  // Якорь юнита: колонка = ЦЕНТЫ (USD×100). Sonnet = 0.30/1.50 за 1k = $3/$15 за 1M.
  it('chat: оценивает по ВЕРХНЕЙ границе (max_tokens), markup 1.8', () => {
    // 1k prompt + до 500 output: (0.30 + 0.5*1.50) * 1.8 * 1000 = 1890 микро
    expect(
      estimateChatMicro({
        priceInputCents: 0.30, priceOutputCents: 1.50,
        markup: 1.8, promptTokens: 1000, maxTokens: 500,
      }),
    ).toBe(1890);
  });

  it('chat: РЕГРЕСС-ЯКОРЬ — не 100× (баговая версия дала бы 189000)', () => {
    const v = estimateChatMicro({
      priceInputCents: 0.30, priceOutputCents: 1.50,
      markup: 1.8, promptTokens: 1000, maxTokens: 500,
    });
    expect(v).toBeLessThan(10_000);
  });

  it('media: точная цена операции (dalle-3 = 4.0 центов = $0.04)', () => {
    // 4.0 * 1.8 * 1000 = 7200 микро = 7.2 кредита
    expect(exactMediaMicro({ pricePerOpCents: 4.0, markup: 1.8, count: 1 })).toBe(7200);
  });

  it('media: count множит', () => {
    expect(exactMediaMicro({ pricePerOpCents: 4.0, markup: 1.8, count: 3 })).toBe(21600);
  });

  it('оценка никогда не отрицательна и не NaN', () => {
    expect(estimateChatMicro({
      priceInputCents: 0, priceOutputCents: 0, markup: 1.8, promptTokens: 0, maxTokens: 0,
    })).toBe(0);
  });
});
```

- [ ] **Step 3: Прогнать — убедиться, что падает**

Run: `cd packages/api-gateway && bunx vitest run src/__tests__/cost-estimate.test.ts`
Expected: FAIL — `Cannot find module '../lib/cost-estimate'`

- [ ] **Step 4: Реализовать минимум**

```ts
// packages/api-gateway/src/lib/cost-estimate.ts
//
// Оценка стоимости ДО вызова апстрима — чтобы никогда не тратить деньги
// на апстрим при недостаточном балансе.
//
// 🔴 ЮНИТ: price_*Cents — это ЦЕНТЫ (колонка БД = USD × 100). НЕ рубли, НЕ USD.
// Курс валют здесь не участвует. Настоящий USD = центы / 100.
// Микро-кредит = 1/1000 цента; кредит = 1 цент.

const MICRO_PER_CENT = 1000;

/**
 * Верхняя оценка стоимости чат-запроса в микро-кредитах.
 * Берём max_tokens как худший случай по output — реальный settle
 * пересчитает по факту и спишет точно.
 */
export function estimateChatMicro(args: {
  priceInputCents: number;
  priceOutputCents: number;
  markup: number;
  promptTokens: number;
  maxTokens: number;
}): number {
  const inputCents = (args.priceInputCents * args.promptTokens) / 1000;
  const outputCents = (args.priceOutputCents * args.maxTokens) / 1000;
  const micro = (inputCents + outputCents) * args.markup * MICRO_PER_CENT;
  return Math.max(0, Math.round(micro));
}

/**
 * Точная стоимость медиа-операции в микро-кредитах.
 * У медиа цена детерминирована (за операцию), поэтому её можно списать
 * ДО отправки в апстрим — оценка не нужна.
 */
export function exactMediaMicro(args: {
  pricePerOpCents: number;
  markup: number;
  count: number;
}): number {
  const micro = args.pricePerOpCents * args.markup * args.count * MICRO_PER_CENT;
  return Math.max(0, Math.round(micro));
}
```

- [ ] **Step 5: Прогнать — зелёные**

Run: `cd packages/api-gateway && bunx vitest run src/__tests__/cost-estimate.test.ts`
Expected: PASS (5 тестов)

- [ ] **Step 6: Коммит**

```bash
git add packages/api-gateway/src/lib/cost-estimate.ts packages/api-gateway/src/__tests__/cost-estimate.test.ts
git commit -m "feat(gateway): add pre-upstream cost estimator in micro-credits"
```

---

### Task 2: Мидлварь пред-проверки баланса

**Files:**
- Create: `packages/api-gateway/src/middleware/require-balance.ts`
- Modify: `packages/api-gateway/src/server.ts` (цепочка `/v1/*`, около строк 73-77)
- Test: `packages/api-gateway/src/__tests__/require-balance.test.ts`

**Interfaces:**
- Consumes: `estimateChatMicro`/`exactMediaMicro` (Task 1); контекст ключа из `requireApiKey` (`c.get('key')` — прочитай `auth-plan04.ts`, чтобы узнать точное имя и форму); соединение с БД.
- Produces: `requireBalance` — Hono-мидлварь; при недостатке кидает клиентскую ошибку **402** через существующую таксономию `src/lib/client-errors.ts` (не изобретать новый формат).

- [ ] **Step 1: Прочитать чейн и форму ключа**

Прочитай `packages/api-gateway/src/server.ts:60-90` (цепочка `/v1/*`) и `packages/api-gateway/src/middleware/auth-plan04.ts` — как кладётся ключ/org в контекст, как устроены `requireApiKey`, `rateLimit`, `keyLimits`. Прочитай `src/lib/client-errors.ts` — какой хелпер даёт 402. **Не выдумывай имена — используй существующие.**

- [ ] **Step 2: Написать падающий тест**

```ts
// packages/api-gateway/src/__tests__/require-balance.test.ts
import { describe, it, expect, vi } from 'vitest';
import { hasEnoughBalance } from '../middleware/require-balance';

describe('require-balance', () => {
  it('пропускает: баланс покрывает оценку', () => {
    expect(hasEnoughBalance({ subscriptionMicro: 5000, paygMicro: 0, estimateMicro: 1890 })).toBe(true);
  });

  it('пропускает: суммы двух бакетов хватает', () => {
    expect(hasEnoughBalance({ subscriptionMicro: 1000, paygMicro: 1000, estimateMicro: 1890 })).toBe(true);
  });

  it('🔴 P0: НУЛЕВОЙ баланс — отказ (это и есть утечка)', () => {
    expect(hasEnoughBalance({ subscriptionMicro: 0, paygMicro: 0, estimateMicro: 1 })).toBe(false);
  });

  it('отказ: баланса не хватает на оценку', () => {
    expect(hasEnoughBalance({ subscriptionMicro: 500, paygMicro: 500, estimateMicro: 1890 })).toBe(false);
  });

  it('нулевая оценка при нулевом балансе — пропускаем (бесплатный вызов)', () => {
    expect(hasEnoughBalance({ subscriptionMicro: 0, paygMicro: 0, estimateMicro: 0 })).toBe(true);
  });
});
```

- [ ] **Step 3: Прогнать — падает**

Run: `cd packages/api-gateway && bunx vitest run src/__tests__/require-balance.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 4: Реализовать чистую функцию + мидлварь**

```ts
// packages/api-gateway/src/middleware/require-balance.ts
//
// 🔴 P0-фикс: до этой мидлвари гейтвей звал апстрим ПЕРВЫМ и списывал ПОТОМ.
// При нулевом балансе апстрим отрабатывал (мы платили), settle бросал
// INSUFFICIENT_FUNDS, юзер получал 402 — а наши деньги уже ушли. Бесконечно.
// Теперь: оцениваем стоимость и отказываем ДО расхода.

/** Чистая функция — вся логика решения, тестируется без БД/Hono. */
export function hasEnoughBalance(args: {
  subscriptionMicro: number;
  paygMicro: number;
  estimateMicro: number;
}): boolean {
  if (args.estimateMicro <= 0) return true;
  return args.subscriptionMicro + args.paygMicro >= args.estimateMicro;
}
```

Затем мидлварь `requireBalance` в этом же файле:
- читает org из контекста (имя — из Step 1);
- 🔴 **BYOK/external — пропускать без проверки** (они платят своему провайдеру, у нас списания нет; найди существующий признак — тот же, что даёт `if (isExternal) return` в settle);
- SELECT баланса org (prepared);
- считает оценку: для медиа — `exactMediaMicro`, для чата — `estimateChatMicro` (`max_tokens` из тела; если не задан — возьми потолок модели из реестра, а если и его нет — конфигурируемый дефолт, НЕ ноль: ноль означал бы «бесплатно»);
- `hasEnoughBalance` → false → **402** через хелпер из `client-errors.ts`, сообщение нейтральное («Недостаточно кредитов»), **без имени апстрима**.

- [ ] **Step 5: Прогнать — зелёные**

Run: `cd packages/api-gateway && bunx vitest run src/__tests__/require-balance.test.ts`
Expected: PASS (5 тестов)

- [ ] **Step 6: Вставить в цепочку**

В `packages/api-gateway/src/server.ts` — добавить `requireBalance` в `/v1/*` **после** `keyLimits` и **до** роутов. Порядок важен: сперва аутентификация ключа, потом лимиты ключа, потом баланс.

- [ ] **Step 7: Полный прогон гейтвея**

Run: `cd packages/api-gateway && bun test`
Expected: все прежние тесты зелёные + новые. Если упал тест, ожидавший вызова апстрима при нулевом балансе — он фиксировал баг, **перепиши его честно**.

- [ ] **Step 8: Коммит**

```bash
git add packages/api-gateway/src/middleware/require-balance.ts packages/api-gateway/src/server.ts packages/api-gateway/src/__tests__/require-balance.test.ts
git commit -m "fix(gateway): reject /v1/* with 402 before spending upstream money on zero balance"
```

---

### Task 3: Медиа — списывать ДО апстрима

**Files:**
- Modify: `packages/api-gateway/src/routes/v1/images.ts` (около 62-98), `video.ts` (около 67-87), `audio.ts` (около 62-82)
- Test: `packages/api-gateway/src/__tests__/media-settle-upfront.test.ts`

**Interfaces:**
- Consumes: `exactMediaMicro` (Task 1); `aiag_settle_charge_credits` (T1/T2).
- Produces: поведение — списание до submit; возврат (компенсирующая запись) при отказе апстрима.

**Почему так:** сейчас `if (job.status === 'completed') { await settleCharge(...) }`, иначе 202 **без списания**. Роута дослать счёт (`GET /v1/images/jobs/:id`) **не существует** — док врёт, воркер `upstream-poll` = заглушка. Джоба дольше `KIE_SYNC_POLL_MS` (60с) — а veo/sora/kling генерятся 2-6 минут — **не тарифицируется никогда**. Апстрим выставляет нам ~$1.60/клип. Цена медиа детерминирована → списываем вперёд, проблема исчезает.

- [ ] **Step 1: Прочитать один роут целиком**

Прочитай `packages/api-gateway/src/routes/v1/images.ts`. Пойми: где submit, где поллинг, где `settleCharge`, где возврат 202, откуда берётся цена (`price_per_image`?), как узнаётся `count`/`n`.

- [ ] **Step 2: Написать падающий тест**

```ts
// packages/api-gateway/src/__tests__/media-settle-upfront.test.ts
import { describe, it, expect } from 'vitest';
import { exactMediaMicro } from '../lib/cost-estimate';

describe('media billing (upfront)', () => {
  it('🔴 P0-якорь: медленная джоба ДОЛЖНА быть оплачена (цена известна до submit)', () => {
    // kling/veo: price_per_image 25 центов = $0.25, markup 1.8
    const micro = exactMediaMicro({ pricePerOpCents: 25, markup: 1.8, count: 1 });
    expect(micro).toBe(45000); // 45 кредитов
    // Контракт: роут обязан списать это ДО submit'а, а не после completed.
  });
});
```

Плюс тест на возврат: если submit в апстрим бросил — компенсирующая запись возвращает те же микро (сумма списаний по джобе = 0).

- [ ] **Step 3: Прогнать — падает** (пока нет реализации возврата)

Run: `cd packages/api-gateway && bunx vitest run src/__tests__/media-settle-upfront.test.ts`

- [ ] **Step 4: Переписать порядок в трёх роутах**

Для `images.ts`, `video.ts`, `audio.ts`, каждый:
1. Посчитать `exactMediaMicro` по цене операции × `count`.
2. **Списать** через `aiag_settle_charge_credits` (тот же атомарный путь) — ДО submit'а.
3. Submit в апстрим.
4. Апстрим отказал/бросил → **компенсирующая запись** (вернуть списанное), идемпотентно по id джобы.
5. Дальше поллинг как есть; при `completed` — **НЕ списывать повторно** (уже списано). Убрать старый `settleCharge` из ветки completed.
6. 202 при таймауте поллинга — теперь **корректен**: деньги уже взяты, юзер заберёт результат своим поллингом.

🔴 Не трогать сам механизм поллинга и формат ответа (клиенты завязаны).

- [ ] **Step 5: Прогнать**

Run: `cd packages/api-gateway && bun test`
Expected: зелёные; тесты, ожидавшие «списание при completed», переписать под upfront.

- [ ] **Step 6: Обновить лживый докблок**

В `packages/api-gateway/src/upstreams/kie.ts:10-18` (и в докблоке `images.ts:10-11`) написано про «future internal `/v1/jobs/{id}` endpoint» и «poll status» — роута нет. **Исправить текст на правду** (upfront-биллинг, 202 = деньги уже списаны).

- [ ] **Step 7: Коммит**

```bash
git add packages/api-gateway/src/routes/v1/images.ts packages/api-gateway/src/routes/v1/video.ts packages/api-gateway/src/routes/v1/audio.ts packages/api-gateway/src/upstreams/kie.ts packages/api-gateway/src/__tests__/media-settle-upfront.test.ts
git commit -m "fix(gateway): bill media upfront — slow jobs were never charged at all"
```

---

### Task 4: Стрим — не глотать списание + починить счётчик

**Files:**
- Modify: `packages/api-gateway/src/streaming/sse.ts` (около 118-130, 146)
- Modify: `packages/api-gateway/src/routes/v1/chat.ts` (около 144-146 — запись `usd_day`)
- Test: `packages/api-gateway/src/__tests__/stream-settle.test.ts`

**Interfaces:**
- Consumes: существующий `settleCharge`, Redis-клиент.
- Produces: поведение — ошибка settle на стриме не проглатывается; счётчик `usd_day` инкрементится и на стриме.

**Почему так:** (а) `sse.ts:118-130` — `try { settleCharge } catch (e) { logger.error(...) }` → при нулевом балансе юзер получает **весь ответ бесплатно**, в лог капает `sse_settle_failed`. Это рабочий бесплатный LLM-прокси. (б) `usd_day` пишется **только** в `chat.ts:146`, а это ветка ПОСЛЕ раннего `if (body.stream) return streamSseAndSettle(...)` → для стрима недостижима. Плейграунд всегда шлёт `stream:true` → `daily_usd_cap=$50` не срабатывает **никогда**.

- [ ] **Step 1: Подтвердить фактом**

```bash
cd packages/api-gateway && grep -rn "usd_day" src/ --include=*.ts | grep -v __tests__
```
Expected: ровно 3 хита — чтение (`rate-limit-plan04.ts`), запись (`chat.ts`), комментарий (`key-limits.ts`). Если картина иная — сообщи координатору, план опирался на это.

- [ ] **Step 2: Написать падающий тест**

```ts
// packages/api-gateway/src/__tests__/stream-settle.test.ts
import { describe, it, expect } from 'vitest';
import { shouldPropagateSettleError } from '../streaming/sse';

describe('stream settle', () => {
  it('🔴 P0: ошибка списания на стриме НЕ глотается', () => {
    expect(shouldPropagateSettleError(new Error('P0003 INSUFFICIENT_FUNDS'))).toBe(true);
  });
});
```

- [ ] **Step 3: Прогнать — падает**

Run: `cd packages/api-gateway && bunx vitest run src/__tests__/stream-settle.test.ts`

- [ ] **Step 4: Реализовать**

1. В `sse.ts` — при провале settle: **не глотать**. Ответ клиенту уже отдан (стрим), поэтому HTTP-код не изменить — значит: (а) писать **долг** в леджер (компенсирующая запись со знаком, чтобы баланс ушёл в минус честно) и (б) **пометить ключ** для блокировки следующих запросов. Пред-проверка баланса (Task 2) делает это редким краем, но глотать нельзя.
2. Вынести инкремент `usd_day` из `chat.ts:144-146` в **общее место, через которое проходят обе ветки** (и стрим, и не-стрим) — например, внутрь `settleCharge`-обёртки или в `sse.ts` рядом с `logRequest`. 🔴 Единица счётчика должна совпадать с единицей чтения в `rate-limit-plan04.ts:66-74` — сверь (после T1/T2 там кредиты/микро, а не ₽; если имя `usd_day` теперь врёт — переименуй, имена уже раз спрятали 100×-баг).

- [ ] **Step 5: Прогнать**

Run: `cd packages/api-gateway && bun test`
Expected: зелёные.

- [ ] **Step 6: Коммит**

```bash
git add packages/api-gateway/src/streaming/sse.ts packages/api-gateway/src/routes/v1/chat.ts packages/api-gateway/src/__tests__/stream-settle.test.ts
git commit -m "fix(gateway): stop swallowing stream settle errors; make daily cap reachable on streams"
```

---

### Task 5: Закрыть публичный плейграунд

**Files:**
- Modify: `apps/web/src/app/api/playground/run/route.ts`
- Test: `apps/web/src/__tests__/playground-guard.test.ts`

**Почему так:** `POST /api/playground/run` доступен **без авторизации** (200 подтверждён живым пробоем), шлёт `stream:true` системным ключом `playground-system-key` (rpm 1000, `daily_usd_cap=$50`), а кап не срабатывает (Task 4). Плюс существующий лимит `if (ip && ...)` — при неопределённом IP **пропускается совсем**, счётчик in-memory (сбрасывается рестартом).

- [ ] **Step 1: Прочитать роут**

Прочитай `apps/web/src/app/api/playground/run/route.ts` целиком. Пойми текущий лимит и как берётся IP.

- [ ] **Step 2: Написать падающий тест**

```ts
// apps/web/src/__tests__/playground-guard.test.ts
import { describe, it, expect } from 'vitest';
import { playgroundAllowed } from '@/app/api/playground/run/guard';

describe('playground guard', () => {
  it('🔴 неопределённый IP НЕ пропускает лимит (был обход)', () => {
    expect(playgroundAllowed({ ip: undefined, used: 0, limit: 5 })).toBe(false);
  });

  it('в пределах лимита — можно', () => {
    expect(playgroundAllowed({ ip: '1.2.3.4', used: 2, limit: 5 })).toBe(true);
  });

  it('лимит исчерпан — нельзя', () => {
    expect(playgroundAllowed({ ip: '1.2.3.4', used: 5, limit: 5 })).toBe(false);
  });
});
```

- [ ] **Step 3: Прогнать — падает**

- [ ] **Step 4: Реализовать**

- Вынести решение в чистую `playgroundAllowed` (файл `guard.ts` рядом).
- **Неопределённый IP → отказ** (fail-closed), а не пропуск.
- Счётчик — в **Redis** с TTL до конца суток (не in-memory: рестарт обнулял).
- 🔴 После Task 2 плейграунд-ключ всё равно упрётся в баланс своей org — это второй рубеж. Убедись, что у org плейграунда есть **осмысленный бюджет** (не бесконечный).

- [ ] **Step 5: Прогнать + сборка**

Run: `cd apps/web && bunx vitest run src/__tests__/playground-guard.test.ts && NODE_OPTIONS=--max-old-space-size=8192 TMA_JWT_SECRET=x bun run build`
Expected: тесты PASS, build exit 0

- [ ] **Step 6: Коммит**

```bash
git add apps/web/src/app/api/playground/run/ apps/web/src/__tests__/playground-guard.test.ts
git commit -m "fix(web): playground fail-closed on unknown IP; move counter to Redis"
```

---

### Task 6: Операционка — капы на существующие ключи

**Files:**
- Create: `packages/database/migrations/00NN_default_key_caps.sql` (номер — следующий свободный; на момент написания заняты до `0057`)

**Почему так:** прод-факт: `no_daily_cap = 56/58`, `no_monthly_cap = 45/58`, `active_keys_on_zero_balance_orgs = 47`, rpm 60..1000. Даже с Task 2 разумные капы — второй рубеж.

- [ ] **Step 1: Проверить факт на проде (только SELECT)**

```sql
SELECT count(*) FILTER (WHERE daily_usd_cap IS NULL) AS no_daily,
       count(*) FILTER (WHERE cost_limit_monthly_rub IS NULL) AS no_monthly,
       count(*) AS total
FROM gateway_api_keys WHERE revoked_at IS NULL AND disabled_at IS NULL;
```

- [ ] **Step 2: Написать миграцию**

Проставить дефолтные капы ключам без них. 🔴 Идемпотентна (`WHERE daily_usd_cap IS NULL`). НЕ трогать ключи, где кап уже задан осознанно. 🔴 Имя колонки `cost_limit_monthly_rub` теперь врёт (единица = кредиты) — **не переименовывать в этой миграции** (это T6-задача), но добавить `COMMENT ON COLUMN` с правдой.

- [ ] **Step 3: Прогнать локально не на чем — отдать координатору**

Миграции на прод накатываются **вручную** (`sudo -u postgres psql aiag`), таблицы применённых миграций НЕТ. Не применяй сам. В отчёте — точный SQL + порядок.

- [ ] **Step 4: Коммит**

```bash
git add packages/database/migrations/00NN_default_key_caps.sql
git commit -m "chore(db): default caps for keys that have none"
```

---

## Порядок деплоя (для координатора, не для исполнителя)

1. **Сперва влить `task/t1-t2-credit-ledger`** (юнит + микро-кредиты + `aiag_settle_charge_credits`) по его собственному порядку: функция → stop gateway → `0056` → `0057` + `redis DEL model:*` → код → `gen:catalog` + редеплой web.
2. Затем этот план (Tasks 1-6), деплой `gateway` + `web`.
3. **Down-миграцию писать ДО** — чистого отката нет (старый код + BIGINT-колонки = тихая порча денег, а не отказ).
4. Проверять **эффектом**: `pm2` uptime свежий, `readlink current`, curl-факт. Зелёный деплой ≠ живой код (ловили трижды).
5. 🔴 **Чат-прокси включать только ПОСЛЕ** этого плана. Иначе шесть P0 стреляют одновременно.

## Что этот план НЕ закрывает (отдельные планы)

- **Мост оплата→баланс** (T3) — без него оплата даёт 402. Блокирует founder E2E.
- **Лимиты в ЛК** (T5) — отображение остатка/расхода/капов.
- **Воркеры-заглушки** — `contest-eval` sink (лидерборд пуст), `upstream-poll` sink, `requests:log` без потребителя, `overview.ts` читает несуществующую `gateway_requests`.
- **Цены yandex/gigachat** — в БД $0.80/1M против реальных ~$13/1M → при markup 1.8 платим больше, чем берём. **До включения этих апстримов.**
- **Payout TOCTOU** — неэксплуатируем сейчас (`sendUsdtTransfer` бросает), станет двойным выводом при включении выплат.
- **Юр-страницы** — фейк-ОГРНИП при живом приёме рублей (founder отложил).
- **T6** — переименование `price_per_1k_*` → `*_cents`, `cost_limit_monthly_rub` → кредитное имя (25 файлов).
