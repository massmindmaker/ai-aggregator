# AI Aggregator: начать разработку здесь

**Пауза и переоценка 08.09:** [актуальные баллы F108, принятые изменения и оставшиеся работы](/home/bob/Projects/ai-aggregator/docs/ecosystem/2026-09-08-functional-checkpoint.md). Новые этапы остановлены по указанию пользователя; прежние оценки ниже — история.

**Продолжение 08.09 — последняя принятая волна:** DB HTTP storage `a6c0513` принят независимым TS/financial review: baseline203, schema9, strict types/lint PASS. HTTP key сохраняет один billing UUID, sanitized result атомарен с quota outcome; Чистая guarded-установка 69 миграций и повторный запуск подтверждены на `f455318`: 69/0, затем 0/69; временная БД удалена, исходная БД не изменена. Независимое ревью принято; это проверка native compatibility runner, не production deployment. [B1](superpowers/plans/2026-09-08-http-storage-gateway-bridge.md) принят в77f0148: typed wrappers и sole outcome seam,219unit/15native/types/lint и independent Approved. B2 canonical HTTP identity принят: `f455318` + review fix `b4ce9f3`, 162 tests/types/lint PASS, независимое ревью Approved. Fresh mounted auth принят (`0fde334`): Redis больше не источник авторизации, 11 tests/types/lint PASS, независимое TS review Approved. C1a SQL принят (`a0b6eb8`): durable admission reject и settlement recovery, baseline263, native50 и clean71 PASS. C1b typed bridge принят (`0f0b395`, test fix `fb849ae`): baseline274/regression403, final native12/types/lint, independent Approved. Следующий шаг — trusted mounted composition и cutover; draft уточняется после architecture review. Ранее quota bridge `20187ecd` принят (focused230/native7); публичный route пока не активирован.

**Чекпойнт разработки 08.09:** [принятые изменения, проверки и следующий этап](/home/bob/Projects/ai-aggregator/docs/consolidation/2026-09-08-development-checkpoint.md).

**Карта функционала:** [сценарии, текущее состояние и оставшиеся работы](product/functional-map.md). Срез 08.09.2026; карта не заменяет приёмку.

**Кооперативная стратегия и порядок работ:** [стратегия](/home/bob/Projects/ai-aggregator/docs/ecosystem/2026-09-07-cooperative-strategy.md) и [roadmap](/home/bob/Projects/ai-aggregator/docs/ecosystem/2026-09-07-cooperative-roadmap.md). Главный поток: Aggregator → Arena → Agents Market; общий фонд и подключение будущих сервисов описаны отдельно от product-owned БД/обязательств. Управленческие параметры — предложения, не действующий устав. На паузе 7 сентября локальные previews и test PostgreSQL/Redis были остановлены. При продолжении 8 сентября восстановлен только guarded test PostgreSQL/Redis; production не менялся.

**Исследовательская волна 1 завершена:** [решения и влияние на планы](/home/bob/Projects/ai-aggregator/docs/research/2026-09-07-research-impact-and-decisions.md). В production continuation добавлены D-задачи и критерии приёмки, включая дополнительный TON login во всех трёх продуктах. Кодовый следующий шаг остаётся quota v2 → public route composition → recovery/refund. Это documentary checkpoint; баллы готовности и deployed code не изменены.

Исследовательский вход перед новой функциональной волной: [программа из18пакетов](research/2026-09-07-research-program.md). Последний запрос пользователя добавил полный Hermes/product/competitor/UX/architecture research и обязательную связь выводов с реализацией. Реестр не заменяет текущий кодовый checkpoint и не блокирует уже определённые узкие исправления.

Канонический root: `/home/bob/Projects/ai-aggregator`; ветка `feat/three-projects-completion`. Сначала [AGENTS.md](../AGENTS.md), [рабочая карта](consolidation/DEVELOPMENT-WORKFLOW.md) и [границы продуктов](consolidation/ACTIVE-PROJECTS.md).

## Принятый этап — 8 сентября

Task6 durable quotas принят локально: `fdd8f22` + test-only `2aa3a7f`. Независимые финансовое/spec и TypeScript review — Approved; 68 миграций с нуля, baseline127/127, итоговые quota85/85, строгие проверки типов прошли. Три измерения settled+reserved: ключ/месяц, организация/день, ключ/SID за всё время. Проверены конкурентные транзакции, rollback, original periods и simulated application ACK loss. Task5 подключён к v2 в отдельной принятой bridge-волне выше. Публичные маршруты ещё не переведены; далее trusted route composition и HTTP idempotency/recovery. Production не активирован.

