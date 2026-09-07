# P0: clawback org-кредитов при возврате top-up

Репозиторий: `/home/bob/Projects/ai-aggregator`, ветка `feat/three-projects-completion`, исходная база `2252c95`; выполнять поверх текущей проверенной ветки. Протокольные уточнения от 2026-09-07 в разделе «Binding execution amendments» ниже имеют приоритет над первоначальным текстом. Задача намеренно ограничена Tinkoff top-up. Не объединять все payment providers и не менять subscription-refund семантику.

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


## Binding execution amendments — 2026-09-07

Это последовательные части основной Task 3 плана трёх репозиториев. Они заменяют противоречащие строки первоначального плана: blanket запрет менять adapters, release по любому Success=false, подтверждение partial по webhook, объединение REVERSED с REFUNDED. Старые строки выше сохраняют историю исходного предложения, но не являются контрактом реализации.

Официальный источник — [OpenAPI T-Bank](https://developer.tbank.ru/schemas/eacq/openapi.yaml), проверен 2026-09-07, SHA256 e7686a38723144e739d9268bffb8a6df40d53d98caac18722f92f7043a749ecd. CancelRequest.ExternalRequestId — непустой merchant idempotency key; CancelResponse.OriginalAmount/NewAmount — суммы до/после операции. ExternalRequestId в ответе optional по схеме: отсутствие не является достаточным доказательством для локального settlement. Уведомления не содержат доказанного идентификатора refund operation. GetState.Amount не считается cumulative refunded amount.

Один implementation worker; private brief/report в SDD основной задачи. Все SQL prepared. Все native DB проверки используют принятую схему guard: оба DATABASE_URL/TEST_DATABASE_URL, точный 127.0.0.1:15432/ai_aggregator_test, запрет connection identity overrides, marker/readback до импорта production DB и до любых mutations. Один тяжёлый запуск под flock /tmp/ai-ecosystem-build.lock. Никаких запросов к банку, provider credentials, deployment или изменения других products. Изолированные mocked HTTP fixtures допустимы. Каждый этап проходит review до следующего.

### Task 1: Preserve and validate claim-bound T-Bank refund proof

Ownership: packages/tinkoff/src/types.ts, client.ts, index.ts, новый узкий refund-proof модуль и его тесты; apps/web/src/lib/payments/providers.ts только для добавления отдельной typed Tinkoff top-up capability, если это требуется существующим устройством factory. Существующий PaymentProvider.refund и subscription cancellation сохраняют контракт. Никаких routes, migrations, ledger mutations или включения новых возвратов на этом этапе.

1. Добавить официальные optional ExternalRequestId в Cancel request/response и документированные Params GetState. Сохранить точные копейки и исходный ответ в новом пути; не превращать PaymentId в refund-operation-id. Legacy refundPayment остаётся совместимым.
2. Новый claim-bound вызов принимает сохранённый provider key, PaymentId, OrderId, paid/cumulative/requested integer kopecks и доказанный method context. Key создаётся/сохраняется будущим DB слоем, никогда самим транспортом на retry. До fetch проверять safe integers, 0 < requested <= paid - refunded, nonempty identifiers, method/key restrictions. Не принимать клиентский body как method proof.
3. Pure result union: settled с минимальным валидированным proof; indeterminate с безопасной reason/code; not_dispatched для локальной валидации. Success=false, timeout, non-2xx, malformed JSON и незавершённые статусы не означают no-effect и не дают release. Allowlist доказанных no-effect bank codes первоначально пуст. Никаких сырых body/секретов в ошибках.
4. settled требует Success===true, ErrorCode==='0', exact PaymentId/OrderId/ExternalRequestId, safe nonnegative integer OriginalAmount/NewAmount, OriginalAmount===paid-refunded, OriginalAmount-NewAmount===requested, NewAmount>=0, status REFUNDED только при NewAmount===0, PARTIAL_REFUNDED только при NewAmount>0. Другой status, пропущенная echo, неверный тип, delta или identity => indeterminate. Возвращать только поля доказательства, не доверять TS cast сетевого JSON.
5. Method context: GetState должен совпадать по PaymentId/OrderId и успешному ответу; разобрать документированные Params Key/Value без guessing. При отсутствии/дубликатах/противоречиях Route/Source — unsupported. На первом этапе автоматический Cancel поддерживает только явно доказанный Route=ACQ + Source=cards; остальные комбинации возвращают not_dispatched. Это ограничение возможности автоматического возврата, а не классификация provider=tinkoff как cards. UUIDv4 key допустим для этой ветки, общая длина <=255. Специальные BNPL/installment/AlfaPay операции не включать без их request/receipt контрактов.
6. Partial receipt policy должна быть явной: partial не отправлять без доказанного receipt context. К текущему топапу receipt snapshot не прикреплён, поэтому integration этап должен fail closed для неизвестной кассы/чека. Pure transport может принимать проверенный Receipt либо явный trusted context no-receipt-required; это не client body и не дефолт. Full cancellation Receipt не отправляет. Не придумывать фискальные позиции.
7. RED→GREEN: exact request body/token includes unchanged persisted key and integer Amount; duplicate invocation keeps key; one wrong identity/amount/type/key/method causes zero Cancel fetch; timeout/non2xx/JSON failure remains indeterminate; strict proof valid partial/full and all mismatches; unknown/duplicate Params rejected; legacy refund and init behavior retained. Mock all network; focused types and relevant payment compatibility tests. No full build unless source boundary changes justify it.

Review amendments, fix round1: transport-authorizing method context must be minted by a client-owned bounded GetState capability, immutable and nontransferable between objects/clients. A public pure parser may parse JSON but cannot mint authorization. DB stores immutable method facts; retry re-verifies the saved identity via GetState and compares facts, never fabricates a bank response to recreate an in-memory token. Partial `verified_receipt` is explicitly unsupported in this increment and must return not_dispatched before Cancel, including apparently valid legacy Receipt. Only server-trusted no_receipt_required partial and full no-receipt are enabled. This overrides the optional Receipt support above: a separate fiscal-snapshot increment must validate the current provider schema, exact per-item/total amounts, contacts/limits and immutable retry serialization before enabling it. Legacy init/refund APIs remain unchanged.

Report must name actual base/head, commands/results and any unsupported automatic method/receipt capability; don't label end-to-end refund fixed after only this task.

### Task 2: Atomic snapshot, claims, debt and settlement database primitives

Recheck next migration number (0066 currently free), preserve historical checksums. Extend original snapshot/cumulative fields with persisted refund_provider_key, method context, refund_dispatched_at and consistent all-or-none constraints. A claim key is stable through timeout/retry; no automatically expiring claim. Add partial index on active top-up claims by org. Use ledger request_id refund:claim:<uuid> (fits 64), independent full event refund:full:<payment UUID>. Audit receipt retains claim key, requested/cumulative amounts and proof after clearing active columns; replay A must not consume active B.

Implement primitive claim, dispatch CAS, strict proof finalize, full cumulative reconciliation and proven-no-effect release (no public/general release-on-false). Choose a single org→payment lock order for operations requiring both. Lookup org id first, acquire org row then payment row, revalidate snapshot immutable identity under lock; claim creation must take org lock before making claim visible so gateway's org-locked active-claim check serializes spending. SQL settlement locks org then checks EXISTS active claim without locking payment. No provider call while DB locks held. Confirmation grant also observes compatible ordering or splits its first-time transition safely within one transaction. Review lock graph before coding.

Cumulative SQL numeric rounding and debt arithmetic follow original plan, including full target exactly grant. A full REFUNDED event closes the entire remaining snapshot even if partial claim exists, persists receipt resolving that claim as full reconciliation, and makes late admin finalize a no-op. Dispatch CAS must reject a claim already closed by full webhook. Already in-flight external request uses same idempotency key; reconciliation cannot invent its provider result. Avoid zero-delta duplicate ledger rows and allow legitimate zero-rounded partial audit rows consistently.

Both active claim and debt block non-BYOK stored settlement under org lock, including subscription credits. Debt stays >=0 and payg stays >=0. New top-up repayment keeps whole grant in its snapshot. Original legacy balance remains unchanged in scope.

Native tests must exercise concurrent claim vs settlement, duplicate finalize, A receipt with B active, partial followed by full webhook/late finalize, full-before-dispatch, remaining cumulative amount/rounding/debt repayment and transaction rollback after audit failure. SQL tests prove locking, not only mock calls. Fresh migration application + repeat status; do not reset unrelated schemas.

### Required stage 2B: durable admission before gateway/refund activation

A cross-task review on 2026-09-07 established that existing preflight is a plain SELECT, provider work/SSE precedes settlement and no durable admission exists. Therefore an unconditional claim/debt guard in legacy settlement can reject already-incurred usage. The Task2 instruction above to replace legacy settlement is superseded: Task2 keeps aiag_settle_charge_credits unchanged and adds a separate org-locked non-BYOK admission guard for future atomic admission transactions. Its standalone call is not authorization and the refund routes must remain unactivated until this stage passes.

Before Tasks3–5 activate the flow, implement durable server-owned billing admission separate from client X-Request-Id, org-locked pre-upstream checks, admission-aware idempotent settlement, exact shortfall debt for both refund-first and settle-first ordering, durable retry after SSE/abort and explicit no-charge/queued-media lifecycle. Current BYOK code charges a platform fee; the earlier assumption that BYOK is free is superseded. Preserve actual pricing with server-trusted billing mode and an explicit fee-admission path. Gateway/admission/refund integration shares one reviewed release boundary; no standalone deployment of a post-upstream guard. A detailed bounded implementation plan is required before dispatching this stage.

### Task 3: Confirmation snapshots and monotonic payment transitions

Wire atomic grant/snapshot/debt repayment into actual Tinkoff CONFIRMED path. Only pending|authorized predecessors with no snapshot may grant; persisted amount and bank integer kopecks must agree. Duplicate and late CONFIRMED after refunded/partial_refunded must not grant or downgrade. Other nonterminal notifications use explicit predecessor policy rather than status != confirmed. Keep subscription behavior with regression tests.

Never-granted REVERSED can transition eligible pending|authorized payment to canceled with zero grant; PARTIAL_REVERSED cannot be treated as full cancellation and cannot create credits, so unsupported/reconciliation error. REVERSED against a granted snapshot is contradictory and fail-closed. Missing legacy snapshot never guessed/backfilled. Wrong payment identity must fail before money changes. Tests include reordered authorized/confirmed/refund deliveries and failure rollback of all money fields.

### Task 4: Admin claim dispatch and reconciliation

Maintain requireAdmin + step-up. Read provider/payment ids from DB; reject contradictory body values. Inspect read-only GetState for supported method proof before claim/provider Cancel, using Task1 strict identity parser. Unknown method and unknown partial receipt context fail before Cancel. Claim once, dispatch CAS, network outside transaction, then strict Task1 proof settlement. Indeterminate keeps claim and exposes reconciliation state; no arbitrary new key or success response. Reusing a saved key is permitted only by a specific authenticated reconciliation operation using saved immutable context; never bypass claim ceiling or accept fresh client key. Other providers with possible org grant are unsupported, subscription refund path preserved.

Tests cover concurrent admin, timeout/retry same key, no-effect policy empty, full webhook before/after dispatch, late A response while B active, unsupported receipt/method zero Cancel, step-up and body tampering. Do not contact a real bank. Unsupported automation is explicit response, never fake success.

### Task 5: Refund webhooks, gateway preflight and truthful balance UI

Full signed REFUNDED for a valid snapshot calls cumulative full reconciliation. Partial webhook never settles a claim, even if a local claim exists: delayed event A is indistinguishable from B. Persist high-severity processing/reconciliation error and return non-OK; don't advance cumulative fields from generic Amount. Duplicate full deliveries are idempotent. Successful processed notification returns HTTP200 with exact plain text OK, not JSON; invalid/unsupported events remain non-OK. Subscription semantics unchanged except protocol-correct acknowledgement, with tests.

Gateway preflight and billing summary match stored active-claim/debt block. Include refundDebtCredits and refundPending in summary, spendable zero while either blocks; preserve BYOK path. UI should explain pending reconciliation versus debt without exposing provider errors. Test actual route responses and provider-not-called 402, native race checks, React component behavior if touched. Then run relevant integration/payment/native suites, root types/lint and one final production build covering all refund tasks. No launch/108 claims until the whole user acceptance chain passes.
