# AG-TON2: TON invoice core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task; subagent-driven-development only within already authorized delegation. Steps use checkbox (`- [ ]`) syntax for tracking. **Дизайн принят после независимого financial/spec review на095d9bf. Реализация требует отдельного назначения владельца migration после завершения текущей MC3 проверки.**

**Goal:** Сохранить immutable TON top-up invoice и атомарно выдать её точный grant в gateway microcredits по доверенному подтверждённому входящему chain event ровно один раз.

**Architecture:** TON имеет отдельные invoices/events и TON-only серверный order, не использует RUB `payments`. Положительный receipt хранится в существующем `gateway_transactions`; одна транзакция блокирует org → invoice → event, делает guarded balance update, CAS статуса и receipt. RPC, wallet, sweep и публичные routes остаются последующими задачами AG-TON3/4/5.

**Tech Stack:** TypeScript, PostgreSQL, Drizzle parameterized SQL, accepted pure bigint contract AG-TON1; Bun 1.4.2/Vitest для локальной проверки, существующий guarded native runner.

**Spec:** [TON alongside RUB](2026-09-07-ton-payments.md), [payment/evidence contract](../../ecosystem/payment-and-evidence-design.md), accepted AG-TON1 source `a5731d4`.

## Global Constraints

- Testnet first (`tvm:-3`); mainnet keys/funds/paid providers/production migrations/deploy запрещены в этом локальном этапе.
- Native + allowlisted jetton identity по network/master/decimals, exact integer amounts; display ticker не идентификатор.
- Merchant ledger продукта, PaymentRail и будущий agent wallet разделены. Никаких seed/root private keys в frontend/LLM/logs.
- Existing DB guard до клиента/import/mutation, один heavy run под `flock /tmp/ai-ecosystem-build.lock`; сохранять чужие edits.
- Unknown outcome не разрешает новую отправку денег. Web poll/sweep используют один domain settlement.
- Migration filename/version фиксировать в focused task brief по фактическому manifest перед кодом; не переиспользовать уже применённый номер/checksum.
- Тестовые fixtures, реальная testnet транзакция и production acceptance имеют раздельный evidence.
- V1 compatibility ceiling: новый TON grant и **итоговый** `organizations.payg_credits` ≤9007199254740991 microcredits, пока RUB refund consumer использует `toSafeInteger`. Exact bigint арифметика и единица microcredit не меняются; signed BIGINT contract AG-TON1 сохраняется.
- Здесь только `purpose='gateway_topup'`, owner-only создание/чтение, один grant в `organizations.payg_credits`. Подписки, чужие org members, общий RUB/TON checkout order и TON refunds не входят в AG-TON2.
- Не менять AG-TON1, существующие RUB webhook/refund/admission функции, исторические SQL checksums, pricing/FX, env, runtime switches, network adapters, индексы памяти, `.Codex/` и работы MC3/Arena. У TON нет чтения/записи legacy `users.balance`/`transactions`/`payments`.

## Статус и подтверждённая исходная база

**APPROVED DESIGN — независимое финансовое re-review095d9bf закрывает HIGH совместимости RUB refund. Код, migration и native evidence ещё не реализованы; ожидается отдельный ownership handoff.** Revision после HIGH finding к `ad3e109`: интегратор выбрал временный PAYG compatibility ceiling и стабильный replay при изменении allowlist; этот срез одобрен в095d9bf. Последующее уточнение изоляции native fixtures ниже требует отдельного scoped review и не разрешает реализацию. Исходники прочитаны 08.09.2026 при HEAD `9f2470a48bdb4be14fb95aaea343cc737b6b97cc`; HEAD может меняться из-за параллельных владельцев. Этот документ — единственный owned tracked файл данной design-задачи.

Source-only inventory по тому же порядку `drizzle/*.sql` + `migrations/*.sql`, который использует `discoverNativeMigrations`: **71** файл, последний `migrations/0071_gateway_http_recovery_validation.sql`. Кандидат будущей additive migration — **`0072_ton_invoice_core.sql`**, ожидаемый total72. Повторно сверить manifest непосредственно перед назначением реализации и перед записью; при занятом 0072 назначить следующий свободный номер и обновить focused brief/все expectations согласованно. В этой design-задаче migration не создаётся и DB не вызывается. Bun не обнаружен в текущем PATH и старых `/tmp/bin`/`~/.bun/bin`; инвентарь пересчитан read-only Python по исходному алгоритму, это не результат native migrator/test run. Перед реализацией восстановить/найти штатный Bun runner, без установки в рамках design.

| Источник | Подтверждённый контракт / следствие |
|---|---|
| `packages/database/migrations/0059_pricing_unit_comments.sql`, `packages/api-gateway/src/lib/pricing.ts` | `payg_credits`, `subscription_credits`, `gateway_transactions.delta` — BIGINT **microcredits**, 1 credit = 1000 microcredits. Старый комментарий `schema/gateway.ts` про whole cents не источник единицы. |
| `packages/shared/src/ton-payment-contract.ts` | `TonQuote.sourcePrice.unit` произвольная строка; quote сам не задаёт grant. `convertAtomic` ограничивает intermediate signed BIGINT до деления; `createQuote` фиксирует fee/FX/time/asset, не выбирает цены. |
| `migrations/0004_gateway_core.sql:207`, `0056_web_credits_unit.sql`, `src/schema/gateway.ts:249` | Ledger `type`/`source` — varchar(20), без ENUM/CHECK значений в просмотренной migration history; `request_id` varchar(64), delta после0056 BIGINT. Drizzle delta использует `mode:'number'`; TON работает parameterized SQL с `::text`, не этим mapper. |
| `src/functions/settle-charge.sql`, `src/functions/gateway-charge-admission.sql` | Debit receipt filters `type='api_usage'`, source subscription/payg, request namespace `gw:` у admission. TON source не попадает в debit replay. |
| `apps/web/src/lib/payments/topup-refund.ts:119–129,580,717` | `toSafeInteger` отвергает PAYG >9007199254740991; оба RUB clawback paths читают текущий org PAYG через этот helper. Даже additive TON grant в BIGINT диапазоне может сломать последующий RUB refund; нужен ceiling итогового PAYG, а не только delta. |
| `apps/web/src/lib/payments/topup-refund.ts:416,442,584,772`, `migrations/0066_topup_refund_clawback.sql` | RUB refund receipts type refund/source payg; request namespace `refund:claim:`. Locks org → payment → refund operation. TON receipt не выдаёт себя за RUB refundable payment. |
| `apps/web/src/app/admin/page.tsx:27,102,122` | Денежные KPI выбирают `type='settle'`; TON topup не станет RUB выручкой в этих запросах. DAU/MAU читают все ledger rows: top-up станет активностью, что уже соответствует общей логике reader. |
| `apps/web/src/app/api/admin/requests/[id]/route.ts:60`, `src/functions/gateway-http-storage.sql` | Detail reader читает type/source без enum, привязан к request; HTTP recovery ищет собственный request UUID. `ton:invoice:` не пересечётся с этим namespace. |
| `apps/web/src/app/api/webhooks/tinkoff/route.ts:221` | RUB bridge `Math.round(...)` исторический. Не копировать эту формулу и не менять bridge в AG-TON2. |
| `src/functions/assert-refund-admission-allowed.sql`, admission/refund source | `refund_debt_credits>0` **или** active `payments.refund_claim_id` блокирует новый расход. Возврат неиспользованного **старого hold** может уменьшить debt; это не правило для нового TON top-up. |
| `src/schema/organizations.ts` | Текущий owner = `organizations.owner_id`, members/permissions существуют отдельно. V1 owner-only: membership не даёт TON billing доступ автоматически. |
| `scripts/native-clean-rehearsal.ts`, его test, root `package.json` | Runner жёстко pin-ит71, last0071, clean71 target, frozen hashes; нельзя просто добавить migration и забыть clean rehearsal. |

Reader inventory — основание выбора **`type='topup', source='ton'`**, а не обещание полной UI поддержки TON receipt. Повторить `rg 'gatewayTransactions|gateway_transactions' apps packages` перед реализацией; новая несовместимость reader — financial-review change, не скрытая смена discriminator.

## 1. Денежный и ownership контракт

**Предложение v1 для ревью:** `grant_microcredits` — отдельный immutable positive BIGINT. Для top-up-only `quote.sourcePrice.unit === quote.fx.sourceUnit === 'gateway_microcredits'` и canonical `quote.sourcePrice.amountAtomic === grant_microcredits`. Ценовой слой сервера предоставляет grant и pinned `priceRevision`; quote предоставляет отдельную TON atomic сумму. Нельзя вывести grant из `amountAtomic`, ticker, decimals, RUB формулы или arbitrary source unit. Не использовать `Number`, `parseFloat`, `Math.round` и JSON numeric literals для денег. Даже значение >2^53 возвращать decimal string. Это намеренно сужает generic AG-TON1 на persistence boundary, не меняет generic contract.

