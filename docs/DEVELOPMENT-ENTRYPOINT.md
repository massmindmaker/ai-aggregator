# AI Aggregator: начать разработку здесь

Канонический root: `/home/bob/Projects/ai-aggregator`; ветка `feat/three-projects-completion`. Сначала [AGENTS.md](../AGENTS.md), [рабочая карта](consolidation/DEVELOPMENT-WORKFLOW.md) и [границы продуктов](consolidation/ACTIVE-PROJECTS.md).

## Текущий этап — 7 сентября

Последний принятый gateway code — Task5 `b6266cb7`: исполнитель одной stored plaintext/nonstream попытки объединяет hold→dispatch→provider→usage→outcome→settle. Независимое финансовое/spec review — APPROVE,156/156 focused tests, source/test types и lint PASS. Реальная цепочка adapter→HTTP transport проверена с подставленным сетевым ответом: redirects не создают второй POST. Живая платная модель этим тестом не вызывалась.

Исполнитель пока не подключён к маршрутам. Он использует принятые wrapper `1c25d0f` и candidate/quote `3cc5b271`; полный контракт в [gateway admission plan](superpowers/plans/2026-09-07-gateway-charge-admission.md). Принят [дизайн durable key/org/session quotas](superpowers/plans/2026-09-07-durable-spending-quotas.md): v2 DB entrypoints, lifetime session, точная supplier valuation и проверяемые opening balances при cutover. Реализация/native review ещё не выполнены. После них — trusted route composition/HTTP idempotency, recovery/reconciliation, tool calling, SSE/media/BYOK и полный route/refund cutover. Process-local memoization не заменяет восстановление запросов после рестарта.

## Продуктовая программа

[Production continuation](superpowers/plans/2026-09-07-production-continuation.md), [TON alongside RUB](superpowers/plans/2026-09-07-ton-payments.md), [проверенное исследование](research/2026-09-07-ai-hub-reviewed-synthesis.md), [payment/evidence contract](ecosystem/payment-and-evidence-design.md). Пользователь подтвердил локальную реализацию TON и сохранение RUB; Stars исключены из текущего scope. Реальные funds/production migration/deploy не запускаются на основании одного локального PASS.

Aggregator владеет Web, gateway, model catalog, consumer/author money и своим worker. Отдельный crypto origin настраивается в этом же repo; четвёртый продукт не создаётся. AM Web/TMA и Arena остаются в своих roots.

## Размещение и память

Существующий VPS приоритетен. [Проверка восстановления](consolidation/2026-09-07-resume-audit.md) отделяет доступные старые releases от canonical code; выявлены дубликаты Web/worker в двух PM2 managers. Боевые процессы не менялись.

[Memory status](consolidation/MEMORY-STATUS.md): Serena/LSP и Graphify — производный кодовый контекст; LightRAG — принятые общие знания; Brain — человеческая навигация; Codex ad-hoc — собственные рабочие заметки. Старые Serena memories не отменяют текущие code/plans. Успех внешней синхронизации требует readback.

Приватный controller ledger `.superpowers/sdd/2026-09-06-three-repositories/progress.md` восстанавливает точные task/commit/review states; не загружать его в общую память. Пользователь разрешил независимых implementation workers по репозиториям; один владелец на модуль, один heavy run под `flock /tmp/ai-ecosystem-build.lock`. Серьёзные архитектурные/финансовые задачи — Astra с повышенным reasoning; рутина — лёгкие модели. Scorecards и сквозная приёмка остаются источником готовности, не число коммитов.
