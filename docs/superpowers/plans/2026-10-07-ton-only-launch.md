# AG-TON-L: TON-only Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Статус:** черновик плана от 2026-10-07. Написан по итогам многоагентного ресерча (инвентарь worktree, git-форензика, аудит, паттерны agents-market). Предыдущие гейты: AG-TON1 (контракт quote), AG-TON2 (`0072`, принято локально), AG-TON3 (verifier+recovery, `0074-0076`, 6 HIGH закрыты в `892a09d`), wallet-identity/checkout (`0091`/`0092`) — всё в ветке `feat/ag-author-version-20260928`.

## Черновики без прогона (2026-10-07, Bash в сессии недоступен — cwd мёртв, см. brain/agent-memory/aiag-project-paths.md)

Созданы НОВЫЕ файлы (существующая логика не тронута), все помечены `// DRAFT` и требуют `bun test` до коммита:

- Task 1.3 (частично): `packages/shared/src/ton-evidence-crosscheck.ts` + `__tests__/ton-evidence-crosscheck.test.ts` (crosscheck + TonAPI v2 fetch). НЕ сделано: заголовок `X-API-Key` в провайдере (правка существующего файла — отложена до живого Bash).
- Task 2.1 (частично): `packages/shared/src/ton-fx-oracle.ts` + тест (порт ton-rate, safeFetch, stale-ok); `apps/web/src/lib/ton-wallet/policy-builder.ts` + `apps/web/src/__tests__/ton-policy-builder.test.ts` (выход валиден по parseCheckoutPolicy). НЕ сделано: подключение builder'а к admin_settings (Task 3.4).
- Task 3.4 (частично): TON-секции в `.env.example` и `apps/web/.env.local.example` (имена свёрены с кодом; `TON_RECONCILIATION_MODE=settle`, `TON_SETTLEMENT_CONFIRMATION`, `TONCENTER_API_KEY`, `TON_EVIDENCE_CROSSCHECK` помечены как будущие Phase 1.3/3.2). НЕ сделано: чтение политики из БД.
- Task 4.2: `docs/ops/ton-review-runbook.md` (14 причин review → действия, процедура ручного возврата ≤5 TON, эскалации). Плюс `docs/ops/TON-ONLY-RUNBOOK.md` (подъём observe→settle, откат, go-live чек-лист).

Первое действие исполнителя после оживания Bash: `bun test` по этим файлам, исправить расхождения, закоммитить по одному коммиту на задачу — и только потом продолжать Phase 0/1.

**Goal:** Запустить приём платежей в AI-агрегаторе ТОЛЬКО через TON-кошелёк (native Toncoin, testnet→mainnet), полностью отключив YooKassa/Tinkoff/СБП, с операторским контуром review_required и алертами.

**Architecture:** Используем уже готовое и протестированное ядро worktree `ag-author-version-20260928`: invoic-core (`0072`), reconciliation (`0074-0076`), wallet-identity/checkout (`0091/0092`), TonConnect-веб-слой (`/api/ton/**`, `TonWalletPanel`), observe-цикл воркера (`ton-payment-bootstrap`, 30 с тик). Недостающее достраиваем поверх: mainnet-константы, FX-оракул, активация settlement через worker-only DB principal, expiry-крон, операторский review-контур, алерты, отключение фиата. Простые паттерны (oracle, env-доки) портируем из `agents-market`.

**Tech Stack:** TypeScript, PostgreSQL (drizzle + raw SQL functions), TonCenter API v3, TonConnect UI 3.x, @ton/core, Next.js 14 (apps/web), Bun-воркер (apps/worker), pg 8.20.

**Spec:** исследования этой сессии; [TON alongside RUB](2026-09-07-ton-payments.md); [payment/evidence contract](../../ecosystem/payment-and-evidence-design.md); план TON3 ([2026-09-13-ton-verifier-and-recovery.md](2026-09-13-ton-verifier-and-recovery.md)) — его гейты («settlement activation = отдельный worker-only DB principal/ACL gate, одного env недостаточно») обязательны здесь.

## Global Constraints

