# Реорганизация знания AIAG — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) или executing-plans. Шаги — чекбоксы `- [ ]`.

**Goal:** Собрать разросшееся знание AIAG в единый структурированный SoT (мастер-канон + роли систем памяти) по спеке `docs/superpowers/specs/2026-06-13-knowledge-architecture-design.md`.

**Architecture:** Мастер-канон `docs/canon/AIAG-CANON.md` = источник истины; `/CLAUDE.md` = тонкий якорь→канон; Serena=код/антипаттерны/баги; LightRAG=ресёрч; memgraph=граф сущностей; graphify=код-AST; auto-memory=факт-указатели. Старьё → DEPRECATED, не удалять.

**Tech Stack:** Markdown-доки; MCP — serena.write_memory, memory (memgraph), lightrag.upload_document; `graphify update`.

**Верификация (не код → не TDD):** после каждой задачи — проверка на (а) отсутствие внутренних противоречий, (б) отсутствие «not-built у построенного / built у непостроенного», (в) ссылки разрешаются. Money-path/код-приложения НЕ трогаются.

---

### Task 1: Создать мастер-канон `docs/canon/AIAG-CANON.md` (14 разделов)

**Files:** Create `docs/canon/AIAG-CANON.md`. Source (читать для сборки): `docs/specs/2026-06-12-product-model-hermes-IA-synthesis.md`, `2026-06-12-hire-design.md`, `2026-06-12-hermes-spike-design.md`, `2026-06-12-forensic-audit.md`, `2026-06-03-monetization.md`, `docs/specs/CURRENT-STATE.md`, `memory/project_*` (hermes_capabilities/founder_decisions/target_audience/money_foundation), `/CLAUDE.md`, `DESIGN.md`.

- [ ] **Шаг 1:** Создать файл с шапкой: «# AIAG — МАСТЕР-КАНОН (SoT) · обновлён 2026-06-13 · единственный источник истины; при конфликте с любым другим докой — канон побеждает». + оглавление 14 разделов из спеки §«Структура канона».
- [ ] **Шаг 2:** Разделы 1-2 (Видение+ЦА=агенты/деплоеры; Два продукта TMA-крипто/Web-₽ + repo-split-статус) — сборка из WHAT-WE-ARE-BUILDING §1-2 + target_audience-memory + CLAUDE.md.
- [ ] **Шаг 3:** Раздел 3 «Модель сущностей» (ПРОБЕЛ — написать как единое место): диаграмма Шаблон→Агент→Клон/Наём; таблица сущность→БД (`agents`/`agent_templates`/`agent_sessions`(проект)/`agent_memory`(проект)/`agent_provider_credentials`); lifecycle; флаги `cloneable`(в коде)/`hireable`(проект); A2A call_agent depth-1 cap-3. Источник: synthesis §1 + hire-design §1.
- [ ] **Шаг 4:** Раздел 4 «Тех-модель найма и изоляции» — скопировать готовый кандидат из спеки §«Техническая модель найма» (профиль per-(agent,наниматель); память изолирована; ключ=наш gateway дебет нанимателя; MCP-токены создателя не переносятся; OWASP LLM06).
- [ ] **Шаг 5:** Раздел 5 «Hermes-арх» (ИСПРАВИТЬ устаревшее): REST API ЕСТЬ (/api/model/set, /api/jobs, /api/sessions :8642); профили=изоляция; 11 aux-слотов; тулсеты≠model-slots; provisioning=CLI/скрипт (REST нет); RAM 300-600MB/1.8GB; Phase-0 spike (4-8GB VPS). Источник: project_hermes_capabilities_research + hermes-spike-design.
- [ ] **Шаг 6:** Разделы 6-8: Монетизация (author-rent + наём=дебет нанимателя scope=session; D-0/D-1; FD-2/free-grant открыто); Деплой-статус (Phase16 iNFT live, Wave-0 consolidated, Phase17, repo-split, founder-gates); **§8 ТАБЛИЦА ИСТИНЫ built-vs-not** (фича→построено?→коммит→что сыро — свежая, заменяет 4 противоречивых). Источник: monetization + CURRENT-STATE + forensic-audit + money_foundation.
- [ ] **Шаг 7:** Разделы 9-14: IA/карта-экранов (+пометка «развилка лента-vs-хаб ОТКРЫТА, нужно решение»); Дизайн-система (ссылка DESIGN.md + статус TMA~78%/Web~45%, character-card-сигнатура потеряна); Безопасность (LLM06 per-наниматель + ton-proof); Инфра (авто-деплой + Hermes-сервер 4-8GB); §13 Решения-лог (ADR датированный: 06-02/03/10/12/13); §14 Контент (SOUL.md-формат, 12-15 офиц-агентов как ПРОБЕЛ-todo, онбординг/free-run).
- [ ] **Шаг 8: Верификация:** прочитать канон целиком — нет ли «not-built» у построенного (MCP/author-rent/schedules/iNFT/provider-picker = LIVE), нет ли «managed-Hermes deferred» (теперь курс-на-реальный). Исправить найденное.
- [ ] **Шаг 9: Commit:** `git add docs/canon/AIAG-CANON.md && git commit -m "docs(canon): мастер-канон AIAG — единый SoT, 14 разделов"`