Только для **новой** invoice quote пересобирается через accepted `createQuote(input, currentServerAllowlist, quote.quotedAtMs)` и canonical результат сравнивается с серверным snapshot; freshness ещё раз проверяется по DB clock при первом insert. Для replay сначала bounded structural normalization без текущего allowlist/FX/time policy, затем поиск persisted key и сравнение сохранённого payload; повторный `requireAllowlistedAsset`/`createQuote` с текущим allowlist на replay запрещён. Удаление asset либо смена pinned decimals в текущем allowlist не лишает доступа к идентичной persisted invoice. Нормализовать timestamp в целые Unix milliseconds, recipient/master — lowercase raw `0/-1:<64hex>`. Серверная allowlist/config/policy никогда не приходит из request body. Ни цены, ни FX, ни asset defaults в этом плане не задаются; fixtures имеют явно synthetic rate и не являются товарной ценой.

Создание принимает verified server auth owner + выбранную им org, server quote/grant/price revision и client operation key; **не принимает orderId/invoiceId/reference от клиента**. Внутри org lock новый `order_id=gen_random_uuid()`, invoice id и reference генерируются ровно один раз. Здесь `order_id` — TON-only top-up order, не ID существующего RUB payment/order. Переданные клиентом payment/order IDs отвергать, чтобы существующий заказ нельзя было оплатить ещё одним rail. Общий rail selector/order arbitration относится к AG-TON4 и не включается этим core.

`owner_user_id`, `org_id`, `order_id`, idempotency key, grant, price revision, quote и routing fields после insert immutable. `ownerId` wire-поля однозначно означает user, `orgId` передаётся отдельно. Переименование/передача организации не перепривязывает invoice. Если owner организации сменился до зачисления — сохранить событие в review, ни старому, ни новому owner автоматически не выдавать заказ.

Idempotency scope `UNIQUE(owner_user_id, org_id, idempotency_key)`. Key ASCII `[A-Za-z0-9_-]{1,96}`, без trim/coercion. Equal key + exactly same normalized immutable **request payload** возвращает persisted invoice, включая expired/settled/review, с теми же order/reference/quote; stale quote, позднейшая смена allowlist/decimals/finality policy/FX configuration не мешают identical replay; используются исходные persisted facts, а не новые конфигурационные значения. Другой payload → `TON_IDEMPOTENCY_CONFLICT` (future HTTP409), zero writes. В fingerprint входят owner/org, purpose, grant, price revision, весь quote, recipient, optional expected sender, finality policy/version; генерируемые invoice/order/reference/createdAt исключены. Сравнить и SHA256, и сохранённый JSONB payload, не полагаться только на hash. Retry не создаёт новую quote.

Owner-only read выполняется SQL predicate одновременно `invoice.id`, `invoice.org_id`, `invoice.owner_user_id=actorUserId` и `organizations.owner_id=actorUserId`. Foreign owner/org, отсутствующий invoice, отозванное ownership → один `null` (future404), без раскрытия existence. Route AG-TON4 получает actor только из `getAuthenticatedUser()` → `authUser.user.id`; plain `userId` клиента не trusted context. Worker settlement не нуждается в пользовательском session, но проверяет immutable owner/org binding и org current owner перед первым grant. Settled replay старого события возвращает старый internal receipt без повторного права расхода; public read всё равно проверяет текущее ownership.

### Временный потолок PAYG для совместимости с RUB refund

Independent review исходного draft `ad3e109` нашёл HIGH blocker: legacy `toSafeInteger` разбирает **полный** org PAYG перед clawback. По решению интегратора минимальный v1 fix остаётся только в TON core: `COMPAT_PAYG_MAX = 9007199254740991n` (`2^53−1`) microcredits. Это не новая единица денег и не общий предел TON atomic units/AG-TON1 parser. TON amount/fee/FX и evidence остаются в прежнем exact signed-BIGINT/bounded-string контракте, в том числе TON amount может быть больше2^53.

- New create под org lock: `1 <= grant <= COMPAT_PAYG_MAX`, `0 <= currentPayg <= COMPAT_PAYG_MAX` и `currentPayg <= COMPAT_PAYG_MAX-grant`. Иначе `TON_BALANCE_COMPATIBILITY_LIMIT`, zero invoice/event/receipt/balance writes: не предлагать клиенту заведомо незачисляемую покупку. Existing identical replay выполняется раньше этого new-sale guard.
- Settlement повторяет ту же проверку **под org lock**. Если после create баланс вырос и grant пересечёт ceiling, immutable paid event и review decision сохраняются, invoice→review_required с `balance_compatibility_limit`; zero grant/receipt, debt/subscription без изменений. При точном результате9007199254740991 зачисление допустимо.
- Несколько pending invoices не резервируют headroom. Поэтому две созданные invoices могут по отдельности помещаться в лимит, а при последовательном зачислении вторая уйдёт в review. Не вводить headroom holds внутри этой задачи; явно протестировать и учитывать в future review/refund ops.
- Если legacy balance уже >ceiling до TON операции: new create отказ; existing paid invoice review, никакого clipping, Number conversion, автоматического списания, debt adjustment или другой попытки починки. Уже сохранённый receipt читается/replayed без исправления historical balance. Отрицательный PAYG — отдельный invariant failure/review, не попытка отрицательного grant.
- Снять ceiling можно лишь после отдельно назначенной exact миграции **всех** RUB refund consumers, включая оба `toSafeInteger(org.payg_credits)` paths и соответствующие calculations/receipts, с native compatibility proof за2^53 и финансовым ревью. AG-TON2 не меняет эти файлы. Пока ceiling действует, новый TON receipt.delta тоже≤ceiling; это не заявление, что historical ledger уже безопасен.

## 2. Refund debt: консервативное предложение, требующее financial approval

1. При новом create под org lock вызвать существующий `aiag_assert_refund_admission_allowed(orgId)`: debt>0 или active RUB refund → `TON_REFUND_BLOCKED`, invoice не создавать. Existing identical invoice replay разрешён независимо от debt и не является новой продажей.
2. При уже пришедшем verified transfer повторно проверить debt/active claim **под тем же org lock**. Если блок есть: сохранить immutable event + invoice/event decision; invoice → `review_required` с `refund_blocked`; **не писать positive ledger receipt, не менять payg, subscription или debt**.
3. Событие означает входящие деньги/неразрешённое обязательство. Оно не удаляется, не помечается returned/refunded и не превращается в spendable balance. Internal read показывает amount/asset/grant/причину; операторское урегулирование или возврат — отдельный AG-TON5 gate. До этого операторской release-функции нет.
4. Даже после уменьшения debt повторный sweep того же event возвращает review. Из `review_required` автоматического выхода нет; никакого автоматического repayment/refund. Отсутствие debt позже не доказывает, что уже разбираемое поступление разрешено зачислять.
5. При race TON первым получил org lock и закоммитил grant → последующий RUB refund применяет существующий clawback к org как обычно. Refund первым → TON видит debt/claim и уходит в review. Не вмешиваться в существующий admission guard или восстановление старых holds.

Это уменьшает автоматизацию, но не меняет долг молча и не допускает трат через TON. Недостаток принятия этого предложения: деньги некоторых уже оплаченных invoices требуют ручного финансового решения, которого AG-TON2 ещё не предоставляет. Для future live gate операторская очередь и утверждённый release/refund процесс обязательны.

Conservation для successful settlement: `Δpayg = grant = receipt.delta`, `Δsubscription=0`, `Δdebt=0`; invoice settled iff один matching receipt и один consumed event. Для review: все эти deltas0, receipt отсутствует, входящий event сохранён. Event amount измеряется отдельно в asset atomic units, его нельзя складывать с grant или debt.

## 3. Точная схема будущей migration

Создать только после отдельного назначения реализации. SQL/Drizzle schema должны совпадать; amounts Drizzle `bigint(...,{mode:'bigint'})`, во всех wire/SQL query результатах decimal strings. Ссылки финансовой истории `ON DELETE RESTRICT`, без cascade и без переоценки старых данных.