- Деньги: BIGINT **микрокредиты**, 1 кредит = 1¢ = 1000 микро. Запрещены `Number`/`parseFloat`/`Math.round` для денег; BIGINT из SQL — строкой/BigInt.
- Потолок совместимости RUB-refund: итоговый `organizations.payg_credits` ≤ 2^53−1 микро (мигр. `0072`, `COMPAT_PAYG_MAX`) — не снимать в этом плане.
- Testnet-first: mainnet-константы/миграции/активация — только после Phase 0 консолидации и зелёного baseline. Никаких mainnet-ключей/средств в коде.
- Приватные ключи сервера отсутствуют by design (приём-only, отправка из кошелька юзера через TonConnect). Пейауты — вне скоупа плана (отдельный будущий план).
- Идемпотентность зачисления — только на уровне SQL (UNIQUE события + partial unique settle + CAS статусов). Новый код не добавляет «мягких» путей зачисления в обход `aiag_settle_ton_invoice_v1`.
- Активация settlement: worker-only DB principal (`aiag_ton_worker`), НЕ через env. `TON_RUNTIME_SETTLEMENT_FORBIDDEN` снимается только вместе с миграцией ролей (Phase 3).
- Миграции additive; номер следующей = фактический максимум инвентаря worktree (`0097`) + 1; не переиспользовать применённые номера/checksum'ы. После каждой миграции — прогон миграционного инвентаря и `test:database-baseline` + TON child.
- Один heavy run за раз (`flock /tmp/ai-ecosystem-build.lock`). **PRECONDITION: рабочий Bash в сессии** (в момент написания плана `spawn /bin/bash ENOENT` — среда сломана, все git/test шаги требуют починки).
- Юр-гейт 259-ФЗ (ч.5 ст.14): публичный приём TON от резидентов РФ запрещён; решение (foreign entity / гео-гейт / пауза) — внешний блокер Go-live, не кодовая задача. В коде — крипто-дисклеймер (Phase 5) и гео-гейт по решению юриста.
- Testnet-бюджет внешних RPC исчерпан (20/20): новые проверки цепочки — на фикстурах (`apps/worker/src/__fixtures__/ton/`), живые вызовы только на mainnet-этапе приёмки.

## Review Focus

1. **Двойное зачисление при параллельных циклах** (reconciler тик × 2 инстанса воркера) — ожидание: ровно один settle, второй — `already_settled`; тест: параллельный вызов `settleTonInvoiceAsWorker` (уже есть в native-тестах — сохранить как регресс).
2. **Переплата/недоплата уходит в review и не чинится сама** — ожидание: `review_required` durable, повторный sweep не зачисляет; тест на `underpayment`/`overpayment` фикстурах.
3. **Протухший FX** — ожидание: checkout отказывает с `TON_CHECKOUT_FX_STALE`, а не котирует по старому курсу; тест на грани `maxFxAgeSeconds`.
4. **Settlement без principal** — ожидание: попытка сеттлить ролью без `aiag_ton_worker` падает по ACL (REVOKE), env-обход невозможен; тест: SQL-проверка прав в миграции.
5. **Mainnet-дрейф констант** — ожидание: env mainnet-origin ≠ пинн константы → startup-отказ (`origin_mismatch`), как сейчас для testnet; тест боотстрапа с подменным origin.

---

## Phase 0: Консолидация веток и среда (BLOCKER для всего плана)

### Task 0.1: Починить Bash и зафиксировать состояние

**Files:** — (окружение)

- [ ] Перезапустить ZCode-сессию до живого `bash -c 'echo ok'`. Без этого фаза невыполнима.
- [ ] Зафиксировать: `cd /home/bob/Projects/ai-aggregator && git status && git -C .worktrees/ag-author-version-20260928 status` — оба дерева чистые (если нет — stash-отчёт владельцу, не коммитить чужое).

### Task 0.2: Push рабочей ветки и влить корень

Контекст (git-форензика): стек ЛИНЕЙНЫЙ: `three-projects-completion` (tip `52e1e59`, 2 docs/chore-коммита) ⊂ `stored-chat-stream-lifecycle` ⊂ `byok-lifecycle` ⊂ `async-media-20260926` ⊂ `durable-batches` ⊂ `ag-author-version-20260928` (tip `da504b4`, 01.10, ~110 коммитов, включает TON-веб-слой, money-фиксы 30.09 «idempotency bypass free inference» и «gate payouts», миграции до `0097`). origin отстаёт на ~11 коммитов.

