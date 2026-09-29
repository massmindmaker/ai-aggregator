# Документация и preflight полномочий TON

Основание: checkpoint c03a700, следующий gate TON3 — разные полномочия worker/Web/API. Пользователь поручил автономно продолжить roadmap и использовать Mintlify/Space Bunny.

## Границы и выбор

Mintlify: десять русских страниц, amber/dark по токенам приложения, source-c03a700. Сохранить PR, не merge/deploy. Другие продукты только read-only status review.

Существующий денежный SQL SECURITY INVOKER остаётся неизменным. Одна и та же привилегированная DB identity для всех приложений не исправляется новым TS экспортом или дефайнером. После независимого разбора выбран минимальный безопасный следующий пакет: read-only анализ фактических эффективных прав. Он выдаёт BLOCKED либо REVIEW_REQUIRED, никогда READY/разрешение runtime settlement. Отдельный role provisioning/credential deployment остаётся будущим security-reviewed gate.

## Обязательные проверки

- Точные три различные runtime role names, наличие ролей; pg_roles без password; collector выполняет только SELECT; CLI владеет отдельной REPEATABLE READ READ ONLY transaction.
- Effective privilege closure: текущие права и SET ROLE, включая промежуточное наследование; elevated/admin/owner role paths.
- Schema/db CREATE, PUBLIC/default grants, table и column mutation rights на TON, balances, receipts, платежах; callable user SECURITY DEFINER/procedure surfaces.
- Settlement функция существует, SECURITY INVOKER и pinned search_path; worker EXECUTE и нужные invoker read/write privileges; required protected triggers действуют.
- Вывод только metadata/findings, без клиентов, платежных записей, секретов или текста body функций. Не выполняет settlement/DDL/grants.
- Guarded CLI на отдельной local test DB; native fixtures создают только свои random roles/DB и проверяют cleanup.
- Сценарии: отсутствие ролей, одна identity, суперпользователь, прямой/PUBLIC/унаследованный/SET-only EXECUTE, column write, disabled trigger, definer, schema/default grants, actual app login denial.
- Независимое automated source review, focused/type/lint/native; прежний полный baseline не выдавать за заново выполненный. Настройки runtime и исторические миграции неизменны.

## Этапы

- [x] Прочитать реальные источники и открыть существующий Mintlify deployment.
- [x] Написать/проверить10страниц, сохранить docs PR1 / f10befe.
- [x] Native/unit RED проверки preflight.
- [x] Реализовать read-only collector, guarded CLI и запрет повышения статуса до READY.
- [x] Native/type/lint/source review, исправления и checkpoint.
- [x] Сверить AM5979588/Arena c2f6559 и сообщить остаток по блокам без выдуманного процента готовности.

Итог: source `32fadef50433058ea31f6540cd98d27bc817c5f4`, [evidence](../../consolidation/2026-09-29-documentation-privileges-evidence.json). Закрыт только ограниченный план документации/preflight; PostgreSQL role deployment/runtime settlement и продуктовые gates не закрываются.
