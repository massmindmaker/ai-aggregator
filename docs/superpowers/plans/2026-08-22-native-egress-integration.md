# Native Egress Integration — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Спека: docs/superpowers/specs/2026-08-22-native-egress-integration-design.md
> Репо: C:\Users\боб\projects\aggregator\core, ветка feat/native-egress-integration.
> Пакеты: packages/api-gateway (Hono/Bun), packages/database (Drizzle), apps/worker.

## Task T1: Прокси-ядро + safeFetch интеграция

Files:
- Create: packages/api-gateway/src/proxy/url.ts (порт normalizeProxyUrl/extractExplicitPort из OmniRoute open-sse/utils/proxyDispatcher.ts, с MIT-атрибуцией)
- Create: packages/api-gateway/src/proxy/socks.ts (SOCKS5 клиент: greeting 05, методы 00/02, CONNECT к host:port; на node:net/tls)
- Create: packages/api-gateway/src/proxy/httpConnect.ts (HTTP CONNECT туннель)
- Create: packages/api-gateway/src/proxy/index.ts (export fetchViaProxy(url, init, proxyUrl): Promise<Response>; парс proxy_url схем socks5://[user:pass@]host:port | http://…)
- Modify: packages/shared/src/safe-fetch.ts — добавить опциональный opts.egressProxyUrl; при заданном — туннель через proxy/index.ts с СОХРАНЕНИЕМ allowlist/pin проверок конечного хоста
- Test: packages/api-gateway/src/__tests__/proxy.test.ts

Steps:
- [ ] url.ts: функции + таблица тестов normalize (дефолтные порты 80/443 сохраняются, схемы, user:pass)
- [ ] socks.ts: handshake по RFC1928 (greeting→method→connect→reply 00 success), чтение BND.ADDR; ошибки = throw с кодом reply
- [ ] httpConnect.ts: отправка CONNECT host:port HTTP/1.1, обработка 200/ошибок
- [ ] fetchViaProxy: открыть сокет через туннель → TLS-upgrade → выполнить запрос как в существующем пути safeFetch (переиспользовать его проверки); таймауты наследуются
- [ ] safe-fetch: opts.egressProxyUrl прокидывается; БЕЗ него поведение прежнее (регресс: все старые тесты зелёные)
- [ ] Тесты: mock SOCKS5-сервер в тесте (node:net) принимает handshake и CONNECT → фейковый HTTP ответ проходит; userpass-auth путь; отказ метода → ошибка; normalize-таблица
- [ ] Commit: feat(proxy): egress tunnel core - socks5/http-connect + safeFetch hook

## Task T2: Конфигурация per-upstream + админ-проверка

Files:
- Modify: packages/database/migrations/00NN_upstream_egress_proxy.sql (идемпотентно: ALTER model_upstreams ADD COLUMN IF NOT EXISTS egress_proxy TEXT; COMMENT)
- Modify: packages/api-gateway/src/upstreams/*.ts и routing/resolver.ts — резолв egress: колонка upstream → env AIAG_EGRESS_PROXY_URL → null; передаётся в safeFetch вызовы апстримов
- Create: packages/api-gateway/src/routes/admin/proxyTest.ts (GET /api/admin/proxy/test?url=… — echo-ip через заданный прокси, только admin-guard)
- Test: resolver precedence unit-test

Steps:
- [ ] Миграция (номер взять следующий за максимальным в packages/database/migrations)
- [ ] Резолвер приоритета upstream-col > env > direct; лог выбора
- [ ] Все адаптеры получают прокси автоматически через общий fetch-хелпер (не дублировать в каждом)
- [ ] Админ-route: без ключа админа → 403; с ним → JSON {via: proxy|direct, ip}
- [ ] Тесты: precedence, route guard
- [ ] Commit: feat(proxy): per-upstream egress config + admin echo test

## Task T3: Failover + circuit breaker

Files:
- Modify: миграция: ALTER model_upstreams ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100
- Create: packages/database/migrations/00NN_circuit_breakers.sql (upstream_id PK, state TEXT CHECK closed/open/half_open, failures INT, last_failure_at, opened_until)
- Create: packages/api-gateway/src/failover/classify.ts (порт classify429 из OmniRoute src/shared/utils/classify429.ts, атрибуция)
- Create: packages/api-gateway/src/failover/breaker.ts (in-memory Map<upstream_id,state> + персист Postgres; пороги: transient×5→open 30s; rate_limit→cooldown из classify; экспонента ×2 cap ×16; half_open допускает 1 пробу)
- Modify: routing/resolver.ts — возвращать УПОРЯДОЧЕННЫЙ список кандидатов (ORDER BY priority, id)
- Modify: роуты v1/chat+completions+embeddings+images+video+audio — цикл попыток ≤3: breaker-check → попытка → успех=settle по фактическому upstream_id (уже параметр settle) → выход; классифицированный провал → breaker.recordFailure → следующий кандидат; все мертвы → 502 нейтральный
- Test: failover.test.ts

Steps:
- [ ] classify: regex-паттерны rate_limit/quota_exhausted/transient (5 провайдеров из оригинала)
- [ ] breaker: переходы covered юнитами: closed→open(порог)→half_open(после cooldown)→closed(успех)/open(провал); удвоение cooldown
- [ ] Resolver ordered list + регресс существующих тестов роутинга
- [ ] Интеграция в 7 биллинг-роутах минимальным хелпером executeWithFailover(candidates, fn)
- [ ] Тест: первый кандидат 500 → второй 200 → settle второго; оба падают → 502; после порога breaker skip
- [ ] Commit: feat(failover): ordered candidates + circuit breaker persisted

## Task T4: Каталог models.dev → черновики → apply

Files:
- Create: миграция model_catalog_drafts (id, provider_slug, model_slug UNIQUE(provider,model), raw JSONB, normalized JSONB, status draft/applied/rejected, synced_at)
- Create: apps/worker/src/catalog/transform.ts (адаптация transformModelsDev из OmniRoute: цены $/1M → центы×100, capabilities, context)
- Create: apps/worker/src/catalog/syncJob.ts (cron/env-флаг MODELS_DEV_SYNC=on; fetch api.json; upsert drafts status=draft ON CONFLICT обновление)
- Create: routes admin /api/admin/catalog/diff (список new/changed vs models) и /apply (только approved список из body)
- Test: transform golden-sample + diff логика

Steps:
- [ ] Миграция + индексы
- [ ] Transform + golden тест на зафиксированном срезе api.json (fixture в tests/fixtures/modelsdev-sample.json ≤50KB)
- [ ] Sync job: идемпотентный upsert, ретраи 3 exp-backoff, лог итогов
- [ ] Diff endpoint: сравнение drafts vs models (new/price-changed/capability-changed)
- [ ] Apply: принимает массив id черновиков; ручные записи моделей НЕ перетирает (merge: manual поля сильнее)
- [ ] Commit: feat(catalog): models.dev sync to drafts + admin diff/apply

## Task T5: Атрибуция, доки, полный прогон

- [ ] THIRD_PARTY_NOTICES.md в корне репо: MIT-нотис OmniRoute (c) diegosouzapw + перечень перенесённых функций с путями
- [ ] CLAUDE.md: строка об egress/failover/catalog подсистемах
- [ ] Полный прогон: bun test в api-gateway, worker; lint; регресс D-0 контрактных тестов обязателен зелёным
- [ ] Commit: docs: attribution + architecture notes
- [ ] Push ветки origin

## Приёмка (= §4 спеки)
Все чекбоксы спеки; финальное независимое ревью субагентом (спек-комплаенс + качество) до push.