- [ ] `git -C .worktrees/ag-author-version-20260928 push origin feat/ag-author-version-20260928`
- [ ] Влить корень (2 коммита, риск минимален): в worktree — `git merge feat/three-projects-completion`; конфликт ожидаем только в `.gitignore`/docs — разрешить в пользу объединения.
- [ ] Сверка излишков: `git diff 277b7062 34163eba --stat` (патч `remove-public-legal-requisites` уже cherry-pickнут как `277b7062`; если diff пуст — ветку `feat/remove-public-legal-requisites-20260928` удалить). Ранние streaming-ветки (`feat/stored-chat-stream`, `...-20260925`, `...streaming-20260925`) и слитые lifecycle-ветки — удалить после `git branch --merged` проверки. `feat/async-media-lifecycle-20260926` (4 docs-коммита, ответвление) — merge (docs-only). `feat/r2-readiness` (SEO, старая база) — ОТЛОЖИТЬ отдельной задачей, не мешает TON.
- [ ] Проверить избыточность `donor/september-fixes` (`4c68ae55`): `git cherry -v HEAD donor/september-fixes` — если всё `[-]` (уже применено через историю клона), ветку не вливать; если есть `+`-коммиты — остановить план и доложить владельцу (P0-фиксы биллинга!). Прошлый аудит нашёл фиксы settle в дереве — скорее всего `[-]`.
- [ ] Прогнать в worktree: `bun install && bun test:database-baseline` (ожидание: как минимум прежний зелёный уровень ветки + TON child PASS). Один heavy run, под flock.
- [ ] Commit: `chore(consolidation): merge three-projects-completion, prune merged branches`.

### Task 0.3: Deploy-синхронизация прода (внешний гейт, требует владельца)

- [ ] Снять состояние прода: `ssh aiag-vps 'cd /srv/aiag/web-repo && git log --oneline -3 && pm2 ls'`.
- [ ] Задеплоить консолидированную ветку по действующему pm2-контракту (deploy-коммиты 01.10 в ветке уже правят порт/reload). Каждое действие на проде — только с явного подтверждения владельца в чате.

---

## Phase 1: Mainnet-фундамент

### Task 1.1: Mainnet-константы провайдера (параметризация с пином)

**Files:** Modify: `apps/worker/src/ton-payment-evidence.ts:3-5`, `apps/worker/src/ton-payment-provider.ts:187-194,521`, `apps/worker/src/ton-payment-verifier.ts:15-16,30-40`; Test: `apps/worker/src/__tests__/ton-payment-provider.test.ts` (новые кейсы).

**Interfaces:** Produces: `TON_NETWORK_PRESET = 'testnet' | 'mainnet'` (env), константы `TON_PROVIDER_ID`, `TON_PROVIDER_ORIGIN`, `TON_FINALITY_POLICY_ID` остаются пиннами, но выбираются из пары пресетов. Mainnet-пресет: `https://toncenter.com`, `toncenter-v3-provider-attested-mc-depth-2-v1`, mainnet network-id `tvm:-1` — согласовать с миграцией 0098 (Task 1.2) единым источником.

- [ ] Тест (fail): кейс «env mainnet origin = toncenter.com → провайдер строит URL от mainnet-константы»; кейс «env origin не совпал ни с одним пресетом → `origin_mismatch`» (расширение существующего).
- [ ] Реализация: в `ton-payment-evidence.ts` — `export const TON_PRESETS = { testnet: {...}, mainnet: {...} } as const;` + `resolvePreset(env)`. Провайдер и верификатор принимают пресет аргументом (как сейчас принимают политику), дефолт testnet — поведение тестов не меняется.
- [ ] Прогон: `bun test apps/worker/src/__tests__/ton-payment-provider.test.ts`.
- [ ] Commit: `feat(ton): parameterize provider/verifier presets for mainnet (testnet default unchanged)`.

### Task 1.2: Миграция 0098 — mainnet network и asset-allowlist

