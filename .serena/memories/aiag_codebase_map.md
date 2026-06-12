# AIAG — Карта кодовой базы (где что лежит)

> SoT-канон: `docs/canon/AIAG-CANON.md`. Топология — `docs/ARCHITECTURE.md`. Код-запросы — Serena/graphify (`graphify query "..."`), не grep.

## Сервисы (pm2 на одном Timeweb VPS)
- **`apps/tg-miniapp`** = TMA. Next 14.2.33, порт `:3100`, basePath `/tg`, health `/tg/health`. Прод: `app.ai-aggregator.ru/tg` (через @aiaggbot). НЕ опускать next ниже 14.2.33 (CVE-2025-29927).
- **`apps/agent-worker`** = money-path runner. BullMQ, порт `:3101`. `settleRun` атомарен (markCompleted + daily-spend guard + debit в одном `sql.begin`). Живой агент-рантайм = stateless BullMQ→OpenRouter loop (`src/agent-runner.ts`). ЭТО live billing path — трогать только когда это и есть задача.
- **`packages/api-gateway`** = gateway. Hono/Bun, порт `:4000`, OpenAI-совместимый, white-label, реестр моделей + markup (наценка). Аутентификация agent-worker→gateway по `AIAG_GATEWAY_KEY` (`sk_aiag_live_…`).
- **`apps/web`** = Web-аггрегатор (рубли, RU). Отдельный продукт — не смешивать с TMA.
- nginx фронтит всё; на `/tg` стрипает `x-middleware-subrequest` + `x-tma-user-id`.

## Поток денег (TMA)
TMA → `agent-worker` (BullMQ) → resolveUpstream → gateway `:4000` (AIAG-модель: +markup, debit) ИЛИ свой провайдер юзера (BYOK = 0 charge) → upstream. Правило: AIAG-модель → debit+markup; свой ключ/провайдер → ZERO.

## Данные
- Postgres `aiag` (Timeweb managed) — единый SoT. Ключевые: `tg_user_balances` (TMA spendable, миграция ₽→USD-крипто-кредит), `models` (реестр — сверять слаги!), `agent_*`, `agent_templates`, `gateway_transactions`, `agent_provider_credentials`.
- Redis 7 — BullMQ очереди.

## Деплой (auto, рецепт)
- TMA + agent-worker деплоятся через GitHub Actions:
  `gh workflow run deploy-production.yml --ref BRANCH -f ref=BRANCH -f apps=tma`
- Прод-миграции — РУЧНЫЕ, без трекинга: `sudo -u postgres psql aiag` для ALTER (app-юзер `aiag` не может ALTER). Применять миграцию ДО деплоя кода.
- Repo-split: `agent-market` (приватный, https://github.com/massmindmaker/agent-market) — канонный путь TMA, деплоит автоматом. Монорепо-tma-leg ещё активен (overlap) — не депрекейтить без основателя.
- Полный рецепт релиза — скилл `aiag-deploy`.
- Рабочая ветка: `feat/r1.0-wave0-consolidated`. Master — для PR.
