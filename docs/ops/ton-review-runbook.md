# TON Review Runbook (операторам)

> Контур: TON-only запуск (AG-TON-L). План: [docs/superpowers/plans/2026-10-07-ton-only-launch.md](../superpowers/plans/2026-10-07-ton-only-launch.md), Phase 4.
> Источник истины по причинам: SQL-функция `aiag_settle_ton_invoice_v1` (`packages/database/src/functions/ton-invoice-core.sql`).

## 1. Что такое review_required

`review_required` — **durable-статус** инвойса в `ton_invoices`: деньги реально пришли на merchant-адрес (перевод виден в цепочке и зафиксирован как событие в `ton_chain_events`), но **кредиты НЕ зачислены** и **автоматического выхода из статуса нет**. Статусная машина (`aiag_ton_invoice_guard_v1`) допускает вход в `review_required` из `pending`/`observed`/`expired`, но не допускает из него никаких переходов. Каждое решение оператора пишется append-only в `ton_invoice_event_decisions` — история неизменяема. Пока оператор не разобрал инвойс, деньги «висят»: воркер повторно их не зачислит и не сожжёт (идемпотентность на уровне SQL).

## 2. Как посмотреть очередь

**После Phase 4:** `/admin/ton` — таблица инвойсов со `review_reason`, суммой, asset, tx_hash и кнопками решений (`retry_settle` / `acknowledge_no_credit`).

**Пока Phase 4 нет** (или для прямой проверки) — SQL. Запускать **только под read-only ролью**:

```sql
SELECT id, reference, review_reason, amount_atomic, asset_kind
FROM ton_invoices
WHERE status = 'review_required'
ORDER BY updated_at DESC;
```

Контекст решений по событиям (тоже read-only):

```sql
SELECT d.invoice_id, d.event_id, d.decision, d.reason, d.created_at
FROM ton_invoice_event_decisions d
WHERE d.decision = 'review_required'
ORDER BY d.created_at DESC;
```

Суммы: `amount_atomic` — в атомарных единицах актива (native TON = 9 знаков, делите на 1e9 для «человеческих» TON; для вывода используйте строку/BigInt, не Number).

## 3. Дерево причин и действий

Порядок причин — как в `aiag_settle_ton_invoice_v1` (от более специфичных к менее). Первое сработавшее условие выигрывает.

| Причина (`review_reason`) | Что значит | Действие оператора |
|---|---|---|
| `underpayment` | Перевод меньше суммы счёта (`amount_atomic` события < инвойса) | Кредиты не начислять. По умолчанию — `acknowledge_no_credit` (Phase 4-роут). Если юзер доплатить не может и просит возврат — ручной возврат (раздел 4). Новый платёж — только через новый checkout-счёт. |
| `overpayment` | Перевод больше суммы счёта | Переплата не зачисляется автоматически. `acknowledge_no_credit` + ручной возврат разницы (раздел 4). Если владелец решает зачесть переплату — отдельное решение, не код. |
| `multiple_transfers` | По счёту пришло ≥2 разных цепочечных события (у инвойса уже есть решение по другому событию) | Сверить все события инвойса в `ton_invoice_event_decisions`. Первое событие могло засеттлиться или тоже быть в review. Лишние переводы — `acknowledge_no_credit` + возврат вручную (раздел 4). |
| `additional_transfer` | Новый перевод по уже `settled`-инвойсу (кредиты за первый уже начислены) | Это не «доплата баланса». `acknowledge_no_credit` + ручной возврат (раздел 4). |
| `payment_mismatch` | Факт перевода не совпал со счётом: получатель / asset / reference (комментарий) / отправитель / (для jetton) кошелёк-получатель | Открыть tx в эксплорере, сверить с инвойсом (reference, recipient, expected_sender). Типовые кейсы: перевод без комментария, не с того кошелька. Если деньги наши и автор юзера подтверждён — `acknowledge_no_credit` + возврат вручную. Зачислять «по доверию» запрещено. |
| `late_payment` | Перевод пришёл после `expires_at` счёта (счёт уже `expired` или chainTime ≥ истечения) | `acknowledge_no_credit` + возврат вручную (раздел 4). Повторная оплата — новый счёт через checkout. |
| `owner_changed` | Владелец организации сменился между созданием счёта и сеттлментом | Эскалация владельцу (финконтур). По умолчанию `acknowledge_no_credit` + возврат. |
| `event_already_consumed` | То же цепочечное событие уже засеттлено ДРУГИМ инвойсом | Сверить оба инвойса и событие: юзер мог «размножить» один перевод на два счёта. Кредиты начислены один раз (по первому); второй — `acknowledge_no_credit` + возврат, если юзер платил дважды за одно и то же. При малейшем подозрении на баг — эскалация (раздел 6). |
| `invoice_in_review` | Инвойс уже в review по другому событию | Разбирать первичную причину этого же инвойса (она в `review_reason` истории решений). Новые переводы по счёту обрабатывать как `additional_transfer`. |
| `verification_policy_mismatch` | `verifierVersion` / `finalityPolicyId` в credit не совпали с инвойсом (версия верификатора изменилась между quoting и оплатой) | Обычно массово в момент выката новой политики. Устраняется обновлением политики; затем `retry_settle` (Phase 4-роут, идемпотентен). Если политика уже актуальна, а mismatch повторяется — эскалация. |
| `refund_blocked` | У организации висит фиатный возврат (`refund_debt_credits > 0` или открытый `refund_claim`) | Погасить refund debt через финконтур, затем `retry_settle` (Phase 4). Деньги цепочки тут ни при чём — блокировка защитная. |
| `balance_invariant` | `organizations.payg_credits < 0` — нарушен инвариант баланса организации | Эскалация владельцу (финконтур/бухгалтерия). После восстановления баланса — `retry_settle`. Вручную баланс не править. |
| `balance_compatibility_limit` | Зачисление упёрлось в потолок совместимости (итоговый баланс > 2^53−1 микрокредитов) | Эскалация владельцу. Не чинить руками; `acknowledge_no_credit` — только после решения владельца о судьбе суммы. |
| `evidence_conflict` | Повторно пришло то же событие (`network`+`recipient_account`+`tx_hash`+`message_hash`), но `fact_snapshot` отличается от уже записанного | **Не начислять и не возвращать до разбора.** Это сигнал о возможном баге верификатора/провайдера или расхождении источников. Сразу эскалация (раздел 6). |

