# Hermes v0.17 Adaptation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Перевести Agents Market с stateless-loop MVP на нативный Hermes v0.17 (control-plane), сохранив money-path-инварианты.

**Architecture:** Hermes v0.17 = runtime plane (remote-gateway OAuth + multiplex 1 gateway + профили-per-наниматель + REST :8642). Наш agent-worker = control-plane + биллинг; наша БД = source-of-record по деньгам и namespace памяти.

**Tech Stack:** Next 14.2.33 (tg-miniapp), BullMQ/Node (agent-worker), Postgres, Hermes v0.17 REST :8642, TON.

## Global Constraints (verbatim из спек)
- Money-path: settleRun дебетит нанимателя; правки ТОЛЬКО additive; BYOK/external = 0 комиссии (`if isExternal return`). Наша БД = source-of-record памяти (баг #4726 — Hermes-память кэш).
- Next пинить 14.2.33 (CVE). Не понижать.
- SSH к боксу 176.124.211.11 (hermes@, key timeweb_vps): ОДИН батч-heredoc-коннект, НЕ долбить (fail2ban). ControlMaster не работает (Windows). Auth Hermes REST = статический Bearer API_SERVER_KEY; изоляция нанимателя = X-Hermes-Session-Key (worker из runId, не из тела).
- typecheck зелёный перед коммитом; миграции к проду вручную ДО деплоя кода.

---

## ФАЗА 1 — Деплой ветки feat/r2-readiness (MVP на stateless-loop)
*Ценность сейчас; ops-runbook, не TDD. Деплой = окно обслуживания (PK-своп 0040 связан с кодом).*

### Task 1.1 — Подача мультимодели как aux (pre-deploy фикс)
**Files:** Modify `apps/tg-miniapp/app/agents/new/page.tsx`, `apps/tg-miniapp/app/agents/[id]/page.tsx` (секция «Модели по ролям»).
- [ ] Переименовать UI: «Чат-модель» (основная, обязательна) + сворачиваемые «Расширенные: зрение / картинки / голос» с подписью «по умолчанию = чат-модель». НЕ подавать как 4 равноправные. Колонки/бэкенд (0042) не трогать.
- [ ] `bunx tsc --noEmit` зелёный. Commit.

### Task 1.2 — Бэкап + миграции на проде (ВРУЧНУЮ, по порядку)
**Где:** VPS web/app (5.129.200.99), prod Postgres `aiag` (`sudo -u postgres psql aiag`), через VPN-прокси SSH.
- [ ] `pg_dump` затрагиваемых таблиц (agent_memory, agents, tg_topups, tg_ledger_entries, tg_user_balances) → файл с датой.
- [ ] Применить ПО ПОРЯДКУ: 0040_hire_sessions_memory_scope (⚠️ PK-своп agent_memory), 0041_rental_subscriptions, 0042_agent_role_models, 0043_usdt_topup_and_payouts. Проверить `\d agent_memory` (новый PK+индекс), `\d agents` (role-колонки), `\d tg_topups` (asset/network), наличие `author_payouts`.

### Task 1.3 — Env + сборка + restart (сразу за миграциями, окно ≤ неск. минут)
**Где:** VPS, `/srv/aiag/shared/.env` + сборка tma/agent-worker (вручную, по skill aiag-deploy).
- [ ] Проверить/задать env: `TRANSFER_WEBHOOK_SECRET` (ОБЯЗАТЕЛЬНО — вебхук fail-hard), опц. `UPSTASH_REDIS_REST_URL/TOKEN`, `FREE_FIRST_RUN_CREDITS` (дефолт 30000), `TMA_USDT_JETTON_MASTER` (иначе USDT 503), `TON_PAYOUTS_ENABLED` НЕ ставить (выплаты OFF).
- [ ] `bun install` в apps/tg-miniapp (@upstash/redis) и apps/agent-worker (@ton/ton).
- [ ] Собрать tma + agent-worker, `pm2 restart tma agent-worker --update-env && pm2 save`.
- [ ] Verify: `/tg/health`=200; smoke запуск агента (не 500 на role-колонках); transfer-вебхук не 503.

### Task 1.4 — E2E на проде (2 ТГ-аккаунта)
- [ ] Наём чужого агента 2-м акком → изоляция памяти (наниматель НЕ видит память владельца). Free-run грант начислился раз. Rate-limit 429 при флуде. Pre-check 402 при нуле. USDT-топап показывает реквизиты (если jetton-master задан).

---

## ФАЗА 2 — Апгрейд бокса Hermes v0.12 → v0.17
*SSH к 176.124.211.11. Его ЖИВОЙ Hermes (6 профилей + мосты) — бэкап обязателен, читать breaking-changes.*

### Task 2.1 — Recon + бэкап (ОДИН батч-коннект)
- [ ] SSH (через прокси), в одной heredoc-сессии: `hermes --version`; `ls ~/.hermes/profiles`; `systemctl --user status hermes-gateway`; `cp -a ~/.hermes ~/.hermes.bak.<ts>` (бэкап профилей/config/auth); зафиксировать текущий config.yaml ключи.

### Task 2.2 — Апгрейд + проверка breaking-changes
- [ ] Прочитать changelog v0.13→v0.17 (redaction ON by default, Docker `--insecure`→opt-in, security-дефолты, session_search переписан). Обновить Hermes до v0.17 (по их процедуре — git pull/pip/installer; уточнить на боксе). Сверить config на новые обязательные поля.
- [ ] Рестарт gateway; `hermes --version`=v0.17; проверить что 6 профилей живы (`/health`, тест-чат в одном профиле через :8642).
- [ ] Если сломалось — откат из `~/.hermes.bak`.

---

## ФАЗА 3 — Phase-0 спайк на боксе (валидация натива)
### Task 3.1 — Multiplex + remote-gateway + изоляция памяти
- [ ] Включить multiplex профилей через 1 gateway (config opt-in v0.17); замерить RAM (`docker stats`/`pm2 monit`) при N активных профилях → сколько тенантов на боксе.
- [ ] Проверить remote-gateway OAuth-подключение (тонкий клиент → :8642) — это наш control-plane-транспорт.
- [ ] Для hire-профиля: per-profile `db_path` + отключить `session_search`/holographic (баг #4726) → подтвердить, что память не течёт кросс-профильно. Зафиксировать точные REST-тела (/v1/runs, /events, /api/sessions, profile create CLI).
- [ ] Записать результаты в docs/superpowers/specs/hermes-phase0-results.md.

---

## ФАЗА 4 — Перенос на натив (код, TDD где применимо)
*Зависит от Фаз 2-3 (живой v0.17 + подтверждённые REST). Money-path additive.*

### Task 4.1 — Control-plane сервис (provisioning профиля)
**Files:** Create `apps/agent-worker/src/hermes-control.ts`. Modify `apps/tg-miniapp/app/api/tma/agents/[id]/hire/route.ts`.
- [ ] `ensureProfile(agentId, hirerId)`: SSH/локально на боксе `hermes profile create <agentId>_<hirer> --clone-from <tpl>` + патч config base_url=наш :4000 + AIAG_GATEWAY_KEY (ключи создателя НЕ копируются). Идемпотентно (профиль существует → no-op).
- [ ] На /hire после записи agent_sessions → ensureProfile. Тест: повторный hire = один профиль.

### Task 4.2 — runHired через Hermes :8642 (вместо stateless-loop)
**Files:** Modify `apps/agent-worker/src/agent-runner.ts`.
- [ ] Для нанятого прогона (есть active agent_sessions): вызвать Hermes :8642 (`POST /v1/runs` в профиле нанимателя, header `X-Hermes-Session-Key`=из runId, Bearer API_SERVER_KEY) вместо OpenRouter-loop. settleRun дебетит нанимателя (additive, не менять формулу).
- [ ] Fallback на stateless-loop, если профиль/бокс недоступен. Тест: hired-run идёт через :8642; owner-run без сессии — как раньше.

### Task 4.3 — Run-trace из /events SSE
**Files:** Modify `apps/agent-worker/src/agent-runner.ts` (+ хелпер).
- [ ] Для Hermes-прогона подписаться на `/v1/runs/{id}/events` (SSE) → маппить tool-call события в наш `capturedToolCalls` → `recordToolCalls` (вне settleRun). UI RunTrace без изменений (источник = наша таблица). Тест: события маппятся в существующую модель.

### Task 4.4 — Skills Hub, MCP-config, мультимодель-aux, approval-elicitation
- [ ] Скиллы: /api/tma/skills проксирует Hermes `/v1/skills`; «установить» = `hermes skills install`; 3 SOON-карты → реальный Hub.
- [ ] MCP: при provisioning писать `mcp_servers` в config профиля + OAuth-токен в .env профиля (наш слой = хранение AES-GCM + UI).
- [ ] Мультимодель: при provisioning писать role-слаги в `auxiliary.*` config профиля.
- [ ] Approval: UI «Безопасность» (manual/smart/off) → config профиля; cap-слой кошелька (Postgres) перед подписью, триггер = elicitation. (Кошелёк mainnet — после аудита, OFF.)
- [ ] Каждый под-пункт: typecheck + commit.

---

## Не входит (отдельные треки)
On-chain выплаты mainnet (аудит TON), арт персонажей (видео от основателя), managed-Hermes для НЕ-владельцев агентов как массовый продукт (требует RAM-планирования по Phase-0).
