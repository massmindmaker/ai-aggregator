# Источники и границы выводов

Проведено 06.09.2026: чтение локальных product/spec/audit документов, git HEAD/status/log, деревьев API/schema и выборочных денежных/runtime/worker участков. Production, БД, внешние платные API, браузер и свежие build/test не проверялись. Поэтому «есть код» и «ранее записано в отчёте» отделены от «сейчас работает».

## Прямые источники

| Источник | Для чего использован |
|---|---|
| [PRODUCT текущей копии](/home/bob/Projects/archive/aiag-web/PRODUCT.md) | Обнаружение смешения web и TMA в текущей папке |
| [Паспорт web](/home/bob/Projects/aiag-web/PROJECT.md) | Устаревший указатель на Windows/пустую Linux-папку; опровергнут наличием repo |
| [План web 03.09](/home/bob/Projects/aiag-web/repo/docs/superpowers/plans/2026-09-03-108-score-fixes.md) | Историческая оценка 65.5/108, задачи денег/подписок/надёжности |
| [Свежий settlement](/home/bob/Projects/aiag-web/repo/apps/web/src/lib/payments/settle.ts) | Guarded transactional credit users.balance, необходимость сквозной проверки баланса gateway |
| [Topup](/home/bob/Projects/aiag-web/repo/apps/web/src/app/api/payments/topup/route.ts) | Комментарий ожидает начисление org.payg_credits; это пока не доказательство фактической реализации |
| [Wiring worker](/home/bob/Projects/aiag-web/repo/apps/worker/src/index.ts:32) | Реальный evaluator с log-only sink; stub poll/persist prediction |
| [Agent-worker web-копии](/home/bob/Projects/aiag-web/repo/apps/agent-worker/src/agent-runner.ts:90) | Fallback без AIAG_GATEWAY_KEY |
| [Agent-worker core](/home/bob/Projects/aggregator/core/apps/agent-worker/src/agent-runner.ts:185) | Fail-closed ключа, более развитый run/runtime-контур |
| [TMA чтение каталога](/home/bob/Projects/aggregator/core/apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:235) | Прямая SQL-связь с models/model_upstreams |
| [Suite-спека](/home/bob/Projects/aggregator/core/docs/superpowers/specs/2026-08-22-suite-reorg-design.md) | Историческое решение monorepo + read-only mirrors; конфликт с текущим направлением разделения |
| [План Web/TMA split](/home/bob/Projects/aggregator/core/docs/superpowers/plans/2026-07-17-split-web-tma.md) | Этапы: org/key/wallet → API catalog → FK → DB |
| [Канон core](/home/bob/Projects/aggregator/core/docs/canon/AIAG-CANON.md) | Записанный частичный split, BYOK, приватная память, runtime-vs-marketplace |
| [Readiness 23.08](/home/bob/Projects/aggregator/core/docs/superpowers/specs/2026-08-23-product-readiness-review.md) | Исторические проблемы usage/refund/streaming; повторно проверять, не считать все открытыми |
| [TMA polish 25.06](/home/bob/Projects/aggregator/core/docs/specs/2026-06-25-tma-108-polish-audit.md) | Исторический балл 72, навигация/auth recovery; отчёт содержит более поздние внутри него отметки исправлений |
| [Arena product review 31.08](/home/bob/Projects/aiarena/docs/audit/full-product-review-2026-08-31.md) | 48/108 на старом HEAD; матрица отсутствующих бизнес-потоков и прежний production drift |
| [Arena business review](/home/bob/Projects/aiarena/aiarena-app/docs/audit/business-logic-audit-2026-08-31.md) | Инварианты попыток, public/final, funding, deadlines и команд |
| [Arena schema](/home/bob/Projects/aiarena/aiarena-app/src/db/schema.ts) | Подтверждены базовые сущности; полноценные таблицы evaluation/submissions/battles/votes в этой схеме не найдены |

Исторические сообщения о деплое, процентах, уязвимостях и платежах в этих документах не перепроверены в live-среде. Сравнение двух копий выполнялось выборочно; исчерпывающий diff — задача E0. Оценка срока и целевая архитектура ниже являются предложением по результатам исследования.

LightRAG query_text в доступных инструментах не найден, поэтому семантический recall не выполнен. Поиск в локальном реестре памяти релевантных сведений о трёх продуктах не дал; продуктовые выводы основаны на перечисленных workspace-источниках.

## Внешние первичные спецификации

- [OpenAPI](https://spec.openapis.org/oas/latest.html): стандарт описания HTTP API, выбран как формат будущих контрактов. Конкретную поддерживаемую инструментами версию зафиксировать при E0.
- [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md): стандарт оболочки событий, включая идентификатор и источник. Может использоваться для унификации уведомлений; гарантии доставки/повторов реализуются отдельно.

Это ссылки на форматы, а не доказательство, что существующие проекты уже им соответствуют. Другие технические решения в плане — собственные проектные предложения, а не внешние обязательные требования.
