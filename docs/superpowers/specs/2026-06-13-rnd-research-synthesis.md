# R&D-синтез: что нужно для полного функционала AIAG (2026-06-13)

**Статус:** ресёрч-синтез (3 фоновых воркфлоу, 12 агентов). Источник — веб-доки + GitHub-исходники. Сырьё: `tasks/wezz5qezo.output` (Hermes/память/custody/мульти-крипто), `tasks/wfo130b9k.output` (TON deep-dive), `tasks/w5oqi3t57.output` (TON API + Agentic Wallets). Этот файл = выжимка решений; полные находки в temp-файлах + LightRAG.

> ⚠️ Ресёрч поправил несколько фактов, которые наша память/канон держали НЕВЕРНО. Они помечены 🔴 — внесены в канон §5 + `project_hermes_runtime_setup`.

---

## 1. Hermes control-plane (REST :8642 + provisioning + мультитенантность)

**Adopt:** REST API закрывает control-plane целиком (канон §5 верен по направлению).

Эндпоинты (из исходника `gateway/platforms/api_server.py`):
- **Сессии** `/api/sessions/*` (list пагинация, create, get/patch/delete, `{id}/messages`, `{id}/fork`, `{id}/chat`, `{id}/chat/stream` SSE).
- **Прогоны** `/v1/runs` (POST→run_id 202, GET статус, `{id}/events` SSE tool-call прогресс, `{id}/stop`, `{id}/approval`).
- **Распознавание** `/v1/models`, `/v1/capabilities`, `/v1/skills`, `/v1/toolsets`.
- **OpenAI-совместимые** `/v1/chat/completions` (stateless), `/v1/responses` (stateful через `previous_response_id`).
- **Джобы/cron** `/api/jobs/*`. **Health** `/health`, `/v1/health` (без auth).

🔴 **Поправки фактов (память врала):**
- **Auth = СТАТИЧЕСКИЙ** `Authorization: Bearer API_SERVER_KEY`. Ротируемого session-token НЕТ. agent-worker шлёт фикс-ключ.
- Изоляция нанимателя = заголовок **`X-Hermes-Session-Key`** (НЕ `...-Session-Token`), worker проставляет из `runId` сервер-сайд → это и есть OWASP-LLM06 boundary.
- Docker = **один контейнер на профиль** (label `hermes-profile=`); 5GB = CAP, факт-резидент ~300MB/процесс.
- Provisioning = CLI `hermes profile create <agent>_<hirer> --clone-from <template> --clone-all` (общий спек + приватная память — ровно author-rent) + патч `config.yaml` `base_url=наш :4000`.

**Phase-0 спайк на боксе:** реальный RSS 6 профилей (`docker stats`); **мультиплексинг сессий на одном gateway через `X-Hermes-Session-Key` vs profile-per-процесс** (узкое место — резидентные ~300MB×N → на 8GB ~6-10 активных тенантов); auto-reaping idle; версия (`hermes --version`: v0.12 vs канон v0.15.2); overlay2/XFS+pquota.

---

## 2. Память при найме (изоляция + переносимость) — КРИТИЧЕСКИЙ ПУТЬ

**Строим: гибрид — НАША БД = source of record, Hermes-память = рабочий кэш.** Реализовать hire-design §2-3: `agent_sessions` + `agent_memory.scope_tg_user_id` + namespace `(agent_id, COALESCE(scope,0), key)` + `loadHistory(scope=hirer)` + `settleRun(sessionId)`. **Scope зашивается воркером из runId, НЕ из запроса** (единственная безопасная архитектура — подтверждено mem0/Zep). pgvector сейчас НЕ нужен.

