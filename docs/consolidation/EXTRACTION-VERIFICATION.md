# Проверка разделения трёх проектов

Срез 06.09.2026. Это результаты локальной проверки этапа разделения, а не приёмка готовых продуктов. Исходные папки сохранены; публикация репозиториев и production deployment не выполнялись. Баллы в трёх 108-пунктных матрицах не начислялись за одну только успешную сборку.

| Проект | Проверенный commit | Результат этапа |
|---|---|---|
| AI Aggregator | `ec5013098123194b11fab8bedc1cc42b36f09488` | Отдельный репозиторий, активные Web / gateway / async worker; этап прошёл TypeScript/spec и React review |
| Agents Market | `a0ad767132e4dffe1a312cef5197ec3a26cc784b` | Отдельный репозиторий, отдельные Web3200 и TMA3100, свой worker; этап прошёл TypeScript/spec и React review |
| AI Arena | staging `61b05fbe55e7105778d05ae5a11dd83cb6ead7e6` | Локальная PostgreSQL foundation в работе; оригинал и внешняя рабочая копия Hermes сохранены |

## Agents Market

Извлечение: `6749d1a` + review fixes `a0ad767`. Web пока содержит публичный каталог шаблонов и страницу шаблона; личный кабинет, независимая Web identity и полное исполнение сценариев ещё не реализованы. TMA остаётся самостоятельным интерфейсом этого же продукта.

- Common/TMA/Web/worker typechecks и builds прошли в рамках extraction/fix этапов. TMA:20 сгенерированных страниц.
- На финальном commit независимый root test:96/96 (common46, worker41, TMA9),4 успешные задачи Turbo, без cache.
- HTTP smoke публичных GET:503 при недоступной пустой БД; защищённый POST:401. Это доказательство корректного прохождения middleware, а не успешного DB-backed каталога.
- Четыре реальных DB settlement-теста ещё заблокированы отсутствующей отдельной схемой. Аудит зависимостей:13 findings (2moderate,10high,1critical), исправление не заявлено.

## AI Aggregator

Извлечение `198f6d0`, исправления deploy `77f5d4e` и `ec50130`; база задачи `a77ef0d`. Удалены только перенесённые105 TMA +26 agent-worker файлов; независимый Agents Market и оригиналы их сохраняют. Исторические миграции и legacy contest worker оставлены до отдельного проверенного переноса.

- Focused baseline:5 файлов /60 тестов PASS; pricing, billing preflight, Tinkoff bridge и discovery/header contracts.
- Фактический Vitest discovery:1 файл /2 теста PASS при наличии специально падающей вложенной vendor fixture, которую Vitest корректно не собирает.
- Worker typecheck, gateway ESM/DTS build и отдельный upstream-adapters typecheck PASS.
- Web build:219 страниц. Финальный root build на extraction commit:9/9 задач,7cache. Последующие два коммита меняли только deploy/config и покрыты соответствующими проверками; повторная полная сборка после них не заявляется.
- Deploy contract: default `web gateway worker`, отказ при обязательной build failure и отсутствии runtime artifacts.
- Runtime contract: свежие дочерние процессы получают literal dotenv через документированный PM2 `env`; shell-like строка не исполняется. Fake sudo/PM2 тест подтверждает единый root-owned daemon path. Контроллер независимо повторил оба focused shell-теста.
- Синтаксис shell/Node/YAML и frozen Bun1.4.2 install согласованы. Проверки свежего процесса используют контролируемый Node child и fake PM2, а не реальный production daemon.

Широкий исторический snapshot до финальных discovery исправлений:104 файла,810 тестов;94 файла /796 тестов PASS,10 файлов /14 тестов FAIL. Это не финальное количество оставшихся ошибок. Обнаружены: отсутствующая реализация sync-models-dev, пустая users schema, устаревшие mocks/ожидания payment cancellation/playground/catalog/ModelCard, Next router resolution, legacy contest runner timing. Отдельные Web/gateway test-program typechecks также требуют ремонта.

Остались предупреждения Next14 config/runtime, Browserslist, Tailwind и shared dynamic import. Нет неинтерактивного ESLint/hooks конфига. Minor ревью: диапазон Node>=20.12 формально допускает21.0–21.6 без parseEnv; следующая baseline задача добавляет проверку возможности API.

## Следующая проверяемая последовательность

1. Arena: guarded native DB, credential hygiene, локальные E2E; затем оставшиеся Wave5 lifecycle/team/security задачи.
2. Aggregator: применяемая native test schema, исправление полного baseline, versioned model metadata API и P0 money/runtime.
3. Agents Market: собственная schema, безопасные terminal settlement/claim, native Web identity + dual-proof Telegram linking, полный Web/TMA product flow.
4. Сквозные сценарии: Arena artifact→публикация Aggregator→модель для Agents Market; реальные контракты и evidence в соответствующих108матрицах.

Внешние Node/env/sudo/PM2 permissions, отправка email/Telegram, paid inference, payment callbacks, production release/backup/restore и UI acceptance требуют собственных реальных проверок. Их успешность не следует из локальных unit/build результатов.
