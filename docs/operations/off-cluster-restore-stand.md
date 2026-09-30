# AG-6: отдельный стенд восстановления (off-cluster репетиция)

Дата: 30.09.2026. Ветка: `feat/ag-author-version-20260928`.

## Что сделано

Доказан пункт «репетиция `pg_dump`/`pg_restore` на **отдельном** стенде» — ранее репетиция
выполнялась в том же кластере, где уже существуют глобальные роли, и потому не проверяла
поведение настоящего off-host восстановления.

Подняты **два полностью независимых кластера PostgreSQL 18.6** из того же комплекта
(`.superpowers/tools/native18/root`), каждый со своим PGDATA, портом и сокет-каталогом:

| Роль | Хост:порт | PGDATA |
|---|---|---|
| source | `127.0.0.1:15432` | `/tmp/aiag-source-stand` |
| destination (стенд) | `127.0.0.1:15433` | `/tmp/aiag-restore-stand` |

Управление: `packages/database/scripts/restore-stand.sh {start|stop|reset|psql}`
(принимает `PGDATA` и `PGPORT` в окружении). Скрипт **в репозитории**: копия в
`/home/bob/.hermes/cache/scratch/` отстала от закоммиченной (без защиты от
`rm -rf`, без кавычек у `unix_socket_directories`, без проксирования `PGPORT`,
с захардкоженным путём воркtree) и для восстановления не годится.

## Ключевой факт, который вскрыл стенд

**Глобальные роли не переносятся между кластерами.** На destination-кластере
`aiag%`-ролей — ноль, тогда как на source их несколько. Это ровно то, что ломает реальное
off-host восстановление: `pg_dump --format=custom` сохраняет владельцев объектов и
`GRANT`/`REVOKE`, но сами **роли остаются кластерными глобалами и должны быть созданы заново
до `pg_restore`**. Внутри одного кластера этого никогда не видно, потому что роли «уже есть».

Следствие для runbook: восстановление на новый хост обязано иметь отдельный шаг
«создать роли и выдать членство» до `pg_restore`, иначе `pg_restore --exit-on-error`
упадёт на `role "…" does not exist`.

## Почему это не закрывает AG-6 полностью

- Стенд локальный (`/tmp`, `fsync=off`, `trust`-аутентификация). Это доказательство
  поведения восстановления между кластерами, **не** disaster-recovery аттестация и не RPO/RTO.

Оба пункта, которые раньше стояли здесь как открытые, закрыты кодом этой же волны —
`packages/database/scripts/off-cluster-restore.ts`:

- **Роли на destination создаются автоматически**, до `pg_restore`, в правильном порядке:
  читаются owners + ACL-гранты из каталога, на destination выполняется `CREATE ROLE` с
  воспроизведением атрибутов, и только потом идёт restore. Не переносимые `pg_dump`ом
  членства (`pg_auth_members` — кластерные глобалы) тоже сверяются, иначе эффективные
  права после cutover тихо исчезли бы.
- **Сквозная observability `tenant → run → request → charge` реализована** —
  `packages/api-gateway/src/billing/trace-context.ts` (см.
  `docs/product/acceptance/AG-P6.md`). Открытым остаётся только подключение модуля к
  операторскому эндпоинту — это продуктовое решение о политике доступа, а не пробел
  в доказательстве.

Что репетиция **не** делает: не создаёт и не проверяет резервные копии по расписанию,
не измеряет RPO/RTO и не подтверждает production-восстановление.

## Требуемый порядок для настоящего off-host восстановления

1. Поднять пустой PostgreSQL нужной версии.
2. **Создать кластерные роли и членство** (owner + worker + NOLOGIN-владелец функции)
   *до* восстановления.
3. `pg_dump --format=custom` с сохранением owners и GRANT/REVOKE.
4. Создать пустую destination-БД.
5. `pg_restore --exit-on-error --single-transaction`.
6. Сверить owners/ACL, снимок финансовых записей и права функций с источником.
7. Проверить, что повтор старого платежа возвращает прежний receipt.

Оба кластера и их БД — одноразовые, удаляются через `restore-stand.sh reset`.
Production не затрагивается: скрипт принимает только `127.0.0.1` и требует
`AIAG_TEST_DATABASE=1`.

## Opening balances при cutover

Схема, owners и ACL восстанавливаются бит-в-бит — это доказано выше. Деньги
требуют отдельного доказательства: организация должна проснуться на
destination с **тем же** остатком, а первый расход после cutover должен
списаться именно с этого остатка, а не с нуля.

### Что считается «opening balances»

Не только колонки `organizations.payg_credits` /
`organizations.subscription_credits`. Снимок opening balances состоит из
двух частей и читается одним проходом
(`packages/database/scripts/off-cluster-balances.ts`):

1. **Баланс** — `payg_credits`, `subscription_credits`, `refund_debt_credits`.
2. **Леджер, который этот баланс объясняет** — `gateway_transactions`
   (receipts), `gateway_charge_admissions` + `gateway_charge_admission_events`
   (hold/dispatch/settle), `gateway_quota_buckets`,
   `gateway_charge_quota_reservations`, `gateway_charge_quota_contexts`,
   `author_credit_ledger`. По всему этому считается sha256-дайджест.

