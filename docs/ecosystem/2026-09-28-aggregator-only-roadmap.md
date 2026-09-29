# AI Aggregator: активная дорожная карта

Дата: 28.09.2026. Цель текущей разработки — довести **только AI Aggregator** до проверенного полного сервиса. AI Arena и Agents Market остаются отдельными проектами и не входят в критерий завершения этой цели. Их код и дорожные карты не меняются в рамках этой программы.

## Текущая стадия

**TON29.09:** [Tasks5/6 приняты локально](../consolidation/2026-09-29-ton-settlement-and-startup.md): отдельный fixture-путь одного начисления и replay, source export fence, disabled-by-default observe startup и bounded cleanup. Независимые автоматизированные source reviews выполнены. AG-4 остаётся OPEN до DB ACL, wallet/checkout и внешней testnet-приёмки; runtime settlement не включён.

**Продолжение29.09:** [авторские Batch B/C реализованы с локальными проверками](../consolidation/2026-09-29-author-lifecycle-checkpoint.md). Сохранённая проверка, принятые условия, версия запроса, точное начисление, возврат, mock payout и операторское восстановление работают в локальных native/browser-сценариях. Новая независимая приёмка остаётся открытой. AG-4–AG-7 в целом не завершены.

Локально приняты durable chat, embeddings, scalar completions, streaming, BYOK, async media и batches. Последний финансовый checkpoint: `b949c80`, clean86 applied/no-op, root DB baseline388/388 и TON core58/58; независимые financial/recovery и TypeScript reviews APPROVE. Ветка `feat/durable-batches-20260927` содержит также `277b706`: публичные реквизиты и черновики оферты/условий сняты по запросу владельца; type-check, lint и React/TypeScript review прошли. Эти факты доказывают локальный source candidate, но не deployed runtime. Публичный режим по умолчанию остаётся `legacy`.

AG владеет producer-контрактом `/v1/catalog` и versioned billing receipt. Потребитель каталога в Agents Market — внешний по отношению к этой цели checkpoint. Его отсутствие не подменяет AG-owned доказательства, а его локальный кандидат не считается готовностью Aggregator.

## Обязательные этапы до локального release candidate

| Порядок | Результат и критерий приёмки |
|---|---|
| AG-3a · локальный кандидат реализован | Безопасная заявка, сохранённый probe, независимое от автора решение модератора, принятые неизменяемые условия, закреплённая версия в gateway. Native/HTTP и браузерные сценарии подтвердили version switch/rollback, freeze/resume и сохранность старого receipt. Внешний security review остаётся обязательным gate. |
| AG-3b · локальный кандидат реализован | Одно атомарное начисление из подтверждённого settlement; replay, rollback, refund/reversal, disputed/pending/available и mock payout проверены. Реальные переводы и независимая финансовая приёмка не заявляются. |
| AG-4 · observe recovery реализован локально | [TON3 Task4](../consolidation/2026-09-29-ton-observation-recovery.md): восстановление наблюдений, сохранённая позиция, ограниченные ожидания и отключённый bootstrap. Независимое review, fixture settlement, worker-only DB authorization, wallet login/link и checkout остаются отдельными этапами. Только проверенное chain evidence меняет обязательства; существующие RUB top-up/refund не переоцениваются. Testnet proof и mainnet activation — отдельные внешние gates. |
| AG-5 | Закрыть обязательные продаваемые v1 modalities и async состояния, включая transcription, если она остаётся в продаваемом составе. Для каждого включённого маршрута есть сохранённый результат, точный receipt и recovery; `501` не считается реализацией. |
| AG-6 · частично | Для авторских запросов реализованы recovery сохранённого результата, подтверждённое отсутствие списания, спор и возврат без нового inference. Opening balances, общая observability и полноценный backup/restore rehearsal на отдельном стенде остаются открытыми. |
| AG-7 | Покупатель, автор и администратор проходят Web/API сценарии; claims на сайте сверены с runtime и политиками; release artifact, мобильная/клавиатурная проверка, pilot и release decision имеют отдельные evidence. |

Последовательный критический путь: **AG-3a → AG-3b → AG-6 → AG-7**. AG-4 и AG-5 могут идти параллельно в отдельных файлах и при одном тяжёлом тесте за раз. Полный сервис требует все шесть этапов, а не только критический путь.

Ориентир планирования: **4–8 недель активной разработки** до локального release candidate при неизменном составе v1. Это оценка, не дата релиза. Время внешних testnet/provider/pilot, юридических решений и production activation сюда не входит.

## Отдельные release gates

- Production migration/deploy, платный provider, mainnet, реальные выплаты и публичный pilot не следуют из локальных тестов и требуют отдельного решения владельца.
- После `277b706` на сайте нет публичной оферты и сведений об ИП. Перед платным публичным запуском нужен юридически проверенный способ раскрытия исполнителя и договорных условий; локальная правка не является разрешением на выпуск.
- Serena/Graphify — производная навигация. LightRAG и Memory Graph считаются обновлёнными только после безопасной записи и readback; существующие ограничения отмечены в [статусе памяти](../consolidation/2026-09-27-memory-refresh-status.md).

Owner evidence: [entrypoint](../DEVELOPMENT-ENTRYPOINT.md), [AG-P3 программа](../superpowers/plans/2026-09-07-production-continuation.md), [паспорт и денежный контракт](payment-and-evidence-design.md), [TON3 plan](../superpowers/plans/2026-09-13-ton-verifier-and-recovery.md). Эта карта заменяет трёхпроектный порядок как **активную цель**, но сохраняет старую карту как исторический контекст.
