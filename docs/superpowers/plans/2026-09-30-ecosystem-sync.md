# План синхронизации экосистемы: Aggregator + Arena + Agents Market

Дата: 30.09.2026. Составлен по итогам трёх независимых брейншторм-проходов
(Arena, Agents Market, Aggregator) плюс gap-анализа и ревью волны AG-6/AG-7.

## Три находки, которые переопределяют порядок работ

1. **В Aggregator уже есть конкурсный контур, и он примерно так же незавершён, как Arena.**
   Таблицы `contests`, `contest_submissions`, **`evaluations`**, `evaluator_scripts`,
   `prize_awards`, `author_earnings`, `payouts` существуют, роуты `contests/[slug]/submit`
   и `/leaderboard` написаны. Но `apps/worker/src/index.ts:59` — заглушка:
   `// TODO Phase 2: UPDATE evaluations SET status=$1, public_score=$2 …`. Воркер исполняет
   evaluator в песочнице и **выбрасывает результат**. `leaderboard` читает пустую таблицу.
   Значит Arena не обязана строить evaluation-схему с нуля, и самый дешёвый блокирующий
   пункт всей экосистемы находится в Aggregator.

2. **AM-воркер физически не может вызвать продаваемый контракт.** Он не шлёт
   `Idempotency-Key` (а `parseIdempotencyKey` в `stored-chat-http-identity.ts:55` его требует)
   и шлёт `tools`/`tool_choice`, тогда как продаваемый контракт объявляет их
   `unsupportedExecutionFields` и отвечает 501. Без stored-режима нет ни author-моделей,
   ни admission, ни reconciliation.

3. **`GET /v1/catalog` существует, но не содержит авторских моделей.** Он строится из
   `models JOIN model_upstreams JOIN upstreams`; у авторской версии нет строки в
   `model_upstreams`, поэтому она получает `unavailable('no_admitted_deployment')`. При этом
   `/v1/models` авторские версии выдаёт. Два публичных списка в одном продукте противоречат
   друг другу — и цикл упирается в каталог, а не в форму публикации.

## Порядок волн

### Волна 1 — снять блокеры, ничего не меняя в архитектуре (параллельно, разные репозитории)

| # | Работа | Где | Почему первая |
|---|---|---|---|
| 1 | **AM: `Idempotency-Key` + чтение `x-aiag-billing-request-id` / `x-aiag-charged-*`**, персист `billing_request_id` до вызова; убрать локальную оценку `PRICING`/`FALLBACK_PRICE` из authoritative-пути | agents-market | Без этого ретрай BullMQ = двойное списание, и stored-контракт недоступен |
| 2 | **AM: заменить 3 прямых `FROM models` / `FROM model_upstreams` на HTTP-адаптер `/v1/catalog`** + read-only tool `list_models` у агента | agents-market | Снимает нарушение границы продуктов. Эти таблицы вообще не создаются миграциями AM — маршруты упадут |
| 3 | **Aggregator: добавить авторские модели в `/v1/catalog`** | ai-aggregator | Убирает противоречие с `/v1/models`; иначе цикл упирается в каталог |
| 4 | **Aggregator: закрыть заглушку eval-sink** — писать результат в `evaluations` | ai-aggregator | Самая дешёвая и самая блокирующая точка: даёт оценки сразу и Aggregator, и (для сверки) Arena |

Волна 1 не трогает Arena — она на паузе, и для неё это подарок: Aggregator начнёт
производить оценки, с которыми Arena сможет сверяться.

### Волна 2 — деньги и покупка

- **Aggregator: `GET /v1/usage/{billing_id}`** (своя org/key) — авторитетный receipt.
- **Aggregator: минт `gateway_api_keys` по S2S** (модель нанимателя, `model_whitelist`,
  `cost_limit_monthly_rub`) — HTTP-эндпоинта создания ключа нет вообще.
- **AM: per-agent gateway key** — агент выбирает модель и покупает своим ключом.
  Это «минимальный реальный агент-покупатель» (вариант B из брейншторма).
- Лимиты закрываются **на стороне Aggregator** — это серверный 402/403, не самодеятельность.

### Волна 3 — цикл Arena → Aggregator

- `EvaluationEvidence v1` как узкий контракт + server-fetch (E4: fetch + подпись +
  whitelist `protocol_sha256` + `valid_until`). Три из нужных digest'ов уже есть в Arena
  (`submission_versions.artifactSha256`, `PREDICTION_EVALUATION_PROTOCOL_SHA256`, dataset sha256).
- `POST /v1/publication-drafts` — идемпотентный, по `manifest_digest`.
- **Сначала разделить engineering- и production-режим в Arena:** PE-T1 сейчас выставляет
  `purpose: "engineering-fixture"`, `visibility: "private"` и захардкоженный датасет
  `arena-engineering-8`. Первая же подпись утверждала бы, что оценивается фикстура.
- Рекомендация по контрактам: **своя схема + явный маппинг на границе** для первого среза;
  пакет `@aiag/contracts` заводить, когда появится второй потребитель или вторая версия схемы.
  Registry как единственная точка отказа — плохая идея для трёх локальных продуктов.

### Волна 4 — Hermes-контур в Agents Market

Рантайм сейчас — свой BullMQ-loop, **не** Hermes. Твоя формулировка «основан на базе Hermes»
пока не соответствует архитектуре, и это стоит решить явно:
- **сейчас** — вычистить мёртвый `hermesChat()` (он не вызывается нигде) и считать Hermes
  опциональным upstream, как сейчас;
- **позже** — Hermes как источник capabilities (toolsets/skills) для BullMQ-исполнителя.
  Дёшево, ничего не ломает, делает формулировку правдой на уровне capability;
- **не сейчас** — замена рантайма на Hermes: ломает fail-closed на gateway-ключе, authoritative
  billing, mid-run budget cutoff, `settleRun` CAS, `call_agent` depth-1. В плане AM-P4/D07 это
  уже зафиксировано как отдельный пилот с вердиктом.

## Долги, которые нужно закрыть независимо от связки

1. **Авторский токен пишется открытым текстом в `models.metadata`.** FIXME ссылается на
   `packages/shared/crypto.ts`, которого не существует. В прод нельзя.
2. **Дубль таблиц моделей:** `models` (0004) и `ai_models` (0005 + `schema/ai-models.ts`),
   миграции расширяют обе. `request-publish` пишет в `models`.
3. **Песочница evaluator — `systemd-run`**, с `SECURITY-TODO` на nsjail/k3s.
4. **`packages/database/tsconfig.json` не включает `scripts/`** — `tsc` не проверяет скрипты
   восстановления. Трижды пропускало Critical.

## Что блокирует пилот с одним реальным пользователем

Блокирует: (1) нет способа купить inference в проде — нужны ключ и кредиты, а TON settlement
выключен и testnet не проходился; (2) несовместимость AM-воркера с продаваемым контрактом;
(3) нет production-конфигурации БД — всё принятие на одноразовых локальных стендах;
(4) юридический gate.

Не блокирует: 108 скорекардов и 14 INT-сценариев — это release-гейт v1, а не условие пилота
на одного человека. INT-01/INT-02 в пилоте без Arena не воспроизводятся по построению.

**Минимальный честный пилот:** один пользователь, один API-ключ, один агент в AM, кредиты
зачислены вручную, stored-режим gateway включён, `Idempotency-Key` добавлен. Это волны 1–2.