```sql
CREATE TABLE ton_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  purpose TEXT NOT NULL CHECK (purpose='gateway_topup'),
  idempotency_key VARCHAR(96) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,96}$'),
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  price_revision VARCHAR(96) NOT NULL CHECK (length(price_revision)>0),
  grant_microcredits BIGINT NOT NULL CHECK (grant_microcredits>0 AND grant_microcredits<=9007199254740991),
  source_price_unit TEXT NOT NULL CHECK (source_price_unit='gateway_microcredits'),
  source_price_atomic BIGINT NOT NULL CHECK (source_price_atomic=grant_microcredits),
  quote_id VARCHAR(96) NOT NULL CHECK (length(quote_id)>0),
  quote_snapshot JSONB NOT NULL CHECK (jsonb_typeof(quote_snapshot)='object'),
  network TEXT NOT NULL CHECK (network='tvm:-3'),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('native','jetton')),
  master_address VARCHAR(67),
  asset_decimals SMALLINT NOT NULL CHECK (asset_decimals BETWEEN 0 AND 18),
  amount_atomic BIGINT NOT NULL CHECK (amount_atomic>0),
  recipient VARCHAR(67) NOT NULL CHECK (recipient ~ '^(0|-1):[0-9a-f]{64}$'),
  expected_sender VARCHAR(67) CHECK (expected_sender ~ '^(0|-1):[0-9a-f]{64}$'),
  reference VARCHAR(64) NOT NULL UNIQUE,
  finality_policy_id VARCHAR(96) NOT NULL CHECK (length(finality_policy_id)>0),
  verifier_version VARCHAR(96) NOT NULL CHECK (length(verifier_version)>0),
  quoted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','observed','confirmed','settled','expired','review_required')),
  review_reason VARCHAR(64),
  settled_event_id UUID UNIQUE,
  receipt_id UUID UNIQUE REFERENCES gateway_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  UNIQUE(owner_user_id,org_id,idempotency_key),
  UNIQUE(id,org_id),
  CHECK (expires_at>quoted_at AND quoted_at<=created_at),
  CHECK ((asset_kind='native' AND master_address IS NULL AND asset_decimals=9)
    OR (asset_kind='jetton' AND master_address IS NOT NULL AND master_address ~ '^(0|-1):[0-9a-f]{64}$')),
  CHECK ((status='settled') = (settled_event_id IS NOT NULL AND receipt_id IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (status='settled' OR (settled_event_id IS NULL AND receipt_id IS NULL AND settled_at IS NULL)),
  CHECK ((status='review_required') = (review_reason IS NOT NULL)),
  CHECK (octet_length(request_payload::text)<=16384 AND octet_length(quote_snapshot::text)<=8192)
);

CREATE TABLE ton_chain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network TEXT NOT NULL CHECK (network='tvm:-3'),
  recipient_account VARCHAR(67) NOT NULL CHECK (recipient_account ~ '^(0|-1):[0-9a-f]{64}$'),
  tx_hash CHAR(64) NOT NULL CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  message_hash CHAR(64) NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  tx_lt VARCHAR(78) NOT NULL CHECK (tx_lt ~ '^(0|[1-9][0-9]{0,77})$'),
  message_index INTEGER NOT NULL CHECK (message_index>=0),
  fact_snapshot JSONB NOT NULL CHECK (jsonb_typeof(fact_snapshot)='object'),
  evidence_snapshot JSONB NOT NULL CHECK (jsonb_typeof(evidence_snapshot)='object'),
  observed_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(network,recipient_account,tx_hash,message_hash),
  CHECK (observed_at<=verified_at AND verified_at<=created_at),
  CHECK (octet_length(fact_snapshot::text)<=8192 AND octet_length(evidence_snapshot::text)<=32768)
);
ALTER TABLE ton_invoices ADD CONSTRAINT ton_invoice_settled_event_fk
  FOREIGN KEY(settled_event_id) REFERENCES ton_chain_events(id) ON DELETE RESTRICT;

-- Append-only durable decisions, including second transfers after an invoice settled.
CREATE TABLE ton_invoice_event_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES ton_invoices(id) ON DELETE RESTRICT,
  event_id UUID NOT NULL REFERENCES ton_chain_events(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('settled','review_required')),
  reason VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(invoice_id,event_id),
  CHECK ((decision='review_required') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX ton_event_one_settlement ON ton_invoice_event_decisions(event_id)
  WHERE decision='settled';
CREATE UNIQUE INDEX ton_invoice_one_settlement ON ton_invoice_event_decisions(invoice_id)
  WHERE decision='settled';
CREATE UNIQUE INDEX gateway_transactions_ton_invoice_uniq ON gateway_transactions(request_id)
  WHERE type='topup' AND source='ton';
CREATE INDEX ton_invoices_pending_expiry ON ton_invoices(expires_at,id)
  WHERE status IN ('pending','observed');
CREATE INDEX ton_invoices_owner_read ON ton_invoices(owner_user_id,org_id,created_at,id);
CREATE INDEX ton_invoice_reviews ON ton_invoice_event_decisions(created_at,id)
  WHERE decision='review_required';
```

Jetton branch явно требует `master_address IS NOT NULL`: SQL NULL не должен проходить через UNKNOWN. Reference генерировать `'aiag-ton:' || gen_random_uuid()::text`, не из client key; ≤64. PostgreSQL regex дополнить проверкой отсутствия `chr(10)/chr(13)` для всех bounded identifiers/raw addresses (либо использовать PostgreSQL абсолютные anchors `\A...\Z`); JS validators используют full-input assertion AG-TON1, не `$`.

Новая migration также создаёт три trigger-функции: `aiag_ton_invoice_guard_v1`, `aiag_ton_event_immutable_v1`, `aiag_ton_decision_immutable_v1`. Event/decision UPDATE и DELETE всегда запрещены. Invoice DELETE запрещён; UPDATE допускает только status/review_reason/settled_event_id/receipt_id/updated_at/settled_at. Сравнение остальных колонок — `to_jsonb(NEW) - ARRAY[...allowed keys...] IS DISTINCT FROM to_jsonb(OLD) - ARRAY[...]` → exception `TON_IMMUTABLE`. Valid transitions: pending→observed/expired/review_required; observed→confirmed/review_required; confirmed→settled; expired→review_required; same-state только с неизменными финансовыми полями. Settled/review terminal. Создание всегда pending; trigger запрещает иной initial status. Переход observed→confirmed→settled выполняется внутри одной транзакции; наружу не показывается частично выданный grant.

Добавить deferred constraint trigger `aiag_ton_settlement_consistent_v1` на INSERT/UPDATE invoice и INSERT decision: на COMMIT settled invoice обязан ссылаться на decision settled с тем же event, а receipt — иметь тот же org, request_id `'ton:invoice:'||invoice.id`, type topup/source ton и delta=grant; settled decision обязан иметь matching settled invoice. На COMMIT status confirmed запрещён: подтверждение без атомарного settlement не должно пережить transaction; observed может храниться только для последующего AG-TON3 observation contract. Он сверяет и receipt metadata `invoice_id/order_id/event_id/grant_microcredits`. Это ловит неверный linkage/орфанный receipt при direct SQL тестах; не является защитой от злонамеренного DB superuser. Отдельный trigger ledger scoped только `type='topup' AND source='ton'` запрещает UPDATE/DELETE таких receipts и deferred проверкой INSERT подтверждает matching invoice. Existing non-TON ledger rows не затрагивать.

`fact_snapshot` содержит только immutable normalized external facts: asset identity/decimals, sender, получатель TON invoice и фактически зачисленный account (native recipient либо verified merchant jetton wallet), amountAtomic canonical decimal string≤78digits, reference, tx LT/index, chain timestamp ms. Хранение слишком большой/неправильной суммы в **bounded evidence string** сохраняет поступление для review; это не разрешение persist/grant вне BIGINT. `evidence_snapshot`: block/masterchain anchor, execution path digest, verifier version, finality policy id, actual credit account, allowlisted master/derived merchant wallet для jetton. Все поля и strings ограничены≤96chars кроме raw address/hash и ограниченного evidence JSON; тип/границы проверять до BigInt/JSON serialization. Raw RPC trace/BOC/secrets не хранить здесь. Полное подтверждение finality/path реализует AG-TON3, а не JSON CHECK.

`ton_chain_events` принимает только завершённое verified evidence AG-TON2 trust boundary. Частичные observations/перепроверка finality AG-TON3 должны иметь отдельный append-only observation contract: нельзя UPDATE evidence в этой таблице. Это не блокирует pending→observed transient transition для verified settlement в этой задаче.

## 4. Domain API и transaction protocol

**Create:** `packages/database/src/ton-payments.ts` (без import-time DB/env/network), `packages/database/src/ton-payment-types.ts`, `packages/database/src/functions/ton-invoice-core.sql` (точный mirror migration functions). Экспорт schema через `src/schema/index.ts`; domain/types через `src/index.ts`. Не добавлять runtime DB singleton.

