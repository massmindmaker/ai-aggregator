# Функциональный срез AI Hub — 7 сентября 2026

**AI Aggregator — 43/108 F; AI Arena — 22/108 F; Agents Market Web + TMA — 39/108 F. Ни один продукт не прошёл production-приёмку полного согласованного объёма.**

Это инженерная оценка имеющихся пользовательских и API-сценариев по текущим исходникам и принятым локальным проверкам. Она нужна для выбора следующей работы, не измеряет процент потраченного времени и не обещает оставшиеся сроки. Исторические65.5/48/72 относились к другим версиям и составу; снижение относительно этих чисел не означает удаления реализованных функций.

## Методика и границы

Сохранены12 блоков и36 требований каждого действующего продуктового плана. Для функционального F-среза каждое требование получает0…3: **0** — рабочей функции нет/есть план; **1** — есть часть реализации, крупное звено отсутствует; **2** — основной путь реализован с локальной опорой, но важные ветки/интеграции не приняты; **3** — требование целиком реализовано и проверены относящиеся к нему положительные/отрицательные сценарии. Итого12×3×3=108. Тройка в таблице следует порядку требований в исходном плане. Частичность составного требования не скрывается средним баллом.

Это **отдельный аналитический срез**, не замена исходной шкалы I/T/O и не изменение release gates. Формальные108-строчные CSV приёмки остаются прежними; их UNVERIFIED не трактуется как отсутствие кода. F=2 не обещает свежий E2E каждого пути: часть оценок основана на source и ранее принятых локальных проверках. Новые платные/production прогоны в этом аудите не выполнялись. В спорных source-only областях уверенность средняя. F=3 не начислен за широкое требование только на основании unit-тестов его части.

Денежные и межпродуктовые gates обязательны при любой сумме. TON не добавляет функциональные баллы за существование кошелька или плана: покрытие native/stablecoin, invoice, reconciliation и payouts ещё должно работать. Сумма баллов проектов не подтверждает интеграцию хаба.

## AI Aggregator — 43/108

Source: `b6266cb7`, последующие документы `f3b55a5`. Матрица: [aggregator.md](aggregator.md). Аудит выполнен независимым Astra high по текущим маршрутам, schema и принятым отчётам; controller сверил выводы.

| ID / функция | F1/2/3 | Баллы | Что есть → что необходимо закончить |
|---|---|---:|---|
| AG-01 Каталог | 2/1/0 | 3/9 | Поиск/карточки → актуальные availability/price revision, лицензия, доказательства Arena, достоверные метрики |
| AG-02 Первый вызов | 2/2/1 | 5/9 | Auth и ключи → персональный оплаченный playground с результатом и расходом, восстановление сессии |
| AG-03 Оплата и доступ | 2/1/1 | 4/9 | RUB credit bridge и refund primitives → единый payment/grant/refund/debt flow, renewal и TON |
| AG-04 Исполнение и списания | 1/1/1 | 3/9 | Реальные legacy routes → резерв, durable quota, outcome, HTTP idempotency и восстановление |
| AG-05 Провайдеры | 1/2/1 | 4/9 | Adapters/failover → единый capability contract, ценовые версии и общий предел расхода попыток |
| AG-06 Автор и публикация | 1/1/1 | 3/9 | Заявка и moderation flags → безопасный probe, вызываемая immutable версия, обновление/откат |
| AG-07 Авторский доход | 1/1/1 | 3/9 | Кабинет/заготовки начислений → earnings в действующем credit settle, реальные payout/reversal states |
| AG-08 Организации и права | 2/1/1 | 4/9 | Серверные роли/ключи/egress → полная tenant матрица, author secret protection, квоты всех денежных routes |
| AG-09 Async-результаты | 1/1/1 | 3/9 | Очереди и API → реальный polling/sink, deadline/cancel и одно конечное состояние после restart |
| AG-10 Пользовательский интерфейс | 1/1/1 | 3/9 | Основные страницы → полные buyer/author/admin пути, восстановление ошибок, mobile/a11y |
| AG-11 Поддержка и эксплуатация | 2/2/1 | 5/9 | Native test/migration/deploy contracts → release gate, restore rehearsal, операторская сверка и споры |
| AG-12 Связь с хабом | 1/1/1 | 3/9 | Базовые API → rich catalog/usage, реальные AM/Arena contracts и сквозной авторский выпуск |
| **Итого** | | **43/108** | **65 баллов функциональных требований ещё не закрыты** |

