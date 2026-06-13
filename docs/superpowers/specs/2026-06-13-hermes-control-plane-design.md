# AIAG↔Hermes control-plane — дизайн (2026-06-13)

**Статус:** дизайн. Основан на ground-truth живого Hermes основателя (прочитан 2026-06-13, см. memory `project_hermes_runtime_setup`). ⚠️ Точные сигнатуры REST-эндпоинтов :8642 + provisioning-команда — ДОБРАТЬ с бокса (сейчас SSH под fail2ban-баном после серии подключений; верифицировать когда спадёт).

## Контекст (что УЖЕ есть — инфра-блокер снят)
Hermes v0.12 на VPS `176.124.211.11` (ssh `hermes@`, key `timeweb_vps`): gateway REST **`:8642`**, dashboard/kanban `:9119`, мост `:9121`, gonka-proxy `:9131`. **6 живых профилей** (alisa/backend-eng/ops/researcher/reviewer) — изоляция доказана. **Docker** (`container_memory: 5120`). Провайдеры: gonkagate + ollama-cloud + groq + openai-codex. → сервер не нужен, строим на этом.

## Цель
Связать AIAG TMA с реальным Hermes так, чтобы **наём = отдельный Hermes-profile per (agent, наниматель)** с персональной памятью, общими скиллами, дебетом нанимателя.

## Архитектура (поток найма)
```
TMA «Нанять» → POST /api/tma/agents/[id]/hire (наш)
   → agent-worker: запись agent_sessions(agent_id, hirer_tg_user_id, profile, status)
   → CONTROL-PLANE (новый наш сервис на VPS, рядом с Hermes):
       1) hermes profile create <agent_id>_<hirer>  (клон спека агента)
       2) патч config.yaml профиля: base_url=наш gateway :4000, key=AIAG_GATEWAY_KEY
          (ключи/MCP-токены создателя НЕ копируются — NULL)
       3) Docker-контейнер профиля (изоляция ФС) — как у существующих профилей
   → чат: TMA → agent-worker → Hermes :8642 REST (sessions/runs) в нужном профиле
   → settleRun: дебет НАНИМАТЕЛЯ (scope=session), НЕ создателя; биллинг не ломаем
   → память: MEMORY.md в профиле нанимателя (изолирована) + наша БД agent_memory(agent_id,hirer)
```

## Компоненты
1. **Control-plane сервис** (наш, на VPS 176.124.211.11 рядом с Hermes): принимает запросы от agent-worker, исполняет `hermes profile create/delete` + патч config + старт/стоп контейнера + healthcheck. Доступ: локально на боксе (избегаем SSH-фана) ИЛИ через мост `:9121` (windows_agent уже умеет exec). Авторизация — shared secret.
2. **agent-worker (наш, есть):** новый путь `runHired(sessionId)` → вызывает Hermes :8642 REST для прогона в профиле нанимателя; settleRun дебетит нанимателя. Money-path additive, не трогаем существующий.
3. **Hermes :8642 REST (его, есть):** `/api/model/set`, `/api/sessions`, `/api/jobs` (точные тела — добрать). Стабильный токен `API_SERVER_KEY` (механизм добрать — сейчас токен сессии ротируется).
4. **БД (наш):** `agent_sessions(id, agent_id, hirer_tg_user_id, hermes_profile, status, created_at)` + `agent_memory(agent_id, hirer_tg_user_id, key, value)` (namespace-изоляция, OWASP LLM06).

## Изоляция
- Память: профиль Hermes изолирует MEMORY.md/USER.md/state.db через HERMES_HOME + Docker ФС-изоляция; наша БД дублирует namespace `(agent_id, hirer)`.
- Ключи: модель-ключ = наш AIAG_GATEWAY_KEY (дебет нанимателя); ключи/MCP-токены создателя НЕ переносятся (наниматель подключает свои).
- Спек создателя: read-only (обновления автора применяются).

## Поэтапный план
- **Phase-0 (ручной спайк, ~1 день):** на боксе руками `hermes profile create test_hire`, пропатчить config на наш gateway, прогнать 1 чат через :8642 REST, замерить RAM/изоляцию памяти, верифицировать точные эндпоинты + токен-механизм. ← закрывает open-вопросы.
- **Phase-1 (control-plane MVP):** сервис provisioning + `/hire` роут + `agent_sessions` миграция + `runHired` в agent-worker + дебет нанимателя + экран «Нанять»→провижн→чат (борд уже есть). Память per-профиль.
- **Phase-2:** UI памяти (просмотр/очистка MEMORY.md профиля) · approval-режимы · каналы (Hermes нативно бриджит — прописать TELEGRAM_BOT_TOKEN в .env профиля) · skills-hub.

## Что строим vs что даёт Hermes
- **Hermes даёт:** рантайм, профили-изоляция, Docker, REST, модели/тулсеты/MCP/память/kanban/cron/22-канала, провайдер-fallback.
- **Строим мы:** control-plane (provisioning-обёртка), `/hire` + `agent_sessions` + биллинг нанимателя, TMA-UI (нанять/досье/память), маппинг наш-gateway↔Hermes-провайдер.

## Открытые вопросы (добрать с бокса, когда SSH спадёт с бана)
1. Точные REST-эндпоинты :8642 (тела `/api/model/set`, `/api/sessions`, `/api/runs`, есть ли `/api/memory`).
2. Стабильный API-токен (`API_SERVER_KEY` env?) vs ротируемый session-token.
3. Точная команда provisioning профиля (CLI `hermes profile create --clone-from` vs код) + как патчить config программно.
4. v0.12 vs v0.16 различия в API (бокс на 0.12).
5. Как control-plane стартует Docker-контейнер per-профиль (config `terminal.backend: docker`?).

## Риски
- fail2ban на боксе при частых SSH — control-plane должен жить НА боксе (локальные вызовы), не дёргать SSH извне.
- Money-path: дебет нанимателя — строго additive к settleRun, под тестом.
- RAM: каждый профиль 300-600MB + Docker → лимит активных профилей; нужен auto-sleep неактивных.
