# TON-ONLY Runbook (прод)

> Полный план: [docs/superpowers/plans/2026-10-07-ton-only-launch.md](../superpowers/plans/2026-10-07-ton-only-launch.md), гейт Go/No-Go — Phase 7.3.
> Разбор зависших платежей: [docs/ops/ton-review-runbook.md](ton-review-runbook.md). Полный список переменных: корневой `.env.example`, секция «TON payments (AG-TON-L)».

## Подъём воркера TON в проде

1. Собрать env воркера (worker-часть секции TON в `.env.example`): `TON_RECONCILIATION_MODE`, `TON_RECONCILIATION_NETWORK=tvm:-3`, `TON_RECONCILIATION_ASSET_KIND=native`, `TON_RECONCILIATION_PROVIDER_ID`, `TON_RECONCILIATION_PROVIDER_ORIGIN`, `TON_RECONCILIATION_VERIFIER_VERSION`, `TON_RECONCILIATION_FINALITY_POLICY_ID` (+ опц. `TONCENTER_API_KEY`, `TON_EVIDENCE_CROSSCHECK=1`). Любое отклонение от констант кода — startup-отказ.
2. Задать `TON_POLICY_TEMPLATE` (включение Gram-витрины): при наличии переменной воркер каждые 60 с пересобирает политику чекаута (подставляя свежий `usdPerTon` из FX-оракула; протухший курс не перештамповывается) и пишет её в `admin_settings` под ключом `ton_checkout_policy` — откуда её читает `/api/ton/*` веб-слоя. Готовый шаблон (recipient заменить на адрес владельца):

   ```json
   {
     "recipient": "0:<ЗАМЕНИТЬ_НА_АДРЕС_ВЛАДЕЛЬЦА>",
     "revision": "credit-v1",
     "finalityPolicyId": "toncenter-v3-testnet-provider-attested-mc-depth-2-v1",
     "verifierVersion": "aiag-toncenter-v3-verifier-v1",
     "packages": [
       { "id": "credit-600", "label": "Стартовый — 600 кредитов", "grantMicrocredits": 600000 },
       { "id": "credit-1200", "label": "Basic — 1 200 кредитов", "grantMicrocredits": 1200000 },
       { "id": "credit-3200", "label": "Starter — 3 200 кредитов", "grantMicrocredits": 3200000 },
       { "id": "credit-10000", "label": "Pro — 10 000 кредитов", "grantMicrocredits": 10000000 }
     ],
     "quoteLifetimeSeconds": 600,
     "maxFxAgeSeconds": 300
   }
   ```

   `grantMicrocredits` — обычные JSON-числа (микрокредиты = кредиты ×1000), воркер сам приводит их к BigInt. `maxFxAgeSeconds=300`, чтобы окно оплаты было реальными ~5 минутами, а не 60 секундами (дефолт билдера).
3. Стартовать в observe: `TON_RECONCILIATION_MODE=observe` → `pm2 restart aiag-worker` (env читается при старте; правки `/srv/aiag/shared/.env` без рестарта не применяются).
4. Проверить здоровье: `curl -s http://127.0.0.1:4001/health` → `{"status":"ok","service":"aiag-worker",...}`.
5. Проверить логи: `pm2 logs aiag-worker` — записи с `component:'ton-reconciliation'` ('TON reconciliation observation'), без `startup_refused`.
6. Перевести в settle (только после Phase 3 плана: миграция 0099 + Task 3.2): БД-роль `aiag_ton_worker` (worker-only, веб-роль settle-прав не имеет) + `TON_RECONCILIATION_MODE=settle` + `TON_SETTLEMENT_CONFIRMATION=I-UNDERSTAND-WORKER-ONLY-SETTLEMENT` → `pm2 restart aiag-worker`. Это двойной гейт: не хватает любого из двух — startup-отказ.

## Как понять, что свип жив

- В логах воркера тик каждые 30 секунд (`POLL_MS=30_000`): регулярные `component:'ton-reconciliation'` записи по каждому source.
- `/health` на `127.0.0.1:4001` отвечает `status: ok`.
- Отсутствие записей > 2 минут при живом `/health` — считать зависанием свипа: собрать лог, `pm2 restart aiag-worker`, при повторе — откат ниже.

## Откат

- Мягкий (без денег): `TON_RECONCILIATION_MODE=observe` → `pm2 restart aiag-worker`. Свип смотрит, ничего не зачисляет.
- Полная остановка контура: `TON_RECONCILIATION_MODE=disabled` → `pm2 restart aiag-worker` (worker стартует, TON-контур молчит).
- Web-часть: убрать/не задавать `TON_WALLET_ENABLED` — все `/api/ton/*` отвечают 503 `TON_WALLET_DISABLED`.

## Чек-лист Go-live (Phase 7.3)

- [ ] Юр-решение 259-ФЗ задокументировано (foreign entity / гео-гейт / решение юриста).
- [ ] Прод-env собран полностью по секции `.env.example`; `TINKOFF_*`/`YOOKASSA_*` отсутствуют (фиат отключён).
- [ ] Воркер под pm2 в `settle` + confirmation + роль `aiag_ton_worker`; `/health:4001` зелёный.
- [ ] Свип тикает (30 с), алерты доходят в Telegram-чат.
- [ ] Оператор прогнал `docs/ops/ton-review-runbook.md` на тестовом кейсе; `/admin/ton` доступен.
- [ ] Mainnet smoke (0.5 TON от кошелька владельца) — settle в ≤2 тика, кредиты на балансе.
