# TON: предварительная проверка полномочий PostgreSQL

Дата: 29.09.2026. Это диагностический инструмент, а не выдача прав и не разрешение на начисления.

## Назначение

`packages/database/scripts/ton-privilege-preflight.ts` читает метаданные PostgreSQL: роли, эффективные права, объекты, default ACL и защитные триггеры. `ton-privilege-preflight-cli.ts` допускает только существующую маркированную локальную тестовую БД. Не загружает `.env`, не создаёт роли, не выполняет миграции, `GRANT`/`REVOKE`, изменение баланса или settlement.

Результат всегда содержит `runtimeSettlementAllowed: false`:

| Статус / exit code | Значение |
|---|---|
| `blocked` / `1` | Найден небезопасный или неполный контракт, либо проверка не смогла завершиться |
| `review_required` / `2` | Перечисленные проверки не обнаружили блокеров; отдельные deployment, кодовые и финансовые gates остаются обязательными |

Exit0 не существует намеренно: этот инструмент нельзя превратить в автоматическое разрешение runtime settlement.

## Что проверяется

Три различные именованные login-роли Web/API/worker; эффективные прямые, наследуемые и доступные через `SET ROLE` права. Для приложений выявляются административные возможности, settlement EXECUTE, защищённые table/column writes, CREATE schema/database, default grants и доступные пользовательские SECURITY DEFINER функции.

Защитные триггеры должны существовать, быть включены и ссылаться на ожидаемую функцию в `public`, без аргументов и без SECURITY DEFINER. Необходимые worker-отношения должны быть обычными таблицами, а не view/foreign table. Проверяются базовые права invoker и наличие settlement-функции с ожидаемыми режимом и search_path.

CLI открывает собственное соединение и `REPEATABLE READ READ ONLY`, задаёт короткие query/statement/lock budgets, закрывает snapshot через `ROLLBACK`, затем соединение. `inspectTonPrivileges` сама выполняет только SELECT и оставляет транзакцию вызывающему коду; `withTonPrivilegeSnapshot` разрешено использовать исключительно на выделенном свободном соединении.

## Повторить регрессионную проверку

Из корня актуального worktree при уже подготовленных native test tools:

```bash
scripts/with-native-test-services.sh bash -c '
  bun run db:test:bootstrap &&
  RUN_NATIVE_DB_INTEGRATION=1 bun run test:unit --no-file-parallelism \
    packages/database/scripts/__tests__/ton-privilege-preflight.test.ts \
    packages/database/scripts/__tests__/ton-privilege-cli.test.ts \
    packages/database/scripts/__tests__/ton-privilege-preflight.native.integration.test.ts
'
```

Native fixture сама создаёт отдельную БД и случайные временные роли. Проверяет настоящие отдельные логины Web/API/worker, прямой отказ в settlement и изменении баланса для приложений, PUBLIC/inherited/SET-only/column/default grants, missing/подменённый trigger/table, definer и отсутствие финансовых изменений. Затем удаляет собственные роли/БД; wrapper останавливает PostgreSQL/Redis. Это одна составная native-проверка, не десятки отдельных успешных тестов.

## Запуск CLI в подготовленной локальной среде

Нужны одинаковые `DATABASE_URL` и `TEST_DATABASE_URL` для `127.0.0.1:15432/ai_aggregator_test`, существующий test marker и `AIAG_TEST_DATABASE=1`. Передайте реальные имена **уже созданных для этой среды** ролей через `TON_AUDIT_WEB_ROLE`, `TON_AUDIT_API_ROLE`, `TON_AUDIT_WORKER_ROLE`, затем запустите `bun packages/database/scripts/ton-privilege-preflight-cli.ts`.

Не подставляйте production URL и не выдавайте дополнительные права ради прохождения проверки. Параметры URL, отсутствующие роли и неоднозначное окружение отклоняются до подключения или дают BLOCKED. CLI не создаёт недостающий marker.