**Files:** Create: `packages/database/migrations/0098_ton_mainnet_network.sql`; Modify: `packages/database/src/schema/ton-payments.ts` (CHECK-зеркало), `packages/database/src/ton-payment-types.ts:17-19`; Test: native-интеграционные по образцу `ton-payments.native.integration.test.ts`.

**Interfaces:** Produces: `network IN ('tvm:-3','tvm:-1')` во всех CHECK; таблица `ton_asset_allowlist` (`network`, `asset_kind`, `master_address NULL`, `asset_decimals`, `is_active`, UNIQUE(network, master_address)); SQL-функция `aiag_ton_allowlisted_assets_v1(network)` — READ-only источник для `TonServerPolicy` вместо аргумента-константы. Reconciliation-биндинг остаётся native-only (это отдельный будущий гейт jetton).

- [ ] Написать миграцию 0098 (additive: ослабить CHECK через новую таблицу-домен нельзя — поэтому `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT network IN ('tvm:-3','tvm:-1')` — ВНИМАНИЕ: это единственная не чисто-additive операция плана, прогнать на disposable DB сначала; инвентарь миграций в `packages/database/CLAUDE.md` обновить).
- [ ] Insert-строка native-TON mainnet в allowlist ( decimals=9, master NULL ).
- [ ] Тесты: create/settle инвойса с `network='tvm:-1'` PASS; инвойс с network вне allowlist → `TON_ASSET_NOT_ALLOWLISTED`; тестныq сети поведение не изменилось (replay старых тестов).
- [ ] Прогон baseline + TON child. Commit: `feat(ton): 0098 mainnet network + server-side asset allowlist`.

### Task 1.3: TonCenter API-ключ и второй источник (решение + минимальная реализация)

**Files:** Modify: `apps/worker/src/ton-payment-provider.ts` (заголовок `X-API-Key` при env `TONCENTER_API_KEY`), `apps/worker/src/env.ts`; Create: `packages/shared/src/ton-evidence-crosscheck.ts`; Test: `__tests__/ton-evidence-crosscheck.test.ts`.

**Interfaces:** Produces: `crosscheckMasterchainRoot(primary, secondary): {ok, mismatch}` — сверка `masterchainInfo` (seqno + root hash) двух источников. Второй источник — TonAPI v2 (`https://tonapi.io/v2`), только этот эндпоинт, через `safeFetch`.

- [ ] Тесты crosscheck: совпадение root-hash → ok; расхождение seqno>допуска → mismatch (верификатор вернёт `finality_pending`, не отказ).
- [ ] Реализация + подключение в `verifyChainCredit` перед гейтом финальности: secondary-вызов только при `TON_EVIDENCE_CROSSCHECK=1` (mainnet-пресет включает по умолчанию).
- [ ] `.env.example`: `TONCENTER_API_KEY=`, `TON_EVIDENCE_CROSSCHECK=`.
- [ ] Commit: `feat(ton): TonCenter API key + optional secondary-source crosscheck`.

---

## Phase 2: FX-оракул

### Task 2.1: Порт ton-rate.ts и операторская сборка политики

**Files:** Create: `packages/shared/src/ton-fx-oracle.ts` (порт `/home/bob/Projects/agents-market/apps/tma/src/lib/ton-rate.ts`), `apps/web/src/lib/ton-wallet/policy-builder.ts`; Test: `packages/shared/src/__tests__/ton-fx-oracle.test.ts`, `apps/web/src/lib/ton-wallet/__tests__/policy-builder.test.ts`.

**Interfaces:** Produces: `getTonUsdRate(): Promise<number>` (CoinGecko simple/price, кэш 60 с, stale-ok — порт 1:1, но fetch через `safeFetch`); `buildCheckoutPolicy({fxSource, presets, recipient, revision}): string` — собирает JSON `TON_CHECKOUT_POLICY` (схема уже есть в `checkout-policy.ts:4-9`), где `fx.numerator/denominator` = курс TON→USD из оракула (BigInt-пропорция `Math.round(rate*1e6)` / `1_000_000n`, `observedAtMs=now`, `expiresAtMs=now+maxFxAgeSeconds*1000`).