Проверены конкретные основания, а не только наличие файлов: `apps/web/src/lib/marketplace`, auth/dashboard/key/playground routes; `api/webhooks/tinkoff`, subscriptions/refund routes; `packages/api-gateway/src/routes/v1/chat.ts`, `billing/stored-chat-attempt.ts`, routing/registry; `api/models/request-publish`, admin approve/payout routes; `packages/database/src/functions/settle-charge.sql`; `apps/worker/src/index.ts`; `.github/workflows/ci.yml`.

**Завершённый технический результат:** native DB baseline, protocol/refund helpers, admission/quote и одноразовый executor. Последний прошёл156focused tests, types/lint и independent review. **Открытый пользовательский разрыв:** public routes всё ещё используют legacy billing; refund primitives также не включены в публичный процесс. Авторское approve лишь активирует listing, не создаёт вызываемый adapter/version. Credit settle не содержит полного author earnings hook. Async bootstrap оставляет polling/sink заглушками. AM tools теряются на route/adapter boundary. Поэтому полную услугу ещё нельзя считать готовой.

Следующая последовательность: [durable quotas v2](../superpowers/plans/2026-09-07-durable-spending-quotas.md) → trusted composition первого plaintext route и HTTP idempotency → recovery/refund cutover → tools/SSE/media/BYOK → авторская версия/доход → TON/RUB regression и выпуск.

## AI Arena — 22/108

Domain `59e27acc`, harness `8a825925`, [приёмка AR-P2.0](/home/bob/Projects/aiarena/docs/product/acceptance/AR-P2.0.md) на `d00e2e6`. Матрица: [arena.md](/home/bob/Projects/aiarena/docs/ecosystem/arena.md). Независимый Astra high source-аудит и controller review.

| ID / функция | F1/2/3 | Баллы | Что есть → что необходимо закончить |
|---|---|---:|---|
| AR-01 Каталог конкурсов | 2/2/2 | 6/9 | DB-каталог/правила/draft ACL → настоящие deadline/funding условия, private artifact ACL |
| AR-02 Организатор | 1/1/1 | 3/9 | Wizard/draft/moderation → восстановление draft, immutable rules, серверный lifecycle конкурса |
| AR-03 Участники и команды | 2/2/2 | 6/9 | Команды, приглашения, атомарные переходы → deadline policy и все UI/concurrency границы |
| AR-04 Решения и версии | 0/0/0 | 0/9 | Реализовать private submissions, versioned artifacts, workspace и выбор финальной версии |
| AR-05 Исполнитель оценки | 0/0/0 | 0/9 | Реализовать jobs/runner/sandbox, сохранение результата, timeout/retry/platform error |
| AR-06 Методы model/agent/RAG | 0/0/0 | 0/9 | Ввести разные проверяемые методики, версии датасетов и воспроизводимость |
| AR-07 Результаты и рейтинг | 0/0/0 | 0/9 | Public/final datasets, настоящий score, freeze и апелляции |
| AR-08 Слепое сравнение | 0/0/0 | 0/9 | Пары, скрытие идентичности, голос/tie/both bad, антинакрутка и неопределённость рейтинга |
| AR-09 Призы и споры | 1/0/0 | 1/9 | Funding enum → подтверждённое покрытие TON, team split, payout/refund/dispute |
| AR-10 Профили и операторы | 1/1/1 | 3/9 | Профили/уведомления/admin → подтверждённые работы, appeals/reports и UX новых сценариев |
| AR-11 Безопасность и восстановление | 2/0/1 | 3/9 | Auth/roles/test guards → runner isolation, multi-instance limits, restore/queue/release parity |
| AR-12 Публикация в хаб | 0/0/0 | 0/9 | Consent + права + pinned version/evidence → черновик AG/AM → проверенный пилот |
| **Итого** | | **22/108** | **86 баллов функциональных требований ещё не закрыты** |