```ts
import type { TonQuote, Asset } from '../../shared/src/ton-payment-contract';
export type AtomicString = string; // Runtime canonical decimal validation mandatory.
export interface TonInvoiceContext { actorUserId: string; orgId: string }
export interface CreateTonInvoiceInput {
  idempotencyKey: string;
  grantMicrocredits: AtomicString;
  priceRevision: string;
  quote: TonQuote;
  recipient: string;
  expectedSender: string | null;
  finalityPolicyId: string;
  verifierVersion: string;
}
export interface TonServerPolicy { allowlist: readonly Asset[] }
export interface TonInvoice {
  schemaVersion: 1; product: 'aggregator'; purpose: 'gateway_topup';
  invoiceId: string; ownerId: string; orgId: string; orderId: string;
  idempotencyKey: string; quoteId: string; quote: TonQuote;
  grantMicrocredits: AtomicString; priceRevision: string;
  network: 'tvm:-3'; asset: Asset; amountAtomic: AtomicString;
  recipient: string; reference: string; expectedSender: string | null;
  finalityPolicyId: string; verifierVersion: string;
  expiresAt: string; createdAt: string;
  status: 'pending'|'observed'|'confirmed'|'settled'|'expired'|'review_required';
  reviewReason: string|null;
}
export interface TonReceipt {
  receiptId: string; invoiceId: string; ownerId: string; orgId: string;
  orderId: string; eventId: string; grantMicrocredits: AtomicString;
  amountAtomic: AtomicString; network: 'tvm:-3'; asset: Asset; settledAt: string;
  paygAfterMicrocredits: AtomicString; refundDebtAfterMicrocredits: AtomicString;
}
export interface VerifiedChainCredit {
  network: 'tvm:-3'; asset: Asset; recipient: string; recipientAccount: string;
  sender: string; amountAtomic: AtomicString; reference: string;
  txHash: string; txLt: string; messageHash: string; messageIndex: number;
  chainTimeMs: number; observedAtMs: number; verifiedAtMs: number;
  blockAnchor: string; masterchainAnchor: string; executionPathDigest: string;
  verifierVersion: string; finalityPolicyId: string;
  jettonCredit: null | { masterAddress: string; merchantJettonWallet: string };
}
export type TonSettlementResult =
  | { kind:'settled'|'already_settled'; receipt:TonReceipt }
  | { kind:'review_required'; invoiceId:string; eventId:string; reason:string }
  | { kind:'not_found' }
  | { kind:'evidence_conflict'; eventId:string };
export interface TonSqlClient {
  query<Row extends Record<string,unknown> = Record<string,unknown>>(
    config:{text:string; values:readonly unknown[]}
  ):Promise<{rows:Row[]; rowCount:number|null}>;
}
export interface TonPaymentDatabase {
  transaction<T>(run:(tx:TonSqlClient)=>Promise<T>):Promise<T>;
}
// Public server domain, not browser endpoints; context comes from server auth.
export declare function createTonInvoice(db:TonPaymentDatabase,
  ctx:TonInvoiceContext,input:CreateTonInvoiceInput,policy:TonServerPolicy):Promise<TonInvoice>;
export declare function getTonInvoice(db:TonPaymentDatabase,
  ctx:TonInvoiceContext,invoiceId:string):Promise<TonInvoice|null>;
export declare function expireTonInvoice(db:TonPaymentDatabase,
  invoiceId:string):Promise<'expired'|'unchanged'|'not_found'>;
// Internal AG-TON3 entry only. No public route may deserialize this argument.
export declare function settleTonInvoice(db:TonPaymentDatabase,
  invoiceId:string,credit:VerifiedChainCredit):Promise<TonSettlementResult>;
```

`TonPaymentDatabase` — adapter к существующему transaction-capable pg/Drizzle client, callback на одном connection, BEGIN/COMMIT/ROLLBACK. Native harness adapter использует guarded `pg` client. Не принимать Neon HTTP fake transaction за native transaction. Перед выдачей результатов amounts выбрать `::text`; JSONB metadata sums строками. Public invoice читает receipt отдельно только после owner SQL filter; raw chain evidence не отдавать клиенту.

**Trust boundary:** TypeScript interface/brand и поля `verifierVersion` сами не доказывают оплату. AG-TON2 вообще не имеет сетевого production caller; native fixture напрямую вызывает internal method, что является тестовым допущением. AG-TON3 обязан вызывать его только после собственной серверной проверки full trace/inclusion/finality и asset trust pin исходной invoice. Текущий allowlist управляет новыми invoices, не отменяет immutable старые обязательства; особая security revocation может отдельно запретить новое settlement и отправить его в review, но не изменяет create/status/settled replay. AG-TON4 status endpoint получает лишь invoiceId, вызывает server verifier/sweep; JSON пользователя, TON Connect result/BOC, RPC HTTP200 не конструируют VerifiedChainCredit. Не экспортировать `verified:true` factory/HTTP settlement endpoint. До независимого AG-TON3 review и import-boundary test runtime settlement выключен. SQL функции не объявлять SECURITY DEFINER; миграция `REVOKE EXECUTE ... FROM PUBLIC`, не выдавать grants произвольным ролям и не изобретать production role names. Разрешение worker DB principal проверяется в последующем integration/release gate.

SQL entrypoints mirror (все parameters prepared, возвращают JSONB со строковыми денежными полями):

```sql
-- Normalized payload содержит все входные immutable fields и quote.
aiag_create_ton_invoice_v1(_actor UUID,_org UUID,_payload JSONB,_fingerprint TEXT) RETURNS JSONB
aiag_read_ton_invoice_v1(_actor UUID,_org UUID,_invoice UUID) RETURNS JSONB
aiag_expire_ton_invoice_v1(_invoice UUID) RETURNS TEXT
aiag_settle_ton_invoice_v1(_invoice UUID,_credit JSONB) RETURNS JSONB
```

DB functions проверяют те же top-up единицы, parsed canonical positive amounts и schemaVersion, quote snapshot equality с denormalized columns, payload bounds/identifier/time/asset fields **до casts**. Quote FX arithmetic остаётся accepted shared code, а SQL дополнительно сверяет `source amount*numerator/denominator` c exact NUMERIC и явным rounding/fee, с guard product≤9223372036854775807; не разрешать более широкий FX policy в DB. `floor`, `ceil`, `half-up` реализовать через quotient/remainder, half-up `remainder>=denominator-remainder`; denominator/numerator>0, fee≥0, result>0/max. `quotedAt<=now`, quote expiry≤FX expiry, FX observed≤quotedAt, equal source/target asset. Create replay ищется после auth/key/payload structural normalization, **до current-allowlist/freshness/refund/compatibility guard**, но не до проверки исходного payload equality.

### Create/read/expiry

- Create: lock organization FOR UPDATE by org+owner; validate same user active/unbanned and org active; lookup `(owner,org,key)`. При существующей строке сравнить payload/hash и вернуть persisted. При новой — текущий server allowlist, refund guard, compatibility ceiling grant/currentPayg/result, свежесть по `clock_timestamp()` после ожидания lock, canonical quote checks; INSERT pending с генерируемыми IDs/reference; unique order/reference retry ограниченно только при доказанном UUID collision в этой же transaction savepoint, иначе rollback. Не менять баланс.
- Read: plain filtered SELECT без изменения expired status и без DB lock; expire вызывается отдельной внутренней функцией. Read не проверяет/не зачисляет chain payment.
- Expire: untrusted no-lock org hint из invoice, затем org FOR UPDATE → invoice FOR UPDATE, повторить binding. `UPDATE ... WHERE status='pending' AND expires_at<=clock_timestamp() RETURNING id`; observed без полного evidence не помечать expired автоматически, требуется review AG-TON3. Missing возвращает not_found. Порядок lock тот же, что settlement.

### Settlement: точная последовательность

1. Validate bounded evidence shape before DB; отсутствующий finality/path/jettonCredit либо invalid network → отказ до insert (typed validation error), zero grant. Непроверенные/неполные trace остаются AG-TON3 observations; этот entry не превращает их в verified credit.
2. Read invoice org hint без lock; transaction: org FOR UPDATE → invoice FOR UPDATE. Повторно проверить org binding. Никакого RPC под lock. Unknown invoice → not_found; несопоставленные incoming transfers сохраняет AG-TON3 durable reconciliation, не выдуманная invoice.
3. Insert canonical event `ON CONFLICT(network,recipient_account,tx_hash,message_hash) DO NOTHING RETURNING id`, затем SELECT того же event FOR UPDATE. Unique insert conflict ждёт существующую txn. Нельзя брать второй org/invoice lock после event; foreign settlement читается без lock, текущая invoice уходит review. Сравнить canonical `fact_snapshot` без наблюдательных timestamps. Изменённый amount/asset/LT/messageIndex/reference/sender/chainTime при том же key → evidence_conflict, сохранить первое evidence; не перезаписывать/не выдавать credits. Более поздний verifiedAt/anchor retry не меняет первичную immutable evidence и не создаёт новый event.
4. Если decision для `(invoice,event)` уже существует — вернуть original receipt либо original review reason. Не переоценивать expiry, balances, debt или новый FX для replay. Receipt возвращается из сохранённых metadata; post-balance не пересчитывается по текущему org. Если invoice settled **другим** event: создать review decision `additional_transfer`, сохранить event, вернуть review, invoice/receipt оставить settled; не закрывать уже выполненный заказ обратно.
5. Если event уже consumed другой invoice — создать только текущую review decision `event_already_consumed`, текущая незавершённая invoice→review; не трогать чужую invoice/org. Event uniqueness недостаточен без этой проверки и unique settled indexes.
6. Reason precedence для нового decision: terminal review (`invoice_in_review`, сохраняется исходный invoice.review_reason) → expired/`now>=expires_at` или chainTime>=expires_at (`late_payment`) → owner drift (`owner_changed`) → wrong recipient/asset/decimals/reference/sender, mismatch native recipientAccount или jetton merchant wallet/master (`payment_mismatch`) → verifierVersion/finalityPolicyId не равны pinned invoice (`verification_policy_mismatch`) → amount<expected (`underpayment`) / amount>expected (`overpayment`) → debt/active refund (`refund_blocked`) → negative currentPayg (`balance_invariant`) → grant/currentPayg/result выше9007199254740991 (`balance_compatibility_limit`). Для нескольких **уже известных** distinct linked events незавершённой invoice — `multiple_transfers`; не складывать partial amounts. После первого exact settlement второй перевод остаётся отдельным review, не ретроактивно отзывает grant.
7. В любом review branch записать immutable event decision и CAS invoice pending/observed/expired→review_required (если уже terminal — не переписывать первоначальную причину). Review сохраняется transaction COMMIT; это не exception, который откатит факт поступления. Wrong network/невалидная форма не принимается в testnet event table и фиксируется verifier reconciliation AG-TON3.
8. Для разрешённого payment: `pending→observed→confirmed` посредством guarded UPDATE RETURNING; если статус уже observed, начать со второго перехода. Выполнить balance update ниже. Insert gateway receipt, unique settled decision, затем `confirmed→settled` с receipt/event/time; сверить все rowCount=1. Любой unexpected affected-row/unique/CAS failure → exception и полный ROLLBACK. Expected review reasons определяются **до** промежуточных переходов.

