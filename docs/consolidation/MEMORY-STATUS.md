# Статус developer memory

## Refresh принятого C1 — 08.09.2026, 01:38 UTC

Производная навигация только для принятого C1; источник приёмки остаётся в [AG-P1](../product/acceptance/AG-P1.md), а не в этом статусе.

| Слой | Проверенный результат | Граница |
|---|---|---|
| Graphify AG | `graphify update .` завершён под `flock /tmp/ai-ecosystem-build.lock`; JSON readback: 9710 nodes / 14836 links / 692 communities, `built_at_commit` `fbccc4f`, mtime 01:38 UTC. Focused graph readback: `createStoredChatAttempt`, `rejectUnstartedGatewayHttpRequest`, `recoverGatewayHttpSettlement`. | AST-only, без LLM/API. `fbccc4f` принимает C1b-документацию; после него рабочее дерево содержит только незакоммиченные изменения plan/acceptance формата, не новый runtime source. Индекс не доказывает mounted public cutover, 108/108 или production. |
| Serena AG | Existing locator `ai-hub/development-entrypoint` прочитан, дополнен C1 locator и прочитан обратно через supported Serena CLI; existing 24 legacy memories сохранены. Serena health-check подтвердил registered project `aiag-new` и LSP cache 652 TypeScript entries. | Это locator и focused navigation, не полный reindex. Текущий Codex harness не предоставляет Serena MCP tool-calls; глобальная конфигурация не менялась. |
| LightRAG / Brain / Memory Graph | Без записи. Existing LightRAG continuation locator, Brain/Codex locators и Memory Graph не менялись. | Повторную загрузку без dedupe/readback не выполнять; Memory Graph остаётся read-only до доказанного concurrency contract. |

## Refresh принятого snapshot — 08.09.2026, 00:36 UTC

Производная навигация к [принятому continuation](2026-09-08-development-continuation.md); не новая приёмка продукта.

| Слой | Проверенный результат | Граница |
|---|---|---|
| Graphify AG | `graphify update` exit0 под shared flock; JSON readback 9599 nodes / 14537 links / 694 communities, mtime 00:35:04 UTC | Source snapshot `73d6c3f` (включает accepted `0fde334`); последующий `f315508` меняет только C1 plan. После начала новой SQL implementation C1a этот индекс исторический; refresh нового source PENDING до freeze/acceptance. |
| Graphify Arena | exit0, JSON readback 1945 / 2733 / 205, mtime 00:35:42 UTC | HEAD `66a323c`, accepted runtime `2465f33`; прежние untracked docs сохранены. |
| Graphify AM | exit0, JSON readback 1714 / 2466 / 191, mtime 00:36:31 UTC | HEAD `dca7746`, accepted CAS `9e24aff`; исходники frozen. |
| Serena | Все три existing `ai-hub/development-entrypoint` прочитаны через MCP; Arena locator дополнен continuation/map и прочитан обратно. Focused symbols: AG `auth-plan04.ts` (`requireApiKey`, `resolveFromDb`), Arena `submission-versions.ts` (`savePrivateVersion`, `readPrivateWorkspace`), AM `db.ts` (`markStarted`, `markFailed`, `settleRun`). | Это focused live navigation, не полный Serena reindex. В конце явно активирован AG. Новый экземпляр MCP начинал с No active project, поэтому активацию нужно проверять в своём harness. |
| Brain / Codex | Brain README направлен на continuation вместо раннего checkpoint; отдельная Codex ad-hoc correction note отменяет устаревшие формулировки clean69/private versions. | Только ссылки на owner evidence, без копии решений/баллов. |

Все Graphify запуски последовательны под `/tmp/ai-ecosystem-build.lock`, AST-only, без LLM/API. CLI также создал стандартные local cache/backup/report/html artifacts; community labels обновлены по hub эвристике, semantic labeling не запускался. LightRAG locator `doc-365591f10b64a84274fc6ed561d9de74` не загружался повторно: canonical references неизменны, прежний processed/hybrid readback сохранён. В этой подволне нового LightRAG readback нет. Memory Graph без мутации; Wiki не дублируется, канбан принадлежит Hermes. Полных 108, production deployment, paid/mainnet и C1a implementation acceptance эта запись не утверждает.