Основания: `aiarena-app/src/lib/{challenges,enroll,teams,moderation,authz,ratelimit}.ts`, `src/db/schema.ts`, challenge/organizer/profile routes и AR-P1/P2.0. Workspace-заглушка не получает балл за submissions; activity leaderboard не считается рейтингом качества. В enrollment проверяется status, но полного authoritative deadline gate нет. Funding `secured` в поле не доказывает получение средств.

**Завершено:** базовый сайт конкурсов, auth, draft/moderation, команды/приглашения, профили; согласованность семи domain mutations и исправления UI. Focused20 и общий native11 PASS с independent reviews. Общий прогон использовал guarded reuse неизменного ранее собранного приложения, условия описаны в acceptance. **Основной остаток:** само конкурсное ядро — решение → проверка → достоверный результат → приз/публикация.

Порядок: contest policy/deadlines → submissions/versioned artifacts → evaluator/sandbox → model/agent/RAG protocols → public/final/appeals → blind arena → TON prizes и export. Денежный конкурс не выпускается до funding/payout приёмки; бесплатный технический пилот не закрывает призовую функцию.

## Agents Market — 39/108

Совместная оценка продукта с **обязательными Web и TMA**. DB foundation `cfc97f91`, app integration `38b05189`, cleanup follow-up `510c104` с открытым Important review. Матрица: [agents-market.md](/home/bob/Projects/agents-market/docs/ecosystem/agents-market.md). Controller source-аудит, отдельная read-only карта TMA/Web и результаты независимых TS/React reviews.

| ID / функция | F1/2/3 | Баллы | Что есть → что необходимо закончить |
|---|---|---:|---|
| AM-01 Каталог агентов | 2/1/1 | 4/9 | Реальные list/detail, TMA discovery → версия, runtime/permissions, честные условия и Arena evidence |
| AM-02 Вход и активация | 1/0/1 | 2/9 | Telegram auth → native Web auth/recovery, dual-proof linking, первый полезный run в обоих клиентах |
| AM-03 Создание и версии | 1/1/0 | 2/9 | TMA editor/templates → capability validation, immutable publication, update/rollback policy |
| AM-04 Надёжный запуск | 1/1/1 | 3/9 | Run/worker/history/limits → терминальный CAS, cancel/timeout, crash/retry без повторного эффекта |
| AM-05 Рантаймы и подключения | 1/2/1 | 4/9 | Provider/credential/MCP функции → полный health/version контракт и проверенная memory isolation |
| AM-06 Бюджеты и деньги | 1/1/1 | 3/9 | Guarded debit/ledger/daily cap → reservation, exact usage receipt, unknown/reconcile и TON |
| AM-07 Наём и копии | 2/1/1 | 4/9 | Free clone и paid rent транзакции → полный scope/права/бюджет, окончание доступа и расписаний |
| AM-08 Авторский доход | 2/1/1 | 4/9 | Тариф/rent credit/income API → доказуемая сверка, payout/refund/dispute и доступный остаток |
| AM-09 Расписания и разрешения | 2/1/1 | 4/9 | Расписания/атомарный claim, encrypted keys → downtime policy, approvals/kill switch и полный revoke audit |
| AM-10 Web и TMA | 1/2/1 | 4/9 | TMA приложение и Web-витрина → полноценный Web workspace/run/author/billing, общий reconnect |
| AM-11 Поддержка и восстановление | 1/1/1 | 3/9 | Own DB, guards, local checks → hung cleanup, crash/restore/release checks и операторский спор по run |
| AM-12 Интеграция хаба | 1/0/1 | 2/9 | Gateway client и split → убрать чужой SQL, принять tools/capabilities, Arena export и оба releases |
| **Итого** | | **39/108** | **69 баллов функциональных требований ещё не закрыты** |