---

### Task 2: Утончить `/CLAUDE.md` до якоря + карта памяти + 2 критфикса

**Files:** Modify `/CLAUDE.md`.

- [ ] **Шаг 1:** В начало — блок «КАНОН: `docs/canon/AIAG-CANON.md` — единственный источник истины, при конфликте побеждает он. Этот файл = тонкий якорь.»
- [ ] **Шаг 2:** Добавить «КАРТА ПАМЯТИ (куда за чем): продукт/модель→канон · код→Serena+graphify · ресёрч→LightRAG · сущности/связи→memgraph · быстрый факт→auto-memory MEMORY.md · дизайн→DESIGN.md+борды».
- [ ] **Шаг 3: КРИТФИКС 1:** найти строку «Hermes has **NO remote config REST API**» (секция HERMES) → заменить на «Hermes ИМЕЕТ REST API (/api/model/set, /api/jobs, /api/sessions на :8642; токен ротируется) — наш UI может им управлять. (research 2026-06-12)».
- [ ] **Шаг 4: КРИТФИКС 2:** найти «managed-Hermes runtime = R&D, deferred» / «BUILD managed-Hermes для test» → заменить на «РЕШЕНИЕ 2026-06-12: КУРС НА РЕАЛЬНЫЙ Hermes (наш UI=control-plane к Hermes REST; наём=profile-per-наниматель). Инфра-блокер: нужен VPS 4-8GB (текущий 2GB не тянет) → Phase-0 spike. См. канон §4-5.»
- [ ] **Шаг 5:** Добавить в «Founder decisions» строки 2026-06-12: наём (строим, agent_sessions+память-namespace) · cloneable (флаг+роут) · Hermes-разворот. Со ссылкой на канон §13.
- [ ] **Шаг 6: Верификация:** перечитать /CLAUDE.md — нет остаточных «no REST API»/«deferred»; якорь <1.5 экрана; карта памяти присутствует.
- [ ] **Шаг 7: Commit:** `git commit -am "docs(CLAUDE): тонкий якорь + карта памяти + критфиксы Hermes-REST/managed-разворот"`

---

### Task 3: Обновить ARCHITECTURE.md + PRODUCT.md + SECURITY.md под решения 2026-06-12

**Files:** Modify `docs/ARCHITECTURE.md`, `PRODUCT.md`, `SECURITY.md`.

- [ ] **Шаг 1:** ARCHITECTURE.md — в «NOT built» убрать «MCP servers» (построено); добавить Hermes-proxy слой (план, канон §5); добавить в data-stores `agent_templates`, `agent_sessions`(проект), `agent_memory`(проект-namespace). Ссылка на канон §5,12.
- [ ] **Шаг 2:** PRODUCT.md — уточнить «ЦА=агенты, люди=деплоеры»; добавить hire-модель (1 абзац + ссылка канон §3-4); пометить что character-card-сигнатура потеряна в built UI (задача дизайна).
- [ ] **Шаг 3:** SECURITY.md — добавить раздел «Изоляция памяти per-наниматель (OWASP LLM06): namespace `(agent_id, hirer_tg_user_id)`; наниматель не видит память создателя/других»; обновить known-TODOs; отметить ton-proof верифицируется. Ссылка канон §11.
- [ ] **Шаг 4: Верификация:** 3 файла не противоречат канону; ссылки на канон-разделы валидны.
- [ ] **Шаг 5: Commit:** `git commit -am "docs: ARCHITECTURE/PRODUCT/SECURITY под решения 2026-06-12 (наём, Hermes, LLM06)"`

---

### Task 4: Депрекейтнуть старый канон + user-workflows (не удалять)

**Files:** Modify `docs/specs/2026-06-02-WHAT-WE-ARE-BUILDING.md`, `docs/specs/2026-06-03-user-workflows.md`.

- [ ] **Шаг 1:** В шапку обоих — баннер: «> 🔴 DEPRECATED (2026-06-13). Актуальный SoT = `docs/canon/AIAG-CANON.md`. Этот файл — исторический; статусы «not-built/deferred» здесь УСТАРЕЛИ (MCP/author-rent/schedules/iNFT/provider-picker = LIVE; managed-Hermes = курс-на-реальный). Не доверять статусам, сверять с каноном.»
- [ ] **Шаг 2: Верификация:** баннер первой строкой в обоих; ссылка на канон.
- [ ] **Шаг 3: Commit:** `git commit -am "docs: депрекейт старого канона + user-workflows → AIAG-CANON"`

