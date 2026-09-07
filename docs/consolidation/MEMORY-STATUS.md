# Статус developer memory

Обновлено: 07.09.2026 после приёмки AG Task4, AM DB Task1 и Arena baseline. Это операционный снимок доступности и правил применения memory-слоёв для трёх канонических репозиториев. Он не утверждает product readiness и не заменяет документы-владельцы.

## Подтверждённые чтения

| Слой | Фактический доступ | Полезный контекст для следующей задачи | Граница свежести |
|---|---|---|---|
| Graphify 0.9.55 | CLI и локальные `graphify-out/graph.json` доступны; `tree-sitter-sql 0.3.11` установлен только как supported optional extra в изолированном Graphify tool env | Arena: свежий AST 1693 nodes/2227 links, включая 21 SQL node из 9 SQL files; Aggregator: 9080/13456, 177/72 SQL. AM остаётся на 1381/2062. | Arena snapshot создан 11:07 +03 после code freeze. После snapshot принят profile scenario fix `382cc78` и все10 guarded integration scenarios; evidence `aiarena/docs/product/acceptance/AR-P1.md` на `bb1057c`. Эти три изменённых script-файла snapshot ещё не отражает. Aggregator snapshot мог пересечься с Task 4 и не current; AM refresh отложен из-за активной DB-работы. |
| Serena 1.7.1.dev0 | Supported CLI и отдельный MCP server действительно прочитали Arena project-local cache; текущий harness не получил Serena tool-calls | Arena cache обновлён в 11:10 +03: 141 TypeScript и 15 HTML symbol entries. MCP перечислил 7 existing memories. | Существующие Serena memories остаются legacy provenance: `core.md` описывает старый frontend-only prototype. Их содержимое не переписывалось до отдельного принятого code handoff. AG snapshot potentially mixed/unaccepted; AM refresh отложен. |
| LightRAG | Подтверждён live read и upload/readback через существующий client/service | `X-API-Key` с уже настроенным значением из Hermes `.env` вернул HTTP 200; два принятых public documents загружены по stable filename и readback показывает `processed` с 3 chunks у каждого. | `Bearer` возвращает 401. Прежний 403 был вызван буквальной строкой `${LIGHTRAG_API_KEY}` при обходе env-resolution, а не неправильным заголовком. Успешный bounded semantic query был generic и не используется как product fact. |
| Memory Graph | `/home/bob/pinglass-data/memory.jsonl` прочитан локальным Python JSONL reader, не MCP | 9 валидных строк (5 entity, 4 relation); совпадений с AI Hub terms нет. | Supported server writes whole graph через atomic rename, но не имеет межпроцессной блокировки; current harness tool-call не получен. Запись пропущена, чтобы не потерять concurrent updates. |
| Brain | Читаемая навигация доступна | Этот README ведёт к каноническим repo docs и к данному статусу | Не дублирует private journals или непроверенный research. |

## Как извлечённый контекст ускоряет ближайшие задачи

- **Arena RevealOnScroll.** Graphify подтверждает, что компонент используется на challenge, home, organizer, admin, profile, leaderboard и team surfaces. Снимок полезен для карты consumers; полная suite впоследствии прошла все10 сценариев; source/scripts свежее снимка, поэтому индекс не является доказательством приёмки.
- **Aggregator admission.** Graphify ведёт к `packages/api-gateway/src/billing/admission.ts`, `admission-result.ts`, `billing-admission.test.ts` и принятому документу `docs/superpowers/plans/2026-09-07-gateway-charge-admission.md`. Рабочая карта сохраняет gate: wrapper ещё не активирован в route/executor; candidate capability/quote принят на `3cc5b271`; последующие executor, durable quota, usage receipt и reconciliation ещё не приняты.
- **Agents Market DB.** Graphify связывает будущую AM-owned БД с `docs/superpowers/plans/2026-09-07-own-database.md`, `docs/ecosystem/database-boundary.md`, worker `runAgent()` и отдельным TMA `useAuth()`. Это подтверждает границу: Web и TMA самостоятельны; Task1 принята на `cfc97f91` (56unit/10native/types/lint); Task2 приложения на собственной схеме в работе. Индекс AM старше этих изменений.

## Операционный порядок

1. Открыть `AGENTS.md`, product entrypoint и релевантный plan у владельца.
2. Сверить HEAD, `git status` и timestamp индекса. Для dirty code читать diff/символы напрямую.
3. Использовать Graphify для структуры и Serena cache для code navigation; не превращать historical Serena memories в решение.
4. Сначала принять очищенный research/repo document. Затем выполнять только существующий идемпотентный LightRAG upload/sync по stable filename и подтверждать document status/readback; не подменять это generic semantic answer.
5. Memory Graph обновлять лишь после документированного read/write contract, namespace и dedupe. Производный граф хранит связи и ссылки, не второй текст решения.

Индексация Arena выполнялась единственным запущенным ранее процессом под `flock /tmp/ai-ecosystem-build.lock`; другие refresh не запускались. Полные product checks принадлежат исполнителю продуктовой задачи. Текущий harness всё ещё не получил новые memory MCP tools; включённая конфигурация требует новой сессии для их появления. До обновления code indexes использовать текущие исходники и принятые entrypoints; не объявлять старые snapshots актуальными.