Основания: `packages/database` и `packages/common/src/{catalog,gateway}.ts`; `apps/tma/app/api/tma/{templates,agents,wallet,me,providers}`, `src/hooks/useAuth.ts`, `src/lib/{crypto,mcp-oauth}.ts`; `apps/worker/src/{agent-runner,db,scheduler,payouts,topup-reconciler}.ts`; `apps/web/src/app`. Уверенность высокая в отсутствии Web кабинетов/versions/export и найденных blockers, средняя в полноте старых TMA runtime/credentials/rent веток без нового сквозного прогона.

В `settleRun` условие `status <> completed` допускает failed→completed; owner/charge также ещё требуют authoritative persisted validation. Atomic debit и успешные четыре baseline financial cases не закрывают эту ошибку. Реальный TON payout send остаётся TODO. Есть unsafe/неподтверждённые legacy chain parsing assumptions, поэтому наличие topup endpoints не считается production crypto. Расписания привязаны к Europe/Moscow; полный downtime/missed-run contract ещё не принят. Отдельные client/provider SQL reads всё ещё требуют AG таблицы.

### Разница между Web и TMA

| Сценарий | Web сейчас | TMA сейчас |
|---|---|---|
| Каталог, карточка | Работают на локальной AM DB; интерфейс требует переработки | Реализованы, source/API шире Web |
| Вход и собственный кабинет | Native auth отсутствует | Telegram auth реализован; полный lifecycle ещё требует приёмки |
| Свои агенты, настройка, история | Отсутствуют | Реализованы частично/по отдельным путям |
| Run → результат → расходы | Отсутствует | Код есть; деньги/recovery имеют blockers |
| Наём и автор | Отсутствуют | Clone/rent/income код есть; version/payout неполны |
| Кошелёк | Отсутствует | Balance/ledger/TON groundwork есть; новый согласованный денежный контур не принят |

**Завершено:** независимый repo, собственная исполняемая БД,26таблиц/8DDL, безопасный test guard, реально проверенный публичный Web/TMA каталог. DB Task1 принят (56unit/10native). Task2 имеет native worker6 и TMA catalogue2, успешные builds/type/lint, HTTP/browser populated/detail/empty/not-found/unavailable и React APPROVE. **Не закрыт:** общий Task2 review — hang deadline локального stack cleanup. Последний root happy path этого замечания не отменяет.

Порядок: закрыть узкий cleanup review → завершить [исследование Web UX](/home/bob/Projects/agents-market/docs/specs/2026-09-07-web-ux-research-checkpoint.md) и контракт сценариев → денежный CAS/резервы/reconciliation → native Web identity и AG rich catalog → один полный useful-run в двух клиентах → авторская версия/доход → TON Web и releases. UX research можно продолжать параллельно денежной базе; строить ложные кнопки завершённых возможностей нельзя.

## Что связывает три проекта и чего пока нет

Папки, планы, API-границы и разработческая память организованы. Сквозной продуктовый цикл ещё не принят: **автор создал версию → Arena проверила → опубликовано в AG/AM → пользователь запустил через AG → результат и квитанция → авторский доход**. Нужны version/evidence/rights manifests, service identity, rich catalog/usage receipts, безопасное поведение при сбое соседнего продукта и consent-based feedback без передачи приватной памяти.

Первый проверяемый рубеж после паузы: Web-пользователь входит без Telegram, получает доступ к агенту, задаёт разрешения и бюджет, выполняет одну поддержанную задачу через Aggregator, видит сохранённый результат и ровно один согласованный расход; reconnect не запускает её заново. Отдельный рубеж Arena — submit version → воспроизводимая оценка, до обещаний денежного конкурса.

## Артефакты и продолжение

- [Построчные оценки F](2026-09-07-functional-checkpoint.csv):108 требований по трём продуктам,36на продукт; это не исходные324 строки I/T/O.
- [Чекпойнт с версиями/review/публикацией/памятью](../consolidation/2026-09-07-pause-checkpoint.md).
- [Актуальные канонические проекты](../consolidation/ACTIVE-PROJECTS.md), [память](../consolidation/MEMORY-STATUS.md).

Баллы остатка — незакрытые пункты шкалы, не равные часы/дни: evaluator и финансовый recovery существенно сложнее отдельных UI состояний. Новый push/deploy не выполнялся; старые production сайты не показывают автоматически эти локальные изменения.
