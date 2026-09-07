# Статус developer memory

Обновлено: 07.09.2026 после приёмки AG Task5, AM DB Task1 и Arena baseline; AR-P2.0 и AM Task2 проходят review/интеграцию. Это операционный снимок доступности и правил применения memory-слоёв для трёх канонических репозиториев. Он не утверждает product readiness и не заменяет документы-владельцы.

## Подтверждённые чтения

| Слой | Фактический доступ | Полезный контекст для следующей задачи | Граница свежести |
|---|---|---|---|
| Graphify 0.9.55 | CLI и локальные graph.json доступны; supported SQL parser установлен в изолированном tool env | Aggregator: свежий полный update после Task5,9186nodes/13723links/657communities,177 AST SQL nodes из72files. Lookup нашёл createStoredChatAttempt и его admission/quote/contract связи; consumers пока tests. Arena: прежний1693/2227; AM: прежний1381/2062. | AG код сверён с b6266cb7, последующие commits docs-only; update exit0. Arena и AM индексы старше текущих source fixes, обновятся после их приёмки. Число nodes не равно production readiness. |
| Serena 1.7.1.dev0 | Supported CLI и отдельный MCP доступны; текущий harness не получил новые tool-calls | Aggregator: свежие664/664 TypeScript после Task5, cache readback; создана namespaced memory ai-hub/development-entrypoint со ссылками на canonical docs. Все24 legacy memories сохранены. Arena: прежние141TS+15HTML/7legacy memories. AM: прежние138TS. | AG source frozen/сверён; существующие memories остаются provenance. Arena/AM ещё ожидают refresh после текущих edits. Глобальная конфигурация Serena не менялась. |
| LightRAG | Подтверждён live read и upload/readback через существующий client/service | `X-API-Key` с уже настроенным значением из Hermes `.env` вернул HTTP 200; исследование и payment design загружены по stable filename (`processed`, по3chunks). Затем topology contract из ACTIVE-PROJECTS.md на dd0194f загружен как ai-hub-development-topology-2026-09-07.md: processed/1chunk; контрольный hybrid context возвращает этот filename и все3канонических roots. | `Bearer` возвращает 401. Прежний 403 был вызван буквальной строкой `${LIGHTRAG_API_KEY}` при обходе env-resolution, а не неправильным заголовком. Первый skill-recall также вернул устаревшее описание общего monorepo/БД; его не приняли за текущий факт. Добавленный topology contract явно описывает supersession старых правил для этих3продуктов. |
| Memory Graph | Установленный MCP server реально вызван через отдельный локальный SDK client: create_entities/create_relations/read_graph | Добавлены 7 namespaced reference entities и 6 relations в `ai-hub:`: карта, три repo и их entrypoints. Readback подтверждён; все9 исходных строк сохранены, итог22. Решения и private journals не копировались. | Перед записью проверено отсутствие известных активных Memory server processes, сохранена private backup и проверен неизменный source. Использован локальный sync lock. Server atomic rename не даёт общей межпроцессной блокировки; при активном другом server этот sync откажется. Новые tool-calls в текущий harness по-прежнему не инжектированы. |
| Brain | Читаемая навигация доступна | Этот README ведёт к каноническим repo docs и к данному статусу | Не дублирует private journals или непроверенный research. |

## Как извлечённый контекст ускоряет ближайшие задачи

- **Arena RevealOnScroll.** Graphify подтверждает, что компонент используется на challenge, home, organizer, admin, profile, leaderboard и team surfaces. Снимок полезен для карты consumers; полная suite впоследствии прошла все10 сценариев; source/scripts свежее снимка, поэтому индекс не является доказательством приёмки.
- **Aggregator admission.** Graphify ведёт к `packages/api-gateway/src/billing/admission.ts`, `admission-result.ts`, `billing-admission.test.ts` и принятому документу `docs/superpowers/plans/2026-09-07-gateway-charge-admission.md`. Рабочая карта сохраняет gate: wrapper ещё не активирован в route/executor; candidate capability/quote принят на `3cc5b271`; одноразовый executor принят на `b6266cb7` (156focused/type/lint + independent review), остаётся unused. Durable quota, trusted route composition и reconciliation ещё не приняты.
- **Agents Market DB.** Graphify связывает будущую AM-owned БД с `docs/superpowers/plans/2026-09-07-own-database.md`, `docs/ecosystem/database-boundary.md`, worker `runAgent()` и отдельным TMA `useAuth()`. Это подтверждает границу: Web и TMA самостоятельны; Task1 принята на `cfc97f91` (56unit/10native/types/lint); Task2 приложения на собственной схеме в работе. Индекс AM старше этих изменений.

## Операционный порядок

1. Открыть `AGENTS.md`, product entrypoint и релевантный plan у владельца.
2. Сверить HEAD, `git status` и timestamp индекса. Для dirty code читать diff/символы напрямую.
3. Использовать Graphify для структуры и Serena cache для code navigation; не превращать historical Serena memories в решение.
4. Сначала принять очищенный research/repo document. Затем выполнять только существующий идемпотентный LightRAG upload/sync по stable filename и подтверждать document status/readback; не подменять это generic semantic answer.
5. Memory Graph обновлять лишь после документированного read/write contract, namespace и dedupe. Производный граф хранит связи и ссылки, не второй текст решения.

Индексы обновляются последовательно под `flock /tmp/ai-ecosystem-build.lock`; product checks имеют приоритет. Полные product checks принадлежат исполнителю продуктовой задачи. Текущий harness всё ещё не получил новые memory MCP tools; включённая конфигурация требует новой сессии для их появления. До обновления code indexes использовать текущие исходники и принятые entrypoints; не объявлять старые snapshots актуальными.

Первая ограниченная90s попытка AG Graphify завершилась timeout и не обновила graph.json. После code freeze выполнен полный supported update с exit0 и readback9186/13723; этот результат заменяет прежний устаревший снимок. SQL nodes считаются по `_origin=ast` и `.sql` source_file, поскольку schema не содержит node_type/language.