## Подтверждённое продолжение — 08.09.2026

- **LightRAG: новый locator подтверждён.** Перед записью точный hybrid lookup не нашёл continuation path. MCP insert_texts вернул duplicated для общего text_input_1.txt и старый track: это не загрузка нового текста. Повторную вставку/удаление старого документа не делали; upload уникального ai-hub-development-continuation-2026-09-08.md завершился processed, doc-365591f10b64a84274fc6ed561d9de74, track upload_20260907_233646_34165808. Последующий hybrid readback вернул точный canonical path и содержимое locator. Это навигация к [текущему continuation](2026-09-08-development-continuation.md), не копия acceptance/баллов. Старые UNKNOWN записи research locator этим не переоцениваются.
- **Serena: AM активирован через MCP.** Выполнен live symbol lookup apps/worker/src/db.ts на текущем source (markStarted/markFailed/settleRun). ai-hub/development-entrypoint обновлён и прочитан обратно: убран устаревший открытый cleanup verdict, даны ссылки на owner docs. Это focused lookup и locator refresh; полного переиндексирования после новых commits ещё нет. Active project MCP сейчас agents-market; параллельным агентам сообщено использовать явный workdir, не предполагать иной active project.
- **Serena AG:** после принятия fresh auth выполнен symbol lookup `auth-plan04.ts`; locator дополнен ссылками на continuation и functional map, readback подтверждён. Active project MCP теперь ai-aggregator. Это focused lookup, не полный reindex.
- **Codex ad-hoc:** сохранён reference note к continuation и entrypoints. **Graphify:** полный refresh этой волной ещё не выполнен; **Memory Graph:** без мутации. Старые снимки ниже сохраняются как история, не текущая приёмка.


## Проверка текущего harness — 08.09.2026

LightRAG `query_text` теперь callable: hybrid context получен. Ответ широкий и содержит исторические сведения; это не подтверждение последнего checkpoint locator и не основание менять accepted code. Последняя синхронизация остаётся PENDING до точного dedupe/readback. Для последующих запросов ограничивать вывод и разбирать вложенный JSON перед передачей в контекст.

Serena `initial_instructions` и `get_current_config` вызваны: инструмент работает, но активного canonical проекта нет; auto-activation/index freshness не заявляются. Старые индексы AG после0068 требуют обновления на frozen source. Memory Graph в этой волне не менялся. Brain navigation подтверждена предыдущим checkpoint commit40d040b.

Ниже — исторические проверки 07.09, не текущая code acceptance. Текущий вход: [checkpoint08.09](2026-09-08-development-checkpoint.md) и owner development entrypoint.

Обновлено: 07.09.2026, чекпойнт перед паузой. AG Task5, AM DB Task1, Arena AR-P1/P2.0 приняты; AM Task2 имеет открытый Important cleanup review. Это операционный снимок доступности и правил применения memory-слоёв для трёх канонических репозиториев. Он не утверждает product readiness и не заменяет документы-владельцы.

## Подтверждённые чтения