Ключевая адаптация: в AG FX-цепочка идёт `gateway_microcredits → asset` через RationalFx с точной bigint-арифметикой (`ton-payment-contract.ts:141-159`) — оракул лишь наполняет `TON_CHECKOUT_POLICY.fx`; конверсия микрокредитов: `micro → USD-центы = micro/1000`, `TON atomic = ceil((micro/100000)/rate*1e9)` (сверить с `createQuote`, не дублировать!).

- [ ] Тесты: кэш-хит без сети (mock fetch); stale-ok при 5xx; политика собирается валидной по zod-схеме `parseCheckoutPolicy`; курс ≤0 → исключение.
- [ ] Реализация; `policy-builder` вызывается cron'ом Phase 3.4 или вручную оператором (см. Review Focus 3: stale FX сам по себе уже гейтится `ton-wallet-checkout.ts:38`).
- [ ] Commit: `feat(ton): TON/USD fx oracle + checkout policy builder`.

---

## Phase 3: Runtime-активация settlement

### Task 3.1: Миграция 0099 — worker-only settlement principal

**Files:** Create: `packages/database/migrations/0099_ton_settlement_principal.sql`; Test: native `ton-settlement-worker-client`-подобный + новый ACL-тест.

**Interfaces:** Produces: роль `aiag_ton_worker` (NOLOGIN, пароль выдаётся отдельным секретом деплоя): GRANT SELECT/UPDATE на reconciliation-таблицы + EXECUTE на `aiag_ton_worker.settle_invoice_v1` (функция уже существует в зеркале `ton-payments.ts:367`; проверить её SQL-схему в worktree — если роль/схема `aiag_ton_worker` уже созданы миграцией TON3-цикла, задача сужается до выдачи прав и прод-проверки). REVOKE всего у PUBLIC. Роль веб-приложения НЕ получает settle-прав.

- [ ] Тесты: settle от `aiag_ton_worker` PASS; settle от web-роли → отказ по правам; `has_table_privilege`-проверки в миграции.
- [ ] Прогон baseline. Commit: `feat(ton): 0099 worker-only settlement principal + ACL`.

### Task 3.2: Снятие гейта TON_RUNTIME_SETTLEMENT_FORBIDDEN

**Files:** Modify: `apps/worker/src/ton-payment-bootstrap.ts:109-131`, `ton-payment-reconciler.ts:177-188,474-512`; Test: обновить `bootstrap`-тесты.

**Interfaces:** Produces: env `TON_RECONCILIATION_MODE = disabled | observe | settle`. Режим `settle` требует: (а) БД-подключение через `createTonSettlementWorkerDatabase` (роль из 3.1, уже в `ton-reconciliation-internal.ts:264`), (б) явный env `TON_SETTLEMENT_CONFIRMATION=I-UNDERSTAND-WORKER-ONLY-SETTLEMENT` (двойное подтверждение, не один флаг — по духу решения TON3), (в) пресет mainnet или осознанный testnet-режим. Любая попытка инъекции settle в `observe` → прежний `TON_RUNTIME_SETTLEMENT_FORBIDDEN` (тест сохраняется).

- [ ] Тесты: `observe` + settle-инъекция → FORBIDDEN (регресс); `settle` без confirmation → startup-отказ; `settle` с confirmation + worker-БД → reconciler вызывает `settleVerifiedCredit` (мок, фикстура успешного native-события).
- [ ] Реализация. Commit: `feat(ton): enable worker settlement mode behind dual gate`.

### Task 3.3: Expiry-крон инвойсов

**Files:** Modify: `apps/worker/src/ton-payment-bootstrap.ts` (второй интервал) или `apps/worker/src/index.ts`; Test: unit на тик.

**Interfaces:** Consumes: `expireTonInvoice` (`packages/database/src/ton-payments.ts:249`). Produces: тик раз в 5 мин: `UPDATE` через SQL-функцию для всех `pending` с `expires_at < now()` (пачечно, LIMIT 100, лог количества). Reconciler уже не подхватит истёкшие (claim заблокирован триггером 0092) — крон закрывает мусорные pending.