Дополнительно: причины верификатора (`network_mismatch`, `policy_mismatch`, `trace_*`, `*_mismatch` из `TonReviewReason`, файл `apps/worker/src/ton-payment-verifier.ts`) пишутся в `ton_chain_observations` на этапе верификации и не переводят инвойс сами; до сеттлмента они не доходят. Если они стали массовыми — эскалация.

Доступные оператору решения (после Phase 4):
- `retry_settle` — повторить сеттлмент через воркерный путь (`settleTonInvoiceAsWorker`, идемпотентен). Применим, когда причина была временной и устранена (`refund_blocked`, `verification_policy_mismatch`, `balance_invariant`).
- `acknowledge_no_credit` — зафиксировать осознанное решение «кредиты не начисляем» с операторским аудитом. Не меняет деньги и не отменяет возврат.
- возврат вручную — вне кода, раздел 4; в БД при этом ничего не менять, событие остаётся `review_required`, решение фиксируется `acknowledge_no_credit` через Phase 4-роут.

## 4. Ручной возврат переплаты (пока вне кода)

1. Зафиксировать `tx_hash` и сумму из события (`ton_chain_events`, либо данные из `/admin/ton` после Phase 4). Переплата = `amount_atomic` события − `amount_atomic` инвойса.
2. Вернуть с **merchant hot-wallet** на адрес отправителя. Отправитель = `expected_sender` из инвойса (для native — `sender` события).
3. Лимит: **≤ 5 TON за одну операцию**. Больше — эскалация владельцу, самостоятельно не возвращать.
4. Записать факт возврата в операторский лог (commit-сообщение / чекпойнт): инвойс-Id, tx_hash возврата, сумма, дата, кто вернул.
5. В БД **ничего не менять**: событие и инвойс остаются `review_required`; операторское решение оформляется только `acknowledge_no_credit` через Phase 4-роут.

## 5. Правила безопасности

- **Никогда** не править `ton_*` таблицы (`ton_invoices`, `ton_chain_events`, `ton_invoice_event_decisions`, `ton_chain_observations`, `ton_reconciliation_cursors`) через UPDATE/DELETE вручную. Всё immutable: триггеры `TON_IMMUTABLE` поднимут исключение, а обход триггеров ломает гарантии идемпотентности и аудита.
- Решения — только через API-роуты Phase 4 (`/admin/ton`), которые пишут append-only решения с аудитом актора.
- Сверочные SQL-запросы — только под read-only ролью.
- Деньги и суммы — BIGINT атомарных единиц; в скриптах/консолях не использовать Number/float для арифметики по суммам.

## 6. Эскалации

- `evidence_conflict` **подряд > 1** — стоп мира: перевести воркер в `observe`/`disabled` (см. `docs/ops/TON-ONLY-RUNBOOK.md`), ничего не начислять и не возвращать, отчёт владельцу. Возможен баг верификатора или рассинхрон TonCenter/TonAPI.
- Любой массовый всплеск review (≥5 за час одной причины) — отчёт владельцу до разбора поштучно.
- `balance_invariant`, `owner_changed`, `event_already_consumed` с расхождениями — всегда эскалация, не разбирать в одиночку.