| Слой | Фактический доступ | Полезный контекст для следующей задачи | Граница свежести |
|---|---|---|---|
| Graphify 0.9.55 | CLI и локальные graph.json доступны; supported SQL parser установлен в изолированном tool env | Aggregator: свежий полный update после Task5,9186nodes/13723links/657communities,177 AST SQL nodes из72files. Lookup нашёл createStoredChatAttempt и его admission/quote/contract связи; consumers пока tests. Arena: свежий1750nodes/2343links/187communities,21 AST SQL nodes/9files. AM: свежий1660nodes/2387links/179communities,90 AST SQL nodes/41files. | AG код сверён с b6266cb7, последующие commits docs-only; update exit0. Arena и AM full update exit0, сверены с runtime source; наличие индекса не означает приёмку открытого AM cleanup review. Число nodes не равно production readiness. |
| Serena 1.7.1.dev0 | Supported CLI и отдельный MCP доступны; текущий harness не получил новые tool-calls | Aggregator: свежие664/664 TypeScript после Task5, cache readback; создана namespaced memory ai-hub/development-entrypoint со ссылками на canonical docs. Все24 legacy memories сохранены. Arena:162/162 files (147TS+15HTML),7legacy memories сохранены; namespaced entrypoint reference добавлен. AM:149/149TS, cache timestamp сверён; entrypoint reference добавлен root при закрытии. | AG source frozen/сверён; существующие memories остаются provenance. Arena/AM refresh завершён: code source Arena59e27acc+8a825scripts, AM510c104; более новые commits документационные. Глобальная конфигурация Serena не менялась. |
| LightRAG | Подтверждён live read и upload/readback через существующий client/service | `X-API-Key` с уже настроенным значением из Hermes `.env` вернул HTTP 200; исследование и payment design загружены по stable filename (`processed`, по3chunks). Затем topology contract из ACTIVE-PROJECTS.md на dd0194f загружен как ai-hub-development-topology-2026-09-07.md: processed/1chunk; контрольный hybrid context возвращает этот filename и все3канонических roots. | `Bearer` возвращает 401. Прежний 403 был вызван буквальной строкой `${LIGHTRAG_API_KEY}` при обходе env-resolution, а не неправильным заголовком. Первый skill-recall также вернул устаревшее описание общего monorepo/БД; его не приняли за текущий факт. Добавленный topology contract явно описывает supersession старых правил для этих3продуктов. |
| Memory Graph | Установленный MCP server реально вызван через отдельный локальный SDK client: create_entities/create_relations/read_graph | Добавлены 7 namespaced reference entities и 6 relations в `ai-hub:`: карта, три repo и их entrypoints. Readback подтверждён; все9 исходных строк сохранены, итог22. Решения и private journals не копировались. | Перед записью проверено отсутствие известных активных Memory server processes, сохранена private backup и проверен неизменный source. Использован локальный sync lock. Server atomic rename не даёт общей межпроцессной блокировки; при активном другом server этот sync откажется. Новые tool-calls в текущий harness по-прежнему не инжектированы. |
| Brain | Читаемая навигация доступна | Этот README ведёт к каноническим repo docs и к данному статусу | Не дублирует private journals или непроверенный research. |

## Как извлечённый контекст ускоряет ближайшие задачи

- **Arena RevealOnScroll.** Graphify подтверждает, что компонент используется на challenge, home, organizer, admin, profile, leaderboard и team surfaces. Снимок полезен для карты consumers; полная suite впоследствии прошла11 сценариев. После приёмки AR-P2.0 индекс обновлён; он по-прежнему не является доказательством приёмки.
- **Aggregator admission.** Graphify ведёт к `packages/api-gateway/src/billing/admission.ts`, `admission-result.ts`, `billing-admission.test.ts` и принятому документу `docs/superpowers/plans/2026-09-07-gateway-charge-admission.md`. Рабочая карта сохраняет gate: wrapper ещё не активирован в route/executor; candidate capability/quote принят на `3cc5b271`; одноразовый executor принят на `b6266cb7` (156focused/type/lint + independent review), остаётся unused. Durable quota, trusted route composition и reconciliation ещё не приняты.
- **Agents Market DB.** Graphify связывает будущую AM-owned БД с `docs/superpowers/plans/2026-09-07-own-database.md`, `docs/ecosystem/database-boundary.md`, worker `runAgent()` и отдельным TMA `useAuth()`. Это подтверждает границу: Web и TMA самостоятельны; Task1 принята на `cfc97f91` (56unit/10native/types/lint); Task2 source38b05189 проверен локально; follow-up510c104 сохраняет открытый hang-deadline Important. Индекс AM обновлён по этому source, а не по будущему исправлению.

## Операционный порядок

