# Product-Readiness Review — 2026-08-23 (два прохода: пути/оплата · админ/workflow · безопасность)

> Репо `aggregator/core`, `feat/r2-readiness` @ c4856ed. Метод: 3 параллельных аудита кода (плательщик, админ+workflow, security-дельта) + синтез. Предыдущие: аудит 3-го круга 2026-07-17 (11 P0), ревью egress-интеграции 103/108.

## 1. Что уже работает e2e (проверено по коду)

Приём ₽: топап форма→pending→вебхук (fail-closed secret, HMAC, guarded idempotent UPDATE + UNIQUE(payment_id,type))→users.balance+= и R1a-мост org payg_credits+= · Подписка бэкенд: /api/subscriptions/create живой (Init Tinkoff, yearly ×12), вебхук активирует тир и грантит subscription_credits · Списание: preflight-402 → settle атомарный · Биллинг-сводка ЛК: реальные данные · Админка web: users/orgs/upstreams/routing/models/refunds/payouts/KYC/contests/webhooks/jobs — живые, двойной гейт · Воркер: close-contests + finalize-earnings реально пишут · Egress/failover/catalog-sync: код смержен, ждут деплоя/env.

## 2. Блокеры «рабочего продукта» (приоритет)

| # | Блокер | Суть | Чинимость |
|---|---|---|---|
| B1 | 🔴 **Подписка не покупается с фронта** | `/dashboard/billing?upgrade=X` параметр игнорирует; handleSubscribe = мёртвый код. Бэкенд цел | S: читать searchParams → звать POST /api/subscriptions/create |
| B2 | 🔴 **gateway_requests никто не пишет** | usage-страница/счётчики вечно 0 при реальных тратах → недоверие к биллингу | M: писать строку в settle-пути (или consumer requests:log) |
| B3 | 🔴 **Рефанд без клэука кредитов** | админ вернул деньги — org оставил кредиты → бесплатное пользование | S: клэук в refund-route/webhook |
| B4 | 🟠 **Стрим-биллинг = 0** | chatStream без `include_usage` → input-токены не считаются, stream:true фактически бесплатен | S: одна строка × 3 апстрима + fallback-оценка |
| B5 | 🟠 **Free-grant $300/аккаунт (TMA)** | FREE_GRANT_CREDITS=30000 микро? нет — 30000 кредитов = $300; сибил-ферминг | XS: снизить до $1–5 + env |
| B6 | 🟠 **Юрблокер** | ОГРНИП 0000000000 в оферте/terms/privacy при живом эквайринге; welcome-кредитов нет при «попробовать» | основатель + S-фиксы текстов |
| B7 | 🟠 Payout TOCTOU | double-payout при конкуренции (спящий до включения выплат) | S: FOR UPDATE/advisory lock |
| B8 | 🟡 creditsUsed никогда не растёт · batches принимает оплату без consumer (отключить/501) · кап сессии юнит×10⁶ · OAuth-обход бана · iNFT статический секрет · email-send/contest-eval/upstream-poll sinks-заглушки · probe без алерта · Sentry/uptime отсутствуют · каталог apply/diff без UI (curl-only) · egress-proxy поле не редактируется из /admin/upstreams |

## 3. Деплой-чеклист выката feat/r2-readiness

1. Миграции **0062→0065 вручную ДО деплоя** (`sudo -u postgres psql aiag`).
2. `/srv/aiag/shared/.env`: **AIAG_ADMIN_KEY** (без него gateway-admin мёртв fail-closed) · опц. `AIAG_EGRESS_PROXY_URL`, `MODELS_DEV_SYNC=on`, `AIAG_ADMIN_RATE_LIMIT`.
3. `gh workflow run deploy-production.yml --ref feat/r2-readiness -f apps=web,gateway,worker`.
4. Smoke: `/api/admin/catalog/diff` с bearer · pm2 health · /admin/worker.

## 4. Оценки

Продукт web (маркет+модели): ядро денег продакшен-качества, витрина наполовину декоративна — **композит ≈ 68/108** (работа 60 · бизнес 62 · финмодель-учёт 55 · дизайн 76 · честность 50 после фиксов июля). Инфраструктура наблюдаемости: 4/9.

## 5. Дорожная карта до «рабочего продукта» (предложение)

Волна 1 (S, 1 день): B1 чекаут-фронт + B5 free-grant + тексты ОГРНИП-заглушки убрать до получения реальных реквизитов («уточняются», не нули).
Волна 2 (M, 1–2 дня): B2 writer gateway_requests + B3 клэук рефандов + B4 include_usage + batches→501.
Волна 3: payout FOR UPDATE · OAuth ban-check · кап-юнит · UI approve каталога · алерты probe/Sentry.
Параллельно (основатель): NL-VPS прокси → env → деплой по чеклисту §3; юрреквизиты кооператива.