```sql
UPDATE organizations
SET payg_credits=payg_credits+_grant, updated_at=clock_timestamp()
WHERE id=_org AND owner_id=_owner AND payg_credits>=0
  AND refund_debt_credits=0
  AND _grant BETWEEN 1 AND 9007199254740991::bigint
  AND payg_credits<=9007199254740991::bigint-_grant
  AND NOT EXISTS(SELECT 1 FROM payments
    WHERE topup_org_id=_org AND refund_claim_id IS NOT NULL)
RETURNING payg_credits::text,refund_debt_credits::text;

INSERT INTO gateway_transactions(org_id,request_id,type,source,delta,metadata)
VALUES (_org,'ton:invoice:'||_invoice::text,'topup','ton',_grant,
  jsonb_build_object('schema_version',1,'invoice_id',_invoice::text,
    'order_id',_order::text,'event_id',_event::text,'owner_user_id',_owner::text,
    'grant_microcredits',_grant::text,'amount_atomic',_amount::text,
    'asset',_asset_json,'network','tvm:-3','price_revision',_revision,
    'quote_id',_quote_id,'payg_after_microcredits',_payg_after_text,
    'refund_debt_after_microcredits','0','settled_at',_settled_at))
RETURNING id;

UPDATE ton_invoices
SET status='settled',settled_event_id=_event,receipt_id=_receipt,
    settled_at=_settled_at,updated_at=_settled_at
WHERE id=_invoice AND org_id=_org AND owner_user_id=_owner
  AND status='confirmed' AND settled_event_id IS NULL AND receipt_id IS NULL
RETURNING id;
```

`_grant` positive signed BIGINT и дополнительный compatibility ceiling проверены заранее. Такой же guard используется при new create, иначе TON_BALANCE_COMPATIBILITY_LIMIT. Settlement заранее превращает ожидаемое превышение ceiling в durable review; zero-row после предварительных проверок — unexpected failure и rollback. Arithmetic guard использует subtraction, не потенциально overflowing `payg+grant<=max`. Сохранять original receipt full fields и timestamp одной txn. Не делать `ON CONFLICT DO NOTHING` для receipt после balance update: неожиданный duplicate требует rollback, original replay отрабатывает до update.

Transaction expiry policy намеренно консервативна: **первое зачисление требует now<expiresAt и chainTime<expiresAt**, даже если verifier задержался после on-time transfer. Позднее подтверждение уходит review; settled replay всегда возвращает receipt. DB clock, а не client time, решает expiry. Quote/finality pin исходной invoice не обновлять. Любое изменение этой политики после ревью требует новой версии, не silent reprice.

## 5. Файлы и последовательность реализации после ревью

### Task AG-TON2.0: disposable whole-DB native fixture и отдельный guard

**Create:** `packages/database/scripts/native-ton-core-test.ts` (parent provision→migrate→child→cleanup), `packages/database/scripts/ton-core-test-db-guard.ts` (узкий child guard), `packages/database/scripts/__tests__/native-ton-core-test.test.ts`, `packages/database/scripts/__tests__/ton-core-test-db-guard.test.ts` (negative lifecycle/guard proofs). **Modify later:** root `package.json` только после MC3 для script `test:ton-core-native` и обязательной последовательной регистрации. Этот design не создаёт helpers и не запускает provision.

**Problem:** Invoice/event/decision/TON receipts запрещают DELETE, а multi-connection committed races нельзя откатить одной внешней transaction. Поэтому **все TON native fixtures, включая реальные RUB refund calls, выполняются исключительно в отдельной одноразовой whole database `ai_aggregator_ton_core_test`** на127.0.0.1:15432. Никакого DROP SCHEMA, DELETE/disable triggers ради cleanup или committed TON rows в shared `ai_aggregator_test`. Изоляция по уникальному org не заменяет изоляцию БД.

**Interfaces:** parent `runTonCoreNativeTests(env, {clientFactory?, childRunner?}) -> Promise<TonCoreNativeEvidence>`; опции только для unit injected fakes, не принимают URL/target override. CLI не принимает positional flags/имя БД. Child `assertTonCoreTestEnvironment(env)` — pure static check; `withTonCoreTestDatabase(env, options, callback)` — fixed identity+marker gate перед передачей client; создание соединений fixture только через этот entry. Reuse generic `TestDatabaseClient`/query types можно, **`assertTestDatabaseEnvironment` не расширяется** и по-прежнему отвергает любое имя, кроме canonical `ai_aggregator_test`.

```ts
export interface TonCoreNativeEvidence {
  ok: boolean;
  target: 'ai_aggregator_ton_core_test';
  createdByThisRun: boolean;
  first?: {total:number; applied:number; skipped:number};
  rerun?: {total:number; applied:number; skipped:number};
  child?: {exitCode:number|null; timedOut:boolean; passed:number; failed:number; skipped:number};
  targetSessionsAfterChild?: number;
  cleanup: 'not_created'|'cleanup_unverified'|'dropped';
  canonicalUnchanged: boolean|null;
  error?: string; // Sanitized stage code, never URL/credentials/raw pg error.
  gaps: string[];
}
```

