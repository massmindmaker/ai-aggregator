# Восстановление разработки после обрыва — 7 сентября 2026

## Проверенное размещение

Проверено read-only около 10:24–10:28 МСК. `https://ai-aggregator.ru` и `https://app.ai-aggregator.ru/tg` вернули HTTP200. В браузере Aggregator отрисовал публичную главную, TMA перенаправила на `/tg/agents` и показала требование Telegram initData. Это подтверждает доступность UI, но не оплату, inference, запуск агента или готовность актуального локального кода. Обе страницы открыты в приложении.

Через существующий SSH alias `aiag-vps`, прежний ключ и строгую проверку known host прочитаны service metadata и Nginx routes. Старый ProxyCommand использует отсутствующую команду `connect`; одноразовый `ProxyCommand=none` позволил соединиться напрямую. Глобальная SSH-конфигурация не менялась.

| Сервис | Развёрнутый release | Наблюдение |
|---|---|---|
| Aggregator Web | `20260823T203722Z-eac8ae0` | Рабочий listener3000 принадлежит `pm2-aiag.service`; дубликат в root PM2 получает EADDRINUSE |
| Gateway | `20260717T084543Z-d16cc39` | root PM2 online, listener4000 |
| Aggregator worker | `20260511T064003Z-e1e56d3` | Рабочий listener4001 принадлежит `pm2-aiag.service`; дубликат root PM2 циклически перезапускается |
| TMA | `20260712T195933Z-5e9212f` | root PM2 online, listener3100 |
| Agent worker | `20260717T070658Z-5255d81` | root PM2 online, listener3101 |

Активны одновременно `pm2-aiag.service` и `pm2-root.service`. Счётчики root Web/worker за проверку выросли с86/76 до101/89, в последних логах обеих служб есть EADDRINUSE. Нельзя просто останавливать весь root PM2: он также владеет gateway, TMA и agent-worker. Перед эксплуатационным исправлением требуется зафиксировать единственного владельца каждого сервиса, проверить именно дубликаты и сохранённые startup manifests. Никакие процессы, systemd/PM2-конфиги, данные, миграции или боевые releases этой проверкой не изменялись.

Дополнительно: gateway `/health` вернул HTTP200 с `ok: true`; реальный inference не вызывался. Анонимный GET `https://app.ai-aggregator.ru/tg/api/tma/templates` вернул401. Новый локальный Web ожидает публичный list/detail контракт, поэтому перед полезным preview необходимо выпустить совместимый API; простое подключение к нынешнему VPS приводит к состоянию unavailable.

Отдельного Agents Market Web процесса в проверенных пяти PM2 services и отдельного Web route в Nginx не найдено. Это ограниченное доказательство конфигурации данного VPS, а не утверждение об отсутствии другого внешнего размещения. Локальный `agents-market/apps/web` содержит public catalog/detail, но полноценные Web auth/workspace/run/author/billing ещё не реализованы. TMA вне Telegram не заменяет такой Web.

## Точка продолжения

- Aggregator: последний принятый продуктовый этап `1c25d0f` — admission wrapper. Подключение к исполнению, точные квоты, receipts/reconciliation и RUB grant/refund activation остаются впереди.
- Arena: `d4174fb` восстановил карточки; `a7d976f` исправил stale intersection callback. Следующая проверка нашла слишком широкий focused scenario allowlist и document.body observer; исправление и окончательная приёмка продолжаются. Ни старый browser PASS, ни новый unit PASS не заменяют новый guarded browser run.
- Agents Market: отдельный Web существует как витрина; собственная исполняемая схема и native Web identity ещё не готовы. [Own-DB plan](/home/bob/Projects/agents-market/docs/superpowers/plans/2026-09-07-own-database.md) — ближайший обязательный шаг.

Пользователь прямо подтвердил TON-контуры всех трёх продуктов и сохранение RUB в Aggregator. Решения/исследования обновляются отдельно; любые плановые возможности остаются незавершёнными до реализации и приёмки. Возможное размещение AM Web на Vercel рассматривается отдельно от действующих TMA/API/worker на VPS; нового deploy пока не создано.

## Локальное тестовое окружение

После обрыва прежние `/tmp/ai-ecosystem-*` runtime/credentials отсутствовали, локальные PostgreSQL и Redis не слушали тестовые порты. Восстановлены только disposable local PostgreSQL16.14 (npm `@embedded-postgres/linux-x64@16.14.0-beta.17`), Redis8.0.5 (Ubuntu packages, распакованы без системной установки) и Bun1.4.2 (официальный npm binary, integrity проверена).

Инструменты и новый cluster находятся в `/home/bob/.cache/ai-ecosystem-test-runtime`. Новый файл тестовых credentials имеет mode0600; старые production `.env` не копировались. Созданы отдельные `ai_aggregator_test`, `ai_arena_test`, `agents_market_test` на loopback15432; Redis loopback16379 без persistence. Новый helper `run` сохраняет для Arena отличающуюся parent DB identity и native direct/HTTP marker/token guards. Bootstrap marker и orchestrator должны получать один и тот же generated environment. Сам факт создания пустых DB ещё не доказывает migrations/native tests.

[Статус памяти](MEMORY-STATUS.md) и [рабочая карта](DEVELOPMENT-WORKFLOW.md) содержат актуальное разделение Graphify/Serena, LightRAG, Memory Graph, Brain и Codex. Локальный индекс не равен подключению MCP; неуспешная авторизация не считается синхронизацией.
