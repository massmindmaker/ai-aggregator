# P0: clawback org-кредитов при возврате top-up

Репозиторий: `/home/bob/Projects/ai-aggregator`, ветка `feat/three-projects-completion`, база `2252c95`. Задача намеренно ограничена Tinkoff top-up. Не объединять все payment providers и не менять subscription-refund семантику.

## Наблюдаемая проблема

При подтверждении Tinkoff top-up `apps/web/src/app/api/webhooks/tinkoff/route.ts:162-227` зачисляет одновременно legacy `users.balance` и реальный gateway-кошелёк `organizations.payg_credits`. Возврат через webhook (`route.ts:307-318`) и admin (`apps/web/src/app/api/admin/payments/refund/route.ts:145-149`) меняет только payment-поля. Выданные org credits остаются расходуемыми.

Текущая схема не хранит исходный grant snapshot. `payments.metadata` содержит только `kind`/`provider`; `balance_transactions` хранит рублёвый legacy deposit, но не `org_id`, не grant в micro-credits и не курс/формулу. `getOrCreateDefaultOrg(userId)` может позже вернуть другую организацию. Поэтому для уже подтверждённых top-up нельзя надёжно восстановить, какой org и сколько micro-credits получил. Автоматический backfill по текущей формуле запрещён; такие платежи требуют ручной сверки.

Существующий unique index `uq_balance_tx_payment_type(payment_id,type)` допускает только один `refund` на payment и поэтому не годится как источник истины для нескольких partial refunds. Источником истины для clawback должны стать typed snapshot/cumulative поля payment и `gateway_transactions` как append-only audit.

## Минимальная production-correct модель

Добавить миграцию `packages/database/migrations/0066_topup_refund_clawback.sql`:

- `payments.topup_org_id UUID NULL REFERENCES organizations(id)`;
- `payments.topup_paid_kopecks BIGINT NULL`;
- `payments.topup_grant_credits BIGINT NULL` — здесь и ниже credits означают текущий runtime unit, то есть micro-credits;
- `payments.topup_refunded_kopecks BIGINT NOT NULL DEFAULT 0`;
- `payments.topup_clawed_credits BIGINT NOT NULL DEFAULT 0`;
- `payments.refund_claim_id UUID NULL`, `refund_claim_kopecks BIGINT NULL`, `refund_claimed_at TIMESTAMPTZ NULL` — один внешний refund in flight;
- `organizations.refund_debt_credits BIGINT NOT NULL DEFAULT 0 CHECK (refund_debt_credits >= 0)`;
- CHECK: snapshot либо целиком NULL, либо `org_id != NULL`, `paid_kopecks > 0`, `grant_credits > 0`; cumulative refund/clawback неотрицательны и не выше snapshot totals; claim-поля либо все NULL, либо все заполнены и amount > 0;
- partial unique index на `gateway_transactions(request_id, source) WHERE type='refund'`, где `request_id='refund:' || claim_id` и `source='payg'`.

Отразить payment-поля в `packages/database/src/schema/payments.ts`. Org balance columns сейчас намеренно управляются raw migrations и не описаны в Drizzle schema; helper ниже может использовать подготовленные SQL-template запросы, не расширяя `organizations.ts` только ради одного поля.

### Snapshot на CONFIRMED

В `creditBalance` того же Tinkoff webhook:

1. Перевести сохранённый `payments.amount` и проверенный bank amount в целые копейки; при несовпадении не зачислять и вернуть ошибку/alert.
2. Разрешить создание snapshot только delivery, выигравшей существующий guarded transition pending/authorized -> confirmed. Duplicate confirmed ничего не дописывает.
3. Получить org ровно один раз и в той же DB-транзакции записать `topup_org_id`, `topup_paid_kopecks`, `topup_grant_credits` вместе с grant.
4. Заморозить текущий grant: `round(paidRub * 1_200_000 / 990)`. Refund никогда не пересчитывает его по будущему pricing.
5. Новый top-up сначала погашает `refund_debt_credits`, остаток увеличивает `payg_credits`. Полный grant всё равно сохраняется в snapshot данного payment: если этот новый платёж позднее вернут, отменяется и часть, которой он погасил старый долг.

Legacy `users.balance`/deposit оставить как есть в этой задаче. Он не используется gateway (`dashboard/billing/summary` и gateway читают organizations), а его переработка расширит scope.

### Cumulative partial refund

Создать `apps/web/src/lib/payments/topup-refund.ts` с тремя узкими операциями на prepared SQL:

1. `claimTopupRefund(paymentId, requestedKopecks)`:
   - в короткой транзакции блокирует payment row;
   - принимает только `metadata.kind='topup'`, Tinkoff, status `confirmed|partial_refunded`, полный snapshot и отсутствие активного claim;
   - проверяет `0 < requested <= paid - topup_refunded_kopecks`;
   - пишет новый UUID claim и amount, затем коммитит до сетевого вызова;
   - повторный/конкурентный claim получает 409 и не вызывает provider.
2. `finalizeTopupRefund(claimId, providerRefundId, source)`:
   - в одной транзакции `SELECT ... FOR UPDATE` payment, затем org;
   - если `gateway_transactions` уже содержит `refund:<claimId>`, возвращает `already_settled`;
   - `newRefunded = oldRefunded + claimKopecks`;
   - вычисляет cumulative target только в SQL numeric: `targetClaw = round(grant_credits::numeric * newRefunded / paid_kopecks)::bigint`; при полном возврате target обязан быть ровно `grant_credits`;
   - `delta = targetClaw - topup_clawed_credits`; это устраняет накопление ошибки округления при серии partial refunds;
   - снимает `min(payg_credits, delta)` с payg; недостающую уже потраченную часть добавляет в `refund_debt_credits`;
   - атомарно обновляет `payments.refunded_amount = newRefunded / 100`, typed cumulative поля, status `partial_refunded|refunded`, `refunded_at`, очищает claim;
   - вставляет audit row `gateway_transactions(type='refund', source='payg', delta=-delta, request_id='refund:<claimId>')` с metadata payment/org/refund/debt/source.
3. `releaseTopupRefundClaim(claimId)` — очищает claim только при однозначном provider `success:false`. При timeout/throw claim остаётся для ручной сверки; повторный refund не запускается.

`refunded_amount` всегда cumulative, а не amount последнего события. Статус `partial_refunded` должен оставаться допустимым для следующего последовательного partial claim.

### Политика уже потраченных credits

Не ослаблять CHECK `payg_credits >= 0`. Недостаток писать в отдельный положительный `refund_debt_credits`; это яснее отрицательного bucket и сохраняет действующие инварианты.

Пока debt > 0, org должен быть полностью fail-closed для non-BYOK gateway traffic:

- `packages/api-gateway/src/billing/settle.ts::assertPositiveBalance` читает также debt и возвращает 402, если debt > 0, даже при положительных subscription credits;
- `packages/database/src/functions/settle-charge.sql` и та же `CREATE OR REPLACE FUNCTION aiag_settle_charge_credits` в migration 0066 повторяют проверку под org row lock перед списанием. Preflight сам по себе недостаточен из-за race/bypass;
- будущие top-ups автоматически гасят debt; gateway снова открывается только после debt=0.

Это сознательно строгая политика: возвращённые, но уже потраченные credits образуют долг и блокируют весь оплачиваемый gateway, включая subscription bucket. BYOK остаётся бесплатным и не проходит этот баланс-gate.

`apps/web/src/app/api/dashboard/billing/summary/route.ts` должен возвращать spendable=0 при debt>0 и отдельный `refundDebtCredits`, иначе UI покажет положительный баланс при фактическом 402.

## Встраивание в существующие endpoints

### `apps/web/src/app/api/admin/payments/refund/route.ts`

- Сохранить `requireAdmin()` + step-up.
- Для Tinkoff top-up использовать claim -> provider call вне транзакции -> finalize/release.
- Provider и providerPaymentId брать из payment row; значения body удалить либо требовать точного совпадения. Клиент не должен выбирать чужой provider reference.
- Полный/partial ceiling считать в копейках из typed cumulative state.
- Subscription payment не направлять в новый helper. Существующую subscription cancellation/refund ветку не менять этой задачей.
- Top-up другого provider не пытаться «унифицировать»: оставить прежний путь без org clawback только если доказано, что он не выдавал org grant; иначе 409 `TOPUP_REFUND_PROVIDER_UNSUPPORTED` до provider call.

### `apps/web/src/app/api/webhooks/tinkoff/route.ts`

- Не менять payment status/refundedAmount до clawback.
- `REFUNDED|REVERSED` для snapshotted top-up можно финализировать как cumulative full refund. Если локальный claim существует, использовать его; без claim создать детерминированный internal full-refund claim и применить ровно оставшийся paid amount.
- `PARTIAL_REFUNDED|PARTIAL_REVERSED` использовать только как подтверждение существующего local claim. Не выводить refunded delta из webhook `Amount`: локальный тип описывает его лишь как generic payment amount, а имеющийся код не устанавливает, cumulative это значение или delta.
- Duplicate webhook после уже settled claim — `already_settled`, без нового clawback.
- Partial webhook без local claim, snapshot missing или противоречивые суммы: не угадывать org/amount, записать high-severity processing error и вернуть non-OK (503) для повторной доставки/ручной сверки. Не переводить payment в refunded и не подтверждать событие как обработанное.
- Для subscription payment оставить текущий `handleRefund` без изменений: subscription clawback явно вне этой задачи.

