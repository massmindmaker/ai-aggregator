# Спека: нативная интеграция идей OmniRoute в наш gateway

> 2026-08-22 · Ветка `feat/native-egress-integration` (от feat/r2-readiness) · Решение основателя: V3 «нативная пересборка», без sidecar, автономно до конца.
> Источник идей: OmniRoute v3.8.50 (MIT, diegosouzapw) — клон-анализ от 2026-08-22; переносимые фрагменты — только чистые функции с атрибуцией в THIRD_PARTY_NOTICES.md.

## 1. Проблема и цель

Продукт-блокер №1: апстримы банят РФ-IP → чат/playground/API мертвы из РФ («без VPN» на лендинге = ложь). Плюс: нет failover (упал апстрим → 502) и каталог растёт только руками. Цель — три подсистемы в НАШЕМ Hono/Bun-gateway, своим кодом, по проверенным дизайнам OmniRoute:

| Фаза | Что | Результат |
|---|---|---|
| P1 | Egress-прокси слой | Трафик к забаненным апстримам уходит через прокси (SOCKS5/HTTP-CONNECT); продукт оживает из РФ |
| P2 | Failover + circuit breaker | Упорядоченные кандидаты апстрима; открытый breaker исключает провайдера временно |
| P3 | Каталог-sync models.dev | Ежедневный sync → черновики → approve админом → витрина растёт без редеплоя |

## 2. Решения дизайна

1. **Прокси — свой клиент на `node:net`** (Bun совместим), НЕ undici-dispatcher (Bun.fetch его не принимает): SOCKS5 (RFC 1928: greeting, no-auth/user-pass, CONNECT) + HTTP CONNECT для http-прокси; TLS-апгрейд поверх туннеля штатным TLS-стеком рантайма.
2. **Конфигурация двухуровневая**: колонка `model_upstreams.egress_proxy TEXT NULL` (per-upstream) ← fallback env `AIAG_EGRESS_PROXY_URL` (global, пусто = прямое подключение как сейчас). Реестр/ротация/скоупы OmniRoute (proxy_registry+assignments) — YAGNI сейчас, схема колонки допускает эволюцию.
3. **SSRF-гарды сохраняются**: allowlist хостов применяется к конечному назначению независимо от прокси; прокси-хост валидируется тем же normalizeProxyUrl (портрет функции переносим из OmniRoute с атрибуцией).
4. **Breaker**: состояния CLOSED/OPEN/HALF_OPEN (+DEGRADED опционально позже); пороги по классам ошибок (`rate_limit|quota_exhausted|transient` — regex-классификатор classify429 переносим); cooldown экспоненциально ×2 cap ×16; персист в Postgres `circuit_breakers(upstream_id PK, state, failures, last_failure_at, opened_until)` + in-memory кэш. Ключ = upstream_id.
5. **Failover**: резолвер возвращает упорядоченный список кандидатов (новая колонка `model_upstreams.priority INT NOT NULL DEFAULT 100`, меньше = раньше); цикл попыток ≤ N=3 с учётом breaker (open→skip, half_open→одна проба); биллинг не меняется — списание по ФАКТИЧЕСКИ использованному upstream (settle получает выбранный upstream_id; заголовок x-aiag-upstream уже есть).
6. **Каталог**: cron в apps/worker (раз/сутки, env-флаг) тянет `https://models.dev/api.json` → нормализация (transform переносим) → таблица `model_catalog_drafts` (raw JSONB + нормализованные поля) → админ-endpoint `/api/admin/catalog/{diff,apply}` применяет ТОЛЬКО одобренное; наши ручные записи всегда сильнее (merge-слои: manual > synced > ничего). Цены models.dev = $/1M токенов → приводим к нашим центам за 1M (×100) при apply.
7. **Роллаут без риска**: нет env/колонки → поведение идентично текущему; все миграции идемпотентны; prod-VPS с реальным прокси — отдельное действие основателя (не входит).
8. **Не делаем**: ротация пула, TLS-spoofing, free-tier ферма, Quota-Share (ToS-серые/ненужные), MITM, edge-relay типы.