🔴 **Изоляция Hermes НЕ безопасна для мультитенанта «из коробки»:**
- `memory_store.db` де-факто **общий** (открытый баг **#4726**, не исправлен).
- `session_search_tool` читает **кросс-профильно**.
- → наша запись «изоляция доказана 6 профилями» верна для *файлов config/MEMORY.md*, но НЕ для holographic-памяти/поиска.
- **Обязательно при найме:** (а) per-profile `db_path` для holographic ИЛИ отключить; (б) запретить `session_search_tool` в hire-профилях; (в) зеркалить в нашу БД.

**Гейт основателя:** наём MVP на текущем **stateless-loop** (готов, контракт роутов не меняется — рекомендация hire-design) ИЛИ сразу на Hermes-профиле?

---

## 3. Кредит и деньги на TON

🟢 **Кредит остаётся OFF-CHAIN** (`tg_user_balances`, USD-credit). Свой jetton НЕ выпускаем. Сошлись все 3 TON-агента:
1. Газ jetton-перевода (~0.0145–0.05 TON) съест микро-списание per-run.
2. Свой USD-pegged jetton = выпуск стейблкоина иностранным юрлицом + риск ключей минтера (комплаенс «не факторим» — не открывать фронт).
3. Off-chain выигрывает money-path: мгновенные нулевые списания, атомарность `settleRun`, гибкость USD-пега.
4. On-chain ТОЛЬКО на границах: пополнение (USDT-jetton + native TON, live) + выплаты авторам (батч).

**Выплаты авторам:** off-chain ledger накопление → периодический **батч прямым USDT-переводом** (`@ton/ton`) на адрес автора. БЕЗ escrow-контракта. Гейт: порог/расписание/кто платит газ.

**Подписки/рента:** off-chain списание из кредита раз в период. W5-subscription on-chain — в бэклог.

---

## 4. Мульти-крипто пополнение + USD-пег

**v1-минимум:** 2 актива на 1 сети — native TON (live) + **USDT-on-TON** (jetton, USD-пег БЕЗ оракула, 1 USDT=100 кредитов). Кросс-чейн (ETH/SOL) делегировать встроенному **Telegram Wallet** (сам конвертит в USDT/TON). Расширить реконсилер второй веткой на jetton-transfers (TonCenter v3 `/jetton/transfers` + парс `forward_payload`). НЕ строить свои EVM/Solana-индексаторы.

**Гейт:** stables-only (убирает оракул/fix-rate-окно) или volatile-активы? own-wallet (0 комиссий) vs NOWPayments (+0.5-1%, KYB на иностранное юрлицо).

---

## 5. TON API-стек (выбор)

**TonCenter v3 как основа (уже в коде) + npm `@ton/ton` для отправки.**

| Задача | Инструмент | Статус |
|---|---|---|
| Реконсиляция пополнений | TonCenter v3 `GET /api/v3/transactions` (`X-API-Key`) — **уже в `topup-reconciler.ts`** | live |
| Баланс TON / jetton | v3 `/api/v3/account` · `/api/v3/jetton/wallets` | mainnet-ready |
| Get-методы контракта | v3 `/runGetMethod` / `TonClient.runMethod()` | mainnet-ready |
| **Отправка TON/jetton** | npm **`@ton/ton`** (`WalletContractV4.sendTransfer`) — **добавить в package.json** | новая зависимость |

Уже стоят: `@ton/core ^0.59`, `@ton/crypto ^3.3`, `@tonconnect/ui-react 2.4.4`. Ключ TonCenter от `@tonapibot`; **Free 10 RPS хватает** при 1 receiver + тик 2 мин. Опционально **TonAPI Webhooks** (`rt.tonapi.io/webhooks`, Bearer) как push-ускоритель поверх реконсилера (SSE — deprecated, не брать). Идемпотентность отправки: 1 воркер на кошелёк сериализует `sendTransfer` (один seqno = одна транза).

---

## 6. Агентский кошелёк (TON Agentic Wallets) + custody

**Adopt как on-chain исполнительный слой (Model B), боевой mainnet — НЕТ до аудита.**

- Стандарт TON Tech (анонс ~28.04.2026): self-custody кошелёк агента = смарт-контракт-SBT (**TEP-85**), сохраняет Wallet-V5. **Split-key:** `operatorKey` (агент подписывает автономно) + owner master key (юзер фондирует/отзывает; отзыв = обнуление operatorKey).
- ⛔ **Контракты НЕ аудированы** ("use testnet"); `@ton/mcp` — **alpha**; лицензия `the-ton-tech/agentic-wallet-contract` НЕ указана; **встроенных спенд-капов/allowlist НЕТ** ("fund what you risk").
- **Встройка:** НЕ смешивать с LLM-дебетом. Наценка моделей = внутренний USD-ledger (`settleRun`). Agentic wallet = отдельный кошелёк агента для on-chain трат. `operatorKey` генерим server-side, храним **AES-256-GCM** (как BYOK). Owner = TON-кошелёк нанимателя (уже привязан + ton-proof). **Наш cap-слой в Postgres** (дневной + per-call + allowlist) ПЕРЕД подписью — то, чего нет в контракте. gasless через W5 `internal_signed` (газ в USDT).

**Custody operatorKey (founder-gate, work3 R&D):** self-managed **Vault/OpenBao transit (ed25519)** на изолированном хосте (US-TEE-вендоры блокируются RF-UBO/OFAC; Turnkey = fallback). hot-wallet на воркере vs внешний вендор — решение основателя.

---

## 7. Прочие R&D (из gap-карты, не углублялись сейчас)
- **A2A payment channels** (`ton-blockchain/payment-channels` или `xssnick` Go-сайдкар) — позже, только при реальной межагентской экономике.
- **x402-on-TON** (CAIP-2 `tvm:` в спеке есть, готового facilitator под USDT-on-TON нет → строить свой) — под tool-broker, позже. Проверить `second-state/x402-facilitator` на `tvm:`.
- **Контракты:** язык **Tolk** (Tact депрекейтится ~апр-2026), Blueprint + `@ton/sandbox`. Любой свой money-контракт = аудит ($25–70k, 2–6 нед; TonTech/TonBit/Zellic/SlowMist). Принцип: **меньше своего кода = меньше аудита** (брать аудированный `stablecoin-contract`/Omniston-escrow форком).
- **Tool-broker метеринг**, **Telegram-deploy нанятого агента** (проброс `TELEGRAM_BOT_TOKEN` в .env профиля), **run-trace из Hermes→TMA** (Langfuse на боксе) — отдельные треки.

---

## Критический путь

`2 (память) → (4 пополнение ‖ 1 Hermes-спайк) → 6 (агентский кошелёк) → 7 (A2A/x402)`

1. **Память** — без namespace `(agent_id, hirer)` найма НЕТ (cross-tenant leak). Load-bearing, не зависит от Hermes, реализуема на stateless-loop СЕЙЧАС.
2. **Hermes control-plane** — для «настоящего» найма; провижининг+изоляция доказаны; Phase-0 спайк.
3. **Мульти-крипто (USDT-on-TON)** — нанимателю чем платить; малый инкремент поверх реконсилера.
4. **Агентский кошелёк** — самый поздний: unaudited контракт + custody-гейт + MiCAR юр-гейт.

## Можно начать СЕЙЧАС (код, без бокса)
- Память: миграция `agent_sessions` + `agent_memory.scope_tg_user_id` + namespace-индекс + `loadHistory(scope)` + `settleRun(sessionId)` на stateless-loop.
- Пополнение: jetton-ветка реконсилера + `getTonUsdRate` multi-id + колонки `asset/network/expected_amount/quote_ts` в `tg_topups`.
- TON-отправка: добавить `@ton/ton`, seqno-сериализация на воркере; cap/policy-слой в Postgres (нужен в любом сценарии).
- Документация: правки фактов в канон/SECURITY/память (auth-токен, `X-Hermes-Session-Key`, контейнер-на-профиль, #4726).

## Требует Phase-0 спайка на боксе
- Hermes: RSS-замер, мультиплексинг vs profile-per-процесс, per-profile `memory_store.db` (#4726) + гейтинг `session_search_tool`, версия, overlay2/XFS.
- TON: матчинг jetton через TonCenter v3 реальным USDT-переводом; `@ton/mcp@alpha` agentic wallet на testnet (split-key, headless confirmation-flow, HTTP multi-session); Vault→TON sign round-trip + ротация.

## Гейты основателя (блокируют, не код)
1. Наём MVP — stateless-loop или сразу Hermes-профиль?
2. Пополнение — stables-only (USDT-on-TON) или volatile? own-wallet или NOWPayments?
3. Custody operatorKey — hot-wallet воркера vs Vault/внешний вендор?
4. Когда agentic wallets на mainnet — заблокировано до аудита контрактов TON.
5. Юр-заключение MiCAR перед боевым внешним рельсом агентского кошелька.