---

### Task 5: Serena-мемории — антипаттерны, баги, карта кодовой базы

**Files:** через `mcp__plugin_serena_serena__write_memory` (активировать проект сначала, если нужно): `aiag_antipatterns`, `aiag_bugs`, `aiag_codebase_map`.

- [ ] **Шаг 1:** Активировать Serena-проект (aggregator) если write_memory требует.
- [ ] **Шаг 2:** `aiag_antipatterns` — собрать из forensic-audit + сессии: цена ×100 (локальная fmtCredits вместо @/lib/credits), ambiguous-column-после-JOIN (квалифицировать `agents.`), незарегистрированный model_slug→OpenRouter-margin-leak (только namespaced слаги), pm2-jlist-под-non-root (sudo -n), bun-install-через-VPN-прокси (используй --offline), commit-без-гейта-typecheck, потёмкинские витрины (0 шаблонов), доки-врут-в-минус.
- [ ] **Шаг 3:** `aiag_bugs` — известные/пофикшенные: HTTP500 открытия агента (42702 updated_at), cloneable-SELECT-до-миграции, market пустой, mintFeeTon вне scope. Формат симптом→причина→фикс→коммит.
- [ ] **Шаг 4:** `aiag_codebase_map` — где что: apps/tg-miniapp (TMA), apps/agent-worker (money-path runner settleRun), packages/api-gateway (:4000 markup), money-path-инварианты, deploy-рецепт (gh workflow run …, авто-деплой).
- [ ] **Шаг 5: Commit:** Serena пишет в `.serena/memories/` — `git add .serena/memories && git commit -m "serena: антипаттерны + баги + карта кода AIAG"`

---

### Task 6: Синхрон производных — memgraph + LightRAG + graphify

**Files:** MCP-операции (memgraph, lightrag) + `graphify update`.

- [ ] **Шаг 1: memgraph** (`mcp__memory`): `search_nodes "AIAG"` → создать новые сущности `agent_sessions`/`HireModel`/`HermesProfile`/`HermesControlPlane`; связи (Agent-hasTemplate→Template, Agent-isHiredBy→HireSession, HireSession-isolatesMemoryFor→TgUser, HermesProfile-isolates→HireSession, Creator-earnsRentFrom→HireSession); add_observations к узлу AIAG/Hermes (v0.16 REST API, aux-слоты, провижн=CLI, RAM, managed-разворот).
- [ ] **Шаг 2: LightRAG** (`mcp__lightrag__upload_document` — НЕ insert_text): загрузить как документы свежие ресёрчи — `2026-06-12-product-model-hermes-IA-synthesis.md`, `2026-06-12-hire-design.md`, `2026-06-12-hermes-spike-design.md`, и сам `AIAG-CANON.md`. (upload_document берёт имя файла = уникальный source, обходит дедуп.)
- [ ] **Шаг 3: graphify:** `graphify update .` (AST-граф кода; учтёт cloneable-роут уже в коде). Отметить: hire-код ещё не написан → граф не поймает (только после реализации).
- [ ] **Шаг 4: Верификация:** memgraph `search_nodes "HireSession"` возвращает узел; LightRAG `get_health` ok + upload вернул success (не duplicated); graphify graph.json свежий.

---

### Task 7: Правила поддержки в /CLAUDE.md + индекс auto-memory

**Files:** Modify `/CLAUDE.md`; Update `memory/MEMORY.md`; Create memory `knowledge_architecture`.

- [ ] **Шаг 1:** В /CLAUDE.md добавить «ПРАВИЛА ПОДДЕРЖКИ ЗНАНИЯ: канон=SoT; при изменении продукта/модели — обновить канон → синхрон memgraph-узел + auto-memory-указатель; после кода — `graphify update`; новый ресёрч → LightRAG upload_document + auto-memory-резюме; старые доки не удалять, помечать DEPRECATED→канон».
- [ ] **Шаг 2:** Создать auto-memory `knowledge_architecture.md` (указатель на канон + карту систем) + строку в MEMORY.md.
- [ ] **Шаг 3: Commit:** `git commit -am "docs: правила поддержки знания + индекс архитектуры памяти"`

---

## Self-Review
- **Покрытие спеки:** 7 фаз спеки → Task 1-7. ✓ Все 14 разделов канона в Task 1; критфиксы в Task 2; обновления в Task 3; депрекейт в Task 4; Serena в Task 5; синхрон в Task 6; правила в Task 7.
- **Placeholder-скан:** §14 «12-15 офиц-агентов» помечен как ПРОБЕЛ-todo в каноне (это честный gap-маркер контента, не плейсхолдер плана — контент создаётся отдельно с основателем). Остальное конкретно.
- **Консистентность:** имена файлов/сущностей/команд единообразны (AIAG-CANON.md, agent_sessions, upload_document, graphify update) во всех задачах.
