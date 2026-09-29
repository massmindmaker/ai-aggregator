# AG-6: отдельный стенд восстановления (off-cluster) + opening balances

Spec: docs/operations/off-cluster-restore-stand.md (доказано live: pg_restore на кластер
без ролей падает `role does not exist`; после создания ролей — restore ок, владельцы
сохранены). Дата: 30.09.2026.

Execution: Superpowers subagent-driven. Один тяжёлый прогон за раз под
`flock /tmp/ai-ecosystem-build.lock`. No production, no deploy, no paid calls.
Не трогать `migrations/` применённые, `SECURITY.md`-инварианты: SQL prepared,
деньги через `UPDATE ... WHERE guard RETURNING`.

## Task 1 — Кластеризованный стенд + runbook-скрипт

Files: `packages/database/scripts/restore-stand.sh` (новый, из
`/home/bob/.hermes/cache/scratch/raise-stand.sh`, 105 строк, уже работает live),
`packages/database/scripts/__tests__/restore-stand.smoke.test.ts` (новый).

Требования:
- Перенести рабочий скрипт из scratch в репо: `start|stop|reset|psql`, env `PGDATA`/`PGPORT`,
  дефолт 15432 source / 15433 dest, `unix_socket_directories=$PGDATA` (без этого сервер не
  стартует — сокет-каталог /var/run/postgresql недоступен).
- В `psql`-режиме проксировать `PGPORT` в переменную окружения, чтобы команды шли на нужный
  кластер, а не на дефолт.
- Smoke-тест запускает start→psql select→reset и проверяет, что после reset PGDATA отсутствует.
- Ограничения скрипта: bind только 127.0.0.1, trust auth только на 127.0.0.1, fsync=off
  (одноразовый тестовый кластер), страницы test-only.
- Свободный порт выбирается динамически в тесте, чтобы не зависеть от 15433.
  Прим.: production скрипт держит дефолты 15432/15433.

## Task 2 — Разделение ролей на off-cluster restore + доказательство

Files: `packages/database/scripts/ton-worker-restore.ts` (существующий, 308 строк),
`packages/database/scripts/off-cluster-restore.ts` (новый).

Требования:
- Обобщить `rehearseTonWorkerRestore` так, чтобы destination-кластер задавался явно
  (сейчас destination = тот же 15432 — это ровно то, что AG-6 требует закрыть).
  Сохранить все гварды: `AIAG_TEST_DATABASE=1`, 127.0.0.1, `TON_RESTORE_*` ошибки.
- Новый скрипт `off-cluster-restore.ts`: source и destination на разных портах,
  полный порядок off-host восстановления: create roles → pg_dump → create dest db →
  pg_restore → verify (owners/ACL, снимок финансовых записей, replay old payment → same receipt).
- Доказательство уже получено live: restore без ролей падает `role does not exist`,
  с ролями — ок, owner сохранён. Теперь формализовать как код+тест.
- Тест `off-cluster-restore.native.integration.test.ts`: поднимает два кластера
  (15432/15433), выполняет полный порядок, проверяет owners/ACL и снимок. Skip-механика как у
  существующих native-тестов (только при driver flag).
- Свободные порты выбираются динамically в тесте (15432/15433 могут быть заняты другими
  нативными тестами), дефолты скрипта не меняем.

## Task 3 — Opening balances при cutover

Files: `packages/database/scripts/off-cluster-restore.ts` (расширение Task 2),
`packages/database/scripts/__tests__/off-cluster-restore.native.integration.test.ts`.

Требования:
- После restore на destination проверить: снимок балансов org до и после cutover идентичен;
  первый расход после restore списывается с корректного остатка; ledger/quota/receipt
  согласованы (один request → один immutable outcome).
- Записать процедуру в runbook `docs/operations/off-cluster-restore-stand.md`.
- Прим.: срок жизни стенда ограничен, "/tmp" — одноразовые кластеры, fsync=off.

## Task 4 — Сквозная observability tenant→run→request→charge

Files: `packages/api-gateway/src/billing/` (новый модуль `trace-context.ts`),
`packages/api-gateway/src/__tests__/trace-context.test.ts`.

Ты (реализатор) выбираешь минимальную реализацию: собрать существующие идентификаторы
(tenant org id, billing_request_id, request_id, run id, attempt id) в один trace context,
возвращаемый из вызовов billing-модулей, и дать оператору единый SELECT/HTTP-endpoint
"по одному идентификатору найти все связанные записи". Минимально достаточное: SQL-функция
или модуль + тесты. Не строить распределённую трассировку, не подключать Jaeger/OTel — это
переползание скоупа. Не касаться `migrations/` — только чтение структуры (таблицы уже есть).

## Task 5 — Документация + закрытие AG-6

Files: `docs/product/acceptance/AG-P6.md`, `docs/operations/off-cluster-restore-stand.md`,
`docs/ecosystem/ECOSYSTEM-START-HERE.md`.

Т Task 1–4 зелёные: обновить AG-P6 (закрыть пункты off-cluster stand + opening balances +
observability), обновить runbook (скрипт перенесён в репо), обновить start-here: AG-6 закрыт,
следующий этап AG-7. Коммит-сообщение с точным тест-эвиденсом (какие команды, какие счётчики).

## Global Constraints

- Один тяжёлый прогон за раз, `flock /tmp/ai-ecosystem-build.lock`.
- SQL prepared statements only; деньги `UPDATE ... WHERE guard RETURNING`.
- Не редактировать применённые миграции; читать можно.
- Тесты без внешних вызовов и реальных денег; native-тесты только с драйвер-флагом.
- Не деплоить, не мержить, не пушить. Коммитит контроллер одним проходом (см. aiag-pipeline).
- Worktree: `.worktrees/ag-author-version-20260928`, ветка `feat/ag-author-version-20260928`.
- В тестах динамические порты, чтобы не конфликтовать с другими native-tests.
