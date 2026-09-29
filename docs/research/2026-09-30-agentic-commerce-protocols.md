# Research: agentic commerce для цикла Arena → Aggregator → Agents Market

Дата среза: 30.09.2026. Источник: web research + чтение локального кода
(`apps/tma/src/lib/mcp-oauth.ts`, `hermes-client.ts`, `docs/ecosystem/payment-and-evidence-design.md`).
Статус: выводы для решения владельца, не принятая архитектура и не приёмка.

## Ключевой вывод

**Автономный платёж агента без участия человека возможен только крипто-рельсом с
программным кошельком агента.** Все карточные протоколы (AP2, ACP, Visa, Mastercard)
требуют человека хотя бы один раз — они про делегирование покупки, а не про M2M
pay-per-call. Это отсекает большую часть «агентных платежей» как зарубежную экосистему.

Второй по важности вывод: **схема mandate-констрейнтов из Google AP2 стоит взять
независимо от рельса.** Budget, amount_range, allowed_payees, recurrence — ровно те
ограничения, которых не хватает для runaway-spend, и они не привязаны к Visa.

## Сравнение протоколов

| Протокол | Кто платит | Инфраструктура продавца | Статус 09.2026 | Применимость AM→AG |
|---|---|---|---|---|
| x402 v2 (Coinbase → x402 Foundation) | агент; USDC/EURC (EIP-3009) или ERC-20 через Permit2 на Base/Polygon/Arbitrum/Solana | facilitator (CDP: 1000 tx/мес free, далее ~$0.001/tx; либо self-host) | v2 11.12.2025; 69k агентов, 165M tx, $50M объёма; встроен в AWS Bedrock AgentCore | **высокая** — ровно наш кейс pay-per-call без аккаунтов. TON не поддержан |
| AP2 (Google → FIDO Alliance) | человек делегирует агенту права, подписанные Mandates (SD-JWT) | Trusted Surface, Credential Provider, банки-партнёры | v0.2, 120+ партнёров, первые live-транзакции в ЕС | низкая как рельс; **высокая как источник схемы лимитов** |
| ACP (Stripe/OpenAI/Meta) | человек, Stripe-токены | Stripe-аккаунт | Instant Checkout свёрнут в 2026, ушёл к Visa | нет — ритейл |
| UCP (Google/Shopify, 01.2026) | merchant of record | публикация `/.well-known/ucp` | rolling adoption, поверх A2A/MCP/AP2 | нет для платежей; полезен паттерн discovery-манифеста |
| Visa Intelligent Commerce / Mastercard AP4M | человек, токенизированные карты | зависит от issuer | Visa×OpenAI 06.2026; AP4M (M2M sub-cent) с Coinbase/Stripe | нет v1 — фиат-рельсы и юрисдикционный риск |
| Coinbase Agentic Wallet MCP | агент; embedded wallet USDC, газ спонсирован | почти нет (`npx @coinbase/payments-mcp`) | продакшн | средняя — референс и готовый прототип agentic spend |

## A2A / MCP / Hermes — что уже есть локально

- **MCP 2026-07-28 ratified**: stateless core (без `initialize`/`Mcp-Session-Id`),
  заголовки `Mcp-Method`/`Mcp-Name` для gateway-routing, OAuth 2.1 + PKCE, CIMD вместо DCR.
  Сломана совместимость с ранними версиями — вшивать в ядро нельзя, только адаптерами.
- **У нас уже реализовано** в `agents-market/apps/tma/src/lib/mcp-oauth.ts`: OAuth 2.1
  с PKCE S256, RFC 9728/8414/8707, SSRF-защита, AES-256-GCM at rest — написано против
  ревизии 2025-06-18, то есть **отстаёт от ratified-спеки** и требует апдейта.
- **В `~/.hermes/config.yaml`** подключено ~10 MCP-серверов (avito, lightrag, playwright и др.).
- **A2A v1.0** (Linux Foundation → AAIF, 03.2026): стабильная спека, Signed Agent Cards,
  150+ организаций, 5 SDK. Внутри нашего цикла worker→AG не нужен: это протокол
  делегирования задач, а не покупки per-call. Второй транспорт для x402 — спека разрешает.
- **Hermes** даёт: изолированные субагенты, skills, persistent memory, MCP-клиент, cron,
  7 terminal backends (local/Docker/SSH/Daytona/Modal/Singularity/Vercel Sandbox),
  command approval + контейнерная изоляция, bot mode, `/docs/llms.txt`.
  Встроенного платёжного примитива у Hermes **нет** — это наш слой поверх
  (MCP-сервер «оплати вызов», аналог `@coinbase/payments-mcp`).
- В AM уже есть `hermes-client.ts` (OpenAI-совместимый, изоляция через
  `X-Hermes-Session-Key`) — managed provisioning может опираться на существующий коннектор.

## Что берём (в порядке)

1. **HTTP 402-ответ в AG API** — чтобы клиент получал машинно-читаемый отказ с цитатой
   и мог оплатить без нашего SDK. Не трогает ledger, поэтому не зависит от TON-инвариантов.
   Уже зафиксировано в плане AM-W1: «агент корректно получает 402 без bypass».
2. **Constrain-схема из AP2** как дизайн лимитов агентского кошелька
   (budget / amount_range / allowed_payees / recurrence). Только дизайн, усилия малые.
3. **Facilitator = CDP** для preview (1000 tx/мес бесплатно), self-host — план Б.
   Свой settlement не писать.
4. **Выставить AG inference как MCP-сервер** по ratified stateless-спеке — совместимость
   с любым MCP-клиентом (включая Hermes и Claude) сразу, без отдельного SDK.
5. **x402 как внешний протокол** для будущих сторонних агентов-покупателей. Не раньше,
   чем закроются денежные инварианты.
6. **A2A v1.0** — отложить до v2, не блокер.

## Что отвергаем

- AP2/ACP/UCP/Visa/Mastercard как платёжный рельс — human-in-the-loop, нет per-call M2M.
- Свой A2A-сервер в v1 — решает чужую задачу при одном внутреннем цикле.
- TON-x402 мост «сейчас» — ни один facilitator TON не поддерживает. Выбор: USDC/Base
  рядом с TON-контуром **или** свой verifier. Не оба сразу.
- Общий кошелёк продуктов — уже запрещён нашим дизайном, research это подтверждает.

## Риски

- **Комплаенс стейблкоинов**: CDP facilitator делает KYT/OFAC, для нашей юрисдикции это риск
  блокировок. Self-host снимает зависимость, но добавляет обязанности по аудиту.
- **Угон подписывающего ключа** — главный вектор. Нужны session-scoped ключи,
  revoke/rotation, лимиты (паттерн OpenZeppelin programmable spending limits).
- **Волатильность спецификаций**: x402 v2 моложе года, MCP ломал совместимость в 07.2026.
  Изолировать адаптерами, не вшивать в ядро.
- **Runaway spend**: агент с кошельком и без лимитов — классический риск. Budget и
  kill switch обязательны **до** любого mainnet.

## Не подтверждено

Версии Rust-SDK x402 как official; A2A payment-слой вне расширений AP2/x402; статус TON
в roadmap x402 Foundation.

## Побочная находка: требует апдейта

`apps/tma/src/lib/mcp-oauth.ts` написан против ревизии MCP 2025-06-18. Актуальная
спека 2026-07-28 меняет модель сессий. Проверить и обновить отдельной задачей.
