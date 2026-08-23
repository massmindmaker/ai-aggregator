# AIAG сессия 2026-08-22/23 — suite-reorg + egress-интеграция + product-readiness

## Состояние репо
- Канон: `aggregator/core` (suite-реорганизация), ветка `feat/r2-readiness` @ c4856ed. Master заморожен.
- Зеркала GitHub (ai-aggregator-web, agent-market) и перенос aiag-web в _archive — НЕ доделаны: ждали gh-токен (теперь gh подключен как massmindmaker) и перезапуск сессии (лок aiag-web).
- Дашборд 11 зон; отчёт готовности: docs/superpowers/specs/2026-08-23-product-readiness-review.md.

## Egress-интеграция идей OmniRoute (СМЕРЖЕНО ad8ec70+c4856ed)
- P1 прокси: SOCKS5/CONNECT туннели `api-gateway/src/proxy/*`, per-upstream колонка model_upstreams.egress_proxy > env AIAG_EGRESS_PROXY_URL > direct (миграция 0062). SSRF-гарды ДО туннеля.
- P2 failover: routing/failover.ts executeWithFailover ≤3 попыток, breaker closed/open/half_open персист БД (0064), classify429 перенесён дословно из OmniRoute (MIT). BYOK = passthrough.
- P3 каталог: worker catalog/sync-cron (env MODELS_DEV_SYNC=on) → model_catalog_drafts (0065) → /api/admin/catalog/{diff,apply}; apply tx-ный, новые модели enabled=false.
- Админка gateway: requireAdminKey (AIAG_ADMIN_KEY fail-closed) + rate-limit 30/min/IP (AIAG_ADMIN_RATE_LIMIT=off выключает).
- Атрибуция MIT: THIRD_PARTY_NOTICES.md. Тесты gateway 214/0.
- ⚠️ SSE через прокси-путь честно отказывает (STREAM_NOT_SUPPORTED) — passthrough не сделан (P1-хвост).

## Product-readiness (аудит 2026-08-23): композит ≈68/108 — beta
🔴 B1 подписка не покупается с фронта (/dashboard/billing игнорирует ?upgrade=, бэкенд цел)
🔴 B2 gateway_requests никто не пишет → usage вечно нули
🔴 B3 рефанд без клэука кредитов
🟠 стрим-биллинг=0 (нет stream_options include_usage у openrouter/groq/gonka)
🟠 free-grant TMA = $300/аккаунт (сибил), ОГРНИП 0000000000 при живом эквайринге, payout TOCTOU, creditsUsed не растёт, batches принимает оплату без consumer, email-send/contest-eval/upstream-poll sinks-заглушки, probe без алерта, Sentry/uptime нет, каталог approve curl-only.

## Деплой-чеклист feat/r2-readiness
0062→0065 миграции ВРУЧНУЮ до деплоя → /srv/aiag/shared/.env задать AIAG_ADMIN_KEY (без него gateway-admin мёртв) → gh workflow run deploy-production.yml --ref feat/r2-readiness -f apps=web,gateway,worker.

## Уроки
- PowerShell: `c.header()` в Hono = сеттер ответа; читать запрос = `c.req.header()`.
- git cat-file -e HEAD:<path> по $LASTEXITCODE — единственный надёжный existence-check; пути со скобками [] () только -LiteralPath.
- Субагенты-исполнители виснут на длинных промптах — инлайн надёжнее; ревьюеры работают.
- bun test: зависшие дочерние процессы eval-runner не дают процессу выйти.
