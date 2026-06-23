# R2-readiness — план деплоя + статус (2026-06-23)

Ветка `feat/r2-readiness` (off `feat/r1.0-wave0-consolidated`), запушена. Оба typecheck (tg-miniapp + agent-worker) зелёные. НЕ на проде — ждёт founder-go.

## ✅ Сделано на ветке (закоммичено)
- **Волна-1 P0 security:** SSRF probe→safeFetch · transfer-вебхук fail-hard 503 · enqueue-провал→mark failed+503 · run pre-check баланса 402 (AIAG-путь)
- **Волна-1 UI/мобайл:** viewport-fit=cover (safe-area ожил) · бюджет ×100 на дэшборде · disableVerticalSwipes · единицы бюджета при создании
- **Анимации приложения:** переходы между экранами (View Transitions+CSS) · скелетоны на мёртвых окнах · stagger-вход · нативный BackButton+haptics · sticky-композер+safe-area
- **Волна-2 safe:** расписание-вкладка read-only · transfer status-поллинг · app-level rate-limit (Redis, fail-open)
- **JWT live-revocation:** @upstash/redis denylist · middleware-проверка · logout-роут · мягкая деградация без env
- **Наём=подписка (merge ветки hire):** agent_sessions + изоляция памяти per-(agent,hirer) · кнопка Нанять/UI · AI-builder из слов · аренда-помесячно
- **Free-first-run:** грант 300 кр новичку при входе, идемпотентно (md5(id)::uuid+uq_ledger_ref)

## ⚠️ ПЕРЕД деплоем (по порядку)
1. **Мигрaции к проду ВРУЧНУЮ** (`sudo -u postgres psql aiag`): `0040_hire_sessions_memory_scope.sql` (⚠️ PK-своп на живой `agent_memory` — аккуратно, бэкап), затем `0041_rental_subscriptions.sql`. (free-run миграции НЕ требует.)
2. **Env в `/srv/aiag/shared/.env`:**
   - ⚠️ **`TRANSFER_WEBHOOK_SECRET` ДОЛЖЕН быть задан** — вебхук теперь fail-hard (503 если пусто) → иначе передача агента сломается. Проверить что стоит (был shared-токен в callbackUrl).
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (для JWT-отзыва; без них вход работает, отзыв выключен).
   - `FREE_FIRST_RUN_CREDITS` (опц., дефолт 30000=300кр; 0=выкл).
3. **`bun install`** в `apps/tg-miniapp` на VPS (новый `@upstash/redis`) перед сборкой.
4. **Сборка tma + agent-worker** на VPS (вручную, по `aiag-deploy`), pm2 restart.
5. **E2E проверки на проде:** наём чужого агента 2-м ТГ-акком → изоляция памяти (наниматель НЕ видит память владельца) · free-run грант начислился раз · rate-limit (429 при флуде) · transfer-поллинг показывает результат · pre-check 402 при нуле.

## 🔴 Крупное, что осталось (нужны решения/инфра — НЕ закрыто)
- **Мультимодель per-role** (XL) — подтвердить объём (текст/картинка/голос/зрение раздельно).
- **USDT-on-TON пополнение + on-chain выплаты авторам** — нужен `@ton/ton` + аудит TON-контрактов перед боевыми деньгами (R&D-синтез 2026-06-13).
- **Арт персонажей** (character-card) — нужны видео/лица от основателя (2 видео получены, ждём маппинг + остальных).
- **Margin-leak реконсилятор** (1.10) — сверка леджеров gateway↔credits (ops/мониторинг).

## Что НЕ трогали (прочно)
settleRun атомарный дебет+наценка+daily-guard, BYOK=0, ton-proof, реконсилер пополнений, MCP+OAuth, transfer-iNFT минт, D-0/D-1.
