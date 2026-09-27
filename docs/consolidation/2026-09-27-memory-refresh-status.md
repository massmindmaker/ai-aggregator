# AI Hub: проверка слоёв памяти 27.09.2026

Источник продуктовой истины — текущий git, owner entrypoints и принятые acceptance-файлы. Этот документ фиксирует свежесть производных слоёв и не принимает новые функции. Текущий [roadmap](../ecosystem/2026-09-27-development-roadmap-current.md) отмечает Aggregator batch Task3 как WIP; Arena и Agents Market остаются следующими по очереди продуктами.

| Слой | Проверено сейчас | Статус и граница |
|---|---|---|
| Serena | Existing `ai-hub/development-entrypoint` в AG, Arena и AM обновлён через supported MCP с сохранением прежних фактов; каждый locator прочитан обратно. | Навигация по принятому source. AG media `2f6c15b`/docs-only HEAD `56cbfcb`, Arena HEAD `c2f6559`, AM accepted auth core `42387bc` при более новом unreviewed HTTP WIP. |
| Graphify | AST-only refresh под общим build lock: AG clean accepted snapshot `56cbfcb` — 11 792 nodes / 19 261 links / 764 communities; AM `42387bc` — 2 163 / 3 343 / 227. Arena artifact уже был на точном HEAD `c2f6559`: 2 202 / 3 357 / 214, повторный тяжёлый прогон не требовался. JSON `built_at_commit` сверены. | Это индекс кода, не приёмка batch Task3, Arena evaluator, AM HTTP/BFF или production. WIP и generated/vendor каталоги исключены. |
| LightRAG | Health запрос и один точный повторный lookup существующего `doc-365591f10b64a84274fc6ed561d9de74` завершились `LightRAGTimeoutError`; успешного readback нет. | **PENDING.** Новых вставок/дубликатов нет; текущий checkpoint не объявляется синхронизированным. После восстановления сервиса: exact lookup → idempotent update → processed+content readback. |
| Memory Graph | Read-only поиск вернул 7 AI Hub entities/6 relations. Target `/home/bob/pinglass-data/memory.jsonl`: 22 valid objects. Шесть активных `server-memory` процессов используют один target; writer выполняет load→temporary write→rename без межпроцессной блокировки/CAS. | **BLOCKED для записи.** Atomic rename не исключает потерю чужой записи. Нужен один сериализованный writer либо interprocess lock для всего read-modify-write, затем namespace `ai-hub:`/dedupe и readback без потери прежних rows. |

Подробные receipts сохранены приватно в `.superpowers/sdd/2026-09-27-roadmap-audit/{derived-memory-report,semantic-memory-report}.md` канонического AG checkout. Старые записи и пользовательский WIP не удалялись; production и платные provider-вызовы не выполнялись.