T-Bank документирует, что partial/full refund переводят платёж соответственно в `PARTIAL_REFUNDED`/`REFUNDED`, а webhook повторяется до корректного `200 OK`; это поддерживает status-based full refund и идемпотентную повторную обработку. Документация не даёт достаточного основания считать webhook `Amount` cumulative refunded total: [возвраты](https://developer.tbank.ru/eacq/scenarios/cancel_confirm/), [уведомления](https://developer.tbank.ru/eacq/intro/developer/notification).

## Точные файлы изменения

- `packages/database/migrations/0066_topup_refund_clawback.sql` — поля, constraints/index, debt guard в stored function.
- `packages/database/src/schema/payments.ts` — typed snapshot/cumulative/claim поля.
- `packages/database/src/functions/settle-charge.sql` — каноническая копия debt guard.
- `apps/web/src/lib/payments/topup-refund.ts` — claim/finalize/release.
- `apps/web/src/app/api/webhooks/tinkoff/route.ts` — snapshot при confirmation и top-up refund dispatch.
- `apps/web/src/app/api/admin/payments/refund/route.ts` — Tinkoff top-up branch.
- `packages/api-gateway/src/billing/settle.ts` — preflight debt block.
- `apps/web/src/app/api/dashboard/billing/summary/route.ts` — честный spendable/debt response.
- Тесты ниже. Не менять `apps/web/src/app/api/subscriptions/cancel/route.ts` и provider adapters.

## Regression scenarios

Расширить `apps/web/src/app/api/webhooks/__tests__/tinkoff-credit-bridge.test.ts`:

- confirmation сохраняет org/paid/grant snapshot в той же транзакции;
- 990 RUB snapshot = 99_000 kopecks и 1_200_000 micro; duplicate CONFIRMED ничего не меняет;
- новый top-up сначала погашает debt, затем увеличивает payg;
- subscription confirmation/refund поведение не изменилось.

Добавить `apps/web/src/lib/payments/__tests__/topup-refund.test.ts`:

- partial 1/3 + 1/3 + остаток использует cumulative rounding, а финальный clawback равен grant точно;
- две partial refund последовательно накапливают `refunded_amount`, не перезаписывают его;
- duplicate finalize одного claim создаёт один ledger row и один delta;
- недостаточный payg создаёт точный debt, не уводит payg ниже нуля;
- новый top-up частично/полностью гасит debt;
- missing snapshot, wrong kind/provider, over-refund и zero amount отсекаются до provider call;
- definitive provider failure освобождает claim; throw/timeout сохраняет claim;
- full unsolicited webhook со snapshot применяет только remaining amount; partial unsolicited webhook fail-closed.

Расширить `apps/web/src/__tests__/payments/routes.test.ts` и `admin-refund-stepup.test.ts`:

- два concurrent admin POST: provider вызван один раз;
- admin claim + concurrent webhook: один clawback/ledger entry; поздний admin finalize получает already_settled;
- webhook first + duplicate webhook: один эффект;
- после первой partial второй последовательный admin partial разрешён, cumulative ceiling соблюдён;
- body provider reference не может отличаться от DB;
- step-up и существующие subscription tests остаются зелёными.

Расширить `packages/api-gateway/src/__tests__/billing-preflight.test.ts`:

- debt>0 даёт 402 до upstream даже при положительном total/subscription balance;
- debt=0 сохраняет текущие BIGINT/preflight cases;
- stored settlement race check тестируется отдельно SQL-интеграцией.

Добавить Postgres-интеграционный тест, например `apps/web/src/lib/payments/__tests__/topup-refund.integration.test.ts`, по образцу atomic money tests: параллельные finalize одного claim, параллельный gateway settle и clawback на одной org row, rollback при ledger/update ошибке. Мок-тесты не доказывают row-lock/WHERE-guard семантику.

## Явно вне scope

- Унификация YooKassa/SBP/CloudPayments payments и их webhook formats.
- Subscription credit clawback, cancel policy и prorating.
- Backfill старых confirmed top-ups без snapshot.
- Изменение legacy `users.balance` и `balance_transactions`.
- Chargebacks/disputes и автоматическое снятие блокировки после ручной сверки unsupported webhook.