- [ ] **Parent guard до client import:** по существующему clean-rehearsal pattern вызвать canonical `assertTestDatabaseEnvironment(env)` → `withGuardedTestDatabase` с marker bootstrap **выключенным**. Сохранить canonical identity/OID/marker/schema_migrations raw+effective hashes для before/after. Parent не делает bootstrap/migrate/DML/DDL в canonical schema; единственные cluster-level mutations — CREATE/DROP фиксированной отдельной БД. Root baseline может запускать свои прежние canonical suites до этого helper, но TON helper туда fixtures не пишет.
- [ ] **Exclusive ownership:** проверить CREATEDB permission и отсутствие fixed target в `pg_database`; существующая БД всегда `existing_target`, даже если name/marker похожи. Не adopt/drop/reuse. Затем literal `CREATE DATABASE ai_aggregator_ton_core_test TEMPLATE template0`, успешный ACK, получить OID и проверить live `current_database()/inet_server_addr()/inet_server_port()/OID`. Target обязан быть пустым по проверке user objects из clean runner. Только тогда создать `_aiag_test_database_marker` с singleton marker `ai-aggregator:ton-core:<fresh UUID>:<fresh 32-byte random hex>`. Parent хранит original OID/marker и `createdByThisRun` только в памяти вызова; до marker establishment никакой автоматической попытки DROP при неопределённом исходе.
- [ ] **Provision до child:** после live identity+marker checks применить полный фактический manifest (ожидается72/last0072 после назначения), сверить schema_migrations checksums и повторный no-op. Создать tables/functions в disposable target существующим `runNativeMigrations`; не вызывать canonical-only `native-test-db.ts` с новым URL и не копировать `.env`. Child запрещено bootstrap/migrate/создавать marker. Ошибка migrations → child не запускается, ownership-qualified cleanup выполняется в finally.
- [ ] **Child env до любых imports:** derive target URL из validated canonical credentials с literal pathname `/ai_aggregator_ton_core_test`, очистить URL query options. В **новом процессе** установить одинаковые `DATABASE_URL` и `TEST_DATABASE_URL` на target; `AIAG_TON_CORE_TEST='1'`, `RUN_TON_CORE_DB_INTEGRATION='1'`, `AIAG_TON_CORE_TEST_DB_OID=<parent OID>`, `AIAG_TON_CORE_TEST_RUN_ID=<generated UUID>`, `AIAG_TON_CORE_TEST_MARKER_SHA256=<hash exact marker>`. Удалить `RUN_NATIVE_DB_INTEGRATION`; не запускать стандартные canonical suites на target. Env/marker не печатать, ничего не сохранять на диск. Нельзя менять process.env после import real refund/db module в том же процессе и считать это изоляцией.
- [ ] **Child invocation:** parent через argument array и тот же Bun executable (`process.execPath`, когда parent запущен Bun) запускает `['x','--no-install','vitest','run','--no-file-parallelism','--reporter=json','packages/database/scripts/__tests__/ton-payments.native.integration.test.ts']`, cwd canonical repo. Child stdout/stderr собираются bounded pipes≤1MiB, наружу выдаётся только sanitized stage/count summary. Vitest JSON report парсится в памяти: exact suite path присутствует, total>0, passed=total, failed0, skipped0; отсутствие/oversize/invalid report — fail, exit0 недостаточно. Никакой shell interpolation/установки npm packages. Общий timeout180000ms, SIGTERM и ограниченное ожидание exit10s; при необходимости завершить принадлежащий runner process group, не посторонние процессы. Timeout/nonzero exit всегда fail; после неясного завершения DB не удалять, пока исчезновение всех target sessions не доказано. Child не запускает descendants, кроме собственного Vitest runner/workers; close-on-parent-exit и bounded worker shutdown проверить. На Linux runner создаёт только свою process group (`detached:true`) и сигналит лишь сохранённый собственный group ID, без поиска/kill по именам. Новый helper не берёт повторно heavy flock: его держит внешний root command.
- [ ] **Dedicated child guard:** module-level pure check при RUN_TON_CORE_DB_INTEGRATION1 до dynamic `pg`/Drizzle/domain/refund imports. Allow только protocol postgres/postgresql, literal host127.0.0.1, port15432, literal db `ai_aggregator_ton_core_test`, одинаковые DATABASE_URL/TEST_DATABASE_URL, отсутствие URL query options/identity aliases, flags ровно1, UUID/positive OID/hash64 в ожидаемой форме. Missing/mismatch/remote/canonical/clean72/arbitrary target отвергать до factory construction. Live gate каждого нового connection сверяет exact database/host/port/OID и SHA256 marker, marker runId обязан совпасть с env. Env-флаг сам по себе не является proof; guard никогда не создаёт marker. До live identity proof разрешены лишь identity/marker SELECT; callback SQL и dynamic import реального refund module только после успеха. Factory imports driver после static check, schema/domain/refund imports — после live checks.
- [ ] **Все реальные clients закрываемы:** fixture ведёт registry всех guarded `pg.Client` и связанных Drizzle adapters (≤24 одновременных connections:20racers+observer+setup+reserve); каждый новый racer/restart connection проходит dedicated guard. Создать Drizzle на уже проверенном explicit client; TON transaction adapter и RUB `database` argument получают этот adapter. Не обращаться к lazy global `apps/web/src/lib/db.ts` default connection. `claimTopupRefund(paymentId,amount,context,refundDb)`, `markTopupRefundDispatched(claimId,refundDb)`, `finalizeTopupRefundProof(claimId,proof,refundDb)` используют настоящие функции с explicit transaction-capable dependency. Dynamic import после gate, module test подтверждает ноль обращения к default db proxy. `afterAll/finally` завершает все explicit clients с timeout5s/connection и общим close budget30s; перед закрытием rollback оставшихся test transactions, если connection живой. Не оставлять pool без `.end()` или default-client singleton.
- [ ] **Cleanup whole DB:** после child exit parent проверяет отсутствующие target sessions по `pg_stat_activity`/target OID, кроме своего admin target connection; recheck live target identity/OID/exact marker. Закрыть этот последний target client, дождаться ACK и повторно из canonical admin connection проверить original OID и **zero** target sessions. Только при proof `createdByThisRun && createACK && originalOID && markerEstablished && markerVerified && allClientsClosed` literal `DROP DATABASE ai_aggregator_ton_core_test` без FORCE/retry/adoption. После DROP ACK проверить отсутствие fixed target. Любая foreign session, changed OID/marker, close timeout/CREATE or DROP ACK loss → fail + `cleanup_unverified`, без terminate чужих DB sessions и без повторного DROP. Если DB была до запуска: cleanup `not_created`, ничего не удалять. Canonical identity/marker/migration snapshot сверить снова даже после failure. `ok=true` требует child exit0, expected fresh/no-op counts, zero sessions, cleanup dropped и canonicalUnchanged true.
- [ ] **Negative proofs в unit helpers до native RED:** denied env не создаёт clients/import callbacks; mismatch live identity/OID/marker не вызывает fixture SQL/refund import; existing target не выполняет CREATE/DROP; empty-target check failure не запускает migrations/child; wrong parent/child URL не запускает child; CREATE ACK loss не даёт ownership; marker/OID drift/close failure/foreign sessions не даёт DROP; migration/child failure при доказанном владении корректно закрывает clients и чистит whole DB; DROP ACK loss не retry; canonical snapshot mismatch никогда не PASS. Поддельный RUN flag/marker hash без matching live marker не открывает connection callback. Unit проверяет exact fixed SQL/child args/env до import и отсутствие `FORCE`, `DROP SCHEMA`, trigger disabling и target override APIs.
- [ ] **Native isolation evidence:** child действительно делает committed create/settlement в разных connections и видит их после reconnect; DELETE guards остаются enabled и запрещают удаление. После успешного helper target отсутствует, canonical identity/marker/migration ledger и контрольные row-counts `ton_invoices/ton_chain_events/ton_invoice_event_decisions/gateway_transactions` равны before. Counters читать только если соответствующие tables уже существуют. No row-count-only acceptance: read-only parent SQL inventory подтверждает отсутствие canonical mutation. Failure injection в child после committed TON settlement → nonzero child, owned target cleanup dropped, canonical untouched. Child skipped0 assertions не PASS: зафиксировать, что named mandatory suite выполнен, а не skipped. Все isolation tests на одном heavy lock.

### Task AG-TON2.1: contract/fixtures и native RED

**Create:** `packages/database/src/ton-payment-types.ts`, `packages/database/scripts/__tests__/ton-payments.native.integration.test.ts`, `packages/database/scripts/__tests__/ton-payments.native.fixture.ts`, `packages/database/src/__tests__/ton-payments.test.ts`.

**Consumes:** accepted AG-TON1 `Asset`, `TonQuote`, `createQuote`, exact amount helpers; dedicated TON disposable DB guard/client contracts task2.0. **Produces:** interfaces раздела4; fixture `openTonFixture`, `createInput`, `verifiedCredit`, `snapshot`, `close` с реальным transaction adapter.

- [ ] Определить types строго по разделу4 и synthetic fixtures: два active users/orgs, payg0, debt0, quote unit gateway_microcredits, grant`9007199254740991`, native amount`9007199254740993`, synthetic numerator/denominator1, fee2, raw testnet address `'0:'+'1'.repeat(64)`, finality policy `fixture-only-v1`, quote TTL120000ms. Тестовый identity/rate не экспортировать в runtime policy.
- [ ] Guard: module-level `if (RUN_TON_CORE_DB_INTEGRATION==='1') assertTonCoreTestEnvironment(process.env)` до dynamic driver/domain imports; live proof каждого client через `withTonCoreTestDatabase`, затем refund module import. Этот native suite запускается только child task2.0. Уникальные own IDs разделяют tests внутри disposable target; committed immutable fixtures остаются до безопасного DROP **whole owned DB** parent. Ни rollback всей suite, ни schema disposal в shared canonical DB, ни отключение immutable triggers не являются cleanup.
- [ ] Написать native RED, использующий **настоящие функции**, не ручной SQL clone. Fixture `snapshot(invoiceId)` возвращает canonical `{payg,debt,subscription,receiptCount,eventCount,decisionCount,status}`; `f.create()` вызывает createTonInvoice с f.ctx/input/policy, `f.settle(id,event)` вызывает settleTonInvoice.

```ts
it('twenty create retries return one server order and immutable invoice', async () => {
  const invoices = await Promise.all(Array.from({length:20}, () => f.create()));
  expect(new Set(invoices.map(x=>x.invoiceId)).size).toBe(1);
  expect(new Set(invoices.map(x=>x.orderId)).size).toBe(1);
  expect(new Set(invoices.map(x=>x.reference)).size).toBe(1);
  await expect(f.create({priceRevision:'fixture-price-v2'}))
    .rejects.toThrow('TON_IDEMPOTENCY_CONFLICT');
});
it('poll and sweep races reach the exact PAYG ceiling while TON amount stays above 2^53', async () => {
  const invoice = await f.create();
  const credit = f.verifiedCredit(invoice);
  const results = await Promise.all(Array.from({length:20},()=>f.settle(invoice.invoiceId,credit)));
  expect(results.filter(x=>x.kind==='settled')).toHaveLength(1);
  expect(results.filter(x=>x.kind==='already_settled')).toHaveLength(19);
  expect(await f.snapshot(invoice.invoiceId)).toMatchObject({
    payg:'9007199254740991',debt:'0',receiptCount:1,eventCount:1,decisionCount:1,status:'settled'
  });
});
it('debt appearing after creation retains paid evidence and never grants on replay', async () => {
  const invoice = await f.create();
  await f.setOrgDebt('1000'); // Test setup prepared SQL under org lock.
  const credit = f.verifiedCredit(invoice);
  expect(await f.settle(invoice.invoiceId,credit)).toMatchObject({kind:'review_required',reason:'refund_blocked'});
  expect(await f.snapshot(invoice.invoiceId)).toMatchObject({payg:'0',debt:'1000',receiptCount:0,eventCount:1,status:'review_required'});
  await f.setOrgDebt('0');
  expect(await f.settle(invoice.invoiceId,credit)).toMatchObject({kind:'review_required',reason:'refund_blocked'});
  expect(await f.snapshot(invoice.invoiceId)).toMatchObject({payg:'0',receiptCount:0,eventCount:1,status:'review_required'});
});
```

- [ ] Run focused suite RED под heavy lock через `test:ton-core-native` provision/child helper, записать missing-function/table, а не unrelated import failure. Если Bun/runtime helper отсутствует — подготовить среду отдельным назначением, не обходить guard.

### Task AG-TON2.2: additive persistence и exact create/read

