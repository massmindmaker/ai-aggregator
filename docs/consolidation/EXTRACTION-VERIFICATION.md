# Проверка разделения трёх проектов

Срез обновлён 07.09.2026 после локального организационного cutover. Это результаты проверки этапа разделения, а не приёмка готовых продуктов. Исходные папки сохранены в выделенном source archive; публикация репозиториев и production deployment не выполнялись. Баллы в трёх 108-пунктных матрицах не начислялись за одну только успешную сборку или перенос путей.

| Проект | Проверенный commit | Результат этапа |
|---|---|---|
| AI Aggregator | product review `ec5013098123194b11fab8bedc1cc42b36f09488`; cutover input `371f376cb3049e4f893a431f30168cb213e16dc8` | Отдельный репозиторий, активные Web / gateway / async worker; текущая ветка наследует принятый TypeScript/spec и React review |
| Agents Market | `a0ad767132e4dffe1a312cef5197ec3a26cc784b` | Отдельный репозиторий, отдельные Web3200 и TMA3100, свой worker; этап прошёл TypeScript/spec и React review |
| AI Arena | `d7420771a9b4453cf7f20c3a98cebba58af6a0fe` | Reviewed PostgreSQL foundation активирована в каноническом repo на `feat/arena-foundation-reviewed`; tracked tree чист, 7 audit/plan файлов сохранены untracked |

## Организационный cutover

- Активные независимые Git-корни: `/home/bob/Projects/ai-aggregator`, `/home/bob/Projects/aiarena`, `/home/bob/Projects/agents-market`.
- Старый контейнер Aggregator целиком перенесён в `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aggregator-sourcecontainer`; старый web-контейнер — в `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aiag-web-sourcecontainer`.
- `legacy-source` в Aggregator и Agents Market указывает на архивный `aggregator-sourcecontainer/core`; donor refs доступны по новому пути.
- Исходный Arena `wave2` HEAD `d0879334c6ce2050199d58ce54efaa99689255de` и 2622 status entries сохранены в stash commit `30c91e2d4d06a6e295cdf41c72097ae5118b183c`, устойчивом `refs/archive/pre-three-root-cutover-20260907` и проверенном `aiarena-pre-cutover-20260907.bundle`.
- Внешний Hermes worktree `/home/bob/.hermes/worktrees/aiarena-wave5-release` остался на `wave5-release` `61b05fbe55e7105778d05ae5a11dd83cb6ead7e6`; его файлы cutover не изменял.
- Полный manifest с inode/count/status/ref parity: `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/three-root-cutover-manifest.md`.

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

На extraction-этапе оставались предупреждения Next14 config/runtime, Browserslist, Tailwind и shared dynamic import, отсутствовал неинтерактивный ESLint/hooks конфиг. Последующие принятые этапы ниже закрывают эти пункты, кроме Browserslist и отдельно отмеченного шума логов.

## Aggregator: принятая native DB baseline

Проверенный commit `320fe21608c6deab883e0dfd01af0b02899e8692`; task base `7c464d2`. TypeScript/spec и React review приняли результат после одного раунда исправлений.

- Полная историческая цепочка: начальная Drizzle migration + 64 SQL-файла. Чистое применение — 65, повторное — 0; readback — 65 записей миграций и 96 таблиц.
- Исторические файлы не изменялись. Native test migrator содержит две ограниченные адаптации: индекс payouts в 0005 и недостающие поля/индекс audit_log в 0011. Он проверяет исходную и фактически исполняемую контрольные суммы; неизвестная структура payouts отклоняется.
- Любая мутация требует явного тестового режима, совпадающих URL единственной разрешённой локальной БД и её marker. Отрицательные тесты доказывают отсутствие импорта модулей приложения при ошибочном адресе или marker.
- Покрывающий набор: 5 файлов, 45/45 тестов. В него входят 8 real PostgreSQL integration tests, 3 import-boundary tests и 2 real registration tests. Отдельная команда baseline, подключённая в CI, прошла локально 13/13; это пересекающиеся наборы, а не дополнительные 13 тестов.
- Реальная БД подтверждает rollback DDL/ledger, идемпотентность миграций, subscription-first/PAYG списание, replay, insufficient-funds rollback и сохранение согласий регистрации. Focused TypeScript checks прошли.

Это локальная проверка. Запуск GitHub CI не заявляется, production schema не изменялась. Последующие unit/lint/type и runtime этапы описаны ниже; refund clawback ещё выполняется.

## Aggregator: принятый unit/type/lint baseline

Task2 принят TypeScript/spec и React review на `04bf3eea8b3097fae7d463e5aa4202955021e907` после одного раунда исправлений. Восстановлен offline-конвертер models.dev в параметризованный SQL с отдельными значениями; исправлены unknown-model 404, тестовые mocks/данные, Next/React resolution и детерминированность тестов worker. Добавлены неинтерактивный lint с hooks rules и отдельные обязательные проверки типов тестов.

- На `875674b`: полный unit — 107 passed / 2 gated test files, 885 passed / 10 gated tests, ошибок нет. Эти 10 DB-тестов прошли отдельным native-запуском: 13/13 вместе с import-boundary checks.
- На том же baseline: root lint — 7/7 задач, root typecheck — 16/16; frozen install не изменил lockfile.
- Ревью обнаружило потерю закрытия внутреннего async iterator при отмене и недостаточную проверку SQL `enabled`. На финальном `04bf3ee` исправлены оба замечания: 23 focused tests и соответствующие typechecks прошли. Проверены отмена после первого/последующих фрагментов, ошибка, естественное завершение и однократные close/settlement/log effects в SSE.
- Полный unit после этого узкого fix не повторялся; production build Task2 не запускал. Оба общих прогона запланированы в следующем runtime-этапе, который меняет shared executor registration и конфигурацию сборки.

