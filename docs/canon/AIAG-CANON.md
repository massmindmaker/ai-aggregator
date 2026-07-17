# AIAG — МАСТЕР-КАНОН (SoT) · обновлён 2026-06-13 · единственный источник истины. При конфликте с любым другим докой — побеждает канон.

> Сборка из свежих доков (2026-06-12/13 побеждают 2026-06-02/03). Замещает противоречивые статусы в `user-workflows.md`, старом каноне `2026-06-02-WHAT-WE-ARE-BUILDING.md §8`, `apps/agent-worker/CLAUDE.md` — они помечали построенное как not-built (см. §8 «таблица истины»).
>
> **Карта памяти (куда за чем):** продукт/модель → ЭТОТ канон · код → Serena/graphify · ресёрч → LightRAG · связи/сущности → memgraph · быстрый факт → auto-memory `MEMORY.md`. Тонкий якорь = `/CLAUDE.md`. Токены дизайна = `DESIGN.md`. Правила безопасности = `SECURITY.md`. Топология = `docs/ARCHITECTURE.md`.

---

## 1. Видение и позиционирование

**Что строим:** **TMA (Telegram Mini App) — маркетплейс AI-агентов, которые живут в Telegram.** Discover / run / клонировать-из-шаблона / нанять / создать своего. Агенты — персонифицированные характеры (лицо, имя, личность), а не безликие функции. Биллинг — **крипто-кредиты** (USD-pegged, 1 кредит = $0.01; пополнение TON + другие крипты; Telegram Stars отложены).

**Целевая аудитория = сами AI-агенты** (рефрейм основателя 2026-06-10). Продукт = **инфраструктура для агентов**: продуктовые приоритеты выводятся из вопроса «что нужно агенту для максимального развития», а не из классического user-research. **Люди = деплоеры/кураторы**, которым должно быть тривиально «задеплоить агента и дать ему скиллы»; рост должен быть стихийным (виральным), не только для разработчиков.

**TMA = «костюм» (suit) для е-агента**; сам агент = подключаемый **РАНТАЙМ** (Hermes / OpenClaw / NanoClaw …) со своей встроенной памятью. Свой memory-слой (pgvector) НЕ строим — память приходит из рантайма + сторонних тулзов/MCP + покупная. Приоритеты: коннекторы рантаймов → 1-тап клон / виральный онбординг → агентские траты (TON Agentic Wallets) → кооперативная память (отложена).

**vs Hermes-standalone:** Hermes — это сам по себе мощный open-source агент-рантайм (нативно бриджит ~22 платформы, включая Telegram). Мы НЕ конкурируем с ним и НЕ строим чат-бридж. Наша добавленная ценность поверх любого рантайма: **биллинг/крипто-кредиты, маркетплейс шаблонов, character-card каталог, transferable-iNFT, budget-card, author-rent монетизация** — всё, чего у рантайма нет. Рантайм исполняет; мы — «костюм», экономика и витрина.

Песочница зафиксирована: **Telegram + TON + iNFT**.

---

## 2. Два продукта (жёсткая граница)

Два РАЗНЫХ продукта. Никогда не смешивать. Разделены по **валюте + юр.лицу + аудитории**; делят только Postgres `aiag` и gateway `:4000` как провайдера моделей. ⚠️ DEPRECATED → см. подраздел «Web↔TMA split (2026-07-17)» ниже: эта строка описывает состояние ДО сплита (одна орга, один кошелёк на двоих) — с 2026-07-17 TMA имеет свою оргу/ключ/кошелёк, но физически БД пока одна (сплит наполовину сделан).

| | **TMA** — **ТЕКУЩИЙ ФОКУС** | **Web-аггрегатор** |
|---|---|---|
| Что | Маркетплейс AI-агентов в Telegram | AI модели+агенты marketplace для RU + OpenAI-совместимый API-шлюз (white-label) |
| Домен | `app.ai-aggregator.ru/tg` (через @aiaggbot) | `ai-aggregator.ru` |
| Код | `apps/tg-miniapp` (Next 14.2.33, `:3100`, basePath `/tg`) + `apps/agent-worker` (BullMQ, `:3101`) | `apps/web` (Next 14.x) + `packages/api-gateway` (Hono/Bun, `:4000`) |
| Валюта | **КРИПТО-КРЕДИТЫ** (USD-pegged, TON + др.; ₽ удалены; Stars отложены) | **РУБЛИ (₽) на входе** (Tinkoff-эквайринг + подписки + B2B org-keys, без крипто) — но ⚠️ **внутренний юнит расхода = КРЕДИТЫ** (founder 2026-07-15, разворот, см. §6 «Финмодель web»); DEPRECATED→§6: старое чтение этой строки как «весь путь = рубли, без промежуточного юнита» |
| Юр.лицо | Foreign entity (покупает модели у RF-аггрегатора как клиент) | RF (ИП → производственный кооператив, IT 7.6%) |
| Статус | live; маркетплейс ~80%; деньги-фундамент LIVE | live; admin (Phase 14) live |

**Repo-split статус (2026-06-12):** монорепо `aggregator` разделяется на 2 автономных репо.
- **Фаза 1 ЗАВЕРШЕНА:** `agent-market` (TMA) создан — https://github.com/massmindmaker/agent-market (приватный). **Деплоит на прод автоматом** (run 27416802372, релиз 63c270b: health/agents/market = 200). Канонный путь TMA. Решение: `@aiag/database` ИСКЛЮЧЁН (ходят в raw `postgres`), схема-референс в `db-schema-reference/`. Отдельный deploy-ключ `~/.ssh/agent_market_deploy` (overlap-safe).
- **Фаза 2 (`aiag-web`) НЕ ЗАВЕРШЕНА:** экстракция сделана (`C:\Users\боб\projects\aiag-web`), `bun install` заблокирован сетью (VPN/прокси). Осталось: install → сборка → repo create + секреты + тест-деплой.
- **Overlap активен:** монорепо И agent-market оба умеют деплоить tma/agent-worker на тот же бокс. **Монорепо НЕ удалять, монорепо-tma-leg НЕ депрекейтить без ведома основателя.** Улучшения 2026-06-12 деплоились из МОНОРЕПО → синхронизировать в agent-market при полном cutover.

### Web↔TMA split — решение основателя 2026-07-17 (ПОЛОВИНА СДЕЛАНА)

Основатель зафиксировал: AI-агрегатор и Agents Market (TMA) — **два разных проекта**,
не сиамские близнецы в одном контуре. Агрегатор = **провайдер** моделей (RF, рубли);
TMA = **клиент**, покупающий у агрегатора как любой другой клиент. **Трансфертная
цена = те же ставки, что и всем остальным** — per-org markup не строим, кода под
это ноль. План: `docs/superpowers/plans/2026-07-17-split-web-tma.md`.

**Сделано на проде (2026-07-17):**
- Своя орга `agents-market` + свой gateway-ключ + свой кошелёк (стартует с **0** —
  каждый ран TMA до ручного пополнения честно отдаёт 402) + реальные капы —
  миграция `0060_tma_own_org.sql`.
- `AIAG_GATEWAY_KEY` агент-воркера переключён на новый ключ.
- Два тихих фолбэка на прямой OpenRouter закрыты (`agent-runner.ts`): 402/401/403/
  пустой ключ теперь честная ошибка вместо утечки маржи + слома white-label без
  единой записи в логах.