**Create:** `packages/database/migrations/0072_ton_invoice_core.sql` (после recheck), `packages/database/src/schema/ton-payments.ts`, `packages/database/src/functions/ton-invoice-core.sql`, `packages/database/src/ton-payments.ts`.
**Modify:** `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`, `packages/database/scripts/__tests__/native-migrate.test.ts`, `packages/database/scripts/__tests__/native-baseline.integration.test.ts`.
**Produces:** schema/immutable triggers, create/read/expiry SQL functions + transaction wrappers. Migration текущей task2 содержит все финальные functions, checksum фиксируется только перед shared application/commit; после применения исправления отдельной новой migration, не rewrite.

- [ ] Реализовать DDL/guards разделов1–4; зеркалить named SQL functions в source, baseline проверяет latest applied definition, а не наличие похожей строки. Schema export только additive.
- [ ] `createTonInvoice` нормализует bounded canonical request **без current allowlist/freshness validation**, вычисляет SHA256 named normalized JSON, в transaction блокирует org и ищет key. Если key существует — сравнить исходный payload и вызвать replay без `createQuote`/новой policy; если key отсутствует — проверить accepted quote против current allowlist под тем же lock. Wrapper вызывает `SELECT aiag_create_ton_invoice_v1($1::uuid,$2::uuid,$3::jsonb,$4::text)` в transaction. `getTonInvoice` вызывает owner-filtered SQL, serializer не использует numeric mapper. Unit fake client проверяет prepared values/import safety/decimal strings; native проверяет реальный equality и auth.
- [ ] Write/PASS случаи: zero/negative/sign/exponent/newline/leading zeros, oversized strings до allocation, sourcePrice mismatch, sourceUnit arbitrary, altered quoteAmount/fee/FX/priceRevision, AG-TON1 atomic BIGINT max/max+1 отдельно от grant/result compatibility ceiling/ceiling+1, stale quote, FX product overflow, wrong native decimals/jetton master/allowlist, wrong owner/org, member без ownership, same key+same content replay после expiry, после удаления asset из current allowlist и после изменения decimals конфигурации; stale/removed asset для **нового key** отказ без invoice; replay с altered asset/decimals payload409, независимо от current allowlist; same key+изменённый snapshot409, разные keys разные TON orders. Unique quoteId не вводить: одна серверная quote может встретиться повторно, order/idempotency обеспечивают отдельный purchase intent.
- [ ] Native direct UPDATE immutable owner/org/order/grant/quote/reference → TON_IMMUTABLE; deleting financial history rejected; review can't return pending; duplicate/mismatched receipt linkage fails at commit. PASS read projection отсутствия evidence/secrets.
- [ ] Focused TS review обязателен для новых TS changes, financial/spec review проверяет schema и units. Scoped commit только owned files после review.

### Task AG-TON2.3: atomic settlement/review и recovery

**Modify:** новые `ton-payments.ts`, `ton-invoice-core.sql`, ещё не применённая task migration, native/unit fixture/test files из2.1.
**Consumes/Produces:** verified internal input и persisted invoice → `TonSettlementResult` раздела4. Не создаёт network adapter или worker startup.

- [ ] Реализовать settlement protocol exactly из раздела4, normalizer фактов отдельно от observation metadata. Retry одного event с другим sender/amount/messageIndex/LT/asset не обновляет первую запись и не начисляет. Invalid/incomplete evidence отвергается до SQL. Review commits evidence, unexpected errors roll back.
- [ ] Native PASS для двадцати одинаковых poll/sweep; двух invoices разных org с одним event; двух events одного invoice; concurrent expiry; replay после commit/потери ACK; restart новым DB client; partial/over/exact-after-partial; expired с переводом до/после expiry; wrong reference/recipient/sender/master/decimals; jettonCredit отсутствует/wallet mismatch; verifier/finality version mismatch; resulting PAYG ceiling+grant overflow→durable review, exactceiling allowed; existing unsafe legacy balance→newcreate denied / existing paidinvoice review без autoheal; запрет negative initial balance. Повтор review после последующего снижения balance не выдаёт grant автоматически.
- [ ] Две controlled interleavings для RUB refund: использовать реальную `finalizeTopupRefundProof` через guarded dynamic import и native refund fixture. Gate A удерживает org row в TON txn, запускает настоящий refund, освобождает → refund применяет обычный clawback; gate B сначала реальный refund claim/finalize, потом TON→review. Lock timeout bounded и ноль deadlocks; не заменять refund простой изменённой debt строкой как единственное доказательство совместимости. Existing active-claim admission guard остаётся REFUND_BLOCKED после TON review.
- [ ] Добавить обязательную **TON-before-real-RUB-refund** matrix в native suite на отдельных owned orgs. До TON создать исторический RUB topup `payments` fixture по существующему native refund setup: currency RUB, confirmed, paid100kopecks, topup_grant_credits1000, refunded/clawed0, matching providerPaymentId/orderId, без активного claim. Сам TON не пишет этот fixture и не вызывает network. Установить initial PAYG prepared bigint string, не Number.

| Native case | Действие TON | Обязательное состояние и последующий настоящий RUB refund |
|---|---|---|
| Create crossing2^53 | initial PAYG`9007199254740989`, новый grant`3` дал бы`9007199254740992` | `TON_BALANCE_COMPATIBILITY_LIMIT`; invoice/event/TONreceipt0, PAYG прежний/debt0. Затем реальный refund100kopecks claw1000 успешно даёт PAYG`9007199254739989`, debt0. |
| Exact ceiling | initial PAYG`9007199254740989`, create/settle grant`2` | Successful PAYG`9007199254740991`, один TON receipt delta2. Затем реальный refund100kopecks claw1000 успешно даёт PAYG`9007199254739991`, debt0. |
| Concurrent growth after create | initial PAYG`9007199254740989`; create grant`2`; другая connection под org lock прибавляет`1` и commit до TON settle | Новый входящий event остаётся review `balance_compatibility_limit`, receipt0, PAYG`9007199254740990`, debt0. Затем настоящий refund100kopecks claw1000 успешно даёт PAYG`9007199254739990`; повтор TON event остаётся review и не начисляет освободившийся headroom. |
| Already unsafe legacy row | Create при PAYG`9007199254740992`; отдельно invoice создана безопасно, после чего fixture делает legacy PAYG таким же unsafe | New create denied; existing paid invoice→review, PAYG остаётся unsafe/debt неизменен. Нельзя объявлять последующий legacy refund успешным: это известная исходная несовместимость, которую TON не чинит. |
| Grant itself above ceiling | PAYG0, grant`9007199254740992`, точная валидная quote | New create denied, no invoice/receipt/organization writes; AG-TON1 conversion/parser этого exact integer остаётся допустимым до TON-specific admission guard. |

Для первых трёх cases **после** результата TON вызвать действующие `claimTopupRefund(paymentId,100,contextFor(...,'full_no_receipt'),refundDb)`, `markTopupRefundDispatched(claimId,refundDb)`, `finalizeTopupRefundProof(claimId,{paymentId:providerPaymentId,orderId:providerOrderId,externalRequestId:claim.providerKey,status:'REFUNDED',originalAmountKopecks:100,newAmountKopecks:0},refundDb)`. Использовать dedicated live guard-before-dynamic-import, whole disposable TON DB и настоящий refund module с explicit guarded `refundDb`; существующий canonical native refund suite повторно не импортировать/не запускать как fixture. Ожидать `kind:'settled'`, clawedCredits1000, paygRemovedCredits1000, debtAddedCredits0, payment.status refunded и один RUB receipt type refund/source payg; replay proof→already_settled. Это обязательная regression для HIGH finding; подстановка mock refund либо простой ручной debit1000 её не заменяет. Concurrent-growth write — только setup отдельной guarded fixture, не новый runtime top-up route.

- [ ] Failure injection реальной SQL txn: fixture trigger с уникальным именем только на own org/invoice raises exception на receipt insert, затем на final invoice CAS. После каждого `snapshot` до/после равны, нет event/decision/receipt/grant; убрать fixture trigger в finally. Trigger creation/drop — только guarded disposable fixture DB и serialized run. Никаких production debug flags.
- [ ] ACK loss: дождаться успешного DB commit, fixture wrapper бросает synthetic transport error; новый connection retry возвращает **те же** receiptId/event/order/grant/post-balances. Изменить current balance отдельным тестовым consumption перед replay и проверить, что receipt original post-balance не пересчитан. Реальные RPC crashes/testnet этим не доказаны.
- [ ] Native SQL conservation assertion для every settled invoice, mismatch/extra receipt negative cases и no other balances (`users.balance`, subscription, RUB payments) changes. Параллельные денежные тесты используют раздельные connection; один connection с Promise.all не доказывает DB concurrency.

### Task AG-TON2.4: manifest, mandatory suite и clean72 rehearsal

**Modify:** root `package.json`, `packages/database/scripts/native-clean-rehearsal.ts`, `packages/database/scripts/__tests__/native-clean-rehearsal.test.ts`, `packages/database/scripts/__tests__/native-migrate.test.ts`, `packages/database/scripts/__tests__/native-baseline.integration.test.ts`.
**Consumes:** reviewed additive migration+functions. **Produces:** mandatory TON native suite, immutable history/no-op/fresh-DB evidence, clean runner fixed target72 с сохранёнными guard/ownership/cleanup гарантиями.