- [ ] Тест: фикстуры pending/expired → тик помечает expired, повторный тик — 0 изменений.
- [ ] Commit: `feat(ton): invoice expiry cron`.

### Task 3.4: Обновление политики (cron) и .env.example

**Files:** Modify: `.env.example` (корень и `apps/web/.env.local.example`), `apps/worker/src/env.ts`; Create: `apps/worker/src/ton-policy-refresher.ts`.

**Interfaces:** Produces: тик раз в 60 с: `getTonUsdRate()` → `buildCheckoutPolicy()` → запись файла/env в рантайме невозможна для Next.js — поэтому рефрешер пишет политику в таблицу `admin_settings` (ключ `ton_checkout_policy`), а `checkout-service.ts` читает БД → env (env остаётся fallback для локальной разработки). Modify: `apps/web/src/lib/ton-wallet/checkout-service.ts:8`.

- [ ] Тесты: сервис читает политику из БД с приоритетом над env; fallback env когда ключа нет.
- [ ] `.env.example` — полная TON-секция: web (`TON_WALLET_ENABLED`, `TON_WALLET_ORIGIN`, `TON_WALLET_NETWORK`, `TON_CHECKOUT_POLICY`), worker (`TON_RECONCILIATION_MODE`, `TON_RECONCILIATION_*`, `TON_SETTLEMENT_CONFIRMATION`, `TONCENTER_API_KEY`, `TON_EVIDENCE_CROSSCHECK`).
- [ ] Commit: `feat(ton): runtime checkout policy from admin_settings + env docs`.

---

## Phase 4: Операторский контур review_required

### Task 4.1: Admin-роут списка и разбора review

**Files:** Create: `apps/web/src/app/api/admin/ton/review/route.ts` (GET список), `apps/web/src/app/api/admin/ton/review/[id]/route.ts` (POST решение), `apps/web/src/app/admin/ton/page.tsx` (+ пункт в `AdminSidebar`); Modify: `packages/database/src/ton-payments.ts` (экспорт `listTonReviewRequired`, `resolveTonReviewDecision`); Test: роут-тесты + native.

**Interfaces:** Produces: `listTonReviewRequired(limit)` — инвойсы `status='review_required'` с reason/суммой/asset/событием; `resolveTonReviewDecision(id, actor, action)` где `action ∈ {'acknowledge_no_credit' | 'retry_settle'}`. `retry_settle` повторяет `settleTonInvoiceAsWorker` (идемпотентен); `acknowledge_no_credit` пишет append-only решение с operator-аудитом (actor из `requireAdmin` — существующий guard `lib/admin/guard.ts:23-37`) и НЕ меняет статус денег. Возврат средств — ручная процедура (см. docs ниже), НЕ код.

- [ ] Тесты: не-админ → 403; acknowledge пишет аудит и не начисляет; retry_settle на инвойсе с устранённой причиной (фикстура refund_debt погашен) → settled.
- [ ] Commit: `feat(ton): admin review queue for review_required invoices`.

### Task 4.2: Runbook оператора

**Files:** Create: `docs/ops/ton-review-runbook.md`.

- [ ] Содержимое: дерево причин review (underpayment/overpayment/refund_blocked/evidence_conflict/late_payment/...), решение для каждой, ручная процедура возврата переплаты с hot-wallet (шаги, лимит ≤ X TON, двойное подтверждение), эскалация.

---

## Phase 5: TON-only переключение (без юкассы/Т-банка)

### Task 5.1: Отключение фиата

**Files:** Modify: `apps/web/src/app/dashboard/billing/page.tsx:13-37,315-338,358-405` (убрать фиатные кнопки/пресеты ₽/автотопап — TonWalletPanel уже смонтирован :360), `apps/web/src/app/api/payments/topup/route.ts` (503 с копирайтом «Оплата сейчас только в TON»), `apps/web/src/app/api/subscriptions/create/route.ts:61` (аналогично); прод-env: НЕ задавать `TINKOFF_*`/`YOOKASSA_*`; Test: обновить `providers.test.ts`.

- [ ] Тесты: `/api/payments/topup` без фиат-env → 503 с `ton_only`; billing-страница рендерит только TonWalletPanel-блок.
- [ ] Commit: `feat(billing): TON-only checkout, disable fiat rails`.