**Припарковано основателем (не в этом заходе):**
- Каталог моделей TMA через публичный `/v1/models` — сейчас TMA всё ещё читает
  `models`/`model_upstreams` напрямую SQL (клиент видит себестоимость провайдера).
- Разрыв 2 жёстких межконтурных FK (`agents.provider_id`,
  `agent_provider_credentials.provider_id` → `providers`).
- Физический сплит БД (`aiag` → `aiag` + `aiag_tma`) — необратимый шаг, ранбук
  прописан планом, не исполнен.

---

## 3. Модель сущностей (единое место — SoT)

### Диаграмма: Шаблон → Агент → Клон / Наём

```
  agent_templates (публичная СПЕЦ-чертёж, БЕЗ секретов)
        │  publish ▲                        │ clone (free) / rent (paid)
        │          │                        ▼
   ┌────┴──────────┴─────┐          agents (КЛОН: владеющая копия, память с нуля)
   │   agents (ЖИВОЙ)    │
   │  владелец = 1 юзер  │──── hire ───►  agent_sessions (НАЁМ: изолированный инстанс,
   │  спек + ключи +     │   (ПРОЕКТ)      спек создателя read-only, своя память per-наниматель)
   │  память + бюджет    │
   └─────────┬───────────┘
             │ transfer (iNFT, Phase 16) — перепривязка agents.tg_user_id, БЕЗ личной истории
             ▼
        новый владелец
```

### Сущность → БД-таблица