- [ ] После MC3 добавить root script `"test:ton-core-native": "bun run packages/database/scripts/native-ton-core-test.ts"`. В `test:database-baseline` сохранить весь существующий canonical command/список MC3 с `--no-file-parallelism`, затем append `&& bun run test:ton-core-native`. **Не** добавлять TON native файл в canonical Vitest invocation. Сохранить чужие изменения baseline; запуск child обязателен, fail/skip/cleanup-unverified даёт nonzero всему baseline. Обновить manifest count/last72 в native-migrate test; добавить TON tables/signatures/constraints/mirror в native baseline. Не менять discovery algorithm и старые adapter/checksum exceptions.
- [ ] Преобразовать clean runner в fixed `ai_aggregator_clean72_test`/marker `ai-aggregator:clean72:<runUUID>`, `db:test:clean72`; старую `db:test:clean71` alias не сохранять как ложный71 PASS. Обновить unit tests exact CREATE/DROP/name/marker/count/last и negative inventories. Не принимать caller target override, не добавлять FORCE/drop retry/adoption. Сохранить canonical snapshot, live identity host127.0.0.1:15432, OID+marker ownership, close/error redaction и cleanup_unverified при ACK uncertainty.
- [ ] Сохранить FROZEN0067–0070 hashes, добавить0071 `f2fe7fffa30cc03b79712c92b09a7c932ec7af6f84a6abfe759d201dd2eff173`. Сверить остальные original migration hashes по preimplementation manifest. Fresh72: applied72/skipped0; rerun applied0/skipped72, ledger raw/effective checksums match; TON tables/functions verified. Canonical DB identity/marker/migration ledger неизменны после temporary clean DB; cleanup доказан dropped.
- [ ] Native rollback migration failure: runNativeMigrations внутри owned `ai_aggregator_ton_core_test` отдельного parent invocation task2.0 с fixture failing migration после создания test object, подтверждает rollback object и отсутствие schema_migrations записи. Не портить реальную0072 и не запускать fail-file в canonical DB. Existing migrator checksum mismatch/no-op tests сохранить.
- [ ] До/после native run записать фактический manifest/head/dirty paths; если соседний owner изменил package baseline или новую migration — rebase expectations, не перезаписывать его edits.

### Task AG-TON2.5: review и handoff без runtime activation

**Modify:** только этот focused plan для accepted evidence после независимого review; private task report под `.superpowers/sdd/2026-09-07-ton-payments/` при явном ownership следующего задания. General TON plan/entrypoint/controller обновляет интегратор.

- [ ] Выполнить проверки ниже последовательно; если test skipped вместо native executed — gate открыт. Financial reviewer получает immutable scoped diff, commands/results, debt/expiry rationale, source discriminator inventory, mismatch/replay evidence. TS reviewer получает те же source/tests; никакой self-approval.
- [ ] Закрыть review findings scoped fixes и повторить затронутые проверки. Не расширять на AG-TON3/4/5, runtime checkout, real testnet или migration production.
- [ ] В report разделить `design reviewed`, `native fixture core`, `trusted verifier unavailable`, `live testnet not run`, `runtime disabled`. Successful grant в fixture не означает работающий rail и не меняет readiness score.

## 6. Команды проверки и release gates

Команды — для последующего исполнителя после разрешения реализации и подтверждения штатного Bun/helper; CLI использует `bun x --no-install`, отдельный executable `bunx` не предполагается. Для focused native RED/PASS запускать `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run test:ton-core-native`; baseline ниже включает этот helper как обязательный отдельный этап. Рабочая папка `/home/bob/Projects/ai-aggregator`. Не запускались в design-задаче.

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun x --no-install vitest run packages/database/src/__tests__/ton-payments.test.ts packages/database/scripts/__tests__/native-migrate.test.ts packages/database/scripts/__tests__/native-clean-rehearsal.test.ts packages/database/scripts/__tests__/native-ton-core-test.test.ts packages/database/scripts/__tests__/ton-core-test-db-guard.test.ts packages/shared/src/__tests__/ton-payment-contract.test.ts
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run test:database-baseline
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run db:test:clean72
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run --filter @aiag/database type-check
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun x --no-install eslint packages/database/src/ton-payments.ts packages/database/src/ton-payment-types.ts packages/database/src/schema/ton-payments.ts packages/database/src/__tests__/ton-payments.test.ts packages/database/scripts/__tests__/ton-payments.native.integration.test.ts packages/database/scripts/__tests__/ton-payments.native.fixture.ts packages/database/scripts/native-ton-core-test.ts packages/database/scripts/ton-core-test-db-guard.ts packages/database/scripts/__tests__/native-ton-core-test.test.ts packages/database/scripts/__tests__/ton-core-test-db-guard.test.ts
```

Если package-wide typecheck имеет уже известные чужие ошибки, не объявлять PASS: exact scoped strict typecheck новых source/tests с текущими imports обязателен; ошибки/command перечислить отдельно. Существующие финансовые native suites admission/quota/RUB refund входят в baseline, поэтому единичный TON PASS недостаточен. Не запускать общий build несколько раз ради количества проверок.

| Gate | Требуемое evidence | Сейчас |
|---|---|---|
| Design financial/spec | independent reviewer approves unit binding, locks, debt/review, expiry, receipt/event uniqueness, schema и file scope | OPEN: этот draft |
| AG-TON2 native | reviewed source commit + RED/PASS real SQL concurrency/rollback/replay/conservation + TON amount strings>2^53, grant/result compatibility ceiling, actual RUB-refund regression + owner reads | NOT IMPLEMENTED |
| DB safety | unchanged old checksums + fresh72/no-op/checksum/rollback + mandatory baseline → dedicated TON child, target whole-DB dropped/canonical unchanged, negative guard/lifecycle proof; clean72 отдельно | NOT RUN |
| Lift PAYG compatibility ceiling | отдельная exact миграция обоих RUB refund consumers/all dependent calculations + native >2^53 financial review | не входит в AG-TON2; ceiling остаётся |
| Trusted verifier | AG-TON3 real full execution/finality/RPC field fixtures, import-boundary proof, recovery queue | отдельный gate, отсутствует |
| Web exposure | AG-TON4 server auth/origin/order arbitration; no client VerifiedChainCredit, decimal wire/UI | отдельный gate, отсутствует |
| Review/refund ops | AG-TON5 owner/queue/release/refund, unknown outcomes, debt semantics approved | отдельный gate, отсутствует |
| Live testnet/mainnet | отдельно разрешённые identity/RPC/test assets и реальные chain evidence; mainnet отдельный release | не запускать здесь |

## 7. Self-review дизайна перед handoff

- [x] HIGH finding исходного draft учтён: current/result PAYG ceiling на create/settlement, native actual-RUB-refund crossing test, no autoheal; lifting ceiling отдельно.
- [x] Persisted identical replay выполняется до current allowlist/freshness/compatibility checks; новые invoices проходят текущую policy.
- [x] Полный scope только invoice top-up core: owner+org+серверный order неизменяемы; units никогда не смешиваются.
- [x] Создание, expiry, debt и owner checks происходят под правильными locks, repeat возвращает immutable receipt.
- [x] Incoming event не теряется из-за expected review branch; second payment after settled имеет отдельный review decision.
- [x] Каждая денежная mutation имеет guard+RETURNING и один atomic commit; append-only receipts/decisions защищены согласованностью.
- [x] No hidden enum assumption: ledger source inventory приложен; new source='ton' исключает RUB refund/debit paths.
- [x] TON committed races/RUB calls только в fixed whole disposable DB, dedicated guard до imports, default canonical guard не расширяется; close/ownership-qualified DROP без FORCE/DELETE bypass.
- [x] Manifest+mandatory baseline+clean runner72 учтены; historical checksums frozen; нет rollout claims из document/test fixtures.

После подготовки исполнителем каждый code commit делать `git commit --only` с явным owned списком под `/tmp/ai-aggregator-git.lock`, без `git add .`, reset/clean чужих файлов или amend чужого HEAD. Этот дизайн коммитится только своим doc path; финальное решение по началу реализации принимает интегратор после independent review.

## Root acceptance дизайна

Независимое financial re-review095d9bf: Approved. Grant/resulting PAYG ceiling, concurrent growth review и persisted replay ordering приняты. До завершения MC3 не менять общий manifest71 и root baseline registration. После MC3 нужен точный implementation brief, актуальный next migration ID и единственный владелец SQL/schema/native-clean runner. Это принятие дизайна, не работающая TON оплата.

**Последующее isolation-уточнение:** отдельный whole-DB fixture/child env/cleanup protocol task2.0 добавлен по root finding после принятия095d9bf. До его scoped review этот новый execution contract не считать Approved; одобрение финансового ceiling/replay среза сохраняется. MC3 остаётся владельцем текущей native работы; manifest/source/test/env здесь не менялись.

Isolation review `e9b8e59`: Approved. Fixed disposable whole-DB lifecycle, отдельные strict guard/provisioner/child, реальные RUB functions с explicit guarded DB, no-FORCE cleanup и mandatory child acceptance проверены по дизайну. Реализация/negative lifecycle/native evidence ещё впереди. Root сохраняет очередь: завершить MC3 review, затем передать единому владельцу TON2 source/schema/manifest/isolated harness.