Minor ревью: unit output сохраняет Vite CJS/Node localStorage warnings и диагностические сообщения негативных тестов. Это не функциональные ошибки; очистка шума остаётся отдельной задачей. Полный продуктовый выпуск и 108-балльная приёмка не заявляются.

## Aggregator: принятый runtime baseline

Task3 принят TypeScript/spec и React review на `8ddb2fe7c23ac5690fa2dd36d3126d87f755b20f`. Исправлены проверка доступности parseEnv, настройка Next14, литеральные exports health-route, загрузка server-only undici и регистрация vetted egress executor в настоящем пути server-node → server. FAQ сохранил анимацию400ms и получил доступные состояния раскрытия/скрытия для скринридеров.

- На `c169f89`: focused72/72 и два shell contracts, deploy contract, root lint7/7 и typecheck16/16 прошли.
- Там же полный unit:109 passed /2 gated files,893 passed /10 gated tests; root production build:9/9. Четыре целевых предупреждения исчезли, прежний Browserslist warning остался.
- После узкого FAQ fix на финальном `8ddb2fe`: DOM regression1/1, Next lint и Web typecheck прошли; весь build/unit повторно не запускался.
- Controlled startup test импортирует канонический server entry, наблюдает vetted connectAddr в transport options и отказ SSRF до транспорта. Реальный PM2, внешний DNS и платные provider requests этим тестом не проверяются.

## Aggregator: принятая проверка ответа на возврат T-Bank

Транспортный этап принят TypeScript/spec review на `000d2bbb0994c61ecb1b683adda3f54480e9be0c` после одного раунда исправлений. Новый путь сохраняет merchant ExternalRequestId, проверяет PaymentId/OrderId и целые суммы до/после возврата, ограничивает ожидание GetState/Cancel и возвращает неопределённый исход при недостаточном доказательстве. Контекст ACQ/cards создаётся самим клиентом после GetState, заморожен и привязан к экземпляру клиента. Старый payment-provider API сохранён.

- Первоначальный этап `b160c63`:91 focused tests, package typecheck и ESM/DTS build прошли.
- Финальный fix `000d2bb`:80 package tests, typecheck и ESM/DTS build прошли. Это другой, более узкий набор; Web provider tests повторно не запускались.
- Ревью воспроизвело перенос изменяемого method context и отправку чека с несоответствующей суммой. Повторная проверка подтвердила устранение: скопированный/подменённый контекст и partial verified_receipt не вызывают Cancel.
- Автоматически поддерживается только доказанный ACQ/cards. Partial с чеком отключён до полной проверки актуальной fiscal schema; допустим только явный server-trusted no_receipt_required context. Остальные методы и отсутствие доказанного контекста дают not_dispatched.
- Банковские API в этих проверках заменены локальными fixtures; реальных платёжных операций не выполнялось. Наследуемая package-cwd test-команда требует отдельного исправления пути Vitest setup; проверенный root-focused запуск работает.

Снимок выдачи кредитов, DB claim/clawback/debt и подключение routes ещё выполняются. Межзадачная проверка выявила отсутствие долговечной авторизации AI-вызова до upstream: один лишь запрет последующего списания при возврате оставлял бы уже выданный ответ без оплаты. Поэтому перед включением возвратов добавлен обязательный этап durable gateway admission и восстанавливаемого settlement. Task2 добавляет отдельную проверку допуска, сохраняя legacy settlement до совместного переключения. Этот транспортный этап не доказывает сквозной возврат или готовность денежного контура.

## AI Arena

Foundation `692bc12` и review fix `d742077` прошли TypeScript/spec и React review. Удалены 3276 отслеживаемых generated-файлов; исходники и package manifests сохранены. Native PostgreSQL разрешён только в явном тестовом режиме с проверкой адреса и DB marker; production driver остаётся Neon.

- На `d742077`: 41/41 unit tests, typecheck, syntax и проверка текущего tracked tree на фиксированные credentials прошли.
- На foundation commit: Next14.2.35 build прошёл; guarded bootstrap, миграции, direct/HTTP marker и fixtures выполнены на локальной БД.
- Реальные Chromium-сценарии Wave1:26/26; T8, включая конкурентные callbacks, прошёл.
- Полный E2E не прошёл: в Wave3 остаются три проверки reveal/visibility. Ревью выявило устаревшие selectors и отсутствие scroll перед проверкой admin heading; отдельная задача сверит их с исходной UX-спецификацией. После guard/scanner fix полный browser suite повторно не запускался.
- После cutover выполнены canonical `npm ci --ignore-scripts` по lockfile и typecheck. `pg@8.23.0`, `next@14.2.35`, `tsx@4.23.12`, `playwright@1.62.1` разрешаются из основной копии; tracked files не менялись.

Это не приёмка evaluator, рейтингов, выплат или production. Полный исторический secret audit и связанные operational проверки остаются отдельными задачами.

## Следующая проверяемая последовательность

1. Aggregator: native DB, unit/type/lint и runtime baseline приняты; далее P0 refund/credit consistency, затем versioned model metadata API.
2. Arena: оставшиеся lifecycle/team/security задачи и сохранение submission/evaluation результата; отдельное закрытие Wave3 UI baseline.
3. Agents Market: собственная schema, безопасные terminal settlement/claim, native Web identity + dual-proof Telegram linking, полный Web/TMA product flow.
4. Сквозные сценарии: Arena artifact→публикация Aggregator→модель для Agents Market; реальные контракты и evidence в соответствующих108матрицах.

Внешние Node/env/sudo/PM2 permissions, отправка email/Telegram, paid inference, payment callbacks, production release/backup/restore и UI acceptance требуют собственных реальных проверок. Их успешность не следует из локальных unit/build результатов.
