# Сравнение источников AI Aggregator

Дата исходной проверки: 2026-09-06. Путь к источникам обновлён после cutover 2026-09-07. Проверка выполнялась только чтением, без сборок и изменений исходников.

## Решение

Исторической базой служит `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aggregator-sourcecontainer/core`, ветка `feat/r2-readiness`, HEAD `2252c95f3dbcfcae693a7a51bc3f910bfcf9b3cc`. Активный AI Aggregator уже выделен в `/home/bob/Projects/ai-aggregator`. Архивный `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aiag-web-sourcecontainer/repo` использовать только как донор выбранных функций, не как базу или полный overlay.

Оба репозитория имеют общий предок `abc4f842a6b22434957727a00604310a8db35de0`. После него `aiag-web` содержит 6 уникальных коммитов, из которых 5 затрагивают код, а `core` — 339 уникальных коммитов всего и 117 коммитов в `apps/web`, `packages/api-gateway`, `packages/database`, `apps/worker`. Сравнение HEAD в этих четырёх зонах: 225 файлов, `+4281/-12891` со стороны `aiag-web` относительно `core`; полный overlay удалил бы значительную часть актуального gateway и БД.

## Что уникально и ценно в aiag-web

- `b26af3e` — единый provider-agnostic webhook settlement, pending payment до provider init, идемпотентность, refund workflow. Переносить только как ручную адаптацию: текущий `apps/web/src/lib/payments/settle.ts` до сих пор работает с legacy `users.balance` и не обновляет gateway org wallet.
- `89826fd` — email verification (`verify-email` page/route + register flow) и сохранение отмены подписки. Новые verification-файлы можно переносить почти напрямую; `cancel/route.ts` требует ручного merge с более новым core.
- `7849aaa` — единый `apps/web/src/lib/pricing.ts`, billing UX и app error boundaries (`error.tsx`, `global-error.tsx`, `not-found.tsx`). Это низкорисковый выборочный перенос; `PricingClient.tsx` конфликтует.
- `f238ff8` — 120-секундный timeout + один retry LLM-вызова, более строгий `settleRun WHERE status='running'`, реальные DB/Redis readiness-проверки. Переносить фрагментами. Не удалять `packages/api-gateway/src/index.ts`/`middleware/rate-limit.ts` автоматически: в core `tsup.config.ts` всё ещё собирает `src/index.ts`, package exports указывают на `dist/index.js`, а `index.ts` содержит единственную регистрацию egress executor.
- `4c68ae5` — новый `packages/cloudpayments` и подключение CloudPayments. Пакет можно перенести отдельно; webhook/provider wiring адаптировать поверх нового settlement. Не переносить `package-lock.json`: core использует актуальный workspace/lockfile своего дерева.
- `39c4454` — только план, не код.

В `packages/database` и `apps/worker` нет уникальных кодовых коммитов `aiag-web`. В этих зонах `core` строго богаче: `aiag-web` не имеет 39 миграций `0027`–`0065`; среди них USD/credit ledger (`0029`, `0056`–`0059`), отдельная org/key/wallet Agents Market (`0060`), cap conversion (`0061`), egress/failover/catalog (`0062`–`0065`). В `apps/worker` overlay удалил бы catalog sync и его тесты.

## Критическое расхождение settlement -> org wallet

В `core` gateway списывает micro-credits с `organizations.subscription_credits + payg_credits`: `packages/api-gateway/src/billing/settle.ts:64-120` вызывает `aiag_settle_charge_credits`, определённую миграцией `packages/database/migrations/0058_settle_charge_credits_fn.sql`. Разделение Agents Market закреплено `packages/database/migrations/0060_tma_own_org.sql:69-101`: отдельная организация, API key и нулевой кошелёк.

Рабочий Tinkoff bridge в `core` зачисляет именно этот кошелёк: `apps/web/src/app/api/webhooks/tinkoff/route.ts:208-227` увеличивает `organizations.payg_credits`, а строки `270-289` устанавливают `subscription_credits`. В доноре `aiag-web` новый `apps/web/src/lib/payments/settle.ts:75-117` меняет только `users.balance` и `subscriptions`; org wallet не трогает. Прямой cherry-pick `b26af3e` удаляет core Tinkoff route и после успешной оплаты оставляет gateway-баланс без пополнения, то есть запросы получают 402.

Дополнительно в самом `core` остаётся P0 refund-дыра:

- `apps/web/src/app/api/webhooks/tinkoff/route.ts:307-318` при refund обновляет только поля payment;
- `apps/web/src/app/api/admin/payments/refund/route.ts:145-149` после возврата обновляет только status/refunded_amount;
- ни один путь не уменьшает `organizations.payg_credits`/`subscription_credits`; следовательно, возвращённые рубли могут оставить уже выданные spendable credits.

Ручная адаптация должна сделать единый settlement внутри одной DB-транзакции: guarded payment transition, legacy ledger при необходимости, изменение org wallet, subscription period и webhook log. Refund должен атомарно сторнировать тот же org bucket с явно определённой политикой при уже потраченных credits. Нельзя копировать conversion из донорского helper: каноническая формула core для top-up сейчас `round(rub * 1_200_000 / 990)` micro, а tier grant — `tier.credits * months * 1000`.

Отдельный settlement риск в `apps/agent-worker`: в `core` `apps/agent-worker/src/db.ts:697-714` использует `status <> 'completed'`; коммит `f238ff8` ужесточает это до `status='running'`. Текущий guard позволяет повторной доставке перевести ранее failed run в completed и дебетить его. Перенести только условие/логирование, сохранив credit-поля и ledger из core.

## Безопасная последовательность переноса

1. От базы `2252c95` создать интеграционную ветку в независимом клоне.
2. Сначала перенести две substantive незакоммиченные правки из старого `core`: `apps/web/src/middleware.ts` (+13 строк CSP) и untracked `packages/database/scripts/__tests__/sync-models-dev.test.ts` (223 строки). Не копировать 932 CRLF-only изменения.
3. Портировать отдельными коммитами error boundaries/pricing/UI из `7849aaa`, затем email verification из `89826fd`.
4. Портировать `packages/cloudpayments` из `4c68ae5`, после чего вручную встроить provider wiring.
5. Спроектировать единый settlement из идей `b26af3e`, но сохранить/расширить core org-wallet bridge и добавить org-credit reversal на refunds.
6. Из `f238ff8` взять timeout/retry, `status='running'` и readiness-код. Консолидацию gateway entrypoints делать отдельным изменением с одновременным обновлением `package.json`, `tsup.config.ts`, server-node imports и переносом `registerEgressExecutor`; простой delete ломает сборочную схему и egress.

Полный cherry-pick не безопасен: пробная трёхсторонняя аппликация на `2252c95` дала конфликты в payment routes/provider registry для `b26af3e`, в cancel для `89826fd`, в `PricingClient.tsx` для `7849aaa`, в `agent-worker/db.ts`, gateway `index.ts` и `server.ts` для `f238ff8`, а также в CloudPayments wiring/lockfile для `4c68ae5`.

## Рабочее дерево и стартовые тесты

`aiag-web/repo` чист. В старом `core` Git показывает 932 tracked modified из-за CRLF-конверсии (`141235/141222` raw), но `git diff --ignore-cr-at-eol` оставляет только `apps/web/src/middleware.ts`. Untracked roots: `.worktrees/`, `docs/roadmaps/`, `packages/database/scripts/__tests__/`, `reports/`, `tma/`, `web/`. Для консолидации кода обязательны только названные middleware и test-файл; остальные roots сохранять отдельно до классификации, не overlay-ить автоматически.

Стартовые проверки после реализации:

- `apps/web/src/app/api/webhooks/__tests__/tinkoff-credit-bridge.test.ts` — существующие top-up/tier/idempotency assertions; добавить refund reversal и provider-agnostic cases.
- `apps/web/src/__tests__/payments/routes.test.ts` — admin step-up, refund ceiling/idempotency и payment init; расширить проверкой org wallet.
- `apps/agent-worker/src/__tests__/run-settle.integration.test.ts` — atomic settle; добавить failed-run/retry case для `status='running'`.
- `packages/api-gateway/src/__tests__/billing-preflight.test.ts`, `billing-headers.contract.test.ts`, `pricing.test.ts` — сохранить credit-unit и 402-инварианты.
- `packages/database/scripts/__tests__/sync-models-dev.test.ts` — незакоммиченный тест, который нужно перенести вместе с CSP-правкой.

Дополнительный риск core: production PM2 запускает `packages/api-gateway/dist/server-node.js`, который импортирует `server.ts`, тогда как `registerEgressExecutor(fetchViaProxy)` находится только в legacy `src/index.ts`. Поэтому egress-настройка может не регистрироваться в production entrypoint; исправить при консолидации gateway stack и закрепить тестом entrypoint wiring.
