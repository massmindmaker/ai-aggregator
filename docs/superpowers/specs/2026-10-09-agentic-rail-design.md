# Design: Агентский рельс (A + C) — headless-агенты на гейтвее, Gram + USDT, MCP-фасад

Дата: 2026-10-09. Спецификация по итогам brainstorm `2026-10-09-agentic-audience-brainstorm.md` (выбор владельца зафиксирован в §7.1). Путь: architectural (superpowers:brainstorming) → этот спек → writing-plans → реализация с ревью.

## 1. Цель и решения

ИИ-агент, без человека в цикле: доказывает владение TON-кошельком → получает аккаунт и API-ключ → сам пополняет баланс (Gram или USDT) → сам настраивает роутинг-политики и свои лимиты/сроки ключей → работает через OpenAI-совместимый `/v1` и/или наш MCP-сервер.

Решения владельца (09.10): A+C сразу; USDT-jetton в скоупе; лимиты и TTL ключей опциональны (выбирает агент, не мы); зарубежное юрлицо отложено — прототип живёт в **testnet**; x402-TON — зафиксировать разбором (этап 2, §10).

Инварианты репо действуют: SQL prepared; деньги BIGINT микрокредиты (1 кредит = 1¢ = 1000 микро; 1 USDT = $1 = 100 кредитов = 100 000 микро); `UPDATE … WHERE <guard> … RETURNING`; потолок 2^53−1 не снимать; фиат-гейты и gram-витрина прода не трогаются; mainnet-включение — только по явной команде владельца.

## 2. Скоуп v1

1. Agent identity: headless-регистрация по ton-proof, принципал = org без human-user.
2. Ключи агента: mint/rotate/revoke/list по API, опциональные `expires_at` и капы.
3. Headless-топап: invoice по API для native Gram и USDT-jetton; статус-поллинг; зачисление существующим settle-воркером.
4. USDT-приём в воркере: jetton-источники reconciliation, матчинг forward-payload, allowlist мастер-контрактов, peg-FX.
5. Policy/limits API: чтение/запись per-key routing-политик и опциональных квот (v2-таблицы).
6. 402-JSON при нулевом балансе: machine-readable «сколько/куда/зачем платить» (семантика x402-challenge без EVM).
7. MCP-фасад: `POST /mcp` (streamable HTTP) в гейтвее, auth тем же агентским ключом; tools каталог/баланс/топап/политика/ключи/чат.

Не-скоуп v1: вывод крипты (payout); личные fallback-приоритеты per-agent; x402-приём per-request (§10); CLI/SDK-пакет (доки + curl; допущение — спрос покажет); mainnet-runtime; фиат для агентов.

## 3. Архитектура (компоненты)

### C1. Agent principal (identity)