Два снимка, снятые на разных кластерах, должны совпасть и по балансу, и по
дайджесту. Совпадение только баланса — недостаточно: организация с тем же
остатком, но с другим набором receipts, не восстановлена.

### Инвариант остатка

Леджер не содержит строки на первоначальный грант аккаунта (он предшествует
леджеру), поэтому базовая сумма передаётся явно, а тождество не
самореферентно:

```
balance + reserves == grant + credits - debits
```

- `grant` — исходный грант аккаунта, сообщается вызывающим;
- `credits` / `debits` — суммы из `gateway_transactions` по source
  `payg` / `subscription`;
- `reserves` — незакрытые холды на admissions в состояниях
  `held` / `dispatched` / `outcome_recorded` (холд уже вычтен из баланса в
  момент admission, поэтому в тождестве он возвращается).

**TON-пополнение входит в кредиты.** `source='ton'` — это авторитетный
кредит, а не движение помимо авторитета: settlement одной транзакцией делает
`UPDATE organizations SET payg_credits = payg_credits + _grant`
(миграция `0072:393`) и пишет receipt `type='topup', source='ton'`
(`0072:399`). Поэтому положительные строки `source='ton'` суммируются в
кредиты PAYG наравне с `payg`. Если бы они попадали в `unattributed_delta`,
сверка **никогда** не прошла бы на любой базе, где хоть раз принимали TON-платёж,
и операторский порядок ниже всегда велел бы «стоп» на совершенно здоровом
остатке.

Дополнительно сам TON-путь защищён в базе: constraint-триггер
`aiag_ton_settlement_consistent_v1` (`0072:144-169`, навешен на `ton_invoices`,
`ton_invoice_event_decisions` и `gateway_transactions`, `0072:185-187`) построчно
сверяет receipt с инвойсом и при расхождении отвергает транзакцию на COMMIT.
Сверка Task 3 этому не противоречит, а дополняет: триггер доказывает, что receipt
честный, но **не** сверяет его с текущим значением `organizations.payg_credits`
(в его теле нет обращения к `organizations` вовсе) — расхождение «леджер против
живого баланса» после cutover ловится только здесь.

`unattributed_delta` теперь означает ровно то, что должен: движение, которое не
относится ни к одному известному бакету (например, строка от источника,
не встречающегося в миграциях). Ненулевое значение **обнуляет** согласованность
и останавливает cutover.

### Один request → один immutable outcome

Первый расход после restore проходит через уже применённую авторитетную
цепочку, а не через прямую запись в баланс:

`aiag_admit_gateway_charge_v2` → `aiag_mark_gateway_charge_dispatched` →
`aiag_record_gateway_charge_outcome_v2` → `aiag_settle_admitted_gateway_charge`

Деньги двигает только последняя функция, внутри
`UPDATE ... WHERE guard RETURNING`. После расчёта проверяется:

- баланс уменьшился ровно на `actual_cost_credits`;
- ровно одна строка receipt `type='api_usage'` на оплаченный бакет;
- ровно одна строка `gateway_charge_admission_events` с
  `event_kind='settlement'`;
- повторный `settle` возвращает `did_transition = false` и не добавляет
  receipt — исход неизменяем.

До движения денег проверяется гард: холд больше восстановленного остатка
отклоняется с `OFF_CLUSTER_BALANCE_HOLD_EXCEEDS_RESTORED`, и заведомо
непроходимый расход не оставляет ни admission, ни холда, ни receipt.

### Обязательный порядок проверки на настоящем cutover

1. Снять opening snapshot на source **до** `pg_dump`:
   баланс + дайджест леджера.
2. Выполнить восстановление (шаги 1–6 выше: роли → dump → БД → restore).
3. На destination снять тот же снимок и сравнить с исходным. Расхождение —
   **стоп cutover**, деньги не двигаем.
4. Выполнить первый расход на destination по авторитетной цепочке и сверить
   остаток, receipt, settlement event и неизменяемость исхода.
5. Повторно снять снимок на source и убедиться, что он не изменился: restore
   и расход на destination не должны трогать источник.

Шаги 1, 3, 5 реализованы как `readOpeningSnapshot` /
`openingBalancesIdentical` / `reconcileOpeningBalances`, шаг 4 — как
`firstDebitAfterRestore`. Всё это читает существующие таблицы и вызывает
существующие функции; ни одной новой таблицы, триггера или второго источника
правды не добавлено, применённые миграции не менялись.

### Автоматическая проверка

```
flock /tmp/ai-ecosystem-build.lock env AIAG_TEST_DATABASE=1 RUN_NATIVE_DB_INTEGRATION=1 \
  npx vitest run --no-file-parallelism \
  packages/database/scripts/__tests__/off-cluster-balances.native.integration.test.ts
```

Тест самодостаточен: поднимает **два** одноразовых кластера через
`restore-stand.sh` на динамически выбранных портах (не 15432/15433 — они
заняты другими native-тестами), прогоняет миграции на source, создаёт
фикстуру с историей платежа, восстанавливает на destination **после**
пересоздания ролей, сверяет снимки и выполняет первый расход. Дефолты
`restore-stand.sh` (15432/15433) не меняются.

Ограничения стенда те же: `/tmp`, `fsync=off`, `trust` на 127.0.0.1, тестовые
страницы. Это доказательство поведения cutover, а не DR-аттестация и не
RPO/RTO.