### Task 5.2: Крипто-дисклеймер и судьба фиат-юзеров

**Files:** Create: `apps/web/src/components/billing/CryptoDisclaimer.tsx`; Modify: billing page, `apps/web/messages/*.json` (заголовки, не хардкод — заодно первый шаг локализации биллинга).

- [ ] Текст (юр-ревью владельцем): «Оплата в Toncoin; возвраты — по заявке на support; курс фиксируется на момент счёта; криптовалюта не является инвестицией». + Баннер существующим фиат-юзерам: подписки доживают период, пополнение картой недоступно, остаток PAYG не сгорает. Commit: `feat(billing): crypto disclaimer + fiat sunset notice`.

---

## Phase 6: Алерты

### Task 6.1: Подключение telegram-alerts к TON-событиям

**Files:** Modify: `apps/worker/src/ton-payment-reconciler.ts` (хук onResult), `apps/worker/src/ton-payment-bootstrap.ts`; Consumes: `sendAlert` (`packages/telegram-alerts/src/bot.ts:17-57`).

**Interfaces:** Produces: алерты: `review_required` (сразу, с reason), settle-успех (aggregated раз в час, если были), `TON_CHECKOUT_FX_STALE`/oracle-down > 5 мин, lease-fail streak > 3. Severity: review → error, остальное → warn. Тихий no-op без env (как в самом пакете).

- [ ] Тест: мок sendAlert, фикстура review-события → один вызов с reason.
- [ ] Commit: `feat(ton): telegram alerts for review/stale-fx/lease-failures`.

---

## Phase 7: Приёмка и Go-live

### Task 7.1: Полный локальный гейт

- [ ] `bun test:database-baseline` зелёный + TON child; `clean`-rehearsal по контракту `native-clean-rehearsal.ts` (миграции 0098/0099 в инвентаре).
- [ ] Новые тесты Phase 1-6 все зелёные; инвентарные тесты миграций обновлены.

### Task 7.2: Testnet e2e на фикстурах + mainnet smoke (внешние гейты)

- [ ] Testnet: полный прогон checkout→observe→settle на существующих фикстурах (живой testnet-бюджет исчерпан — RPC не трогать).
- [ ] Mainnet smoke — ТОЛЬКО с явного разрешения владельца и после юр-решения: перевод 0.5 TON с кошелька владельца на merchant-адрес → ожидание settle в течение ≤2 тиков → кредиты на балансе → алерт получен. Отдельный чекпойнт-документ `docs/superpowers/plans/2026-10-07-ton-only-launch.md` (этот файл) дополняется секцией «Live evidence».

### Task 7.3: Go/No-Go чек-лист

- [ ] Юр-решение 259-ФЗ (foreign entity / гео-гейт / решение юриста) — документировано.
- [ ] Прод-env собран полностью (секция .env.example), pm2 воркера поднят, `TON_RECONCILIATION_MODE=settle` + confirmation, health `/health:4001` зелёный.
- [ ] Оператор (владелец) прогнал runbook разбора review на тестовом кейсе.
- [ ] Алерты дошли в Telegram-чат.
- [ ] Фиат отключён (env), баннеры живут, `admin/ton` доступен.

---

## Ссылки на источники плана

- Инвентарь TON-кода worktree: `/home/bob/Projects/ai-aggregator/.worktrees/ag-author-version-20260928/apps/web/src/lib/ton-wallet/*`, `apps/web/src/app/api/ton/**`, `apps/worker/src/ton-*.ts`, `packages/database/src/ton-*.ts`.
- Git-стек веток: `.git/packed-refs`, `.git/logs/refs/heads/*` (форензика 2026-10-07).
- Паттерны порта: `/home/bob/Projects/agents-market/apps/tma/src/lib/ton-rate.ts`, `app/api/tma/topup/{init,check/[id]}/route.ts`, `apps/worker/src/topup-reconciler.ts`.
- Юр: `docs/specs/research/R-05.md` (259-ФЗ), `docs/ecosystem/ECOSYSTEM-START-HERE.md:203`.
