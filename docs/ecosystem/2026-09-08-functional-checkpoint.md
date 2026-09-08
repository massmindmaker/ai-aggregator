# Функциональный чекпойнт и пауза — 8 сентября 2026

Разработка новых этапов остановлена по указанию пользователя. **Aggregator 45/108 F; Arena 26/108 F; Agents Market Web + TMA 40/108 F. Ни один продукт не прошёл полную production-приёмку.**

## Методика

Сохранена [исходная методика](2026-09-07-functional-checkpoint.md): 36 требований × 0…3 = 108 на продукт. 0 — нет функции; 1 — частичная реализация; 2 — основной путь с существенными пробелами; 3 — целое требование локально проверено. Это функциональный F-срез, не процент оставшегося времени и не исходная release-матрица I/T/O.

Это переоценка изменений относительно 07.09 по принятым исходникам, локальным проверкам и независимым reviews. Неизменённые строки наследуют предыдущий аудит; новый полный аудит каждого старого пути и production-прогон не выполнялись. Отдельные read-only рецензенты сверили изменения по каждому продукту. [Все 108 требований трёх продуктов, по36 на продукт](2026-09-08-functional-checkpoint.csv) содержат прежний балл и основание изменения.

| Продукт | Было | Сейчас | Прирост | Незакрытые баллы |
|---|---:|---:|---:|---:|
| AI Aggregator |43|45/108|+2|63|
| AI Arena |22|26/108|+4|82|
| Agents Market — Web и TMA вместе |39|40/108|+1|68|

Большая инженерная работа может дать небольшой прирост: составное требование не получает полный балл за проверку только одного режима или исправление отдельной ошибки.

## Изменившиеся требования

| ID | Было → стало | Принятое основание и граница |
|---|---|---|
| AG-04.2 |1→2|Stored plaintext HTTP: durable claim, конкурентный повтор, стабильный replay, отказы и потеря ACK. Остальные режимы и production cutover открыты.|
| AG-04.3 |1→2|Billing UUID связывает usage/outcome/result/ledger; проверены rollback и trusted recovery. Операторское восстановление целиком не принято.|
| AR-03.1 |2→3|Статус, authoritative deadline после блокировок и точный повтор вступления; AR-P2.1 и общий AR-P2.3 baseline.|
| AR-04.1 |0→1|Immutable private JSON versions, bytes/digests/history. Исполняемые модели/агенты/RAG этим не реализованы.|
| AR-04.2 |0→1|Серверный выбор 1–2 финальных версий, CAS, дедлайн и receipt. Health-check и полный контракт квот открыты.|
| AR-04.3 |0→1|Приватность JSON workspace и ACL проверены; endpoint secrets и export отсутствуют.|
| AM-04.2 |1→2|Terminal CAS исключает повторный dispatch/settle/notify. Recovery после внешнего успеха до persistence, receipt и reservation открыты.|

Остальные требования без изменения балла. В частности, ни pure TON contract, ни проверенный candidate invoice, ни draft evaluator не равны готовому денежному или оценочному сервису.

## AI Aggregator

Приняты durable quotas, HTTP identity/storage, fresh auth, typed settlement/recovery bridge и реальная mounted server composition для ограниченного non-stream plaintext профиля. MC3/MC4 source ac23cae, harness cd37771 + 1c072b3: native46/46, baseline315/315, types/lint и independent Approved. Сетевой ответ провайдера подставлялся; платный вызов не выполнялся. Default остаётся legacy, production переключения не было.

TON1 a5731d4 принят как точный чистый контракт единиц/quote/testnet assets. TON2 724a031 прошёл исправления и финансовое re-review Approved: exact native58 и unit/scanner214 подтверждены evidence, но **финальный canonical database baseline PENDING и миграция0072 в canonical test DB на паузе не запускается**. Нет принятого verifier, checkout, login или mainnet оплаты.

Далее: закончить TON2 baseline; довести восстановление/refund/cutover и полноценный оплаченный путь; tools/SSE/media/BYOK; авторская вызываемая версия и доход; полные RUB/TON rail проверки и выпуск. Авторская экономика, async lifecycle, restore и межпродуктовая приёмка остаются открыты.

Источник: [owner entrypoint](../DEVELOPMENT-ENTRYPOINT.md), [MC acceptance](../superpowers/plans/2026-09-08-stored-chat-public-cutover.md), [TON2 plan](../superpowers/plans/2026-09-08-ton-invoice-core.md).