| Сущность | Что | БД | Содержит | НЕ содержит |
|---|---|---|---|---|
| **Шаблон** | Публичная СПЕЦИФИКАЦИЯ («чертёж»), не рабочая копия | `agent_templates` (0 секретных колонок by design) | name, system_prompt, tools[], model_slug, mcp_url, price, trait | ключи, mcp-auth, память, история (исключены SELECT'ом) |
| **Агент** | Живой экземпляр, владелец = 1 юзер, крутится воркером | `agents` | спек + зашифр. ключи + своя память + бюджет | — |
| **Клон** | Агент из публичного шаблона ИЛИ из `cloneable`-агента. Владелец = клонирующий | `agents` (тот же uuid-класс) | спек (без ключей), своя чистая память | секреты/память создателя (NULL) |
| **Проект / сессия** | Контейнер «один наниматель ↔ один чужой агент» | `agent_sessions` (**ПРОЕКТ, не построено**) | hirer_tg_user_id, owner (денорм.), бюджет найма, статус | — |
| **Память (проект-namespace)** | KV-память, скоуп = `(agent_id, scope_tg_user_id)` | `agent_memory` (scope-колонка = ПРОЕКТ) | key/value на тенанта | чужой скоуп |
| **Учётка провайдера** | Зашифр. BYOK-ключи / OAuth-токены | `agent_provider_credentials`, `agent_mcp_oauth` | AES-256-GCM ключи | — |

### Lifecycle агента
`создан` (CRUD) → `настроен` (спек/модель/тулы/MCP/бюджет) → `опубликован` (`/publish` → шаблон без секретов) → `клонирован` (другие берут free/rent) **И/ИЛИ** `нанят` (изолированные сессии, ПРОЕКТ) → `передан` (iNFT transfer, опц.) → `архив` (soft-delete; расписания/сессии гасятся).

### Флаги
- **`cloneable`** (`agents.cloneable boolean`) — **LIVE**, миграция на проде, роут `POST /agents/[id]/clone` агент→агент (спек без секретов, guard `cloneable=true` иначе 403), тумблер в UI. Money-path не тронут.
- **`hireable`** (`agents.hireable boolean DEFAULT false`) — **ПРОЕКТ** (не построено). Opt-in создателя, ставится на экране Публикация. Без него наём = 403 `not_hireable`.

### A2A (agent-to-agent)
`call_agent` — **LIVE**. Агент делегирует подзадачу другому агенту ТОГО ЖЕ юзера. Sub-cost едет через `toolFeesCredits` → `settleRun` (нет нового дебета, нет крипто). **Рекурсия срезана (depth-1), cap = 3 вызова/run**, ownership-guarded. BYOK-родитель НЕ нанимает (фикс free-exfil). Deployed (worker 9ede010).

### Различие КЛОН vs НАЁМ (критично)
| | **КЛОН** (LIVE) | **НАЁМ** (ПРОЕКТ) |
|---|---|---|
| Владение | ✅ своя владеющая копия | ❌ не владеет, агент остаётся у создателя |
| Спек | заморожен на момент копии, правишь как угодно | **read-only создателя**, обновления видны сразу |
| Память | своя, **с нуля** (изолирована по новому `agent_id`) | **изолированная per-наниматель** namespace `(agent_id, hirer)` |
| Ключи | свои (BYOK) — секреты создателя NULL | ключ модели = наш AIAG-gateway (дебет нанимателя) |
| Кто платит | сам (BYOK = 0 комиссии) | наниматель (AIAG-наценка) |

Доказано кодом: `clone/route.ts` («cloner wires their own keys»), `publish/route.ts` («NEVER select …_encrypted, agent_memory, agent_runs»).

---

## 4. Техническая модель найма и изоляции (ПРОЕКТ)

> Скопировано из `docs/superpowers/specs/2026-06-13-knowledge-architecture-design.md` (раздел «Техническая модель найма»). Реализация-детали: `docs/specs/2026-06-12-hire-design.md`.

**Реальность Hermes v0.16:** один gateway-процесс; изоляция = `hermes profile` (свои `MEMORY.md`/`USER.md`/`state.db`/`config.yaml`/`.env`); provisioning только CLI/скрипт; реальная мультитенантность = Docker-на-тенанта.

**Поток найма:** `POST /agents/[id]/hire` → control-plane `ensureProfile(agent_id, hirer)` → `mkdir ~/.hermes/profiles/<agent_id>_<hirer>/` + cp `config.yaml` создателя + патч `base_url`=наш gateway + наш `AIAG_GATEWAY_KEY` → запись `agent_sessions` → чат `POST /run` с sessionId → `settleRun` дебетит **нанимателя** (не создателя), scope=session.

**Ответ на вопрос основателя «генерятся ли под мой инстанс по моему ключу»: ДА.**
- Профиль создаётся под пару **(agent_id, наниматель)**.
- **ПАМЯТЬ изолирована:** `MEMORY.md` в твоём профиле + БД `agent_memory(agent_id, scope_tg_user_id=hirer)`.
- **МОДЕЛЬ-ключ = наш gateway-ключ** (дебет тебя, не создателя).
- **MCP-конфиг создателя ВИДЕН, но его OAuth-токены НЕ переносятся** — ты подключаешь свой токен (PKCE) при первом использовании.
- Тузы — те же из спека, исполняются в твоём профиле.
- **OWASP LLM06 namespace:** scope нельзя подделать запросом — `ctx.memoryScope` зашит воркером из `runId`/сессии на сервере, НЕ из тела запроса. Это и есть граница изоляции против cross-tenant memory leak.

**Два ключевых риска (адресованы дизайном):**
1. **Память** — `memorySet/Get/List` + `loadHistory` сегодня скоупятся ТОЛЬКО по `agent_id`. Без scope-измерения наниматели читают чужую память = OWASP LLM06. Фикс: `agent_memory.scope_tg_user_id` + уникальный индекс `(agent_id, COALESCE(scope_tg_user_id,0), key)`.
2. **Бюджет** — дневной лимит лежит на строке `agents` → 100 нанимателей делят один счётчик (гонка + DoS). Фикс: бюджет на **`agent_sessions`**, гард в `settleRun` ветвится по `sessionId` (тот же паттерн guarded-`UPDATE…WHERE…RETURNING`).

**Инвариант:** `settleRun` меняется ТОЛЬКО аддитивно (новая ветка по `sessionId`); баланс-дебет (`tg_user_balances` по `tgUserId`) и ledger уже на нанимателе → не трогаются. Интеграционный тест 4/4 остаётся зелёным. MVP: наём только для `connection_type='aiag'`-агентов (нельзя жечь чужой BYOK-ключ).

---

## 5. Hermes-архитектура и маппинг (ИСПРАВЛЕНО — устаревшее ниже)

> ⚠️ ОБНОВЛЕНО 2026-07-10: движок = ТОЛЬКО Hermes (свой у юзера ИЛИ managed-профиль у нас); самопальный луп удаляется. Наниматели = профили; аренда только на managed. Архитектура и факты: docs/specs/2026-07-10-hermes-only-engine-architecture.md

> 🔴 **ПОПРАВКИ к старому канону/`/CLAUDE.md`/`PRODUCT.md`/`ARCHITECTURE.md`** (источник: `project_hermes_capabilities_research`, ресёрч 2026-06-12 по v0.15.2/v0.16). Старые утверждения «Hermes has NO remote REST API» и «managed-Hermes deferred/R&D» — **НЕВЕРНЫ**, заменены.

Hermes = `NousResearch/hermes-agent` — open-source AI-АГЕНТ **РАНТАЙМ** (MIT). **Это НЕ модель.** Последняя версия — v0.16; **у основателя на VPS работает v0.12**.

> 🔥 **РЕАЛЬНЫЙ РАНТАЙМ ОСНОВАТЕЛЯ ЖИВ** (прочитан 2026-06-13, см. `project_hermes_runtime_setup`): Hermes **v0.12** на VPS `176.124.211.11` (ssh `hermes@`, key `timeweb_vps`), gateway REST **`:8642`**, dashboard `:9119`, мост `:9121`, gonka-proxy `:9131`. **6 живых профилей** (alisa/backend-eng/ops/researcher/reviewer) → изоляция доказана. **Docker-мультитенантность** (`container_memory: 5120`). Провайдеры: gonkagate/ollama-cloud/groq/openai-codex. Дизайн интеграции: `docs/superpowers/specs/2026-06-13-hermes-control-plane-design.md`. ⚠️ Точные сигнатуры REST :8642 добрать с бокса (SSH под fail2ban после серии подключений).

**Ключевые факты (исправленные):**
1. **У Hermes ЕСТЬ REST API** на `localhost:8642`: сессии `/api/sessions/*` (+`/chat`, `/chat/stream` SSE, `/fork`, `/messages`), прогоны `/v1/runs` (+`/events` SSE, `/stop`, `/approval`), `/v1/models|capabilities|skills|toolsets`, OpenAI-совм. `/v1/chat/completions`+`/v1/responses`, джобы/cron `/api/jobs/*`, `/health`. 🔴 **ПОПРАВКА (ресёрч 2026-06-13, исходник `api_server.py`):** auth = **СТАТИЧЕСКИЙ** `Authorization: Bearer API_SERVER_KEY` — ротируемого session-token НЕТ (старая запись врала). Изоляция нанимателя = заголовок **`X-Hermes-Session-Key`** (worker проставляет из `runId` сервер-сайд = OWASP-LLM06 boundary). Наш UI/worker МОЖЕТ удалённо управлять Hermes. Provisioning = CLI `hermes profile create <agent>_<hirer> --clone-from <tpl> --clone-all`.
2. **Изоляция = `hermes profile`** (свои порты/память/конфиг), ОДИН gateway-процесс, НЕ pod-на-юзера. Но файловая система НЕ изолирована (профиль работает от OS-юзера) → реальная мультитенантность = **Docker-контейнер на тенанта**.
3. **Provisioning профиля — REST НЕТ** (важно для найма): только CLI `hermes profile create <name> [--clone]`. Скриптовый provisioning = `mkdir ~/.hermes/profiles/<tenant>` + cp + `HERMES_HOME=...`. REST есть для runs/jobs/sessions, НЕ для профилей → **control-plane найма строим САМИ**.
4. **Модели НЕ per-role в нашем смысле:** ОДНА главная модель (чат-цикл) + **11 aux-слотов** (vision, compression, web_extract, approval, title_gen, skills_hub, mcp, triage_specifier, kanban_decomposer, profile_describer, curator). **image_gen и TTS/voice — это ТУЛСЕТЫ, не model-слоты.** → наша «мультимодель» = чат-модель + vision-слот + image/voice как инструменты со своим провайдером (НЕ 4 равных слота).
5. **RAM:** 300-600MB chat-only / 1.2-1.8GB с browser. 2GB прод-VPS = 1-2 профиля макс → **Phase-0 spike требует отдельный 4-8GB VPS** (инфра-блокер подтверждён). Docker-образ `nousresearch/hermes-agent:latest`, Node 20+/22.
6. **Remote gateway (v0.16)** — тонкий клиент → удалённый Hermes-сервер по HTTP/OAuth/user-pass. Это ровно **наша control-plane** для «прокси к Hermes».
7. Память Hermes = `MEMORY.md` + `USER.md` + `state.db` **FTS5 (полнотекст, НЕ вектор)** — НЕ обещать «семантическую память». Вектор только через внешних (Mem0/Honcho).
8. 🔴 **ИЗОЛЯЦИЯ ПАМЯТИ НЕБЕЗОПАСНА «из коробки» для мультитенанта** (ресёрч 2026-06-13): `memory_store.db` де-факто **общий** (открытый баг **#4726**) + `session_search_tool` читает **кросс-профильно**. «Изоляция доказана 6 профилями» верна для файлов config/MEMORY.md, НЕ для holographic-памяти/поиска. При найме ОБЯЗАТЕЛЬНО: per-profile `db_path` (или отключить holographic) + запретить `session_search_tool` в hire-профилях + **наша БД = source of record** (`agent_memory(agent_id,hirer)`), Hermes-память = кэш. RAM: Docker = **контейнер-на-профиль** ~300MB резидент (5GB=cap) → на 8GB ~6-10 активных тенантов; мультиплексинг сессий на одном gateway vs profile-per-процесс = замерить в Phase-0. Полный R&D-синтез: `docs/superpowers/specs/2026-06-13-rnd-research-synthesis.md`.

**Маппинг Hermes → наш UI:**
| Hermes | Наш UI агента |
|---|---|
| main model + provider + base_url | «Чат-модель» (пикер + URL) |
| 11 aux-слотов | «Расширенные настройки модели» (коллапс) |
| toolsets (web/browser/image_gen/tts/code/memory…) | тумблеры «Инструменты» |
| MCP (stdio/HTTP, include/exclude) | секция MCP (серверы + тулы) |
| SOUL.md (free text) | «Личность» = textarea (не структур. поля) |
| MEMORY.md + USER.md + FTS5 | «Память» — просмотр/правка текста (не «семантика») |
| approval manual/smart/off | «Безопасность» — радио |
| Kanban + run-trace (богатые) | **проксировать** (история задач + трейс) |
| cron (fan-out, skill-инъекция) | «Расписание» |
| skills (agentskills.io Hub) | «Навыки» — каталог |
| 22 платформы из 1 gateway | «Каналы» (показываем только TG; мост НЕ строим) |

**Гэпы:** у Hermes есть, у нас нет/заглушка — полный kanban, богатый run-trace, approval-режимы, skills hub, 22 канала, profiles, voice. У нас есть, у Hermes нет — биллинг/кредиты, маркетплейс-шаблонов, crypto/TON, transferable-iNFT, budget-card.

---

## 6. Монетизация и денежные потоки

> Источник: `docs/specs/2026-06-03-monetization.md` + D-0/D-1 (Wave-0). Валюта = USD-pegged крипто-кредит (1 кр = $0.01).

**Author-rent модель (founder decision №7):** автор при публикации шаблона выбирает:
- **Бесплатно** — нет авторской платы.
- **Цена** — автор ставит **точную сумму** (напр. месячная рента или per-deploy/per-use).

Правила:
- Арендатор платит **ровно сумму автора**; автор **получает её целиком** в spendable-кредиты (`tg_user_balances`).
- **AIAG берёт 0% с авторской ренты** (no cut, pass-through).
- Доход AIAG с шаблона = **наценка на модель + тулы + деплой**, которые потребляет арендатор — НЕ авторская рента.

**Что дебетится при разных операциях:**
1. **Использование модели** — через gateway `:4000`, AIAG-наценка = revenue. BYOK/свой провайдер → **0** (платят своему провайдеру).
2. **Платные тулы** (broker) — per-call наценка = revenue.
3. **Деплой/рантайм** — provisioning managed-Hermes → deploy/subscription charge = revenue.
4. **Author rent** — → автору (0% AIAG).

**ПРИ НАЙМЕ (ПРОЕКТ): дебет НАНИМАТЕЛЯ, scope = session**, не создателя. `settleRun` уже дебетует `tg_user_balances` по `tgUserId` → для прогона-найма `tgUserId = hirer` автоматически. Создатель не платит и не отдаёт ключи. Наём всегда `isExternal=false` (AIAG-путь). Рента создателю — Slice 2 (не MVP).

**Фундамент денег (LIVE):**
- **D-0** — gateway возвращает реализованную маржу (`x-aiag-charged-usd-micro` + `x-aiag-upstream-cost-usd-micro`); воркер биллит по ней, фоллбэк никогда не 0. GOLD-verified на проде (charged=4000µ$, upstream=3200µ$, margin=800µ$).
- **D-1** — USD-credit ledger: 1 кредит = 1 US cent (BIGINT); `USD_TO_RUB=90` убран; append-only `tg_ledger_entries`; `settleRun` атомарный (guarded `UPDATE…WHERE balance_credits>=cost RETURNING` + ledger co-committed).
- **BYOK = 0 комиссии** — твёрдо в коде (`if (isExternal) return`).

**Анти-абуз:** ранжирование по реальному usage от distinct funded арендаторов (wash-trading структурно убыточен); self-deal exclusion; single-hop attribution; namespace слагов на автора; dust floor на выплаты.

**Открыто (founder):**
- **FD-2** — авторский доход: **withdrawable наружу vs in-app-spend-only** (лицензионные импликации). Cash-out отложен.
- **Free-first-run грант** — ~300 кр / $3 на первый прогон ИЛИ убрать. Founder-gate открыт, грант НЕ построен.
- **FD-pricing** — наценка (×1.25?) не подтверждена.

**🟢 TON-стек — решения ресёрча 2026-06-13** (полностью: `docs/superpowers/specs/2026-06-13-rnd-research-synthesis.md`):
- **Кредит остаётся OFF-CHAIN** (`tg_user_balances`, USD-credit). Свой jetton НЕ выпускаем (газ съест микро-списания + риск выпуска стейблкоина иностранным юрлицом). On-chain ТОЛЬКО на границах.
- **Пополнение мульти-крипто v1 = native TON (live) + USDT-on-TON jetton** (USD-пег без оракула, 1 USDT=100 кр); кросс-чейн (ETH/SOL) делегируем встроенному Telegram Wallet. Реконсилер: +ветка jetton-transfers (TonCenter v3).
- **Выплаты авторам = off-chain ledger + батч прямым USDT-переводом** (`@ton/ton`), БЕЗ escrow-контракта.
- **TON API-стек:** TonCenter v3 (уже в `topup-reconciler.ts`, Free 10 RPS хватает) + npm **`@ton/ton`** для отправки (новая зависимость; seqno-сериализация 1 воркер/кошелёк). Опц. TonAPI Webhooks как push-ускоритель (SSE deprecated).
- **Агентский кошелёк (Model B) = adopt `the-ton-tech` Agentic Wallet (TEP-85 SBT, split-key) + `@ton/mcp`**, но ⛔ **контракты НЕ аудированы + MCP alpha + спенд-капов нет** → mainnet с деньгами заблокирован до аудита; **наш cap-слой в Postgres** (дневной/per-call/allowlist) перед подписью; `operatorKey` AES-256-GCM как BYOK. **Custody = founder-gate** (Vault/OpenBao vs внешний вендор; US-TEE блокируются OFAC).
- **Контракты если придётся: Tolk** (Tact депрекейтится ~апр-2026) + Blueprint/`@ton/sandbox`; любой money-контракт = аудит ($25–70k) → принцип «меньше своего кода». A2A payment-channels + x402-on-TON = поздний R&D.

### Финмодель web-агрегатора — РАЗВОРОТ (founder 2026-07-15)

> Источник: `docs/specs/2026-07-15-web-full-diagnostic.html` + сессия `.serena/memories/aiag_session_2026_07_15_web_diagnostic_and_finmodel.md`. Меняет модель расхода на web (§2 таблица); Tinkoff-эквайринг в ₽ на ВХОДЕ не меняется.

- **НЕ прямые рубли за расход — КРЕДИТЫ** (модель Higgsfield: тариф даёт N кредитов, докупаются PAYG сверху).
- **1 кредит = 1 US-цент** — ТОТ ЖЕ юнит, что уже в TMA (`apps/tg-miniapp/src/lib/ton-rate.ts`, USD-peg, `tg_user_balances.balance_credits` BIGINT). Кредит совпадает между web и TMA — прямое требование основателя, единая экономика продукта поверх двух разных валют оплаты.
- **Markup 1.20× → 1.8×** (текущий прод занижен, поднимается).
- **Тарифы:** Free 0₽=200 кр (whitelist ТОЛЬКО дешёвых моделей: gpt-4o-mini/DeepSeek/Haiku) · **Lite 290₽=300 кр** (НОВЫЙ тариф, вход вровень с рыночными ChadGPT/BotHub 290₽) · Basic 990₽=1100 кр (маржа 43%) · Starter 2490₽=2900 кр (40%) · Pro 6990₽=8400 кр (39%).
- Кредиты подписки **сгорают** в конце периода; докупленные (payg) — **не сгорают**. Годовой тариф капает кредиты **помесячно**, не разово на год.
- ⚠️ **Формула ниже ИСПРАВЛЕНА (2026-07-17) — прежняя запись была ошибочной.** Первая версия
  этого раздела (2026-07-15/16) гласила `credit_cost = max(1, ceil(upstream_usd × markup × batch × caching × 100))`
  и называла переменную `upstream_usd`. Ошибка: `model_upstreams.price_per_1k_*` /
  `price_per_image` хранит **ЦЕНТЫ** (`USD × 100`), не USD (подтверждено 4 источниками,
  см. memory `project_price_column_is_cents_not_usd`) — переменная называлась `usd`, а
  реально держала центы, то есть `×100` в формуле удваивал перевод и давал результат
  примерно в 100 раз больше нужного (якорь-регресс ловит именно это: Sonnet 1k in + 0.5k
  out @ markup 1.8 — багованная версия формулы даёт 189000 вместо 1890).
  **Верная формула** (реализована в `task/t1-t2-credit-ledger`,
  `docs/superpowers/plans/2026-07-16-gateway-money-leak-closure.md`):
  ```
  costCredits(микро) = round(upstreamCents × markup × batchDiscount × caching × 1000)
  ```
  Кредит = 1 цент = 1000 микро (хранение — BIGINT микро-кредитов). Настоящий USD =
  `центы / 100`. Контракт TMA: `chargedUsd = costCredits / 100_000` (воркер делит на
  `10_000` дальше по цепочке — не переименовывать/не менять этот делитель, он закреплён
  тестом `apps/agent-worker/src/__tests__/billing-100x-anchor.test.ts`). Курс валют в
  списании модели не участвует — конвертация ₽↔кредит происходит только на границе
  тарифа/топ-апа, не в этой формуле.
- **Статус: формула реализована** (`task/t1-t2-credit-ledger`, gateway money-leak-closure
  plan). Остаётся строить: мост оплата→org-бакеты кредитов, реальный учёт расхода (сейчас
  `creditsUsed` не инкрементится — см. §8/диагностика), лимиты в ЛК.
- **🟢 ЗАДЕПЛОЕНО НА ПРОД 2026-07-17 (tip `d16cc39`), проверено эффектом.** Конкретика
  бага: витринная цена показывала ₽18/1M, боевой счёт по багованной формуле составил бы
  **₽1656** (~**120×** оверчардж) — переменная называлась `upstreamUsd`, но реально
  держала центы. Якорь-регресс закрепляет числа: Sonnet 1k in + 0.5k out @ markup 1.8 =
  **1890 микро** (баг давал 189000); эмбеддинг 1k = **4 микро**. Markup **1.8** применён
  на всех **76** привязках модель↔апстрим (было 1.20/1.25). Курс ЦБ убран из рантайма
  целиком — `fetchUsdRubRate` в собранном `dist` не встречается (0 вхождений), не только
  не вызывается в hot-path. Витрина==счёт проверено: `0.027 = 0.027` (gpt-4o-mini, 1k
  input) — ⚠️ честная оговорка: тест читает уже посчитанный артефакт (число со страницы
  и число из леджера), а не пересчитывает обе стороны заново независимо — ловит
  расхождение источников, но не подтверждает саму арифметику с нуля.
  **Миграции:** `0056_web_credits_unit.sql` (перевод юнита, 🔴 **необратима** —
  `USING 0`, старые ₽-значения не восстановить), `0057_markup_180.sql`,
  `0058_settle_charge_credits_fn.sql` (новая функция `aiag_settle_charge_credits` —
  новое имя как защита от случайного вызова по старому имени старой ₽-версии),
  `0059_pricing_unit_comments.sql`, `0061_cost_cap_unit_to_credits.sql` (кап ключа →
  кредиты, фиксированный курс 90, идемпотентна через COMMENT-маркер).

**Аудио/TTS — честно, не работал никогда.** `/v1/audio/speech` осознанно отдаёт **503**
(fail-closed, коммит `01080f1`). Причина: `elevenlabs-tts-hf` маршрутизируется через
апстрим `hf`, для которого в `registry.ts` **нет `case 'hf'`** → 503 при любой цене;
`elevenlabs-tts-kie` не ограничивает длину `input` (до 50k символов → ~час синтеза,
~$18 нашей себестоимости, списали бы по факту ~$0.20 — неограниченная утечка);
апстрим не возвращает реальную длительность аудио для метеринга. **При этом витрина
по-прежнему рекламирует TTS за 32.4 кр/мин** — товар, который 503-ит. Починка — отдельный
план, не в объёме T1-T2.
- 🔴 P0 обнаружен диагностикой 2026-07-15: три несвязанных леджера на проде (топап → `users.balance`, тариф → `subscriptions.credits_limit`, гейтвей списывает ТОЛЬКО `organizations.payg_credits`) → оплативший юзер получает 402. Это и есть повод разворота — старая рублёвая схема без единого кредитного юнита физически не сходится.
- **Известный юр-риск, отложен основателем «в последний момент»:** оферта/условия/политика конфиденциальности = черновики с фейковым ОГРНИП `0000000000`, при этом сайт уже принимает боевые рубли через Tinkoff. Не блокирует финмодель-работу, но зафиксировать как открытый риск.

---

## 7. Текущий деплой-статус (ЖИВОЕ)

Прод TMA: **`app.ai-aggregator.ru/tg`** (через @aiaggbot). Ветка `feat/r1.0-wave0-consolidated` (не в master). Авто-деплой РАБОТАЕТ.

**LIVE на проде:**
- **Phase 16 — transferable-agent iNFT** (миграция 0039, Startonus: минт 1 TON, коллекция EQApEt…SiRW, template 337). Вебхук под shared-токеном (`?token=` в callbackUrl), rate-limit на transfer-offer. ⚠️ **Остался ТОЛЬКО боевой E2E-минт** (2 ТГ-акка + TON Connect); риск: Startonus может срезать query-token → перенести в path.
- **Wave-0 consolidated** — D-0 margin, D-1 USD-credit ledger, author-rent (publish/clone-free/paid-rent 100% автору), provider-picker (create+edit), MCP skills, MCP OAuth 2.1+PKCE, schedules (interval/daily/weekly), creator economy (ratings+remix-lineage+sort), call_agent A2A, white-label, репо PRIVATE, Gonka adapter (inert до GONKA_API_KEY).
- **Серия UI-улучшений 2026-06-12** (через монорепо-пайплайн):
  - Маркет → **5 реальных разделов** (Агенты/Скиллы/MCP/Тузы/Базы — `?tab=`).
  - Агенты → **3 вкладки** Нанять/Мои/Создать (`?tab=`; пустой инбокс→Нанять).
  - **Досье агента**: Публикация-таб, канбан виден всем, форма аренды (убран «появится позже»), метрик-стрип, MCP-статус в просмотре.
  - **cloneable** (колонка + роут агент→агент + тумблер).
  - **tool-call sub-cards** (миграция `agent_runs.tool_calls jsonb`, RunTrace `<details>`-карточки).
  - Углубления: haptics, bottom-sheet удаления (confirm ломал iOS WebView), view-режим настроек, textarea-композер, stagger/spring-анимация, safe-area-inset.

**Founder-gates (открыты):**
- VPS 4-8GB под Hermes-spike (текущий 2GB не тянет).
- Free-first-run грант (~300 кр или убрать).
- FD-2 (withdrawable доход).
- Mainnet TON-кошелёк для real-money go-live (testnet done).
- Merge `feat/r1.0-wave0-consolidated` → master.

**Repo agent-market** — задеплоен и работает (канонный путь TMA), но Фаза 2 `aiag-web` НЕ задеплоена.

---

## 8. Что построено / НЕ построено (ТАБЛИЦА ИСТИНЫ)

> Эта таблица ЗАМЕНЯЕТ 4 противоречивых источника. **Не помечать построенное как not-built.** Доки `user-workflows.md`/старый канон §8/`agent-worker/CLAUDE.md` врут в минус — игнорировать их статусы.

| Фича | Статус | Коммит / где | Что сыро |
|---|---|---|---|
| Agent CRUD / run / история | **LIVE** | `agents` routes + agent-worker | — |
| MCP-серверы (свой URL+auth) | **LIVE** | Wave-0, safeFetch-guard | read-only, билл 0 |
| MCP OAuth 2.1 + PKCE | **LIVE** | Screen 30, миграция 0037 | DCR отложен (ручной client_id для нетех-юзера) |
| Author-rent (100% автору, 0% AIAG) | **LIVE** | Slice 2 (a6e0499), миграция 0032, один `sql.begin` | копирайт местами врёт (фиксы 2026-06-12) |
| Schedules (interval/daily/weekly) | **LIVE** | 2955693, миграция 0034 | daily/weekly затирается в interval на вкладке агента (баг) |
| Transfer-iNFT (TEP-62, Startonus) | **LIVE (код)** | Phase 16, миграция 0039 | боевой E2E-минт ни разу не прогнан; поллинг подтверждения отсутствует |
| Provider-picker / BYOK | **LIVE** | Wave-0, external_openai ветка | свой ключ = 0 комиссии |
| Cloneable (агент→агент) | **LIVE (роут)** | 947da66, `agents.cloneable` | — |
| Tool-call sub-cards | **LIVE** | d0ef1d4, `agent_runs.tool_calls jsonb` | видны только когда агент вызывает тулы (засеянные 7 с tools=[] → пусто) |
| Templates marketplace (publish/clone/rate/sort/lineage) | **LIVE** | Slice 1-3, миграции 0031/0033 | каталог был пуст → засеяны 7 офиц-агентов |
| USD-credit ledger (D-1) + реконсилер + ton-proof | **LIVE** | Wave-0, R2.1-A1/A2 | — |
| D-0 gateway-authoritative margin | **LIVE** | gold-verified на проде | — |
| **Кредитный леджер — правильный юнит (микро-кредиты) + markup 1.8** | **LIVE** | миграции 0056-0059/0061, tip `d16cc39`, 2026-07-17 | тест витрина==счёт читает уже посчитанный артефакт, не пересчитывает независимо |
| **Agents Market — своя орга/ключ/кошелёк (сплит, шаг 1-2)** | **LIVE (частично)** | миграция 0060, тот же деплой | каталог TMA всё ещё через SQL в `models`/`model_upstreams`, межконтурные FK не разорваны, физ. сплит БД не сделан |
| call_agent (A2A depth-1) | **LIVE** | 9ede010 | BYOK-родитель не нанимает |
| Kanban (read-only over BYO-Hermes) | **PARTIAL** | Screen 26, `:9119` server-side | юзер должен экспонировать порт; для не-external = not_connected |
| **Наём / `agent_sessions`** | **ПРОЕКТ** | `2026-06-12-hire-design.md` | таблица/память-namespace/роут не построены |
| **Hermes-proxy (control-plane)** | **ПРОЕКТ (инфра-блок)** | `2026-06-12-hermes-spike-design.md` | нужен Phase-0 spike на 4-8GB VPS |
| **Мультимодель per-role** | **НЕТ** | канон §8 ядро | один `model_slug` на агента; per-role слотов нет |
| **AI-builder («из слов» NL→spec)** | **НЕТ** | s13 | экран/endpoint отсутствуют |
| **Free-first-run грант** | **НЕТ** | founder-gate | копия убрана, грант не построен |
| Run-trace persistence (шаги/токены/таймлайн) | **PARTIAL** | DESIGN сигнатурный | tool-call sub-cards есть, полной persistence шагов нет; цена ДО запуска не показывается |
| Стриминг «агент думает» (SSE) | **НЕТ** | R-05/R2.2 | сознательно не стримим billable |
| Богатая память / KB (pgvector) | **НЕТ (осознанно)** | founder 10.06 | память = «у рантайма», свой слой не строим |
| Tool-approve gate (per-call consent) | **НЕТ** | s09/J2.7 | — |
| Мульти-крипто топ-ап (USDT/USDC/HOT…) | **НЕТ (UI обещает)** | s32 | в коде только native-TON; показывать только TON |
| Audio/TTS-озвучка (`/v1/audio/speech`) | **НЕТ (503 осознанно, fail-closed)** | коммит `01080f1`, 2026-07-17 | никогда не работал — `elevenlabs-tts-hf` без `case 'hf'` в `registry.ts`; `-kie` без кэпа длины `input`; витрина рекламирует 32.4 кр/мин за товар, который 503-ит |
| Managed Hermes provisioning + config-дашборд | **R&D + инфра-блок** | — | курс взят на реальный Hermes (§5/§13), но spike не начат |
| Gonka как провайдер | **PARTIAL** | adapter built, inert | нужен GONKA_API_KEY + spike |

---

## 9. IA и карта экранов

### Единый словарь (заморозить имена раз и навсегда)
| URL | ЕДИНОЕ имя везде | Запрещено называть |
|---|---|---|
| `/agents` | **«Мои агенты»** | ~~«Агенты»~~ (столкновение с сегментом) |
| `/templates` → канонизируется в `/market` | **«Шаблоны»** | ~~«Маркет»~~, ~~«Агенты»~~, ~~«Готовые агенты»~~ |
| `/market` | **«Модели»** (eyebrow «Модель») | — |
| `/skills` | **«Скиллы»** | — |
| `/wallet` + `/profile/topup` | **«Кошелёк»** | — |
| `/account` | **«Аккаунт»** | — |
| `/dashboard` | хаб (оставить pinned+счётчик, не дублировать инбокс) | — |

### 5-таб навигация (bottom tabbar, активный = амбер-индикатор)
```
[ Мои агенты ]  [ Каталог ]  [ Кошелёк ]  [ Аккаунт ]  [ Ещё ]
   /agents       /market       /wallet      /account     sheet
```
«Каталог» внутри = сегменты Шаблоны / Модели / Скиллы / MCP / Тузы / Базы. **Одна навигационная система, не две** (убрать дубли-ячейки сетки 2×4 на `/agents`). Агенты-вкладки: Нанять / Мои / Создать.

### 18 недостающих экранов
Wireframe-борд есть (`docs/wireframes/missing-screens/`), **код нет**. Покрывают: AI-builder, мультимодель-конфиг, run-trace ledger, free-first-run онбординг, наём-флоу (disclosure-шит, бейдж НАЁМ), память-UI, и др.

### ⚠️ РАЗВИЛКА (ОТКРЫТА — нужно решение основателя)
**«лента-персонажей (character-feed) vs биржевой-хаб (data-dense hub)».** Канон/PRODUCT требуют character-first каталог (collectible-card сигнатура); 108-критика тянет к Binance/Bybit-ремеслу (плотность данных, mono-цифры, скорость табов). Решение НЕ принято — зафиксировать здесь, когда основатель выберет. Берём РЕМЕСЛО бирж (плотность/анимация), НЕ их каркас; Агенты/Маркет остаются character-first по канону — но финальная развилка за основателем.

---

## 10. Дизайн-система

**Токены = `DESIGN.md` (единственный SoT).** Dark = TMA + дефолт; Light = web (Studio23-стиль). Амбер = единственный продуктовый акцент (CTA/лого/live-статус/featured-ring), ~10-15% поверхности. JetBrains Mono для всех цифр. Hairline-elevation (1px `--line`, не material shadow). Радиус 8px. OKLCH per-character hues (только agent-cards).

**Статус применения:** TMA ~78% · Web ~45% (оценка 2026-06-10).

**Character-card сигнатура — ЧАСТИЧНО ПОТЕРЯНА:** строка-характера (`trait`) + @автор + live-дот + статы. Карточки на `/agents` и `/templates` говорят на character-card языке, но полная сигнатура упирается в ДАННЫЕ templates-API / контент основателя (нужны реальные лица/арт — сейчас монограммы-плейсхолдеры). Моушн (`aiag-fade-up`/glow/pulse/skeleton) — токены совпадают, частично перенесён (R2.1-E).

**Известный долг (форензик 2026-06-12):** 3 несовместимых языка иконок (outline HubIcon vs emoji ⏰🧩⤴▤ vs глифы ●◷ — последние нарушают «icon+word, не цвет»); inline-стили вместо токенов; захардкоженный rgba success-фон (не переключается dark/light); сегмент «Монетизация» без амбер-акцента.

**3 борда (назначение каждого):**
- **design-board** (`docs/wireframes/...`) — основной апп: построенные/живые экраны в едином дизайн-языке.
- **missing-screens** (`docs/wireframes/missing-screens/`) — 18 недостающих экранов (wireframe есть, код нет): IA-основа для будущей застройки.
- **hifi-hire-deploy** — hi-fi борд флоу найма/деплоя (Нанять vs Скопировать кнопки, disclosure-шит, бейдж НАЁМ): визуализация ПРОЕКТ-найма из §4.

---

## 11. Безопасность и правила

> Полные правила = `SECURITY.md`. Здесь — что канон фиксирует поверх.

- **Изоляция памяти per-наниматель (OWASP LLM06):** namespace `(agent_id, COALESCE(scope_tg_user_id,0), key)`; история фильтруется `tg_user_id = hirer`; scope зашит воркером из `runId`, НЕ из тела запроса (LLM не может попросить чужую память). КРИТИЧНО для найма (§4).
- **TMA JWT:** HS256-пин (`{algorithms:['HS256'], iss:'aiag-tma', aud:'aiag-gateway'}`); fail-hard если `TMA_JWT_SECRET` <32 chars.
- **nginx strip** `x-middleware-subrequest` + `x-tma-user-id` на `/tg` (CVE-2025-29927; Next пин 14.2.33 — **никогда не понижать**).
- **settleRun атомарность:** markCompleted + дневной гард + дебет в одном `sql.begin`. AIAG-модель → дебет+наценка; BYOK → 0 (`if (isExternal) return`).
- **ton-proof** верифицируется СТРОГО (R2.1-A2; старое «unverified» устарело).
- **Prepared statements only;** atomic money = guarded `UPDATE…WHERE…RETURNING`; READ COMMITTED.
- **White-label:** ошибки/UI никогда не раскрывают апстрим-бренд (OpenRouter/Kie); бренд только в server-логах.
- **Секреты:** все в `/srv/aiag/shared/.env` на VPS; BYOK = AES-256-GCM, UI показывает только last-4.
- **Known SECURITY-TODOs:** provider_id SSRF re-validation (R1-7); eval-runner nsjail; VPS root password; live-revocation (`jwt-denylist isRevoked` stub).
- **Never expose** личный Telegram (@b0brov) в артефактах.

---

## 12. Инфраструктура и деплой

- **pm2 на одном 2GB Timeweb VPS** (5 процессов): `web` (Next ₽), `gateway` (Hono/Bun `:4000`), `tma` (Next `:3100` `/tg`), `agent-worker` (BullMQ `:3101` — money-path), `worker` (фоновые джобы). nginx фронтит всё + strip-заголовки.
- **Data stores:** Postgres `aiag` (Timeweb managed) — SoT (`tg_user_balances`, `tg_ledger_entries`, `agents`, `agent_templates`, `agent_memory`, `agent_provider_credentials`, `gateway_transactions`); Redis 7 — BullMQ.
- **Авто-деплой РАБОТАЕТ:** монорепо через GitHub Actions SSH rsync; agent-market через `gh workflow run deploy-production.yml -R massmindmaker/agent-market --ref master -f apps=tma,agent-worker` (scp + pm2do + cleanup). Health-check воркера = `sudo -n pm2 jlist` (не `pm2`/`pm2do` — у jlist exit 0 на пустом → ложный rollback). Прод TMA = `app.ai-aggregator.ru/tg`.
- **Миграции** применяются вручную, без трекинга (`sudo -u postgres psql aiag` для ALTER; app-юзер `aiag` не может ALTER).
- **SSH gotcha:** под always-on VPN тунель через `ssh -o ProxyCommand="connect -H 127.0.0.1:10809 %h %p"`; `pm2 reload` может оставить stale-процесс → `pm2 restart`.
- 🟢 **ИНФРА-БЛОКЕР HERMES СНЯТ (2026-06-13):** отдельный VPS искать НЕ надо — **Hermes уже работает на VPS основателя `176.124.211.11`** (v0.12, gateway :8642, 6 профилей, Docker, ≥5GB). Строим **control-plane к существующему Hermes** (см. §5 + спека control-plane), а НЕ ставим новый. (Прод-TMA-бокс 2GB не трогаем — Hermes на ОТДЕЛЬНОМ боксе основателя, money-path изолирован.) ⚠️ Не долбить SSH к Hermes-боксу (fail2ban) — control-plane жить НА боксе, локальные вызовы. Единый источник релиза TMA: skill `aiag-deploy`.

---

## 13. Решения-лог (ADR, датированный)

| Дата | Решение | Что меняет | Статус |
|---|---|---|---|
| **2026-06-02** | TMA = крипто-кредиты (₽ удалены) | валюта TMA; код-миграция ₽→credits | ✅ D-1 выполнена (LIVE) |
| 2026-06-02 | managed-Hermes runtime = R&D/deferred | live = connect-your-own-Hermes | ⛔ **ОТМЕНЕНО** решением 2026-06-12 (курс на реальный Hermes) |
| 2026-06-02 | Wireframes в 2 слоя (A shippable / B roadmap) | дизайн-процесс | ✅ актуально |
| **2026-06-03** | Мульти-крипто (TON+др., USD-pegged), Stars отложены, legal не-факторим | биллинг/комплаенс | ✅ TON live; мульти-крипто UI обещает больше кода |
| 2026-06-03 | Author-rent: автор ставит цену/free, AIAG 0% с ренты | монетизация (`2026-06-03-monetization.md`) | ✅ LIVE (Slice 2) |
| 2026-06-03 | NFT REMOVED как спекуляция | нет tradable-agent/NFT-marketplace | ⚠️ **ЧАСТИЧНО ОТМЕНЕНО** 2026-06-10 (transfer-iNFT) |
| 2026-06-03 | Web-версия = все TMA-экраны light Studio23 | `docs/wireframes/web/` | ⚪ отложено до Agent Market |
| **2026-06-10** | **ЦА = AI-агенты**, люди = деплоеры; продукт = агентская инфраструктура | приоритеты, оценка | ✅ действует |
| 2026-06-10 | iNFT-transfer reversal — ОДНА opt-in transferable-поверхность | Phase 16 (TEP-62, Startonus) | ✅ LIVE (код); E2E-минт pending |
| 2026-06-10 | Агентские траты = TON Agentic Wallets (adopt-not-build); x402 НЕ строим | work3/кошелёк | 🔨 R2.2 |
| 2026-06-10 | Память НЕ строим (pgvector) — приходит из рантайма | архитектура памяти | ✅ действует |
| **2026-06-12** | **Наём — СТРОИМ настоящий** (`agent_sessions` + память-namespace), не переименование | §3-4 модель найма | 🔨 ПРОЕКТ |
| 2026-06-12 | **cloneable** — флаг + роут агент→агент | §3 | ✅ LIVE |
| 2026-06-12 | **КУРС НА РЕАЛЬНЫЙ HERMES** — наш UI = control-plane к Hermes REST API (РАЗВОРОТ от 2026-06-02 deferred) | §5 архитектура | 🔨 Phase-0 spike pending |
| 2026-06-12 | Repo-split (TMA/Web в 2 репо) | §2 | ✅ Фаза 1 done; Фаза 2 pending |
| **2026-06-13** | **Архитектура знания** — мастер-канон = SoT; производные слои синхронятся | этот документ + карта памяти | ✅ действует |
| **2026-06-13** | **Hermes-рантайм основателя подтверждён ЖИВЫМ** (v0.12, VPS 176.124.211.11, :8642, 6 профилей, Docker) → **инфра-блокер СНЯТ**, строим control-plane на нём | §5, §12, спека control-plane | 🔨 Phase-0 spike (добрать REST :8642 когда SSH спадёт с fail2ban) |
| **2026-06-13** | **R&D-синтез (12 агентов): критический путь наёма = память→Hermes-спайк→USDT-on-TON→агент-кошелёк** | §5 (поправки auth/изоляции), §6 (TON-стек) | ✅ ресёрч (`2026-06-13-rnd-research-synthesis.md`) |
| **2026-06-13** | **Кредит off-chain (свой jetton НЕТ); агент-кошелёк = adopt unaudited the-ton-tech + наш cap-слой; TON API = TonCenter v3 + `@ton/ton`** | §6 TON-стек | 🔨 строим память+пополнение сейчас; кошелёк ждёт аудит+custody-гейт |
| **2026-06-13** | **Наём MVP = на stateless-loop** (не ждём Hermes-профиль); наниматель сам запускает → `settleRun` дебетует его → money-path не трогаем | §3-4 модель найма | 🔨 СТРОИМ (ветка `feat/hire-memory-foundation`) |
| **2026-06-13** | **Пополнение = stables-only USDT-on-TON + свой кошелёк (0%)**; кросс-чейн → Telegram Wallet (без оракула/KYB) | §6 | 🔨 строим jetton-ветку реконсилера |
| **2026-06-13** | **Custody operatorKey агент-кошелька отложено** (последний на пути, заблокирован аудитом): testnet=AES-256-GCM на воркере, mainnet=Vault | §6 агент-кошелёк | ⚪ отложено |
| **2026-07-15** | **Web-финмодель РАЗВОРОТ: рубли-за-расход → КРЕДИТЫ, 1 кр=1¢ (совпадает с TMA-юнитом), markup 1.8×, добавлен тариф Lite 290₽=300кр** | §6 «Финмодель web», §2 таблица | 🔨 РЕШЕНО, реализация pending (мост леджеров + учёт + ЛК-лимиты) |
| **2026-07-17** | **Кредитный леджер: `price_per_1k_*` оказались центами, гейтвей читал их как USD и множил на курс ЦБ → ~120× оверчардж; формула исправлена (`upstreamCents×markup×...×1000`), markup 1.8 на всех 76 привязках, курс ЦБ убран из рантайма** | §6 формула, миграции 0056-0059/0061 | ✅ **LIVE на проде** (tip `d16cc39`), проверено эффектом |
| **2026-07-17** | **Аудио/TTS признан никогда не работавшим — `/v1/audio/speech` осознанно 503 (fail-closed), а не тихий провал; попытка билинга аудио в T1-T2 откачена целиком** | §6 «Аудио/TTS», §8 таблица | ✅ зафиксировано; починка TTS — отдельный план, не начат |
| **2026-07-17** | **Web↔TMA split: агрегатор=провайдер, TMA=клиент со своей оргой/ключом/кошельком (старт с 0); трансфертная цена = те же ставки, что всем; per-org markup не строим** | §2 (старая формулировка «общий контур» → DEPRECATED), новая подсекция «Web↔TMA split» | 🔨 **половина сделана**: своя орга/ключ/кошелёк + закрытые тихие фолбэки LIVE; каталог-через-API, разрыв FK, физ. сплит БД — припарковано |

## 14. Контент и supply

**SOUL.md-формат:** персона агента = свободный текст (не структурированные поля) — соответствует Hermes `SOUL.md`. В нашем UI = «Личность» = textarea. Дополняется `AGENTS.md`-контекстом.

**7 засеянных официальных агентов на проде** (засеяны как official public templates, free, `author_tg_user_id=1` → карточка «официальный»; каждый: role + trait(строка-характера) + system_prompt; слаги ТОЛЬКО namespaced-зарегистрированные иначе утечка маржи через OpenRouter-fallback):
| Агент | Роль | Модель |
|---|---|---|
| Алиса | код-ревью | `anthropic/claude-sonnet-4-6` |
| Макс | копирайт | `openai/gpt-4o-mini` |
| Ника | ресёрч | `anthropic/claude-sonnet-4-6` |
| Гриша | перевод | `openai/gpt-4o-mini` |
| Лея | планировщик | `openai/gpt-4o-mini` |
| Орион | SMM | `openai/gpt-4o-mini` |
| Нова | брейншторм | `anthropic/claude-sonnet-4-6` |

Это ЧЕРНОВИКИ — основатель редактирует имена/роли/персонажей/модели/промпты.

**ПРОБЕЛ (supply):**
- Нужны **реальные лица/арт** (сейчас монограммы-плейсхолдеры; founder-supplied refs позже) → character-card сигнатура неполна (§10).
- Нужны **SOUL.md** на каждого (полноценные персоны).
- Нужно **больше агентов** (7 — стартовый минимум; маркет был пуст до засева).
- **Онбординг / free-first-run НЕ построен** — копия «бесплатно» из s03b/s05 убрана, грант (~300 кр) не построен, founder-gate открыт; виральный онбординг отложен основателем до завершения R2.1. 3 пути онбординга (шаблон/Hermes/с нуля) — две из трёх плиток ведут в один `/agents/new` без преселекта (бутафорский выбор).

---

---

## NFT-поверхности (2026-07-11)

> ⚠️ ОБНОВЛЕНО 2026-07-11: NFT-поверхностей ДВЕ — transferable-агент (Phase 16) И membership-NFT (доступ/квота, 3 яруса creator/builder/studio, 2/10/30 TON, минт Startonus). Членства не торгуются. Запрет NFT-как-инвестиции в силе. Детали — issue #29.
> ⚠️ УТОЧНЕНО 2026-07-12: membership-NFT ПЕРЕДАВАЕМ. Передача NFT = передача членства + всех агентов + дохода с аренды (продажа аккаунта). Арендаторы не затронуты — их память изолирована per-hirer. Источник истины владения = блокчейн (tonapi.io), не БД. Startonus SBT не умеет. Клонирование агентов УБИРАЕТСЯ (решение 07-12): создать агента можно только из шаблона.

---

_Конец мастер-канона. Поддержка: при изменении продукта обновлять ЭТОТ файл первым, затем синхронить производные (memgraph/LightRAG/graphify/auto-memory). Старые противоречащие доки → DEPRECATED со ссылкой сюда._
