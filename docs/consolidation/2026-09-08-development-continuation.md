# AI Hub — продолжение разработки 08.09.2026

Приоритет AG → Arena → AM. Superpowers: узкие планы, реализация с независимым review; Caveman: краткие отчёты. Эта страница фиксирует принятые изменения, а не108/108 или production. Ранний [checkpoint](2026-09-08-development-checkpoint.md) сохраняется как история.

| Проект | Принято локально | Проверки | Дальше |
|---|---|---|---|
| AI Aggregator | Quota/executor bridge20187ec, включая исправление JSONB binding реального postgres.js | focused230, native7, strict types/lint; независимое TS/financial Approved | HTTP storage gate A a6c0513 принят (203native/9schema/types/lint, independent Approved); B1 wrappers/seam реализуется; public route и recovery открыты |
| AI Arena | Immutable participation policy1de43e7 и review fixes636866f | full12 native и52unit на первом коде; послеfix свежий PP01–PP06+types/lint; независимое повторное Approved | Private immutable versions, затем sandboxed evaluator; не подменять срок сдачи сроком регистрации |
| Agents Market | Run terminal CAS9e24aff и lint setupff466d0: failed/completed не перезаписываются, payer из persisted run | native37, worker47, types/lint; независимое TS/financial Approved | Authoritative receipt, reservation/recovery; полноценный useful-run Web/TMA |

## Границы приёмки

Публичный Aggregator ещё не переведён на новый admission. Code review нового хранилища завершён; clean69 не подтверждён: существующий guarded helper поддерживает лишь одну фиксированную populated test DB и не имеет reset/rehearsal команды. Rerun не считается чистой установкой. Arena policy не реализует submissions/evaluator/prizes. AM CAS не является резервированием средств или восстановлением неизвестного выполнения.

Прежние F-срезы43/22/39 из108 не пересчитывались. Выпускные I/T/O, RUB/TON, mainnet, публичные маршруты, восстановление и сквозная пользовательская приёмка остаются самостоятельными критериями. Production migrations/deploy/push/платные провайдеры не выполнялись.

## Источники и воспроизведение

[AG plan](../superpowers/plans/2026-09-08-quota-executor-bridge.md), [Arena acceptance](/home/bob/Projects/aiarena/docs/product/acceptance/AR-P2.1.md), [AM plan](/home/bob/Projects/agents-market/docs/superpowers/plans/2026-09-08-run-settlement-cas.md). Карты функционала находятся в каждом canonical repo; [общий указатель](../ecosystem/functional-maps.md).

Существующий local test runtime PG15432/Redis16379; один тяжёлый процесс под /tmp/ai-ecosystem-build.lock. Секреты не копируются в документы. Private review packages и отчёты .superpowers/sdd сохранены для непрерывного продолжения. Новые accepted commits требуют refresh Serena/Graphify; старый индекс не доказывает текущую реализацию. LightRAG locator теперь processed и подтверждён hybrid readback; AM Serena locator обновлён с readback и focused symbol lookup. Полный refresh индексов ещё открыт; Memory Graph не менялся этой волной.