1. Открыть `AGENTS.md`, product entrypoint и релевантный plan у владельца.
2. Сверить HEAD, `git status` и timestamp индекса. Для dirty code читать diff/символы напрямую.
3. Использовать Graphify для структуры и Serena cache для code navigation; не превращать historical Serena memories в решение.
4. Сначала принять очищенный research/repo document. Затем выполнять только существующий идемпотентный LightRAG upload/sync по stable filename и подтверждать document status/readback; не подменять это generic semantic answer.
5. Memory Graph обновлять лишь после документированного read/write contract, namespace и dedupe. Производный граф хранит связи и ссылки, не второй текст решения.

Индексы обновляются последовательно под `flock /tmp/ai-ecosystem-build.lock`; product checks имеют приоритет. Полные product checks принадлежат исполнителю продуктовой задачи. Текущий harness всё ещё не получил новые memory MCP tools; включённая конфигурация требует новой сессии для их появления. Все три code indexes обновлены к паузе; перед следующей задачей сверить timestamp/source с новыми commits.

Первая ограниченная90s попытка AG Graphify завершилась timeout и не обновила graph.json. После code freeze выполнен полный supported update с exit0 и readback9186/13723; этот результат заменяет прежний устаревший снимок. SQL nodes считаются по `_origin=ast` и `.sql` source_file, поскольку schema не содержит node_type/language.

## Чекпойнт паузы: подтверждённое и pending

Canonical owner: [чекпойнт](2026-09-07-pause-checkpoint.md) и [функциональный отчёт](../ecosystem/2026-09-07-functional-checkpoint.md), AG44330f5. Brain, namespaced Serena notes и Codex ad-hoc note хранят ссылки, не вторую копию оценок. Root сохранил локальные ссылки после остановки документатора.

Новая финальная locator-синхронизация этого checkpoint в LightRAG/Memory Graph **не получила подтверждённого readback до паузы**. Её итог UNKNOWN/PENDING; не утверждать ни успешную запись, ни отсутствие записи. Предыдущие processed topology document и Memory Graph7entities/6relations подтверждены, продолжают использоваться. При возобновлении сначала lookup/dedupe по canonical checkpoint path, затем update только если требуется; не вставлять дубликат вслепую. Graphify/Serena новые результаты выше реально получены, их не смешивать с pending semantic sync.

## Research wave 1 locator: ограниченная синхронизация 07.09.2026

- **LightRAG — UNKNOWN.** После точного lookup с нулём совпадений отправлен очищенный locator `ai-hub-research-decisions-2026-09-07.md` через существующий клиент с `X-API-Key`. Upload вернул success, но три ограниченные проверки списка документов ещё не увидели filename; readback/hybrid retrieval поэтому не подтверждены. Не повторять upload вслепую: сначала lookup по этому filename и canonical source paths, затем записывать только при отсутствии.
- **Memory Graph — DEFERRED, без записи.** Планировалась одна namespaced reference-only `Decision` (`ai-hub:research-wave1-decisions`) и связь с `ai-hub:development-map`; до мутации обнаружен активный Memory server, поэтому sync остановлен. Базовый graph не изменялся этим запуском. После исчезновения активного сервера повторить dedupe/readback и сохранить все прежние rows.
- Locator содержит только принятые durable choices и ссылки на пять canonical research documents. Он не утверждает market proof, implementation/payment/security readiness или production status; private reviews, keys, raw code и journals не синхронизировались.


## Закрытие стратегии кооператива

[Стратегия](/home/bob/Projects/ai-aggregator/docs/ecosystem/2026-09-07-cooperative-strategy.md) и [roadmap](/home/bob/Projects/ai-aggregator/docs/ecosystem/2026-09-07-cooperative-roadmap.md) сохранены как canonical repo documents; Brain и Codex ad-hoc получают ссылки. Эти новые документы ещё не загружены с подтверждённым readback в LightRAG/Memory Graph. Предыдущий research locator остаётся UNKNOWN, новая запись графа DEFERRED; при следующем запуске сначала lookup/dedupe, без слепой повторной вставки. Код не менялся, Serena/Graphify повторно не индексировались. Локальные previews, тестовые БД/Redis и остаточные тестовые процессы остановлены; системные memory connectors Codex сохранены.