## Предыдущий этап — 7 сентября

Последний принятый gateway code — Task5 `b6266cb7`: исполнитель одной stored plaintext/nonstream попытки объединяет hold→dispatch→provider→usage→outcome→settle. Независимое финансовое/spec review — APPROVE,156/156 focused tests, source/test types и lint PASS. Реальная цепочка adapter→HTTP transport проверена с подставленным сетевым ответом: redirects не создают второй POST. Живая платная модель этим тестом не вызывалась.

Исполнитель пока не подключён к маршрутам. Он использует принятые wrapper `1c25d0f` и candidate/quote `3cc5b271`; полный контракт в [gateway admission plan](superpowers/plans/2026-09-07-gateway-charge-admission.md). Принят [дизайн durable key/org/session quotas](superpowers/plans/2026-09-07-durable-spending-quotas.md): v2 DB entrypoints, lifetime session, точная supplier valuation и проверяемые opening balances при cutover. Реализация и native review приняты 8 сентября; детали выше. После них — trusted route composition/HTTP idempotency, recovery/reconciliation, tool calling, SSE/media/BYOK и полный route/refund cutover. Process-local memoization не заменяет восстановление запросов после рестарта.

## Продуктовая программа

[Production continuation](superpowers/plans/2026-09-07-production-continuation.md), [TON alongside RUB](superpowers/plans/2026-09-07-ton-payments.md), [проверенное исследование](research/2026-09-07-ai-hub-reviewed-synthesis.md), [payment/evidence contract](ecosystem/payment-and-evidence-design.md). Пользователь подтвердил локальную реализацию TON и сохранение RUB; Stars исключены из текущего scope. Реальные funds/production migration/deploy не запускаются на основании одного локального PASS.

Aggregator владеет Web, gateway, model catalog, consumer/author money и своим worker. Отдельный crypto origin настраивается в этом же repo; четвёртый продукт не создаётся. AM Web/TMA и Arena остаются в своих roots.

## Размещение и память

Существующий VPS приоритетен. [Проверка восстановления](consolidation/2026-09-07-resume-audit.md) отделяет доступные старые releases от canonical code; выявлены дубликаты Web/worker в двух PM2 managers. Боевые процессы не менялись.

[Memory status](consolidation/MEMORY-STATUS.md): Serena/LSP и Graphify — производный кодовый контекст; LightRAG — принятые общие знания; Brain — человеческая навигация; Codex ad-hoc — собственные рабочие заметки. Старые Serena memories не отменяют текущие code/plans. Успех внешней синхронизации требует readback.

Приватный controller ledger `.superpowers/sdd/2026-09-06-three-repositories/progress.md` восстанавливает точные task/commit/review states; не загружать его в общую память. Пользователь разрешил независимых implementation workers по репозиториям; один владелец на модуль, один heavy run под `flock /tmp/ai-ecosystem-build.lock`. Серьёзные архитектурные/финансовые задачи — Astra с повышенным reasoning; рутина — лёгкие модели. Scorecards и сквозная приёмка остаются источником готовности, не число коммитов.

## Чекпойнт перед паузой — 07.09

[Состояние трёх проектов](consolidation/2026-09-07-pause-checkpoint.md), [функциональный F-срез108](ecosystem/2026-09-07-functional-checkpoint.md). Исходная формальная I/T/O приёмка не подменяется аналитическим F. Следующий AG этап — quota v2, public route composition затем recovery/refund cutover; новый executor пока не подключён.

**Текущий шаг gateway:** MC1 HTTP/config contract `41ede0c` принят локально после независимого TS/spec review (26 unit tests, types/lint PASS). [MC2 composition](superpowers/plans/2026-09-08-stored-chat-public-cutover.md) `ac23cae` принят (570tests/types/lint, independent Approved); MC3/MC4 приняты (`cd37771`, test fix `1c072b3`): baseline315 и final native46 PASS, independent Approved. Production switch ещё не выполнен. Режим по умолчанию остаётся legacy.

**TON:** [AG-TON1 pure contract](superpowers/plans/2026-09-07-ton-payments.md) `a5731d4` принят локально (63tests/types/lint, independent financial Approved). Durable invoice, verifier и реальные платежи ещё открыты.

**Следующий финансовый этап:** [TON invoice core](superpowers/plans/2026-09-08-ton-invoice-core.md) — дизайн принят; реализация с отдельной disposable test DB может получить ownership после закрытого MC3. Сохраняются совместимость RUB refund, PAYG ceiling и отдельный mainnet/release gate.