## 3. Переносимый код (MIT, с атрибуцией)

| Из OmniRoute | Куда | Как |
|---|---|---|
| `normalizeProxyUrl`, `extractExplicitPort` (open-sse/utils/proxyDispatcher.ts) | packages/api-gateway/src/proxy/url.ts | дословно + заголовок-атрибуция |
| `classify429.ts` | src/proxy/../failover/classify.ts | дословно |
| transform models.dev (modelsDevSync/transform.ts) | apps/worker/src/catalog/transform.ts | адаптация типов под Drizzle |
| Дизайн breaker-переходов и cooldownByKind | src/failover/breaker.ts | своя реализация по мотивам |

## 4. Критерии приёмки

- [ ] `AIAG_EGRESS_PROXY_URL=socks5://…` + модель с апстримом openrouter → запрос уходит через туннель (тест с локальным mock-SOCKS5 фиксирует факт CONNECT к назначению); без env — поведение байт-в-байт прежнее (все существующие тесты зелёные).
- [ ] Unit: url-normalize (таблица кейсов), socks-handshake (no-auth/userpass/отказ), breaker-переходы (закрыть→открыть→half-open→закрыть; cooldown-удвоение), classify429 (5 паттернов провайдеров), transform models.dev (golden-sample).
- [ ] Failover: первый upstream 500 → второй отвечает → settle по второму; оба мертвы → честная 502; breaker открылся после порога и пропускает upstream N минут.
- [ ] Каталог: dry-run diff показывает добавления/изменения; apply создаёт только approved; повторный sync не дублирует; ручная правка модели не перетирается.
- [ ] `bun test` в api-gateway и worker зелёный; lint чистый; THIRD_PARTY_NOTICES.md содержит MIT-нотисы перенесённых функций.
- [ ] Ни одного изменения контракта D-0 заголовков и white-label поведения (регрессионные тесты проходят).

## 5. Границы

Prod-деплой прокси-сервера (NL VPS, 3proxy/wireguard), наполнение env на проде, включение cron-флага — вне спеки (действия основателя после приёмки). UI-админку прокси не строим (env+SQL достаточно).

## 6. Решение ревью 2026-08-23: SSE через egress-прокси — ЧЕСТНЫЙ ЗАПРЕТ

**Контекст.** Проксированный egress (T1/T2) исполняет запросы raw HTTP/1.1 над туннельным сокетом и возвращает ПОЛНОСТЬЮ БУФЕРИЗОВАННЫЙ Response (см. JSDoc `packages/shared/src/safe-fetch.ts` и `packages/api-gateway/src/proxy/index.ts`). Значит `stream:true` через прокси физически деградирует: клиент получил бы «поток» из одного чанка в конце генерации — фейковый SSE.

**Рассматривались два варианта:**
1. Стриминг из туннельного сокета — честный SSE через прокси, но требует переписать executor на потоковый парсер + перенести SSRF-ревью ядра; большой риск для money-path-соседнего кода.
2. Честный запрет — проксированный стрим отклоняется типизированной ошибкой до открытия туннеля.

**Выбран вариант 2 (запрет)** — минимальный дифф, fail-loud, нулевой риск для биллинга и SSRF-гардов. Потоковая передача через прокси — отдельная будущая задача, если/когда egress-прокси станет нужен на chat-апстримах с stream:true.

**Механика:** адаптеры помечают SSE-запросы флагом `sse:true` в init `fetchUpstream`; если resolveEgressProxy вернул прокси (колонка или env) — бросается `StreamNotSupportedError` (`400 STREAM_NOT_SUPPORTED`, brand-neutral, детали без кредов прокси), executor не вызывается. Прямой egress (`direct`) не затронут — там стриминг настоящий через global fetch.
