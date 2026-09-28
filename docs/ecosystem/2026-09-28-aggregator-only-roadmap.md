# AI Aggregator: активная дорожная карта

Дата: 28.09.2026. Цель текущей разработки — довести **только AI Aggregator** до проверенного полного сервиса. AI Arena и Agents Market остаются отдельными проектами и не входят в критерий завершения этой цели. Их код и дорожные карты не меняются в рамках этой программы.

## Текущая стадия

Локально приняты durable chat, embeddings, scalar completions, streaming, BYOK, async media и batches. Последний финансовый checkpoint: `b949c80`, clean86 applied/no-op, root DB baseline388/388 и TON core58/58; независимые financial/recovery и TypeScript reviews APPROVE. Ветка `feat/durable-batches-20260927` содержит также `277b706`: публичные реквизиты и черновики оферты/условий сняты по запросу владельца; type-check, lint и React/TypeScript review прошли. Эти факты доказывают локальный source candidate, но не deployed runtime. Публичный режим по умолчанию остаётся `legacy`.

AG владеет producer-контрактом `/v1/catalog` и versioned billing receipt. Потребитель каталога в Agents Market — внешний по отношению к этой цели checkpoint. Его отсутствие не подменяет AG-owned доказательства, а его локальный кандидат не считается готовностью Aggregator.

## Обязательные этапы до локального release candidate

| Порядок | Результат и критерий приёмки |
|---|---|
| AG-3a · следующий | Один независимый автор подаёт manifest; moderation допускает только проверенный HTTPS text adapter; опубликованная исполняемая версия имеет неизменяемые identity/digest/rights/price revision. Старый покупательский run остаётся привязан к прежней версии после update/rollback. Native и HTTP тесты проверяют SSRF/redirect/private IP, права, несовпадение digest и replay. |
| AG-3b | Один оплаченный вызов принятой версии создаёт ровно одно начисление автору из подтверждённого AG settlement. Refund/reversal, pending/available/disputed и mock payout переживают crash/replay без второго списания или выплаты. Показанные покупателю и автору суммы согласованы с ledger. |
| AG-4 | TON3 verifier/recovery, затем wallet login/link и checkout/reconciliation рядом с RUB. Только проверенное chain evidence меняет обязательства; существующие RUB top-up/refund не переоцениваются. Testnet proof и mainnet activation — отдельные внешние gates. |
| AG-5 | Закрыть обязательные продаваемые v1 modalities и async состояния, включая transcription, если она остаётся в продаваемом составе. Для каждого включённого маршрута есть сохранённый результат, точный receipt и recovery; `501` не считается реализацией. |
| AG-6 | Operator reconciliation неизвестных post-dispatch исходов, opening balances, observability, rollback и backup/restore rehearsal на отдельном стенде. Оператор может завершить спор без нового платного вызова или перевода. |
| AG-7 | Покупатель, автор и администратор проходят Web/API сценарии; claims на сайте сверены с runtime и политиками; release artifact, мобильная/клавиатурная проверка, pilot и release decision имеют отдельные evidence. |

Последовательный критический путь: **AG-3a → AG-3b → AG-6 → AG-7**. AG-4 и AG-5 могут идти параллельно в отдельных файлах и при одном тяжёлом тесте за раз. Полный сервис требует все шесть этапов, а не только критический путь.

Ориентир планирования: **4–8 недель активной разработки** до локального release candidate при неизменном составе v1. Это оценка, не дата релиза. Время внешних testnet/provider/pilot, юридических решений и production activation сюда не входит.

## Отдельные release gates

- Production migration/deploy, платный provider, mainnet, реальные выплаты и публичный pilot не следуют из локальных тестов и требуют отдельного решения владельца.
- После `277b706` на сайте нет публичной оферты и сведений об ИП. Перед платным публичным запуском нужен юридически проверенный способ раскрытия исполнителя и договорных условий; локальная правка не является разрешением на выпуск.
- Serena/Graphify — производная навигация. LightRAG и Memory Graph считаются обновлёнными только после безопасной записи и readback; существующие ограничения отмечены в [статусе памяти](../consolidation/2026-09-27-memory-refresh-status.md).

Owner evidence: [entrypoint](../DEVELOPMENT-ENTRYPOINT.md), [AG-P3 программа](../superpowers/plans/2026-09-07-production-continuation.md), [паспорт и денежный контракт](payment-and-evidence-design.md), [TON3 plan](../superpowers/plans/2026-09-13-ton-verifier-and-recovery.md). Эта карта заменяет трёхпроектный порядок как **активную цель**, но сохраняет старую карту как исторический контекст.