- Новая таблица `agent_principals`: `id UUID PK`, `org_id → organizations` (UNIQUE), `network` ('-3' в v1; CHECK допускает '-1' на будущее — mainnet включается env+миграцией данных, не кодом), `address TEXT` (user-friendly), `address_raw TEXT`, `status` ('active'|'revoked'), `created_at`, `revoked_at`. Partial UNIQUE `(network,address) WHERE revoked_at IS NULL`.
- Новая таблица `agent_wallet_challenges` (по образцу `user_ton_wallet_challenges`, 0091): purpose 'register', payload `aiag:agent:<randomBytes(32)>`, TTL 120 c, одноразовый (`consumed_at`), привязка к `domain` (host гейтвея). Без browser-hash (нет браузера). Rate-limit: 60/мин глобально, 6/5мин на address (в таблице `agent_challenge_rate` не городим — Redis sliding window по образцу ton-wallet-auth).
- Регистрация (гейтвей, публичные роуты, без ключа):
  - `POST /v1/agent/challenge` `{address, publicKey?, walletStateInit?}` → `{payload, expiresIn}`.
  - `POST /v1/agent/register` `{address, proof: ton-proof-item-v2}` → верификация офлайн `packages/shared/src/ton-wallet-proof.ts` (переиспользуем как есть; для mainnet потом расширим пиннед-code-hash'ы) → атомарно (одна транзакция): создать `organizations` (синтетический name `agent:<addr-8>`, owner_id NULL — проверить FK: organizations.owner_id nullable? Если NOT NULL — завести технического системного юзера `agents@aiag.local` как owner, по паттерну 0060) + `agent_principals` + **первый ключ** (`sk_aiag_live_…`) с `policies = {kind:'agent'}`. Ответ: principal_id, org_id, key (plaintext — единственный раз).
  - Идемпотентность повторной регистрации того же кошелька: если principal уже active — отвечаем 409 `AGENT_ALREADY_REGISTERED` (восстановления доступа в v1 нет — новый кошелёк = новый принципал; допущение, черновой ревок-флоу — этап 2).
- Отзыв принципала: `POST /v1/agent/revoke` с proof-подписью того же кошелька (challenge→proof, purpose 'revoke') → status revoked + revoke всех ключей org. Оферта: факт оплаты/регистрации = акцепт; плательщик = владелец кошелька (текст в docs, не код).

### C2. Ключи агента

- `ALTER gateway_api_keys ADD expires_at TIMESTAMPTZ NULL` (NULL = бессрочный — выбор агента). Auth-мидлварь добавляет проверку `expires_at > now()` → иначе 401 `KEY_EXPIRED`.
- Эндпоинты (auth: действующий ключ принципала):
  - `POST /v1/agent/keys` — mint (по сути обёртка существующего S2S-минта `organization-keys.ts` с `clampToIssuer`); параметры: name, caps опционально, expires_at опционально, model_whitelist опционально.
  - `POST /v1/agent/keys/:id/rotate` — атомарно: новый hash+prefix в той же строке (сохранить `rotated_from_hash` в JSONB `meta`), ответ с новым plaintext. Старый plaintext мгновенно недействителен.
  - `POST /v1/agent/keys/:id/revoke`, `GET /v1/agent/keys` — list (без plaintext).
- RPM-гигиена остаётся как есть (`rpm_limit` default 60 — существующее поведение, не траты).

### C3. Headless-топап

- `POST /v1/agent/topup` (auth: ключ принципала): `{asset: 'gram'|'usdt', credits: BigInt-like string}` → создаёт invoice через ядро `ton_invoices`:
  - native Gram: существующий `aiag_create_ton_invoice_v1`, но `expected_sender = NULL` — новое: SQL-функция `aiag_create_agent_ton_invoice_v1` (или параметр режима в существующей, выбор — по простоте дифа против триггера 0092: триггер 0092 действует на `user_ton_checkouts`, не на тон-инвойсы — проверено код-эксплорером: пин отправителя сидит в checkout-слое web, не в ядре; значит гейтвею достаточно дергать ядро без expected_sender). Amount = credits→atomic по активной FX-политике (Gram: CoinGecko-оракул + ceil в пользу получателя — существующий builder).
  - USDT: amount = `credits × 10^6 / 100` атомарных USDT (peg 1 USDT = 100 кредитов), FX-оракул не нужен; reference (memo) кладётся в **forward_payload** jetton-перевода (TEP-74), не в comment.
  - Ответ: `{invoiceId, network, asset, recipient, amountAtomic, reference, expiresAt, transferHint: {mode:'native-comment'|'jetton-forward-payload', minForwardAmount}}`.
- `GET /v1/agent/invoices/:id` — статус (pending|observed|confirmed|settled|expired|review_required) + зачисленные кредиты.
- `GET /v1/agent/balance` уже есть (`/v1/balance`) — не дублируем.
- Лимиты: rate 12/5мин на ключ (по аналогии с web-checkout), min-пакет 100 кредитов ($1), max-инвойс — потолок 2^53−1 микро; quote TTL 120 c как у людей.

### C4. USDT-приём в воркере

- `ton_asset_allowlist` (0098): seed строкой USDT-jetton mainnet + тестовый jetton для testnet (адреса — в миграции, источник: pinned при имплементации, env-override).
- Reconciliation-источники: расширение `aiag_list_ton_reconciliation_sources_v1` ассетом 'usdt'; evidence-провайдер: TonCenter v3 `/jetton/transfers?direction=in` по jetton-кошельку merchant-адреса (адрес jetton-кошелька получателя вычисляется `get_wallet_address` через TonCenter `run/method` — кэш 24ч).
- Матчинг: `forward_payload` содержит reference `aiag-ton:<uuid>` (UNIQUE инвойса); обязательные проверки из доков TON: событие = `transfer_notification` (opcode `0x7362d09c`) на адрес получателя, `source` = верифицированный jetton-кошелек отправителя, мастер-контракт ∈ allowlist, `out_msgs.length === 0` (не bounce), amount ≥ ожидаемого. Подток/переплата → существующий review-контур (14 причин уже покрывают under/overpayment).
- Settle: `aiag_settle_ton_invoice_v1` уже network/asset-агностичен по grant-микрокредитам — добавить ветку округления USDT→микрокредиты peg (floor в пользу сервиса, дельта < 1 микрокредита).
- Воркер-режимы/Finality те же: MC-depth≥2, TonCenter polling 30 c.

### C5. Policy/limits API

- `GET /v1/agent/policy` → текущие policies ключа + вписанные квоты.
- `PUT /v1/agent/policy` `{default_mode?, allowed_providers?, blocked_providers?, forbid_non_ru?, allow_pii_transborder?, model_whitelist?, session_micro_limit?, monthly_credits_limit?, daily_org_credits_limit?}`:
  - routing-часть → валидация zod-схемой `ApiKeyPolicies` → `gateway_api_keys.policies` (merge, unknown-ключи — 400, по образцу stored-chat-fresh-policy).
  - квоты → писатель строк `gateway_quota_key_policies` / `gateway_quota_org_policies` (v2, 0068) + автозачистка legacy-полей при миграции на v2 (`QUOTA_POLICY_MIGRATION_REQUIRED`-ветка). Всё опционально: не передал — лимита нет (решение владельца).
  - Зажимание: нельзя расширить сверх issuer-ключа (переиспользуем семантику `clampToIssuer`).
- Отдельного UI в apps/web для этого нет (агентский путь — API/MCP). Human-dashboard не трогаем.

### C6. 402-JSON (нуль баланса)

- Все пути отказа по деньгам (preflight legacy + stored-admission P0003) отвечают единым JSON-телом: `{error:{code:'insufficient_funds', message, topup:{asset_default:'gram', endpoint:'POST /v1/agent/topup', min_credits:100, docs:'...'}}}` + заголовок `Retry-After`. Это «challenge» без суммы (сумма — выбор агента), рельсово-agnostic.

### C7. MCP-фасад

- Монтируется в сам гейтвей: `POST /mcp` (Streamable HTTP, `@modelcontextprotocol/sdk`), перед ним — существующий auth-мидлварь (Bearer агентский ключ; expires_at-проверка). Отдельный сервис не поднимаем (6 ГБ RAM-хост — меньше процессов).
- Tools (префикс `aiag_`): `list_models` (каталог с ценами/кандидатами), `get_balance`, `create_topup_invoice{asset, credits}` (ответ = C3-JSON; для Gram дополнительно готовый `comment`-memo), `get_invoice_status{id}`, `set_routing_policy{...}` (C5), `list_keys`, `rotate_key{id}`, `revoke_key{id}`, `chat_completion{model, messages, ...}` — прокси в /v1 (non-stream; для streaming — указание пользоваться прямым /v1 в description тула).
- Resource `aiag://catalog` — снапшот каталога. Discovery-доки: `docs/api/agent-mcp.md` + well-known JSON с manifest.
- Лимиты тулов: RPM те же, что у ключа; `chat_completion` идёт через общий admission (деньги — те же списания).

## 4. Модель данных (сводка миграций)

1. `0104_agent_principals.sql`: `agent_principals`, `agent_wallet_challenges` (+ индексы, rate-таблиц нет), seed системного owner-юзера `agents@aiag.local` (если organizations.owner_id NOT NULL — проверить на имплементации).
2. `0105_agent_key_lifecycle.sql`: `gateway_api_keys.expires_at`, `meta JSONB` (rotated_from_hash), индекс по org для list.
3. `0106_agent_topup_core.sql`: `aiag_create_agent_ton_invoice_v1(expected_sender NULL)` для gram+usdt; у `ton_invoices` колонка `source_api` ('web'|'agent') — не обязательна, различие уже по отсутствию user checkout; peg-константа USDT→микро в функции.
4. `0107_usdt_reconciliation.sql`: allowlist-seed USDT (mainnet+testnet), расширение листинга источников на ассет 'usdt', `ton_chain_events` допускает jetton-поля (event_payload JSONB уже есть — уточнить схему 0072).
5. `0108_agent_quota_writer.sql`: SQL-функции `aiag_set_key_quota_policy_v1`, `aiag_set_org_quota_policy_v1` (guarded upsert + legacy-чистка).

Номера миграций сдвигаются по факту (следующий свободный). Порядок применения — только локально/testnet-БД; прод — отдельным решением владельца.

## 5. Потоки

- **Регистрация**: challenge → sign → register → (org, principal, key). ~2 HTTP-вызова + 1 подпись кошелька.
- **Топап**: create_topup_invoice → агент шлёт перевод (native: memo=reference; USDT: forward_payload=reference, forward_amount ≥ 0.000000001) → воркер 30 c-цикл → observed → confirmed (MC≥2) → settle → `payg_credits += grant` → следующий /v1-запрос проходит.
- **Нуль баланса**: /v1-вызов → 402-JSON → агент сам вызывает topup → повторяет.
- **Смена политики**: PUT policy → следующий SELECT auth видит новые policies (свежий SELECT на каждый запрос — уже так).
- **Ротация**: rotate → старый plaintext мёртв сразу (тот же key_hash-lookup).

## 6. Ошибки и границы

- Memo-подделка/replay: reference одноразовый UNIQUE + settle-дедуп по (network,recipient,tx,message) — уже в ядре.
- Фейковый USDT: allowlist мастера + get_wallet_address-верификация + opcode-проверка.
- FX-Gram stale: checkout уже отвечает `TON_CHECKOUT_FX_STALE` — агент повторяет.
- Спам-регистрации: rate-limits challenge/register; создать org дешевле, чем выдержать proof-подпись — приемлемо для прототипа.
- Ключ с expires_at в прошлом: 401 `KEY_EXPIRED` (не 403 — различимо агентом).
- MCP-ошибки: JSON-RPC error codes маппятся 1:1 с HTTP-кодами гейтвея.

## 7. Тестирование

- Юнит: proof-верификация challenge-флоу (reuse тестов 0091-паттерна), policy-writer zod, rotate-атомарность, USDT-peg-математика (BigInt, без float).
- Native-интеграционные (по образцу существующих `*.native.integration.test.ts`): register→topup(gram, testnet-фикстуры)→settle→402-исчез; jetton-e2e на фиксстуре transfer_notification; quota-writer→admission-путь; MCP contract-тест (initialize/tools/list/tools/call).
- Воркер: jetton-reconciliation на мок TonCenter.
- Всё локально под flock; прод-данных не трогаем.

## 8. Ревью и гейты

- Ревью каждой фазы — code-reviewer субагент + владелец по желанию; деньги-миграции — обязательный второй проход (паттерн TON-ветки).
- Гейты, НЕ снимаемые без команды владельца: применение миграций на прод; включение mainnet-runtime; включение gram-витрины (Task 8 старого плана); возврат фиата.

## 9. Открытые допущения (зафиксированы, не блокируют)

1. organizations.owner_id может требовать системного юзера-владельца (паттерн 0060) — проверить на имплементации.
2. Восстановление доступа агентом при утере ключа (без кошелька) — нет; с кошельком — новый принципал. Этап 2: re-auth-флоу.
3. USDT-тестнет-мастер и min-депозит подобраться на имплементации (env).
4. `agent topup` принимает произвольную сумму кредитов ≥100 — пакетов-номиналов для агентов не делаем (пакеты — для людской витрины).

## 10. Этап 2 — x402 на TON (брейншторм, зафиксировано)

Факты: x402 под Linux Foundation; в официальной спеке есть exact-схема на TON — но **только USDT-jetton, кошелёк W5R1, native Gram = future extension**; дефолтный фасилитатор TON не покрывает — нужен self-host (референс ohld/x402-ton-facilitator, Apache-2.0, PoC); batch-settlement на TVM нет.

Что это даёт нам, если добавим позже: агенты с x402-клиентами (x402-fetch, AgentKit) смогут платить USDT **за каждый запрос без аккаунта** — наш `/v1` отвечает `402 PAYMENT-REQUIRED` (challenge: amount, asset USDT, payTo, maxTimeoutSeconds), агент прикладывает `PAYMENT-SIGNATURE` (BoC подписанного W5R1-jetton-transfer), мы — свой фасилитатор: off-chain verify (Ed25519+seqno+validUntil+BoC-dedup) → ответ → settle асинхронно.

Почему не v1: (а) пер-реквест сети-комиссии и латентность settle — экономика мельче депозита; (б) клиентская база TON-402 ≈ отсутствует (W5R1-only, PoC-инфраструктура); (в) анонимные пер-реквест платежи — усиленный AML-профиль (сейчас юрлицо отложено — тем более не разгоняем); (г) x402-платежи — это USDT-мир, а ядро our rail = Gram.

Что уже совместимо с v1-дизайном: C6 (402-JSON) — та же семантика; USDT-приём C4 — тот же ассет; депозиты — концепт x402 batch-settlement «канал» наш topup и есть. Переиспользование при этапе 2: максимальное.

Решение: x402-TON принять отдельным этапом после того, как прототип A+C наберёт хотя бы первых платящих агентов; триггер — спрос «хотим платить без аккаунта».

## 11. Что дальше

1. Этот спек → ревью владельца (по желанию; конвейер делегирован).
2. writing-plans: `docs/superpowers/plans/2026-10-09-agentic-rail-plan.md` — фазы: миграции → identity/keys-эндпоинты → topup API → 402-JSON → USDT-воркер → MCP → тесты.
3. Реализация по плану (subagent-driven, ревью после каждой фазы, flock на тяжёлые прогоны).
