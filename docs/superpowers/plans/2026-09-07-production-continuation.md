# AI Aggregator: продолжение до production Implementation Plan

> **Для исполнителей:** REQUIRED SUB-SKILL: использовать Superpowers executing-plans либо уже разрешённый контроллером subagent-driven-development; выполнять по одной проверяемой задаче. Текущий статус выполнения ведётся в рабочем входе, не выводится из этого плана.

**Goal:** Закрыть продаваемый авторский API и денежный путь RUB + TON с доказанной эксплуатацией.

**Architecture:** Aggregator владеет каталогом/версией, gateway usage и своим ledger. Arena evidence и AM inference подключаются через versioned HTTP contracts; отдельный домен — настройка того же repo/VPS.

**Tech Stack:** Next.js, TypeScript, PostgreSQL, существующие Bun/Vitest/native guards.

**Spec:** [Roadmap](../../ecosystem/aggregator.md), [дизайн оплаты и evidence](../../ecosystem/payment-and-evidence-design.md).

## Global Constraints

- Только свой канонический repo; не откатывать работу соседних исполнителей. Exact scoped commit после тестов/review.
- Один тяжёлый build/test через `flock /tmp/ai-ecosystem-build.lock`; guard до любого DB client/import/mutation, только собственная локальная test DB.
- SQL prepared; денежные единицы exact integer, CAS/RETURNING и append-only receipts.
- Никаких mainnet средств, платных upstream, production migration, push или нового deploy в локальном этапе. Существующие targets сохраняются.
- Каждый шаг: RED нужного поведения → минимальная реализация → focused PASS → spec/quality review → commit/evidence. TypeScript/React изменения проходят профильный review.
- Ни один незапущенный тест, fixture, обзор кода или план не засчитывается как production acceptance.

---


## Карта этапов и артефактов

| Порядок | Пакеты исходной roadmap | Вход → выход | Gate |
|---|---|---|---|
| AG-P1 | AG-W1/W2 | Принятая charge-admission задача → все оплачиваемые dispatch пути используют hold/outcome/settle | Нет unmetered path, unknown outcome не rerun |
| AG-P2 | AG-W4/AM-W1 | Каталог → публичный rich DTO с capability/price revision | AM contract consumer работает без AG SQL |
| AG-P3 | AG-W3/W5 | Авторский manifest → продаваемая версия → usage → earnings/refund | Один независимый автор, replay/race/failure доказаны |
| AG-P4 | AG-W1/W2/новый TON | RUB сохранён, TON invoice testnet → доступные gateway credits | [TON-план](2026-09-07-ton-payments.md) полностью принят по I/T |
| AG-P5 | AG-W4/W6 | Включённые modalities/async + truthful UX → release candidate | Recovery/claims/parity/pilot и обязательные I/T/O |

### Task AG-P1: денежное основание и следующие маршруты

**Files:** [принятый granular plan](2026-09-07-gateway-charge-admission.md); `packages/api-gateway`, `packages/database`, `apps/web/src/lib/payments`; evidence в `docs/product/acceptance/AG-P1.md`.

- [ ] Прочитать фактический последний verdict granular plan и code review; уже принятые шаги не переписывать и не запускать заново без изменения/дефекта.
- [ ] Составить по продаваемым routes таблицу reserve/dispatch/outcome/settle/reconcile, request identity и provider effect. Для каждого uncovered пути создать отдельный focused brief с точными файлами и RED crash/replay test до изменения кода.
- [ ] Закрыть remaining billable routes по одному, начиная с фактически включённых в каталоге. Проверять отказ admission до provider, двойной request, неизвестный outcome, concurrent refund/hold и exact credit invariant на native DB.
- [ ] В обязательном guarded `test:database-baseline` сохранить доказательство результата и migration manifest. Связать provider usage/receipt с локальным ledger; неполученный usage остаётся reconciliation, не guessed charge.

### Task AG-P2: контракт каталога для реального потребителя

**Files:** `packages/api-gateway` route/catalog implementation, `packages/shared` DTO/contract tests; producer/consumer evidence `docs/product/acceptance/AG-P2.md`. Перед coding brief зафиксировать существующий route registration, не создавать второй обходной сервер.

- [ ] Зафиксировать `/v1/catalog` schemaVersion, stable IDs, model/provider version, modality/capabilities, exact pricing currency/unit/revision, доступность и pagination. `/v1/models` остаётся совместимым.
- [ ] RED: unsupported capability не проходит, цена без unit/revision отвергается, unavailable provider не продаётся; AM fixture consumer валидирует именно JSON producer.
- [ ] Реализовать один public contract, cache revision/invalidation и 401/402/503 semantics без раскрытия upstream secrets. Проверить реальным локальным HTTP producer/AM consumer без AG DB credentials у AM.
- [ ] Записать pinned fixtures и совместимость. Изменения цены не меняют уже выданный quote/receipt.

### Task AG-P3: marketplace автора и паспорт

**Files:** текущие author/moderation routes в `apps/web`, registry/database модули и `docs/product/acceptance/AG-P3.md`; общий [паспорт](../../ecosystem/payment-and-evidence-design.md).

- [ ] Выбрать уже поддержанный HTTPS text adapter; оформить точный brief manifest→moderation→version→invocation→earnings. RED: SSRF/redirect/private IP, invalid schema, отсутствие прав, смена digest и повтор начисления.
- [ ] Завершить один авторский flow с тестовым автором и контролируемым endpoint. Цена/доля берётся из версионированной политики, не из маркетинговых «70%».
- [ ] Проверить снятие с продажи/rollback/старую версию, refund после consumption, payout mock crash/replay. Публичный evidence attach только к совпавшему digest и с consent; чужие private traces не экспортируются.
- [ ] UI/API receipt объясняет цену, долю, pending/available/reversed и обращение в поддержку.

### Task AG-P4: TON alongside RUB

- [ ] Выполнить [отдельный TON-план](2026-09-07-ton-payments.md) после принятия ledger/admission инвариантов. Native и allowlisted stablecoin сохраняют собственную asset identity.
- [ ] Regress существующий RUB webhook/top-up/refund. Ни один pending RUB order не переписан и не переоценён.
- [ ] Перед mainnet оставить конкретный release checklist: real merchant/recipient ownership, approved FX/fees/refund terms, signer custody, наблюдаемость и rehearsal. Реальные деньги не выполняются этим планом локальной разработки.

### Task AG-P5: release candidate и честные обещания

**Files:** `docs/product/acceptance/release-candidate.md`, существующие release/config/runbooks, `apps/web` только по доказанным UX gaps.

- [ ] Пройти каждый включённый modality/async route до сохранённого результата и receipt; test заглушка не считается работающим upstream.
- [ ] Таблица claims: текст/страница → runtime/API/policy evidence → дата/владелец. Проверить SLA/fallback, цены/context моделей, author share, «автооценка за48ч», сравнения конкурентов, contest links после split. Неподтверждённое исправить/снять до release.
- [ ] Отдельный AG origin/callback/CORS/cookie config проверить локально; оставить существующий VPS. Сверить deployed commit/artifact/DB manifest перед любым release, HTTP200 этого не доказывает.
- [ ] Пройти mobile/desktop/keyboards/error recovery, backup restore на отдельном стенде, incident queue/reconciliation и все обязательные интеграции. Зафиксировать pilot result и реальные I/T/O по исходной108-матрице; найденные gaps остаются FAIL/UNVERIFIED.

Этот документ — последовательность программы. Каждый ещё не реализованный крупный пакет получает focused implementation brief по свежему коду; он не даёт права считать тысячи неизвестных строк заранее проверенными.