## AI Arena

Приняты правила участия и frozen deadlines, приватные JSON-версии и AR-P2.3: выбор одной–двух финальных версий, история редакций, права капитана, конфликты вкладок, повтор после потери ответа, мобильный и клавиатурный сценарии. Application source807fc7c; acceptance7dcf5bd. Свежие migrations/build и все15 registered native/browser scenarios PASS; 21+49+8 unit tests, types/lint и независимые reviews Approved.

**Загруженный JSON ещё не запускается и не оценивается.** Нет evaluator/jobs/results, проверенных методик model/agent/RAG, рейтинга качества, blind comparison, призов и экспорта в маркеты. Следующий план local-prediction-evaluation b3c24a0 сохранён как unreviewed DRAFT, реализация не начата и баллов не добавляет.

Далее: отдельная приёмка узкого воспроизводимого evaluator → устойчивые jobs/results → методики/датасеты/рейтинг → апелляции/призы → export. [AR-P2.3 acceptance](/home/bob/Projects/aiarena/docs/product/acceptance/AR-P2.3.md).

## Agents Market

Приняты собственная БД и приложения на ней, bounded cleanup, terminal CAS9e24aff и изоляция TON/USDT ac313e8. CAS: native37/worker47; asset isolation: TMA native20/worker111; types/lint и independent financial reviews Approved. Native TON poll больше не подтверждает USDT invoice, повтор не списывает деньги повторно.

Web остаётся каталогом и карточками. Native Web auth, workspace, run/history, авторский кабинет и billing ещё отсутствуют. TMA функционально шире, но полный useful-run и денежный lifecycle не приняты. Между AM и AG нет persisted execution identity, authoritative receipt и восстановления потерянного ответа. Нет полной Jetton verification/payout приёмки.

Далее: receipt/reservation/reconciliation контракт AM→AG → Web identity и связывание Telegram → один полный полезный запуск в обоих интерфейсах → версии/авторский доход → выпуск. [Owner entrypoint](/home/bob/Projects/agents-market/docs/DEVELOPMENT-ENTRYPOINT.md).

## Точка возобновления и память

Приоритет сохраняется: Aggregator → Arena → Agents Market. Кооперативная стратегия и мем-токен пилот остаются отложенными. Новые deploy/push, production миграции и mainnet операции этой волной не выполнялись. Локальные результаты не означают, что сайты уже показывают эти изменения.

Канонический факт оценки живёт здесь и в CSV; owner entrypoints и continuation ссылаются сюда. Serena/Brain/LightRAG используются как навигация, Graphify — индекс принятого source. Состояние и границы синхронизации — [MEMORY-STATUS](../consolidation/MEMORY-STATUS.md); Memory Graph остаётся read-only. Следующая сессия начинает с этого чекпойнта и незавершённого TON2 baseline, без повторного запуска уже принятых этапов.

## Выводы для организации следующей работы

1. Единица планирования — законченный сценарий с явными входом, результатом и ошибками. F108 остаётся полной картой, но ближайший этап измеряется локальной приёмкой сценария, а не количеством commits/tests.
2. Перед реализацией фиксировать узкий контракт и негативные случаи; финансовое/архитектурное review проводить до SQL и UI. TON2 показал цену поздней проверки inventory и настоящих RUB/TON lock races; FS3 — цену незафиксированной модели состояния и устаревших async ответов.
3. Параллелить независимые обязанности: автор, reviewer, read-only аудит следующей зависимости. Один владелец изменяемого модуля и один тяжёлый прогон на6GB; дополнительные агенты без независимых задач ускорения не гарантируют.
4. Проверки делать ступенчато: meaningful failing regression → focused tests/types/lint → независимое review → один общий baseline на замороженном source. Проверять ненулевое число найденных тестов; не повторять полный baseline после документационных commits.
5. Уменьшить повторение статуса: один canonical checkpoint и ссылки из entrypoints/памяти. Исторические записи явно помечать; навигационные индексы не использовать как evidence приёмки.
6. Ближайший продуктовый фокус после паузы — один текстовый оплачиваемый сценарий Aggregator с расходом и восстановлением, затем узкая воспроизводимая оценка в Arena. AM готовит контракт интеграции; UI полного запуска строится после стабильного receipt/identity контракта.

Это предложение организации работ на следующую сессию; новые runtime изменения на паузе не выполнялись.
