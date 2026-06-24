# Agents Market на Hermes v0.17 — план адаптации (2026-06-24)

**Принцип:** Hermes v0.17 = **runtime plane** (исполняет агента: модели, тулы, память, каналы, cron, изоляция). Наш стек = **control-plane + commerce plane** (КТО платит / СКОЛЬКО / витрина / TON / iNFT). Граница жёсткая: что v0.17 умеет нативно — НЕ пишем руками, делаем обёртку. **Наша БД = source-of-record по деньгам и namespace памяти** (баг #4726: память Hermes из коробки течёт кросс-профильно). Разблокировщики v0.17: **multiplex профилей через 1 gateway** (снимает RAM-блокер → десятки нанимателей на боксе) + **remote-gateway по OAuth** (= ровно наш control-plane).
Полный вывод: `tasks/wioshbqgz.output`.

## Маппинг: наша фича → натив v0.17 → действие
| Фича | Натив v0.17 | Действие | Суть |
|---|---|---|---|
| **Наём** (stateless-loop + agent_sessions + /hire) | профили + multiplex + remote-gateway; provisioning=CLI `hermes profile create --clone-from` | **BUILD-поверх** | agent_sessions/hire = биллинг-контейнер ОСТАВИТЬ; добавить control-plane: на /hire создать профиль, патч base_url=:4000; runHired→Hermes :8642. На r2 наём=MVP на stateless-loop → после v0.17 заменить на профиль-per-hirer |
| **Изоляция памяти per-hirer** (scope + PK-своп 0040 + resolveRunScope) | профиль + X-Hermes-Session-Key; 🔴 #4726 небезопасно из коробки | **KEEP-наше** | НИЧЕГО не менять: наша БД = source-of-record и граница; Hermes-память = кэш. При v0.17: per-profile db_path + отключить session_search в hire-профилях |
| **Run-trace** (tool_calls jsonb + recordToolCalls) | /events SSE на /v1/runs + Kanban | **BUILD-поверх** | persist остаётся для stateless+биллинг-аудит; для Hermes — подписка на /events SSE → наш recordToolCalls. Стриминг billable не включать |
| **Мультимодель** (image/voice/vision_model_slug 0042) | 1 главная + 11 aux-слотов; image_gen/TTS = ТУЛСЕТЫ | **WRAP-натив** | колонки = тонкая проекция на aux (vision→auxiliary.vision; voice/image→тулсеты). ⚠️ НЕ деплоить/подавать как «4 равные модели» (канон §5.4) → подать как «чат-модель + расширенные (aux)» |
| **Скиллы** (3 SOON-заглушки) | Skills Hub + security-скан + `hermes skills install` | **REPLACE-нативом** | курируемые builtin/doc-скиллы оставить; 3 SOON-карты заменить реальным Hub (/v1/skills + install) после v0.17 |
| **Расписания** (scheduler 60с + settleRun-per-fire) | cronjob + Automation Blueprints + /api/jobs | **BUILD-поверх** | scheduler+settleRun-per-fire = биллинг-критичен, ОСТАЁТСЯ; опц. проксировать /api/jobs, но каждый fire через agent-worker→settleRun. Баг daily/weekly→interval чинить независимо |
| **MCP** (stdio/HTTP + OAuth PKCE) | MCP нативно + каталог + elicitation | **WRAP-натив** | наш слой = хранение креды (AES-GCM) + UI; для Hermes писать mcp_servers в config профиля. Рантайм MCP не дублировать |
| **Approval / агент-кошелёк** (не построен) | elicitation (mid-call) + approval-режимы | **BUILD-поверх** | свой gate НЕ писать → нативный elicitation; наш cap-слой Postgres (дневной/per-call/allowlist) ОБЯЗАТЕЛЕН перед подписью. Кошелёк на r2 не деплоить (аудит) |
| **Провайдеры** (picker+BYOK=0+AES-GCM+Gonka) | провайдеры нативно + fallback | **KEEP-наше** | биллинг-инвариант, не трогать; наш :4000 = один из провайдеров (AIAG-путь=маржа+white-label) |
| **Каналы** (только Telegram) | 25+ каналов из 1 gateway | **KEEP-наше** | мост не строим (преимущество натива); UI=TG. TMA-оболочка/character-card = наше |
| **USDT-on-TON + выплаты** (0043) | — (нет у Hermes) | **KEEP-наше** | полностью наше (канон §6); payouts OFF до аудита |
| **AI-builder** (NL→spec) | profile_describer aux + discovery | **KEEP-наше** | оставить; опц. тянуть ALLOWED из /v1/toolsets|models |

## Переосмыслить на ветке r2-readiness (перед деплоем)
1. **Мультимодель** — не подавать как 4 равные; UI = «чат-модель + расширенные (aux)». Колонки оставить, мапить на aux.
2. **Наём=stateless-loop** — это MVP-костыль до v0.17; после апгрейда → профиль-per-hirer (иначе «инстанс» крутит общий loop = врём про изоляцию рантайма).
3. **3 SOON-скилл-карты** — после v0.17 заменить реальным Hub (не оставлять «скоро» навсегда).
4. **Run-trace** — для Hermes-прогонов источник = /events SSE, не вторая persist-модель.
5. **Расписания daily/weekly** PUT-баг — починить независимо.
6. **approval/consent** — не писать свой, ждать нативный elicitation.

## План перехода
1. **Деплой r2-readiness** (текущий MVP на stateless-loop) — ценность сейчас, по deploy-plan (миграции 0040-0043 + env + сборка + E2E). Мультимодель подать как aux, не «4 равные».
2. **Апгрейд бокса v0.12 → v0.17** (бэкап профилей; breaking: redaction ON, Docker opt-in).
3. **Phase-0 спайк на боксе:** multiplex-1-gateway (RAM-замер) + remote-gateway OAuth (=control-plane) + per-profile db_path/session_search (изоляция памяти #4726).
4. **Перенос на натив:** наём stateless→профиль-per-hirer; run-trace→/events SSE; skills→Hub; approval→elicitation; MCP/мультимодель→config профиля.

## Что строим САМИ (наше уникальное, не у Hermes)
Биллинг/крипто-кредиты, маркетплейс шаблонов + author-rent, character-card каталог, transferable-iNFT, TON/USDT, TMA-оболочка/UX, cap-слой агент-кошелька.
